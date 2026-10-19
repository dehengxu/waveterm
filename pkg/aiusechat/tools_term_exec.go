// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	TermExecuteMaxCommandLen = 8000
)

type TermExecuteCommandToolInput struct {
	WidgetId string `json:"widget_id"`
	Command  string `json:"command"`
}

type TermExecuteCommandToolOutput struct {
	WidgetId   string `json:"widget_id"`
	Command    string `json:"command"`
	Submitted  bool   `json:"submitted"`
	ShellState string `json:"shellstate,omitempty"`
}

func parseTermExecuteCommandInput(input any) (*TermExecuteCommandToolInput, error) {
	result := &TermExecuteCommandToolInput{}

	if input == nil {
		return nil, fmt.Errorf("widget_id and command are required")
	}

	inputBytes, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal input: %w", err)
	}

	if err := json.Unmarshal(inputBytes, result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal input: %w", err)
	}

	if result.WidgetId == "" {
		return nil, fmt.Errorf("widget_id is required")
	}
	if strings.TrimSpace(result.Command) == "" {
		return nil, fmt.Errorf("command is required and must not be blank")
	}

	return result, nil
}

// sanitizeTypedCommand rejects raw control characters so the model cannot smuggle
// escape sequences or terminal interrupts (Ctrl-C, Ctrl-D, ...) past the approval
// UI. Tab and newline stay allowed: a real user types those too, and newlines are
// what makes multi-line constructs such as heredocs work.
func sanitizeTypedCommand(command string) (string, error) {
	for idx, r := range command {
		if r == '\n' || r == '\t' {
			continue
		}
		if unicode.IsControl(r) {
			return "", fmt.Errorf("command contains a control character (U+%04X) at position %d; only plain text, tabs and newlines can be typed into a terminal", r, idx)
		}
	}
	return command, nil
}

func verifyTermExecuteCommandInput(input any, _ *uctypes.UIMessageDataToolUse) error {
	parsed, err := parseTermExecuteCommandInput(input)
	if err != nil {
		return err
	}

	cleaned, err := sanitizeTypedCommand(parsed.Command)
	if err != nil {
		return err
	}

	if len(cleaned) > TermExecuteMaxCommandLen {
		return fmt.Errorf("command is %d bytes, which exceeds the %d byte limit; split it into smaller commands", len(cleaned), TermExecuteMaxCommandLen)
	}

	return nil
}

// typeCommandIntoTerminal delivers the command to the terminal block's pty exactly
// the way a keystroke would, which is the same call the frontend term view uses
// (RpcApi.ControllerInputCommand on TabRpcClient). Appending \r submits it.
//
// The route must be the tab route, matching what the frontend passes. The
// controllerinput command is dispatched by the Wave server itself (it looks the
// block controller up by BlockId), so routing at a block ("feblock:" or
// "controller:") makes the router look for the command on a link that does not
// implement it and fail with "rpc command not supported by [...]".
func typeCommandIntoTerminal(tabId string, fullBlockId string, command string) error {
	payload := command + "\r"
	encoded := base64.StdEncoding.EncodeToString([]byte(payload))

	return wshclient.ControllerInputCommand(
		wshclient.GetBareRpcClient(),
		wshrpc.CommandBlockInputData{
			BlockId:     fullBlockId,
			InputData64: encoded,
		},
		&wshrpc.RpcOpts{Route: wshutil.MakeTabRouteId(tabId)},
	)
}

func runTermExecuteCommand(tabId string, input any) (*TermExecuteCommandToolOutput, error) {
	parsed, err := parseTermExecuteCommandInput(input)
	if err != nil {
		return nil, err
	}

	command, err := sanitizeTypedCommand(parsed.Command)
	if err != nil {
		return nil, err
	}

	ctx, cancelFn := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelFn()

	fullBlockId, err := wcore.ResolveBlockIdFromPrefix(ctx, tabId, parsed.WidgetId)
	if err != nil {
		return nil, err
	}

	block, err := wstore.DBGet[*waveobj.Block](ctx, fullBlockId)
	if err != nil {
		return nil, fmt.Errorf("failed to load block %s: %w", fullBlockId, err)
	}
	if block == nil {
		return nil, fmt.Errorf("block %s no longer exists", fullBlockId)
	}

	viewType, _ := block.Meta[waveobj.MetaKey_View].(string)
	if viewType != "term" {
		return nil, fmt.Errorf("widget %s is a %q widget, not a terminal; term_execute_command can only type into terminal widgets", parsed.WidgetId, viewType)
	}

	blockORef := waveobj.MakeORef(waveobj.OType_Block, fullBlockId)
	rtInfo := wstore.GetRTInfo(blockORef)
	shellState := ""
	if rtInfo != nil {
		shellState = rtInfo.ShellState
		if shellState == "running-command" {
			return nil, fmt.Errorf("the shell in %s is still running the previous command (%s); wait for it to finish, then retry", parsed.WidgetId, rtInfo.ShellLastCmd)
		}
	}

	if err := typeCommandIntoTerminal(tabId, fullBlockId, command); err != nil {
		return nil, fmt.Errorf("failed to send command to terminal %s: %w", parsed.WidgetId, err)
	}

	return &TermExecuteCommandToolOutput{
		WidgetId:   parsed.WidgetId,
		Command:    command,
		Submitted:  true,
		ShellState: shellState,
	}, nil
}

func GetTermExecuteCommandToolDefinition(tabId string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:             "term_execute_command",
		DisplayName:      "Run Command In Terminal",
		ShortDescription: "Type a shell command into a terminal widget and submit it. The user approves before anything runs.",
		Description: strings.Join([]string{
			`Type a shell command into one of the user's terminal widgets and press Enter, as if the user had typed it themselves.`,
			`The keystrokes are delivered to the real terminal, so the command is visible in the terminal and its output lands in that terminal's scrollback.`,
			`This requires user approval. After the command runs, read the result with term_get_scrollback (or term_command_output) before drawing conclusions -- never guess at command output.`,
			`The command is typed verbatim. There is no shell interpolation performed on your behalf, so quote and escape exactly as you want bash to see it.`,
			`Only use this when the user has asked you to act. Do not run commands speculatively.`,
		}, " "),
		ToolLogName: "term:executecommand",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"widget_id": map[string]any{
					"type":        "string",
					"description": "8-character widget ID of the terminal widget to type into.",
				},
				"command": map[string]any{
					"type":        "string",
					"description": "The shell command to type, without a trailing newline. It is submitted automatically.",
				},
			},
			"required":             []string{"widget_id", "command"},
			"additionalProperties": false,
		},
		ToolCallDesc: func(input any, output any, toolUseData *uctypes.UIMessageDataToolUse) string {
			parsed, err := parseTermExecuteCommandInput(input)
			if err != nil {
				return fmt.Sprintf("error parsing input: %v", err)
			}
			return fmt.Sprintf("running %q in %s", strings.TrimSpace(parsed.Command), parsed.WidgetId)
		},
		ToolVerifyInput: verifyTermExecuteCommandInput,
		ToolApproval: func(input any) string {
			return uctypes.ApprovalNeedsApproval
		},
		ToolAnyCallback: func(input any, toolUseData *uctypes.UIMessageDataToolUse) (any, error) {
			return runTermExecuteCommand(tabId, input)
		},
	}
}
