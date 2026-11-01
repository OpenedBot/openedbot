package main

import (
	"bytes"
	"errors"
	"os/exec"
	"strings"
	"syscall"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
)

// baseEnv is a non-root host with sudo available and a known binary path.
func baseEnv(run func(*exec.Cmd) error, stderr *bytes.Buffer) elevateEnv {
	return elevateEnv{
		euid:       1000,
		getenv:     func(string) string { return "" },
		lookPath:   func(string) (string, error) { return "/usr/bin/sudo", nil },
		executable: func() (string, error) { return "/usr/local/sbin/edge-setup", nil },
		run:        run,
		stderr:     stderr,
	}
}

// The re-execution is the one place where the whole argv, secrets included,
// would reach another process. It must carry exactly what was typed, behind
// `--` so a leading dash is never read as a sudo flag, and it must set the
// recursion guard so the child never elevates again.
func TestElevatePassesArgvBehindDoubleDashAndGuardsRecursion(t *testing.T) {
	var got *exec.Cmd
	var errb bytes.Buffer
	code, ran := elevateWith(baseEnv(func(c *exec.Cmd) error { got = c; return nil }, &errb), []string{"link", "--ohb", "https://x", "--yes"})
	if !ran || code != cli.ExitOK {
		t.Fatalf("ran=%v code=%d", ran, code)
	}
	want := []string{"/usr/bin/sudo", "--", "/usr/local/sbin/edge-setup", "link", "--ohb", "https://x", "--yes"}
	if strings.Join(got.Args, " ") != strings.Join(want, " ") {
		t.Fatalf("argv %v, want %v", got.Args, want)
	}
	var guarded bool
	for _, kv := range got.Env {
		if kv == "EDGE_SETUP_NO_SUDO=1" {
			guarded = true
		}
	}
	if !guarded {
		t.Fatal("the child can elevate again: EDGE_SETUP_NO_SUDO is not set")
	}
	if errb.Len() != 0 {
		t.Fatalf("stderr: %q", errb.String())
	}
}

// Root and the guard must not re-execute at all; a host without sudo falls
// through so the command itself refuses with its own message (exit 77).
func TestElevateDeclinesWhenItMust(t *testing.T) {
	cases := map[string]elevateEnv{
		"already root":     {euid: 0, getenv: func(string) string { return "" }},
		"guard set":        {euid: 1000, getenv: func(k string) string { return map[string]string{"EDGE_SETUP_NO_SUDO": "1"}[k] }},
		"legacy guard set": {euid: 1000, getenv: func(k string) string { return map[string]string{"HERMES_SETUP_NO_SUDO": "1"}[k] }},
		"no sudo": {
			euid:     1000,
			getenv:   func(string) string { return "" },
			lookPath: func(string) (string, error) { return "", errors.New("not found") },
		},
		"unknown executable": {
			euid:       1000,
			getenv:     func(string) string { return "" },
			lookPath:   func(string) (string, error) { return "/usr/bin/sudo", nil },
			executable: func() (string, error) { return "", errors.New("unreadable") },
		},
	}
	for name, e := range cases {
		e.run = func(*exec.Cmd) error { t.Fatalf("%s: sudo was executed", name); return nil }
		if code, ran := elevateWith(e, []string{"status"}); ran || code != 0 {
			t.Errorf("%s: ran=%v code=%d", name, ran, code)
		}
	}
}

// The child's exit code is the operator contract: a gate refusing inside
// sudo must still surface as 2, not as a generic failure.
func TestElevatePropagatesTheChildExitCode(t *testing.T) {
	var errb bytes.Buffer
	run := func(*exec.Cmd) error {
		// A real *exec.ExitError needs a finished process: run `false`.
		c := exec.Command("/bin/sh", "-c", "exit 2")
		return c.Run()
	}
	code, ran := elevateWith(baseEnv(run, &errb), []string{"up", "--yes"})
	if !ran || code != cli.ExitRefused {
		t.Fatalf("ran=%v code=%d, want %d", ran, code, cli.ExitRefused)
	}
	if errb.Len() != 0 {
		t.Fatalf("an exit code is not an error to report: %q", errb.String())
	}
}

// A sudo that cannot start at all is a failure to report, not a silent 0.
func TestElevateReportsASudoThatCannotRun(t *testing.T) {
	var errb bytes.Buffer
	code, ran := elevateWith(baseEnv(func(*exec.Cmd) error { return errors.New("permission denied") }, &errb), []string{"status"})
	if !ran || code != cli.ExitFailure {
		t.Fatalf("ran=%v code=%d", ran, code)
	}
	if !strings.Contains(errb.String(), "sudo: permission denied") {
		t.Fatalf("stderr %q", errb.String())
	}
}

func TestTightenUmaskAddsWriteBitsAndKeepsStricter(t *testing.T) {
	previous := syscall.Umask(0)
	defer syscall.Umask(previous)
	for inherited, want := range map[int]int{0o000: 0o022, 0o002: 0o022, 0o022: 0o022, 0o027: 0o027, 0o077: 0o077} {
		syscall.Umask(inherited)
		tightenUmask()
		if got := syscall.Umask(0); got != want {
			t.Errorf("umask %04o became %04o, want %04o", inherited, got, want)
		}
	}
}
