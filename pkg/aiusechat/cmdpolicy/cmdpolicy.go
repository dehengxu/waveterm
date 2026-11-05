// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package cmdpolicy implements the command-level policy that the AI terminal
// tools apply to the commands they type into a user's terminal.
//
// The policy exists to bound the tool-level "Approved Forever" grant. That
// grant is stored as a tool name, so without this package a permanently
// approved terminal tool can run any command at all.
//
// The policy is a pair of prefix lists:
//   - Deny: commands that are never auto-approved. A denied command always
//     waits for an explicit user approval, even when the tool is on the
//     auto-approve list.
//   - Allow: commands that may run without an approval prompt.
//
// Matching rules:
//   - Matching is case-insensitive.
//   - A list entry matches when it is a prefix of the command and the
//     character right after the prefix is not a letter or a digit. So "rm -rf"
//     matches "rm -rf /" but not "rmdir /tmp".
//   - Short flags may be bundled or reordered, so "rm -rf" also matches
//     "rm -f -r /". The bundling is a heuristic, so an invalid combination
//     such as "rm -rfoo" is matched as well.
//   - A single-token entry such as "sudo" matches that exact command name
//     only: "sudo ls" matches, "sudoers" does not.
//   - Leading wrapper commands (sudo, doas, env, ...) are stripped before
//     matching, so "sudo rm -rf /" is matched against "rm -rf /".
//   - Shell chains are evaluated part by part, so "ls && rm -rf /" is matched
//     against "rm -rf /" as well.
//
// The two lists are not symmetric. The deny list is checked aggressively (every
// chain part, wrapper commands stripped), because a miss there is a security
// miss. The allow list is checked strictly: the command has to match the
// entry as a whole, with no chain operators and no wrapper stripping, so an
// allowed entry can never be reached through "sudo ..." or "allowed && other".
//
// Known boundaries (deliberate, they are not bugs):
//   - Only the command text is inspected. Nested shell invocations such as
//     `bash -c "rm -rf /"`, `eval "..."` or `$(...)` are not unwrapped, so a
//     denied command hidden inside a quoted argument is not detected.
//   - Obfuscation (base64, variable expansion, aliases, shell functions) is
//     not decoded.
//   - The policy is a guardrail, not a sandbox. It does not stop the user
//     from typing a denied command by hand.
package cmdpolicy

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// Decision is the outcome of evaluating a command against a policy.
type Decision struct {
	// Denied is true when the command hits the deny list.
	Denied bool
	// Allowed is true when the command hits the allow list.
	Allowed bool
}

// GlobalProfile is the profile used when no per-profile policy exists.
const GlobalProfile = ""

// PolicyProvider returns the policy that applies to a profile. It is a
// package level variable so that tests (and future callers) can inject a
// policy without going through the config watcher.
var PolicyProvider = defaultPolicyProvider

func defaultPolicyProvider(_ string) wconfig.CommandPolicyConfigType {
	return wconfig.GetWatcher().GetFullConfig().CommandPolicy
}

// PolicyForProfile returns the command policy that applies to the given
// profile. Today every profile resolves to the single global policy; the
// profile parameter exists so that per-profile policies can be added later
// without changing any call site.
func PolicyForProfile(profile string) wconfig.CommandPolicyConfigType {
	return policyFor(profile)
}

// policyFor is the single lookup point for policies.
func policyFor(profile string) wconfig.CommandPolicyConfigType {
	return PolicyProvider(profile)
}

// Decide evaluates a command against a policy. Deny wins over allow: a
// command that hits both lists is denied.
func Decide(command string, policy wconfig.CommandPolicyConfigType) Decision {
	return Decision{
		Denied:  MatchDeny(command, policy.Deny),
		Allowed: MatchAllow(command, policy.Allow),
	}
}

// IsDenied reports whether the command hits the policy deny list.
func IsDenied(command string, policy wconfig.CommandPolicyConfigType) bool {
	return MatchDeny(command, policy.Deny)
}

// IsAllowed reports whether the command hits the policy allow list.
func IsAllowed(command string, policy wconfig.CommandPolicyConfigType) bool {
	return MatchAllow(command, policy.Allow)
}

// MatchDeny reports whether the command hits any entry of the list, using the
// deny semantics: every part of a shell chain is checked and leading wrapper
// commands are stripped. An empty list never matches.
func MatchDeny(command string, entries []string) bool {
	if len(entries) == 0 || strings.TrimSpace(command) == "" {
		return false
	}
	candidates := denyCandidates(command)
	for _, entry := range entries {
		e := normalizeEntry(entry)
		if e == "" {
			continue
		}
		for _, cand := range candidates {
			if matchEntry(e, cand) {
				return true
			}
		}
	}
	return false
}

// MatchAllow reports whether the command hits any entry of the list, using
// the allow semantics: the command has to match the entry as a whole. Chain
// operators are rejected and wrapper commands are not stripped, so an allowed
// entry can never be reached through "sudo ..." or "allowed && other". An
// empty list never matches.
func MatchAllow(command string, entries []string) bool {
	if len(entries) == 0 || strings.TrimSpace(command) == "" {
		return false
	}
	tokens := splitCommand(command)
	if len(splitParts(tokens)) > 1 {
		// A chained command is never covered by a single allow entry.
		return false
	}
	cand := strings.ToLower(strings.Join(tokens, " "))
	for _, entry := range entries {
		e := normalizeEntry(entry)
		if e == "" {
			continue
		}
		if matchEntry(e, cand) {
			return true
		}
	}
	return false
}

// commandFromToolInput is used to pull the command out of a tool's parsed
// input.
type commandFromToolInput struct {
	Command string `json:"command"`
}

// CommandFromToolInput returns the shell command carried by a tool's parsed
// input, or "" when the tool does not take a command.
func CommandFromToolInput(input any) string {
	if input == nil {
		return ""
	}
	result := &commandFromToolInput{}
	if err := utilfn.ReUnmarshal(result, input); err != nil {
		return ""
	}
	return result.Command
}

// denyCandidates returns the command variants that are matched against the
// deny list: every shell chain part, plus the same part with leading wrapper
// commands removed.
func denyCandidates(command string) []string {
	parts := splitParts(splitCommand(command))
	var cands []string
	seen := map[string]bool{}
	add := func(tokens []string) {
		s := strings.ToLower(strings.Join(tokens, " "))
		if s == "" || seen[s] {
			return
		}
		seen[s] = true
		cands = append(cands, s)
	}
	for _, part := range parts {
		cur := part
		for {
			add(cur)
			rest, ok := stripWrappers(cur)
			if !ok {
				break
			}
			cur = rest
		}
	}
	return cands
}

// matchEntry reports whether a policy entry matches a command candidate.
func matchEntry(entry string, cand string) bool {
	if entry == "" || cand == "" {
		return false
	}
	if cand == entry {
		return true
	}
	if strings.HasPrefix(cand, entry) {
		// The prefix has to end on a word boundary, so "rm -rf" does not
		// match "rm -rfoo".
		if !isWordByte(cand[len(entry)]) {
			return true
		}
	}
	// Fall back to a token comparison. This covers bundled and reordered
	// short flags ("rm -f -r /" against the entry "rm -rf") and extra
	// arguments.
	entryTokens := expandFlags(strings.Fields(entry))
	candTokens := expandFlags(strings.Fields(cand))
	if len(entryTokens) == 0 || len(candTokens) == 0 {
		return false
	}
	if entryTokens[0] != candTokens[0] {
		return false
	}
	for _, tok := range entryTokens[1:] {
		if !containsToken(candTokens[1:], tok) {
			return false
		}
	}
	return true
}

// normalizeEntry lowercases an entry and collapses whitespace runs so that
// "RM  -RF" and "rm -rf" are the same entry.
func normalizeEntry(entry string) string {
	return strings.ToLower(strings.Join(strings.Fields(entry), " "))
}

// isWordByte reports whether the byte can be part of a command word. It is
// used to keep a prefix match from running into the next word.
func isWordByte(b byte) bool {
	return b == '_' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

// expandFlags splits bundled short options ("-rf" becomes "-r" and "-f") so
// that flag bundling and reordering do not affect matching. Long options
// ("--force") are kept as they are.
func expandFlags(tokens []string) []string {
	var out []string
	for _, tok := range tokens {
		if len(tok) > 2 && tok[0] == '-' && tok[1] != '-' {
			for i := 1; i < len(tok); i++ {
				out = append(out, "-"+string(tok[i]))
			}
			continue
		}
		out = append(out, tok)
	}
	return out
}

func containsToken(tokens []string, tok string) bool {
	for _, t := range tokens {
		if t == tok {
			return true
		}
	}
	return false
}

// splitCommand splits a command line into shell-ish tokens. Quoted segments
// are kept together (including the quote characters) and the unquoted shell
// operators "&&", "||", ";" and "|" are returned as separate tokens.
func splitCommand(cmd string) []string {
	var tokens []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			tokens = append(tokens, cur.String())
			cur.Reset()
		}
	}
	runes := []rune(cmd)
	inSingle := false
	inDouble := false
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case r == '\'' && !inDouble:
			inSingle = !inSingle
			cur.WriteRune(r)
		case r == '"' && !inSingle:
			inDouble = !inDouble
			cur.WriteRune(r)
		case (r == ' ' || r == '\t' || r == '\n' || r == '\r') && !inSingle && !inDouble:
			flush()
		case r == '|' && !inSingle && !inDouble:
			flush()
			if i+1 < len(runes) && runes[i+1] == '|' {
				i++
			}
			tokens = append(tokens, "|")
		case r == ';' && !inSingle && !inDouble:
			flush()
			tokens = append(tokens, ";")
		case r == '&' && !inSingle && !inDouble && i+1 < len(runes) && runes[i+1] == '&':
			flush()
			i++
			tokens = append(tokens, "&&")
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return tokens
}

// splitParts splits the token list on the shell operators, so that every
// command of a chain is evaluated on its own.
func splitParts(tokens []string) [][]string {
	var parts [][]string
	var cur []string
	for _, tok := range tokens {
		if tok == "|" || tok == ";" || tok == "&&" {
			if len(cur) > 0 {
				parts = append(parts, cur)
				cur = nil
			}
			continue
		}
		cur = append(cur, tok)
	}
	if len(cur) > 0 {
		parts = append(parts, cur)
	}
	if len(parts) == 0 {
		parts = append(parts, nil)
	}
	return parts
}

// wrapperSpec describes how the arguments of a wrapper command are skipped.
type wrapperSpec struct {
	// valueFlags are wrapper flags that consume the following token as their
	// value (for example "sudo -u root ...").
	valueFlags map[string]bool
}

// wrapperSpecs lists the commands that wrap another command. They are
// stripped before matching so that "sudo rm -rf /" is matched against
// "rm -rf /".
var wrapperSpecs = map[string]wrapperSpec{
	"sudo":    {valueFlags: newSet("-u", "--user", "-g", "--group", "-p", "--prompt", "-c", "--chdir", "-h", "--host", "-r", "--role", "-t", "--type")},
	"doas":    {valueFlags: newSet("-u", "--user", "-c", "--chdir")},
	"env":     {valueFlags: newSet("-u", "--unset", "-c", "--chdir", "-s", "--split-string", "-a", "--argv0")},
	"nice":    {valueFlags: newSet("-n", "--adjustment")},
	"ionice":  {valueFlags: newSet("-c", "-n", "-p")},
	"stdbuf":  {valueFlags: newSet("-i", "-o", "-e")},
	"xargs":   {valueFlags: newSet("-n", "-i", "-p", "-l", "-s", "-a")},
	"nohup":   {},
	"time":    {},
	"command": {},
	"exec":    {},
	"builtin": {},
}

func newSet(values ...string) map[string]bool {
	ret := make(map[string]bool, len(values))
	for _, v := range values {
		ret[v] = true
	}
	return ret
}

// stripWrappers removes a leading wrapper command (sudo, env, ...) from the
// token list. It returns false when the first token is not a wrapper.
func stripWrappers(tokens []string) ([]string, bool) {
	if len(tokens) == 0 {
		return nil, false
	}
	name := strings.ToLower(tokens[0])
	spec, ok := wrapperSpecs[name]
	if !ok {
		return nil, false
	}
	idx := 1
	for idx < len(tokens) && strings.HasPrefix(tokens[idx], "-") {
		flag := strings.ToLower(tokens[idx])
		idx++
		if spec.valueFlags[flag] && idx < len(tokens) {
			idx++
		}
	}
	for idx < len(tokens) && isEnvAssignment(tokens[idx]) {
		idx++
	}
	if idx >= len(tokens) {
		return nil, false
	}
	return tokens[idx:], true
}

// isEnvAssignment reports whether the token is a "NAME=value" assignment.
func isEnvAssignment(token string) bool {
	eq := strings.Index(token, "=")
	if eq <= 0 {
		return false
	}
	name := token[:eq]
	for i, r := range name {
		if r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			continue
		}
		if i > 0 && r >= '0' && r <= '9' {
			continue
		}
		return false
	}
	return true
}
