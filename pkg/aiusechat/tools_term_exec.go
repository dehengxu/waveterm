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
	// How long we let an already-running shell finish before giving up on
	// delivering into it. The model has no "wait" tool, so failing immediately
	// just makes it retry in a tight loop against a terminal that is busy for
	// perfectly ordinary reasons (a find, a build, a download).
	termExecuteBusyWait     = 10 * time.Second
	termExecutePollInterval = 400 * time.Millisecond
	// How long we wait for a submitted command to finish so that its output
	// can be returned in the same tool call.
	termExecuteOutputWait = 30 * time.Second
	// Grace period before we accept "the scrollback grew" as proof that the
	// command finished. Without it we can return while the command is still
	// running, because the echoed command line already counts as new output.
	termExecuteMinRun = 1200 * time.Millisecond
)

type TermExecuteCommandToolInput struct {
	WidgetId string `json:"widget_id"`
	Command  string `json:"command"`
	// Wait defaults to true. When set, the call blocks until the command
	// finishes and returns its output inline, which saves the model a
	// separate term_get_scrollback round trip.
	Wait *bool `json:"wait,omitempty"`
}

func (p *TermExecuteCommandToolInput) shouldWait() bool {
	if p.Wait == nil {
		return true
	}
	return *p.Wait
}

type TermExecuteCommandToolOutput struct {
	WidgetId   string `json:"widget_id"`
	Command    string `json:"command"`
	Submitted  bool   `json:"submitted"`
	ShellState string `json:"shellstate,omitempty"`
	Queued     bool   `json:"queued,omitempty"`
	Output     string `json:"output,omitempty"`
	ExitCode   *int   `json:"exitcode,omitempty"`
	Note       string `json:"note,omitempty"`
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
// (RpcApi.ControllerInputCommand). Appending \r submits it.
//
// Deliberately no RpcOpts.Route. GetBareRpcClient() is an in-process client
// registered against the local WshServerImpl, and ControllerInputCommand is one
// of the methods that implementation exposes, so a nil opts dispatches straight
// to the process that owns the block controller. Setting a route sends the
// message somewhere else instead, and both plausible guesses fail:
// "feblock:<blockid>" resolves to a link with no such command, and
// "tab:<tabid>" resolves to the frontend TabClient, which also has no such
// command. Either way the router replies
// `rpc command "controllerinput" not supported by [...]`.
func typeCommandIntoTerminal(fullBlockId string, command string) error {
	payload := command + "\r"
	encoded := base64.StdEncoding.EncodeToString([]byte(payload))

	return wshclient.ControllerInputCommand(
		wshclient.GetBareRpcClient(),
		wshrpc.CommandBlockInputData{
			BlockId:     fullBlockId,
			InputData64: encoded,
		},
		nil,
	)
}

// waitForShellIdle blocks until the block's shell is no longer running a
// command, or until the budget runs out. It reports whether the shell was
// still busy when the budget expired.
//
// When shell integration is off there is no state to read, so we report idle
// immediately.
func waitForShellIdle(blockORef waveobj.ORef) (string, bool) {
	deadline := time.Now().Add(termExecuteBusyWait)
	for {
		rtInfo := wstore.GetRTInfo(blockORef)
		shellState := ""
		if rtInfo != nil {
			shellState = rtInfo.ShellState
		}
		if shellState != "running-command" {
			return shellState, false
		}
		if time.Now().After(deadline) {
			return shellState, true
		}
		time.Sleep(termExecutePollInterval)
	}
}

// getScrollbackLineCount returns the total number of lines the terminal block
// currently holds. Uses the same feblock route as term_get_scrollback, which is
// the block's own endpoint.
func getScrollbackLineCount(fullBlockId string) (int, error) {
	result, err := wshclient.TermGetScrollbackLinesCommand(
		wshclient.GetBareRpcClient(),
		wshrpc.CommandTermGetScrollbackLinesData{LineStart: 0, LineEnd: 1},
		&wshrpc.RpcOpts{Route: wshutil.MakeFeBlockRouteId(fullBlockId)},
	)
	if err != nil {
		return 0, err
	}
	return result.TotalLines, nil
}

// getScrollbackSince returns the lines that were added after the block held
// beforeLines lines. Scrollback indices count backwards from the most recent
// line, so the new lines occupy the low indices.
func getScrollbackSince(fullBlockId string, beforeLines int, totalLines int) (string, error) {
	newLines := totalLines - beforeLines
	if newLines <= 0 {
		return "", nil
	}
	if newLines > 2000 {
		newLines = 2000
	}

	result, err := wshclient.TermGetScrollbackLinesCommand(
		wshclient.GetBareRpcClient(),
		wshrpc.CommandTermGetScrollbackLinesData{LineStart: 0, LineEnd: newLines},
		&wshrpc.RpcOpts{Route: wshutil.MakeFeBlockRouteId(fullBlockId)},
	)
	if err != nil {
		return "", err
	}
	return strings.Join(result.Lines, "\n"), nil
}

// waitForCommandCompletion blocks until the command we just typed has finished,
// and returns its output plus exit code.
//
// Completion is detected two ways. With shell integration on, the shell reports
// the last executed command, so an exact match is the strongest signal and it
// is immediate. Without it, we fall back to "the scrollback grew and the shell
// is no longer running something", with a short grace period so the echoed
// command line does not look like a finished run.
//
// The output itself is captured with the same lastcommand mechanism
// term_command_output uses, which uses the shell's prompt markers to isolate
// exactly the output region of the command. When shell integration is not
// available that mechanism is unavailable too, so we fall back to the lines
// that were added since the command was typed.
func waitForCommandCompletion(tabId string, widgetId string, fullBlockId string, blockORef waveobj.ORef, command string, beforeLines int) (string, *int, bool) {
	started := time.Now()
	deadline := started.Add(termExecuteOutputWait)

	for {
		shellState := ""
		lastCmd := ""
		exitCode := (*int)(nil)
		shellIntegration := false
		rtInfo := wstore.GetRTInfo(blockORef)
		if rtInfo != nil {
			shellState = rtInfo.ShellState
			lastCmd = rtInfo.ShellLastCmd
			shellIntegration = rtInfo.ShellIntegration
			if shellIntegration {
				code := rtInfo.ShellLastCmdExitCode
				exitCode = &code
			}
		}

		if shellState != "running-command" {
			done := false
			if shellIntegration && lastCmd == command {
				done = true
			} else if time.Since(started) > termExecuteMinRun {
				if total, err := getScrollbackLineCount(fullBlockId); err == nil && total > beforeLines {
					done = true
				}
			}
			if done {
				if shellIntegration {
					if out, err := getTermScrollbackOutput(tabId, widgetId, wshrpc.CommandTermGetScrollbackLinesData{LastCommand: true}); err == nil {
						return out.Content, exitCode, true
					}
				}
				total, err := getScrollbackLineCount(fullBlockId)
				if err != nil {
					return "", exitCode, true
				}
				content, err := getScrollbackSince(fullBlockId, beforeLines, total)
				if err != nil {
					return "", exitCode, true
				}
				return content, exitCode, true
			}
		}

		if time.Now().After(deadline) {
			return "", nil, false
		}
		time.Sleep(termExecutePollInterval)
	}
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
	shellState, wasBusy := waitForShellIdle(blockORef)

	beforeLines := 0
	if parsed.shouldWait() && !wasBusy {
		// Best effort. If this fails we simply fall back to a larger grace
		// period before accepting "the scrollback grew" as completion.
		beforeLines, _ = getScrollbackLineCount(fullBlockId)
	}

	if err := typeCommandIntoTerminal(fullBlockId, command); err != nil {
		return nil, fmt.Errorf("failed to send command to terminal %s: %w", parsed.WidgetId, err)
	}

	output := &TermExecuteCommandToolOutput{
		WidgetId:   parsed.WidgetId,
		Command:    command,
		Submitted:  true,
		ShellState: shellState,
	}
	if wasBusy {
		output.Queued = true
		output.Note = fmt.Sprintf(
			"The shell was still busy after waiting %s, so this command was typed into the terminal anyway. The terminal buffers it and the shell will run it once the previous command finishes. Its output will appear later in the scrollback -- read it before drawing conclusions. If the previous command is waiting for input, it will consume this text instead.",
			termExecuteBusyWait)
		return output, nil
	}

	if parsed.shouldWait() {
		content, exitCode, completed := waitForCommandCompletion(tabId, parsed.WidgetId, fullBlockId, blockORef, command, beforeLines)
		if completed {
			output.Output = content
			output.ExitCode = exitCode
		} else {
			output.Note = fmt.Sprintf(
				"The command was submitted but had not finished after %s, so no output is included. Read term_get_scrollback to check on it instead of re-issuing it.",
				termExecuteOutputWait)
		}
	}
	return output, nil
}

func GetTermExecuteCommandToolDefinition(tabId string) uctypes.ToolDefinition {
	return uctypes.ToolDefinition{
		Name:             "term_execute_command",
		DisplayName:      "Run Command In Terminal",
		ShortDescription: "Type a shell command into a terminal widget and submit it. The user approves before anything runs.",
		Description: strings.Join([]string{
			`Type a shell command into one of the user's terminal widgets and press Enter, as if the user had typed it themselves.`,
			`The keystrokes are delivered to the real terminal, so the command is visible in the terminal and its output lands in that terminal's scrollback.`,
			`This requires user approval. By default the call waits for the command to finish and returns its output and exit code inline, so you usually do not need a separate term_get_scrollback call. Set wait=false to fire and forget, then read the scrollback later.`,
			`Never guess at command output. If the result has no "output" field, the command did not finish within the wait budget: read term_get_scrollback to check on it rather than re-issuing it.`,
			`If the shell is busy, this call waits up to 10 seconds and then types the command anyway -- the terminal buffers it and the shell runs it when the previous command finishes. A "queued" result means the command has NOT run yet; wait and read the scrollback later instead of re-issuing it.`,
			`Keep commands cheap. An unbounded search such as "find ~" will scan node_modules and take minutes, which blocks everything behind it. Scope searches to a specific directory, add -maxdepth, and exclude heavy folders like node_modules.`,
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
				"wait": map[string]any{
					"type":        "boolean",
					"description": "Wait for the command to finish and return its output inline (default true). Set false to fire and forget.",
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
