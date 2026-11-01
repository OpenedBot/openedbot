package commands

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestFinishSummarySaysRolledBackOnARollback(t *testing.T) {
	if got, want := finishSummary("v0.0.3", "v0.0.4", "0123456789ab", false), "upgraded edge-setup v0.0.3 -> v0.0.4 (sha256 0123456789ab)"; got != want {
		t.Fatalf("upgrade summary = %q, want %q", got, want)
	}
	got := finishSummary("v0.0.5", "v0.0.4", "0123456789ab", true)
	if want := "rolled back edge-setup v0.0.5 -> v0.0.4 (sha256 0123456789ab)"; got != want {
		t.Fatalf("rollback summary = %q, want %q", got, want)
	}
	if strings.Contains(got, "upgraded") {
		t.Fatalf("rollback summary says upgraded: %q", got)
	}
}

func TestFinishEnvCarriesTheModeOnlyForARollback(t *testing.T) {
	base := []string{"PATH=/usr/bin", finishModeEnv + "=" + finishModeRollback, "LANG=C"}
	forward := finishEnv(base, false)
	if slices.ContainsFunc(forward, func(kv string) bool { return strings.HasPrefix(kv, finishModeEnv+"=") }) {
		t.Fatalf("an inherited mode reaches a forward finish: %v", forward)
	}
	if !slices.Contains(forward, "PATH=/usr/bin") || !slices.Contains(forward, "LANG=C") {
		t.Fatalf("environment not kept: %v", forward)
	}
	back := finishEnv([]string{"PATH=/usr/bin"}, true)
	if !slices.Contains(back, finishModeEnv+"="+finishModeRollback) {
		t.Fatalf("rollback mode missing: %v", back)
	}
}

// The re-executed finish step receives the mode: a stand-in for the installed
// binary records its arguments and environment.
func TestFinishCommandPassesTheRollbackMode(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	out := filepath.Join(dir, "out")
	stub := filepath.Join(dir, "edge-setup")
	script := "#!/bin/sh\necho \"$* mode=${" + finishModeEnv + ":-}\" > " + out + "\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		rollback bool
		want     string
	}{
		{false, "upgrade --yes --finish --previous v0.0.4 mode="},
		{true, "upgrade --yes --finish --previous v0.0.5 mode=rollback"},
	} {
		previous := "v0.0.4"
		if tc.rollback {
			previous = "v0.0.5"
		}
		cmd := finishCommand(t.Context(), stub, previous, tc.rollback)
		if err := cmd.Run(); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(out)
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(string(got)) != tc.want {
			t.Fatalf("finish ran as %q, want %q", strings.TrimSpace(string(got)), tc.want)
		}
	}
}
