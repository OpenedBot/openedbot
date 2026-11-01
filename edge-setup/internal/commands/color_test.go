package commands

import (
	"bytes"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/audit"
	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/term"
)

func off() term.Color { return term.Color{} }

// forced returns a Color as if EDGE_SETUP_COLOR=always had resolved it,
// without touching the environment (term.Detect is exercised in its own
// package's tests).
func forced(t *testing.T) term.Color {
	t.Helper()
	t.Setenv("EDGE_SETUP_COLOR", "always")
	var sink strings.Builder
	return term.Detect(&sink, false)
}

func TestAuditLineUncoloredIsByteIdenticalToPlain(t *testing.T) {
	r := audit.Result{ID: "ssh", Status: audit.Pass, Message: "key-only, root disabled"}
	got := auditLine(off(), r)
	want := "[PASS   ] ssh                    key-only, root disabled"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestAuditLineColoredKeepsWordsAndAddsEscapes(t *testing.T) {
	c := forced(t)
	r := audit.Result{ID: "ssh", Status: audit.Warn, Message: "listening_ports drifted"}
	got := auditLine(c, r)
	if !strings.Contains(got, "\x1b[33m") { // yellow for WARN
		t.Fatalf("WARN must be yellow: %q", got)
	}
	if !strings.Contains(got, "ssh") || !strings.Contains(got, "listening_ports drifted") {
		t.Fatalf("colouring must not drop or reorder words: %q", got)
	}
}

func TestAuditLineStatusColors(t *testing.T) {
	c := forced(t)
	cases := []struct {
		s    audit.Status
		code string
	}{
		{audit.Pass, "\x1b[32m"},
		{audit.Warn, "\x1b[33m"},
		{audit.Fail, "\x1b[31m"},
		{audit.Unknown, "\x1b[2m"},
	}
	for _, tc := range cases {
		got := auditLine(c, audit.Result{ID: "x", Status: tc.s})
		if !strings.Contains(got, tc.code) {
			t.Errorf("status %s: expected %q in %q", tc.s, tc.code, got)
		}
	}
}

func TestAuditSummaryLineUncoloredIsByteIdenticalToPlain(t *testing.T) {
	got := auditSummaryLine(off(), 20, 1, 0, 0, 4, "/var/lib/hermes/audit/report.json")
	want := "summary: pass=20 warn=1 fail=0 unknown=0 skip=4: report /var/lib/hermes/audit/report.json (root-only)"
	if got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
}

func TestAuditSummaryLineColored(t *testing.T) {
	c := forced(t)
	got := auditSummaryLine(c, 20, 1, 0, 0, 4, "report.json")
	for _, want := range []string{"\x1b[32mpass=20\x1b[0m", "\x1b[33mwarn=1\x1b[0m", "\x1b[31mfail=0\x1b[0m", "\x1b[2munknown=0\x1b[0m"} {
		if !strings.Contains(got, want) {
			t.Errorf("expected %q in %q", want, got)
		}
	}
}

func TestStatusLabelPadding(t *testing.T) {
	if got := statusLabel(off(), audit.Fail, 7); got != "FAIL   " {
		t.Fatalf("padding must be preserved with colour off: %q", got)
	}
	c := forced(t)
	got := statusLabel(c, audit.Fail, 7)
	if !strings.Contains(got, "FAIL   ") {
		t.Fatalf("padding must survive colouring: %q", got)
	}
}

func TestBoolLabel(t *testing.T) {
	if got := boolLabel(off(), true); got != "true" {
		t.Fatalf("got %q", got)
	}
	if got := boolLabel(off(), false); got != "false" {
		t.Fatalf("got %q", got)
	}
	c := forced(t)
	if got := boolLabel(c, true); !strings.Contains(got, "\x1b[32m") {
		t.Fatalf("true must be green: %q", got)
	}
	if got := boolLabel(c, false); !strings.Contains(got, "\x1b[31m") {
		t.Fatalf("false must be red: %q", got)
	}
}

func TestPhaseTag(t *testing.T) {
	cases := []struct {
		line    string
		tag     string
		matches bool
	}{
		{"P1 self-install → /usr/local/lib", "P1", true},
		{"P3/P5 Hermes runtime 1.2.3", "P3/P5", true},
		{"P4/P6 optional sandbox not selected", "P4/P6", true},
		{"P9 finalize", "P9", true},
		{"reachability connector", "", false},
		{"P9000 not a phase", "", false},
	}
	for _, tc := range cases {
		tag, ok := phaseTag(tc.line)
		if ok != tc.matches || (ok && tag != tc.tag) {
			t.Errorf("phaseTag(%q) = (%q, %v), want (%q, %v)", tc.line, tag, ok, tc.tag, tc.matches)
		}
	}
}

func TestColorizePhaseLineUncoloredIsIdentity(t *testing.T) {
	for _, line := range []string{
		"P1 self-install → /usr/local/lib/hermes-setup",
		"reachability connector",
		"writes        /etc/hermes/config.json (no secret)",
	} {
		if got := colorizePhaseLine(off(), line); got != line {
			t.Fatalf("colour off must be the identity function: got %q, want %q", got, line)
		}
	}
}

func TestColorizePhaseLineColorsOnlyTheTag(t *testing.T) {
	c := forced(t)
	got := colorizePhaseLine(c, "P7 harden (ports [22 443])")
	if !strings.HasPrefix(got, "\x1b[1m\x1b[36mP7\x1b[0m\x1b[0m") {
		t.Fatalf("expected a bold-cyan P7 tag, got %q", got)
	}
	if !strings.HasSuffix(got, " harden (ports [22 443])") {
		t.Fatalf("the rest of the line must be untouched: %q", got)
	}
	if got2 := colorizePhaseLine(c, "reachability connector"); got2 != "reachability connector" {
		t.Fatalf("a line without a phase tag must not be touched: %q", got2)
	}
}

func TestPhaseTagsMatchesUpBranches(t *testing.T) {
	full := state.Features{Sandbox: true, SSHHardening: true}
	if got := phaseTags(full, false, true); len(got) != 7 {
		t.Fatalf("fresh host, sandboxed, ssh hardening, not resumed (P9 runs later via verify-access): got %v", got)
	}
	minimal := state.Features{}
	if got := phaseTags(minimal, false, false); len(got) != 7 {
		t.Fatalf("minimal mode finalizes in the same run: got %v", got)
	}
	resumedAfterVerifyAccess := state.Features{Sandbox: true, SSHHardening: true}
	if got := phaseTags(resumedAfterVerifyAccess, true, false); len(got) != 8 {
		t.Fatalf("resumed at P8 after verify-access committed P7: got %v", got)
	}
	withJournal := state.Features{PersistentJournal: true}
	if got := phaseTags(withJournal, false, false); len(got) != 8 {
		t.Fatalf("persistent journald adds its own progress step: got %v", got)
	}
}

func TestDetectJSONHasNoANSIEvenWithColorForced(t *testing.T) {
	t.Setenv("EDGE_SETUP_COLOR", "always")
	var out, errb bytes.Buffer
	env := cli.Env{Version: "test", Stdout: &out, Stderr: &errb, Color: forced(t)}
	code := runDetect(env, []string{"--json"})
	if code != cli.ExitOK && code != cli.ExitFailure {
		t.Fatalf("unexpected code=%d err=%q", code, errb.String())
	}
	if strings.Contains(out.String(), "\x1b[") {
		t.Fatalf("detect --json must never contain an ANSI escape, even with colour forced: %q", out.String())
	}
}
