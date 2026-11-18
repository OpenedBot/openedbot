package agents

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFindLooksOnlyAtExecutablesInAbsoluteDirs(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "grok"), []byte("#!/bin/sh\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "gemini"), []byte("not executable"), 0600); err != nil {
		t.Fatal(err)
	}
	path := strings.Join([]string{"relative", dir}, string(os.PathListSeparator))
	if got, err := Find("grok", path); err != nil || got != filepath.Join(dir, "grok") {
		t.Fatalf("grok: %q %v", got, err)
	}
	if _, err := Find("gemini", path); err != ErrNotFound {
		t.Fatalf("gemini: %v", err)
	}
}

func TestKnownEnginesAreLocalAndUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, a := range Known {
		if !strings.HasPrefix(a.Engine, "local:") || seen[a.Engine] || seen[a.Provider] {
			t.Fatalf("engine %q or provider %q", a.Engine, a.Provider)
		}
		seen[a.Engine], seen[a.Provider] = true, true
	}
}

func TestEnvironmentPassesOnlyNamedVariables(t *testing.T) {
	t.Setenv("CODEX_HOME", "/codex")
	t.Setenv("OPENAI_API_KEY", "secret")
	env := strings.Join(Known[0].Environment("/home/me", "/bin"), "\n")
	if !strings.Contains(env, "CODEX_HOME=/codex") || strings.Contains(env, "OPENAI_API_KEY") {
		t.Fatalf("env: %s", env)
	}
}
