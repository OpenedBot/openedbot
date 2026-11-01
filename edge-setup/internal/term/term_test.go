package term

import (
	"bytes"
	"strings"
	"testing"
)

func TestDetectDisabledOnNonTTY(t *testing.T) {
	var buf bytes.Buffer
	c := Detect(&buf, false)
	if c.Enabled() {
		t.Fatal("a bytes.Buffer is never a terminal: colour must be off")
	}
	if got := c.Green("x"); got != "x" {
		t.Fatalf("disabled Color must not alter text, got %q", got)
	}
}

func TestDetectNoColorEnv(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	var buf bytes.Buffer
	if Detect(&buf, false).Enabled() {
		t.Fatal("NO_COLOR must disable colour")
	}
}

func TestDetectTermDumb(t *testing.T) {
	t.Setenv("TERM", "dumb")
	var buf bytes.Buffer
	if Detect(&buf, false).Enabled() {
		t.Fatal("TERM=dumb must disable colour")
	}
}

func TestDetectNoColorFlag(t *testing.T) {
	t.Setenv("EDGE_SETUP_COLOR", "always")
	var buf bytes.Buffer
	if Detect(&buf, true).Enabled() {
		t.Fatal("--no-color must win over EDGE_SETUP_COLOR=always")
	}
}

func TestDetectForceAlways(t *testing.T) {
	t.Setenv("EDGE_SETUP_COLOR", "always")
	var buf bytes.Buffer
	if !Detect(&buf, false).Enabled() {
		t.Fatal("EDGE_SETUP_COLOR=always must enable colour even off a terminal")
	}
}

func TestDetectForceNever(t *testing.T) {
	t.Setenv("EDGE_SETUP_COLOR", "never")
	var buf bytes.Buffer
	if Detect(&buf, false).Enabled() {
		t.Fatal("EDGE_SETUP_COLOR=never must disable colour")
	}
}

func TestDetectLegacyColorEnvFallback(t *testing.T) {
	t.Setenv("HERMES_SETUP_COLOR", "always")
	var buf bytes.Buffer
	if !Detect(&buf, false).Enabled() {
		t.Fatal("HERMES_SETUP_COLOR=always must still enable colour when EDGE_SETUP_COLOR is unset")
	}
}

func TestDetectNewColorEnvWinsOverLegacy(t *testing.T) {
	t.Setenv("HERMES_SETUP_COLOR", "always")
	t.Setenv("EDGE_SETUP_COLOR", "never")
	var buf bytes.Buffer
	if Detect(&buf, false).Enabled() {
		t.Fatal("EDGE_SETUP_COLOR=never must win over a legacy HERMES_SETUP_COLOR=always")
	}
}

func TestStylesWrapOnlyWhenEnabled(t *testing.T) {
	off := Color{}
	if off.Green("ok") != "ok" || off.Bold("x") != "x" || off.Dim("x") != "x" || off.Red("x") != "x" || off.Yellow("x") != "x" || off.Cyan("x") != "x" {
		t.Fatal("disabled Color must return the input verbatim")
	}
	on := Color{enabled: true}
	if got := on.Green("ok"); !strings.Contains(got, "ok") || !strings.Contains(got, "\x1b[") {
		t.Fatalf("enabled Color must wrap with an ANSI escape, got %q", got)
	}
	if got := on.Green(""); got != "" {
		t.Fatalf("empty input must stay empty, got %q", got)
	}
}

func TestProgressBarNonTTY(t *testing.T) {
	var buf bytes.Buffer
	pb := NewProgressBar(&buf, Color{}, 4)
	if pb.TTY {
		t.Fatal("a bytes.Buffer is never a terminal")
	}
	pb.Step("P1 self-install")
	pb.Step("P2 base packages")
	pb.Finish()
	out := buf.String()
	if strings.Contains(out, "\r") || strings.Contains(out, "\x1b") {
		t.Fatalf("non-TTY rendering must never contain \\r or ANSI escapes, got %q", out)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected one line per step, got %d: %q", len(lines), out)
	}
	if !strings.Contains(lines[0], " 25%") || !strings.HasSuffix(lines[0], "P1 self-install") {
		t.Fatalf("step 1/4 line: %q", lines[0])
	}
	if !strings.Contains(lines[1], " 50%") {
		t.Fatalf("step 2/4 line: %q", lines[1])
	}
}

func TestProgressBarTTYRendering(t *testing.T) {
	var buf bytes.Buffer
	pb := NewProgressBar(&buf, Color{}, 4)
	pb.TTY = true // force the redrawn-line rendering without a real terminal
	pb.Step("P1")
	out := buf.String()
	if !strings.HasPrefix(out, "\r") {
		t.Fatalf("TTY rendering must start each frame with \\r, got %q", out)
	}
	if !strings.Contains(out, "25%") {
		t.Fatalf("expected 25%% at step 1/4, got %q", out)
	}
	buf.Reset()
	pb.done = 2
	pb.render("P2")
	if !strings.Contains(buf.String(), "50%") {
		t.Fatalf("expected 50%% at step 2/4, got %q", buf.String())
	}
	buf.Reset()
	pb.done = 4
	pb.render("P9")
	if !strings.Contains(buf.String(), "100%") {
		t.Fatalf("expected 100%% at step 4/4, got %q", buf.String())
	}
	pb.Finish()
	if !strings.HasSuffix(buf.String(), "\n") {
		t.Fatal("Finish must end the redrawn line on a TTY")
	}
}

func TestBarGaugeWidth(t *testing.T) {
	if g := barGauge(10, 0); g != "[----------]" {
		t.Fatalf("0%%: %q", g)
	}
	if g := barGauge(10, 50); g != "[=====-----]" {
		t.Fatalf("50%%: %q", g)
	}
	if g := barGauge(10, 100); g != "[==========]" {
		t.Fatalf("100%%: %q", g)
	}
}
