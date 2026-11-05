// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmdpolicy

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

var testConfigDir string

// TestMain points the config directory at a scratch directory so that the
// watcher test can write config files without touching the real user config.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "cmdpolicy-config")
	if err != nil {
		panic(err)
	}
	testConfigDir = dir
	wavebase.ConfigHome_VarCache = dir
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func writePolicyFile(t *testing.T, contents string) {
	t.Helper()
	err := os.WriteFile(filepath.Join(testConfigDir, "commandpolicy.json"), []byte(contents), 0644)
	if err != nil {
		t.Fatalf("failed to write the policy file: %v", err)
	}
}

// TestPolicyHotReload proves that a changed commandpolicy.json is picked up
// by the config watcher without restarting anything, and that the policy
// lookup then returns the new values.
func TestPolicyHotReload(t *testing.T) {
	writePolicyFile(t, `{"deny": ["rm -rf"], "allow": ["echo"]}`)

	wconfig.GetWatcher().Start()

	policy := PolicyForProfile(GlobalProfile)
	if len(policy.Deny) != 1 || policy.Deny[0] != "rm -rf" {
		t.Fatalf("initial deny list = %+v, want [rm -rf]", policy.Deny)
	}
	if len(policy.Allow) != 1 || policy.Allow[0] != "echo" {
		t.Fatalf("initial allow list = %+v, want [echo]", policy.Allow)
	}

	// Change the config file. The watcher has to notice it and refresh its
	// cache on its own.
	writePolicyFile(t, `{"deny": ["curl"], "allow": ["git status"]}`)

	deadline := time.Now().Add(15 * time.Second)
	for {
		policy = PolicyForProfile(GlobalProfile)
		if len(policy.Deny) == 1 && policy.Deny[0] == "curl" && len(policy.Allow) == 1 && policy.Allow[0] == "git status" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the watcher did not pick up the new policy, last value was %+v", policy)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// The new values are in effect right away.
	if !IsDenied("curl http://example.com", policy) {
		t.Fatalf("the new deny entry is not in effect")
	}
	if IsDenied("rm -rf /tmp/foo", policy) {
		t.Fatalf("the old deny entry is still in effect")
	}
	if !IsAllowed("git status", policy) {
		t.Fatalf("the new allow entry is not in effect")
	}
}

// TestDefaultPolicyIsLoaded checks that the embedded default policy ends up
// in the config, so a fresh install already has a deny list.
func TestDefaultPolicyIsLoaded(t *testing.T) {
	defaults, errs := wconfig.ReadDefaultsConfigFile("commandpolicy.json")
	if len(errs) > 0 {
		t.Fatalf("failed to read the default policy file: %+v", errs)
	}
	deny, ok := defaults["deny"].([]any)
	if !ok || len(deny) == 0 {
		t.Fatalf("the default deny list is empty: %+v", defaults)
	}
	found := false
	for _, entry := range deny {
		if entry == "rm -rf" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the default deny list does not contain rm -rf: %+v", deny)
	}
}
