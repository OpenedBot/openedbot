package main

import (
	"bytes"
	"errors"
	"reflect"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

func TestMacReexecUsesCanonicalPathForAliasesAndIdentityCommands(t *testing.T) {
	p, _ := layout.ConnectorPaths("darwin", "/Users/fixture")
	for _, tc := range []struct {
		name, command, self string
		same, reexec        bool
	}{
		{"canonical link", "link", p.ExecutablePath, true, false},
		{"link via alias", "link", "/Users/fixture/.local/bin/edge-setup", true, true},
		{"upgrade via alias", "upgrade", "/Users/fixture/.local/bin/edge-setup", true, true},
		{"reset via alias", "reset", "/Users/fixture/.local/bin/edge-setup", true, true},
		{"status via alias", "status", "/Users/fixture/.local/bin/edge-setup", true, true},
		{"downloaded link", "link", "/tmp/edge-setup", false, true},
		{"downloaded upgrade", "upgrade", "/tmp/edge-setup", false, true},
		{"downloaded up retains new code", "up", "/tmp/edge-setup", false, false},
		{"downloaded diagnosis retains new code", "doctor", "/tmp/edge-setup", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			args := []string{tc.command, "--no-color"}
			e := macReexecEnv{home: func() (string, error) { return "/Users/fixture", nil }, executable: func() (string, error) { return tc.self, nil },
				present: func(path string) (bool, error) {
					if path != p.ExecutablePath {
						t.Fatal("unbounded executable path")
					}
					return true, nil
				},
				sameFile: func(string, string) (bool, error) { return tc.same, nil }, stderr: &bytes.Buffer{},
				run: func(path string, got []string) error {
					calls++
					if path != p.ExecutablePath || !reflect.DeepEqual(got, args) {
						t.Fatal("reexec changed argv or selected another image")
					}
					return nil
				},
			}
			code, ran := reexecMacWith(args, e)
			if code != cli.ExitOK || ran != tc.reexec || (calls != 0) != tc.reexec {
				t.Fatalf("code=%d ran=%v calls=%d", code, ran, calls)
			}
		})
	}
}

func TestMacReexecDoesNotExecuteMissingOrUnsafeTarget(t *testing.T) {
	for _, bad := range []error{nil, errors.New("unsafe private executable")} {
		e := macReexecEnv{home: func() (string, error) { return "/Users/fixture", nil }, present: func(string) (bool, error) { return false, bad },
			executable: func() (string, error) { t.Fatal("unsafe target reached source inspection"); return "", nil },
			run:        func(string, []string) error { t.Fatal("unsafe target executed"); return nil },
		}
		if _, ran := reexecMacWith([]string{"upgrade", "--yes"}, e); ran {
			t.Fatal("unsafe target was reexecuted")
		}
	}
}

func TestMacReexecReportsExecutionFailureWithoutRawTranscript(t *testing.T) {
	errout := &bytes.Buffer{}
	e := macReexecEnv{home: func() (string, error) { return "/Users/fixture", nil }, executable: func() (string, error) { return "/tmp/edge-setup", nil },
		present: func(string) (bool, error) { return true, nil }, sameFile: func(string, string) (bool, error) { return false, nil },
		run: func(string, []string) error { return errors.New("fixture private transcript") }, stderr: errout,
	}
	code, ran := reexecMacWith([]string{"link"}, e)
	if code != cli.ExitFailure || !ran || bytes.Contains(errout.Bytes(), []byte("fixture private transcript")) {
		t.Fatal("reexec failure was not redacted and propagated")
	}
}
