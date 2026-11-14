package cli

import (
	"bytes"
	"strings"
	"testing"
)

func run(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := Run(args, Env{Version: "test", Stdout: &out, Stderr: &errb})
	return code, out.String(), errb.String()
}

func TestVersionAndHelp(t *testing.T) {
	code, out, _ := run(t, "version")
	if code != ExitOK || out != "edge-setup test\n" {
		t.Fatalf("version: code=%d out=%q", code, out)
	}
	code, out, _ = run(t)
	if code != ExitOK || !strings.Contains(out, "usage: edge-setup") {
		t.Fatalf("help: code=%d out=%q", code, out)
	}
	for _, name := range []string{"up", "reset", "verify-access", "link", "credentials", "audit", "doctor", "plan", "detect", "status", "export", "update", "upgrade", "self-verify"} {
		if !strings.Contains(out, "  "+name) {
			t.Errorf("help does not list %q", name)
		}
	}
}

func TestVersionNameFollowsTheInvokedFileName(t *testing.T) {
	for arg0, want := range map[string]string{
		"/usr/local/lib/hermes-setup/edge-setup":              "edge-setup",
		"/usr/local/lib/hermes-setup/.hermes-setup.candidate": "hermes-setup",
		"/usr/local/bin/hermes-setup":                         "hermes-setup",
		"/tmp/edge-setup_linux_amd64":                         "edge-setup",
		"edge-setup":                                          "edge-setup",
	} {
		if got := VersionName(arg0); got != want {
			t.Errorf("VersionName(%q) = %q, want %q", arg0, got, want)
		}
	}
}

func TestElevationOnlyForRootCommands(t *testing.T) {
	for _, free := range []string{"help", "version", "self-verify", "internal"} {
		if NeedsRoot(free) {
			t.Errorf("%s must run without root", free)
		}
	}
	for _, root := range []string{"status", "up", "upgrade", "doctor", "plan", "detect"} {
		if !NeedsRoot(root) {
			t.Errorf("%s must be elevated", root)
		}
	}
	var got []string
	env := Env{Version: "test", Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}, Elevate: func(args []string) (int, bool) {
		got = append([]string{}, args...)
		return 42, true
	}}
	if code := Run([]string{"status", "--json"}, env); code != 42 || strings.Join(got, " ") != "status --json" {
		t.Fatalf("status must be elevated with its full argv: code=%d got=%v", code, got)
	}
	got = nil
	if code := Run([]string{"version"}, env); code != ExitOK || got != nil {
		t.Fatalf("version must never be elevated: code=%d got=%v", code, got)
	}
	env.Elevate = func([]string) (int, bool) { return 0, false }
	if code := Run([]string{"up", "--yes"}, env); code != ExitNotImpl {
		t.Fatalf("when elevation declines, the command itself runs: code=%d", code)
	}
}

func TestUnknownCommandIsUsageError(t *testing.T) {
	code, _, errb := run(t, "bogus")
	if code != ExitUsage || !strings.Contains(errb, "unknown command") {
		t.Fatalf("code=%d err=%q", code, errb)
	}
}

func TestPlaceholdersMutateNothing(t *testing.T) {
	code, _, errb := run(t, "up", "--yes")
	if code != ExitNotImpl || !strings.Contains(errb, "not implemented") {
		t.Fatalf("code=%d err=%q", code, errb)
	}
}

func TestSecretFlagsAreRefused(t *testing.T) {
	for _, argv := range [][]string{
		{"--token", "abc"}, {"--token=abc"}, {"--api-key=x"}, {"--bearer", "x"}, {"--authkey=x"},
	} {
		if msg := RefuseSecretFlags(argv); msg == "" {
			t.Errorf("argv %v was not refused", argv)
		}
	}
	if msg := RefuseSecretFlags([]string{"--api-key-file", "/etc/x"}); msg != "" {
		t.Errorf("--api-key-file must be allowed (a path, not a secret): %s", msg)
	}
}

func TestSecretFlagsRefusedBeforeElevation(t *testing.T) {
	elevated := false
	var errb bytes.Buffer
	env := Env{Version: "test", Stdout: &bytes.Buffer{}, Stderr: &errb, Elevate: func([]string) (int, bool) {
		elevated = true
		return 0, true
	}}
	for _, argv := range [][]string{
		{"link", "--token", "x", "--yes"},
		{"up", "--api-key=x"},
		{"upgrade", "--link-token", "x"},
	} {
		errb.Reset()
		if code := Run(argv, env); code != ExitRefused {
			t.Errorf("%v: code=%d, want %d", argv, code, ExitRefused)
		}
		if elevated {
			t.Fatalf("%v: the process was elevated before the secret was refused", argv)
		}
		if !strings.Contains(errb.String(), "never from the command line") {
			t.Errorf("%v: stderr=%q", argv, errb.String())
		}
	}
}

func TestHelpHasNoColorByDefault(t *testing.T) {
	_, out, _ := run(t, "help")
	if strings.Contains(out, "\x1b[") {
		t.Fatalf("help on a non-terminal buffer must never contain ANSI escapes: %q", out)
	}
}

func TestHelpColorForcedByEnv(t *testing.T) {
	t.Setenv("EDGE_SETUP_COLOR", "always")
	_, out, _ := run(t, "help")
	if !strings.Contains(out, "\x1b[") {
		t.Fatal("EDGE_SETUP_COLOR=always must colour help even off a terminal")
	}
	if !strings.Contains(out, "\x1b[2m  (read-only)\x1b[0m") {
		t.Fatalf("the (read-only) suffix must be dim, got %q", out)
	}
}

func TestNoColorFlagOverridesEnvAndIsStrippedFromArgv(t *testing.T) {
	t.Setenv("EDGE_SETUP_COLOR", "always")
	var out bytes.Buffer
	code := Run([]string{"help", "--no-color"}, Env{Version: "test", Stdout: &out, Stderr: &out})
	if code != ExitOK {
		t.Fatalf("code=%d", code)
	}
	if strings.Contains(out.String(), "\x1b[") {
		t.Fatalf("--no-color must win over EDGE_SETUP_COLOR=always: %q", out.String())
	}

	var gotColorEnabled bool
	var gotArgs []string
	Register(Command{Name: "colortest", Summary: "test seam for --no-color plumbing", Run: func(env Env, args []string) int {
		gotColorEnabled = env.Color.Enabled()
		gotArgs = args
		return ExitOK
	}})
	out.Reset()
	code = Run([]string{"colortest", "--no-color", "--flag", "x"}, Env{Version: "test", Stdout: &out, Stderr: &out})
	if code != ExitOK {
		t.Fatalf("code=%d out=%q", code, out.String())
	}
	if gotColorEnabled {
		t.Fatal("--no-color must disable env.Color even with EDGE_SETUP_COLOR=always")
	}
	if strings.Join(gotArgs, " ") != "--flag x" {
		t.Fatalf("--no-color must be stripped before the command sees argv, got %v", gotArgs)
	}
}

func TestJSONFlagCarriesNoANSIEvenWhenColorForced(t *testing.T) {
	t.Setenv("EDGE_SETUP_COLOR", "always")
	var out bytes.Buffer
	Register(Command{Name: "jsontest", Summary: "test seam for --json cleanliness", Run: func(env Env, _ []string) int {
		out2 := env.Stdout
		out2.Write([]byte(`{"ok":true}` + "\n"))
		return ExitOK
	}})
	Run([]string{"jsontest"}, Env{Version: "test", Stdout: &out, Stderr: &out})
	if strings.Contains(out.String(), "\x1b[") {
		t.Fatalf("a command's raw JSON write must never be touched by colour plumbing: %q", out.String())
	}
}
