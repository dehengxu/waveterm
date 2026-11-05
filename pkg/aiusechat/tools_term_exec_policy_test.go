// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/aiutil"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/cmdpolicy"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func setTestPolicy(t *testing.T, policy wconfig.CommandPolicyConfigType) {
	t.Helper()
	prev := cmdpolicy.PolicyProvider
	cmdpolicy.PolicyProvider = func(_ string) wconfig.CommandPolicyConfigType {
		return policy
	}
	t.Cleanup(func() { cmdpolicy.PolicyProvider = prev })
}

func termExecChatOpts(autoApprove bool) uctypes.WaveChatOpts {
	opts := uctypes.WaveChatOpts{
		Tools: []uctypes.ToolDefinition{GetTermExecuteCommandToolDefinition("tab1")},
	}
	if autoApprove {
		// This is what the "Approved Forever" toggle sends.
		opts.AutoApproveTools = []string{"term_execute_command"}
	}
	return opts
}

func termExecInput(command string) any {
	return map[string]any{"widget_id": "abcdefgh", "command": command}
}

func approvalFor(t *testing.T, command string, opts uctypes.WaveChatOpts) string {
	t.Helper()
	args, err := json.Marshal(termExecInput(command))
	if err != nil {
		t.Fatalf("failed to marshal the tool arguments: %v", err)
	}
	toolUse := aiutil.CreateToolUseData("call-1", "term_execute_command", string(args), opts)
	return toolUse.Approval
}

// termExecSpy stands in for the terminal runner. It records every command that
// made it to the terminal, so a test can prove that a blocked command never
// got there.
type termExecSpy struct {
	commands []string
}

func (s *termExecSpy) run(_ string, input any) (*TermExecuteCommandToolOutput, error) {
	command := cmdpolicy.CommandFromToolInput(input)
	s.commands = append(s.commands, command)
	return &TermExecuteCommandToolOutput{
		WidgetId:  "abcdefgh",
		Command:   command,
		Submitted: true,
	}, nil
}

func setTestRunner(t *testing.T, spy *termExecSpy) {
	t.Helper()
	prev := termExecuteRunner
	termExecuteRunner = spy.run
	t.Cleanup(func() { termExecuteRunner = prev })
}

// TestTermExecuteCommandDenyBlocksAutoApprove covers acceptance criterion 2:
// a denied command is not sent to the approval prompt at all. It answers
// "user denied", so the flow skips the approval wait instead of asking the
// user to confirm a command that is never going to run.
func TestTermExecuteCommandDenyBlocksAutoApprove(t *testing.T) {
	setTestPolicy(t, wconfig.CommandPolicyConfigType{
		Deny:  []string{"rm -rf", "sudo"},
		Allow: []string{"git status"},
	})
	opts := termExecChatOpts(true)

	cases := []struct {
		name    string
		command string
	}{
		{name: "denied command", command: "rm -rf /tmp/foo"},
		{name: "denied command with sudo", command: "sudo rm -rf /"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			approval := approvalFor(t, tc.command, opts)
			if approval != uctypes.ApprovalUserDenied {
				t.Fatalf("approval = %q, want %q", approval, uctypes.ApprovalUserDenied)
			}
		})
	}
}

// TestTermExecuteCommandDenyNeverReachesTerminal covers acceptance criterion
// 1: a denied command is blocked in the execution path, so it is never typed
// into the terminal. The spy stands in for the terminal runner and must not
// be called.
func TestTermExecuteCommandDenyNeverReachesTerminal(t *testing.T) {
	setTestPolicy(t, wconfig.CommandPolicyConfigType{
		Deny:  []string{"rm -rf", "sudo"},
		Allow: []string{"git status"},
	})
	spy := &termExecSpy{}
	setTestRunner(t, spy)

	toolDef := GetTermExecuteCommandToolDefinition("tab1")
	_, err := toolDef.ToolAnyCallback(termExecInput("rm -rf /"), nil)
	if err == nil {
		t.Fatalf("the denied command was not blocked")
	}
	if len(spy.commands) != 0 {
		t.Fatalf("the command reached the terminal: %v", spy.commands)
	}
	if !strings.Contains(err.Error(), `command blocked by policy: "rm -rf /"`) {
		t.Fatalf("the error does not name the blocked command: %v", err)
	}
	if !strings.Contains(err.Error(), `deny rule "rm -rf"`) {
		t.Fatalf("the error does not name the matched deny rule: %v", err)
	}
}

// TestTermExecuteCommandDenyBlockedWithApprovedForever covers the first half
// of acceptance criterion 5: with the "Approved Forever" grant in place, a
// denied command is still blocked and still never reaches the terminal.
func TestTermExecuteCommandDenyBlockedWithApprovedForever(t *testing.T) {
	setTestPolicy(t, wconfig.CommandPolicyConfigType{
		Deny:  []string{"rm -rf"},
		Allow: []string{"git status"},
	})
	spy := &termExecSpy{}
	setTestRunner(t, spy)

	opts := termExecChatOpts(true)
	if approval := approvalFor(t, "rm -rf /tmp/foo", opts); approval != uctypes.ApprovalUserDenied {
		t.Fatalf("approval = %q, want %q", approval, uctypes.ApprovalUserDenied)
	}

	toolDef := GetTermExecuteCommandToolDefinition("tab1")
	if _, err := toolDef.ToolAnyCallback(termExecInput("rm -rf /tmp/foo"), nil); err == nil {
		t.Fatalf("the denied command was not blocked")
	}
	if len(spy.commands) != 0 {
		t.Fatalf("the command reached the terminal: %v", spy.commands)
	}
}

// TestTermExecuteCommandAllowedReachesTerminal is the counterpart of the
// blocked case: a command that is not denied still runs, and it runs even
// when the policy sends it down the approval path.
func TestTermExecuteCommandAllowedReachesTerminal(t *testing.T) {
	setTestPolicy(t, wconfig.CommandPolicyConfigType{
		Deny:  []string{"rm -rf"},
		Allow: []string{"git status"},
	})
	spy := &termExecSpy{}
	setTestRunner(t, spy)

	toolDef := GetTermExecuteCommandToolDefinition("tab1")
	if _, err := toolDef.ToolAnyCallback(termExecInput("git status"), nil); err != nil {
		t.Fatalf("the allowed command was blocked: %v", err)
	}
	if len(spy.commands) != 1 || spy.commands[0] != "git status" {
		t.Fatalf("the command did not reach the terminal: %v", spy.commands)
	}
}

// TestTermExecuteCommandAllowSkipsApproval covers acceptance criterion 3:
// an allowed command runs without an approval prompt.
func TestTermExecuteCommandAllowSkipsApproval(t *testing.T) {
	setTestPolicy(t, wconfig.CommandPolicyConfigType{
		Deny:  []string{"rm -rf"},
		Allow: []string{"git status"},
	})
	// The allow list works on its own, without the "Approved Forever" grant.
	opts := termExecChatOpts(false)
	if approval := approvalFor(t, "git status", opts); approval != uctypes.ApprovalAutoApproved {
		t.Fatalf("approval = %q, want %q", approval, uctypes.ApprovalAutoApproved)
	}
}

// TestTermExecuteCommandUnlistedNeedsApproval covers acceptance criterion 4:
// a command that hits neither list still waits for the user.
func TestTermExecuteCommandUnlistedNeedsApproval(t *testing.T) {
	setTestPolicy(t, wconfig.CommandPolicyConfigType{
		Deny:  []string{"rm -rf"},
		Allow: []string{"git status"},
	})
	opts := termExecChatOpts(false)
	if approval := approvalFor(t, "echo hello", opts); approval != uctypes.ApprovalNeedsApproval {
		t.Fatalf("approval = %q, want %q", approval, uctypes.ApprovalNeedsApproval)
	}
}

// TestTermExecuteCommandAutoApproveStillWorks makes sure the deny list is
// what blocks the denied command: without a deny entry the permanent grant
// still auto-approves the command.
func TestTermExecuteCommandAutoApproveStillWorks(t *testing.T) {
	setTestPolicy(t, wconfig.CommandPolicyConfigType{})
	opts := termExecChatOpts(true)
	if approval := approvalFor(t, "rm -rf /tmp/foo", opts); approval != uctypes.ApprovalAutoApproved {
		t.Fatalf("approval = %q, want %q", approval, uctypes.ApprovalAutoApproved)
	}
}
