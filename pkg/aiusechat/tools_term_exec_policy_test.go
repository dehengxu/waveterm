// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"encoding/json"
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

func approvalFor(t *testing.T, command string, opts uctypes.WaveChatOpts) string {
	t.Helper()
	args, err := json.Marshal(map[string]any{"widget_id": "abcdefgh", "command": command})
	if err != nil {
		t.Fatalf("failed to marshal the tool arguments: %v", err)
	}
	toolUse := aiutil.CreateToolUseData("call-1", "term_execute_command", string(args), opts)
	return toolUse.Approval
}

// TestTermExecuteCommandDenyBlocksAutoApprove covers acceptance criterion 1:
// a denied command must not be auto-approved, even when the user permanently
// approved the tool.
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
			if approval != uctypes.ApprovalNeedsApproval {
				t.Fatalf("approval = %q, want %q", approval, uctypes.ApprovalNeedsApproval)
			}
		})
	}
}

// TestTermExecuteCommandAllowSkipsApproval covers acceptance criterion 2:
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
