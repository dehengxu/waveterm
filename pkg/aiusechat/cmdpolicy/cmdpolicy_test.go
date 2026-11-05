// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmdpolicy

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

func testPolicy() wconfig.CommandPolicyConfigType {
	return wconfig.CommandPolicyConfigType{
		Deny:  []string{"rm -rf", "sudo", "curl"},
		Allow: []string{"ls", "git status"},
	}
}

func TestDecide(t *testing.T) {
	policy := testPolicy()
	cases := []struct {
		name    string
		command string
		denied  bool
		allowed bool
	}{
		{name: "deny entry", command: "rm -rf", denied: true},
		{name: "deny entry with args", command: "rm -rf /tmp/foo", denied: true},
		{name: "deny entry with extra whitespace", command: "rm  -rf /tmp/foo", denied: true},
		{name: "deny entry uppercase", command: "RM -RF /tmp/foo", denied: true},
		{name: "deny entry mixed case", command: "Rm -Rf /tmp/foo", denied: true},
		{name: "sudo wrapper", command: "sudo rm -rf /", denied: true},
		{name: "sudo wrapper with user flag", command: "sudo -u root rm -rf /", denied: true},
		{name: "sudo wrapper with env assignment", command: "env FOO=bar rm -rf /", denied: true},
		{name: "sudo on its own", command: "sudo ls -la", denied: true},
		{name: "deny entry with reordered flags", command: "rm -f -r /", denied: true},
		{name: "deny entry in a shell chain", command: "ls && rm -rf /", denied: true},
		{name: "deny entry in a pipeline", command: "cat /tmp/x | rm -rf /", denied: true},
		{name: "allow entry", command: "ls -la", allowed: true},
		{name: "allow entry with args", command: "git status --short", allowed: true},
		{name: "allow entry exact", command: "git status", allowed: true},
		{name: "allow entry that is not denied", command: "ls", denied: false, allowed: true},
		{name: "no match", command: "echo hello", denied: false, allowed: false},
		{name: "different command with same prefix", command: "rmdir /tmp/foo", denied: false, allowed: false},
		{name: "word starting with a deny entry", command: "sudoers", denied: false, allowed: false},
		{name: "quoted command is not inspected", command: `echo "rm -rf /"`, denied: false, allowed: false},
		{name: "wrapper does not inherit an allow entry", command: "sudo ls -la", denied: true, allowed: false},
		{name: "chain does not inherit an allow entry", command: "ls && rm -rf /", denied: true, allowed: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			decision := Decide(tc.command, policy)
			if decision.Denied != tc.denied {
				t.Errorf("Decide(%q).Denied = %v, want %v", tc.command, decision.Denied, tc.denied)
			}
			if decision.Allowed != tc.allowed {
				t.Errorf("Decide(%q).Allowed = %v, want %v", tc.command, decision.Allowed, tc.allowed)
			}
			if got := IsDenied(tc.command, policy); got != tc.denied {
				t.Errorf("IsDenied(%q) = %v, want %v", tc.command, got, tc.denied)
			}
			if got := IsAllowed(tc.command, policy); got != tc.allowed {
				t.Errorf("IsAllowed(%q) = %v, want %v", tc.command, got, tc.allowed)
			}
		})
	}
}

func TestDecideDenyWinsOverAllow(t *testing.T) {
	policy := wconfig.CommandPolicyConfigType{
		Deny:  []string{"rm -rf"},
		Allow: []string{"rm -rf", "ls"},
	}
	decision := Decide("rm -rf /tmp/foo", policy)
	if !decision.Denied {
		t.Fatalf("expected the command to be denied")
	}
	if !decision.Allowed {
		t.Fatalf("expected the command to also hit the allow list")
	}
	// Both flags are set, so the callers have to check Denied first. That is
	// what the tool approval does.
	if !decision.Denied {
		t.Fatalf("deny must take precedence over allow")
	}
}

func TestDecideEmptyLists(t *testing.T) {
	policy := wconfig.CommandPolicyConfigType{}
	decision := Decide("rm -rf /tmp/foo", policy)
	if decision.Denied {
		t.Errorf("an empty deny list must not deny anything")
	}
	if decision.Allowed {
		t.Errorf("an empty allow list must not allow anything")
	}
	if MatchDeny("rm -rf /tmp/foo", nil) {
		t.Errorf("an empty entry list must not match")
	}
	if MatchAllow("rm -rf /tmp/foo", nil) {
		t.Errorf("an empty entry list must not match")
	}
	if MatchDeny("   ", []string{"rm -rf"}) {
		t.Errorf("an empty command must not match")
	}
}

func TestDecideAllowOnly(t *testing.T) {
	policy := wconfig.CommandPolicyConfigType{
		Allow: []string{"git status"},
	}
	decision := Decide("git status", policy)
	if decision.Denied {
		t.Errorf("the command must not be denied")
	}
	if !decision.Allowed {
		t.Errorf("the command must be allowed")
	}
}

func TestMatchIsCaseInsensitive(t *testing.T) {
	policy := wconfig.CommandPolicyConfigType{
		Deny:  []string{"RM -RF"},
		Allow: []string{"GIT STATUS"},
	}
	if !IsDenied("rm -rf /", policy) {
		t.Errorf("a lower case command must hit an upper case deny entry")
	}
	if !IsAllowed("git status", policy) {
		t.Errorf("a lower case command must hit an upper case allow entry")
	}
}

func TestMatchWithArguments(t *testing.T) {
	policy := wconfig.CommandPolicyConfigType{
		Deny: []string{"git push --force"},
	}
	if !IsDenied("git push --force origin main", policy) {
		t.Errorf("a deny entry must match a command with extra arguments")
	}
	if IsDenied("git push origin main", policy) {
		t.Errorf("a deny entry must not match a command without the denied flags")
	}
}

func TestCommandFromToolInput(t *testing.T) {
	if got := CommandFromToolInput(map[string]any{"command": "ls -la"}); got != "ls -la" {
		t.Errorf("CommandFromToolInput = %q, want %q", got, "ls -la")
	}
	if got := CommandFromToolInput(map[string]any{"path": "/tmp"}); got != "" {
		t.Errorf("CommandFromToolInput = %q, want an empty string", got)
	}
	if got := CommandFromToolInput(nil); got != "" {
		t.Errorf("CommandFromToolInput = %q, want an empty string", got)
	}
}

func TestPolicyForProfileUsesTheProvider(t *testing.T) {
	prev := PolicyProvider
	defer func() { PolicyProvider = prev }()
	PolicyProvider = func(profile string) wconfig.CommandPolicyConfigType {
		return wconfig.CommandPolicyConfigType{Deny: []string{profile}}
	}
	policy := PolicyForProfile("myprofile")
	if len(policy.Deny) != 1 || policy.Deny[0] != "myprofile" {
		t.Fatalf("PolicyForProfile did not use the provider, got %+v", policy)
	}
}

// TestMatchDenyRuleReportsTheEntry checks that the deny matcher reports which
// entry blocked the command, so that the error the model sees can name the
// rule the user has to change.
func TestMatchDenyRuleReportsTheEntry(t *testing.T) {
	entries := []string{"sudo", "rm -rf"}
	rule, ok := MatchDenyRule("sudo rm -rf /", entries)
	if !ok {
		t.Fatalf("the command was not denied")
	}
	if rule != "sudo" {
		t.Fatalf("rule = %q, want %q", rule, "sudo")
	}
	rule, ok = MatchDenyRule("rm -rf /tmp/foo", entries)
	if !ok || rule != "rm -rf" {
		t.Fatalf("rule = %q (denied=%v), want %q", rule, ok, "rm -rf")
	}
	if _, ok := MatchDenyRule("ls -la", entries); ok {
		t.Fatalf("an unrelated command was denied")
	}
	if _, ok := MatchDenyRule("ls -la", nil); ok {
		t.Fatalf("an empty entry list denied a command")
	}
}

// TestDecideReportsTheDenyRule checks that the decision carries the matched
// deny entry.
func TestDecideReportsTheDenyRule(t *testing.T) {
	policy := wconfig.CommandPolicyConfigType{Deny: []string{"curl"}}
	decision := Decide("curl http://example.com", policy)
	if !decision.Denied {
		t.Fatalf("the command must be denied")
	}
	if decision.DenyRule != "curl" {
		t.Fatalf("DenyRule = %q, want %q", decision.DenyRule, "curl")
	}
	decision = Decide("ls -la", policy)
	if decision.Denied || decision.DenyRule != "" {
		t.Fatalf("an unrelated command was denied: %+v", decision)
	}
}
