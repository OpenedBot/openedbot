// Package term decides whether ANSI colour escapes may be written to a
// stream and renders the styled text and progress bar that edge-setup
// prints for a human at a terminal. It never colours anything by itself:
// callers build the decision once (Detect) and pass the resulting Color
// down to whatever prints the line.
package term

import (
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"
)

// Color renders styled text, or leaves it untouched when colour output is
// disabled. The zero value is disabled, so an Env built without going
// through Detect (tests, placeholders) never emits an escape sequence.
type Color struct {
	enabled bool
}

// Detect resolves whether colour output should be enabled for w. Priority,
// highest first: an explicit --no-color flag (forceOff) always wins;
// EDGE_SETUP_COLOR=always|never overrides everything else (the pre-rename
// HERMES_SETUP_COLOR is still honoured when the new name is unset); NO_COLOR
// (https://no-color.org, any value) and TERM=dumb disable colour; otherwise
// colour is enabled only when w is a terminal.
func Detect(w io.Writer, forceOff bool) Color {
	if forceOff {
		return Color{}
	}
	switch strings.ToLower(strings.TrimSpace(getenvFallback("EDGE_SETUP_COLOR", "HERMES_SETUP_COLOR"))) {
	case "always":
		return Color{enabled: true}
	case "never":
		return Color{}
	}
	if _, set := os.LookupEnv("NO_COLOR"); set {
		return Color{}
	}
	if os.Getenv("TERM") == "dumb" {
		return Color{}
	}
	return Color{enabled: isTerminal(w)}
}

// getenvFallback reads name and returns it when set (including empty), or
// falls back to legacy when name is entirely unset: a host or CI job that
// still exports the pre-rename variable keeps working after the rename.
func getenvFallback(name, legacy string) string {
	if v, set := os.LookupEnv(name); set {
		return v
	}
	return os.Getenv(legacy)
}

// isTerminal reports whether w is a terminal file descriptor: an *os.File, or
// a wrapper that exposes the descriptor it writes to (the install journal's
// tee). Any other writer (a bytes.Buffer in tests, a log file) is never a
// terminal.
func isTerminal(w io.Writer) bool {
	f, ok := w.(interface{ Fd() uintptr })
	if !ok {
		return false
	}
	return term.IsTerminal(int(f.Fd()))
}

// Enabled reports whether c renders ANSI escapes.
func (c Color) Enabled() bool { return c.enabled }

const (
	ansiReset  = "\x1b[0m"
	ansiBold   = "\x1b[1m"
	ansiDim    = "\x1b[2m"
	ansiRed    = "\x1b[31m"
	ansiGreen  = "\x1b[32m"
	ansiYellow = "\x1b[33m"
	ansiCyan   = "\x1b[36m"
)

func (c Color) wrap(code, s string) string {
	if !c.enabled || s == "" {
		return s
	}
	return code + s + ansiReset
}

// Bold renders s in bold when colour is enabled (used for check/verb names).
func (c Color) Bold(s string) string { return c.wrap(ansiBold, s) }

// Dim renders s dimmed when colour is enabled (used for UNKNOWN, hints, the
// "(read-only)" suffix).
func (c Color) Dim(s string) string { return c.wrap(ansiDim, s) }

// Red renders s in red when colour is enabled (FAIL, false, errors).
func (c Color) Red(s string) string { return c.wrap(ansiRed, s) }

// Green renders s in green when colour is enabled (PASS, true, success).
func (c Color) Green(s string) string { return c.wrap(ansiGreen, s) }

// Yellow renders s in yellow when colour is enabled (WARN).
func (c Color) Yellow(s string) string { return c.wrap(ansiYellow, s) }

// Cyan renders s in cyan when colour is enabled (progress bar, phase markers).
func (c Color) Cyan(s string) string { return c.wrap(ansiCyan, s) }

// ProgressBar renders phase progress for `up`: a single line redrawn in
// place with \r on a terminal, or one plain line per step when the output
// is not a terminal (piped, logged, --detach), so it is always safe to use
// regardless of where stdout goes.
type ProgressBar struct {
	// W is the destination.
	W io.Writer
	// Color styles the bar; the zero value never emits escapes.
	Color Color
	// TTY selects the redrawn-line rendering. NewProgressBar resolves it
	// from W; tests may override it directly to exercise both renderings
	// without a real terminal.
	TTY bool
	// Width is the bar width in columns.
	Width int
	// Total is the number of steps the bar represents. Zero disables
	// percentage rendering (Step still prints the label).
	Total int

	done int
}

// NewProgressBar builds a bar of total steps writing to w, styled with c.
func NewProgressBar(w io.Writer, c Color, total int) *ProgressBar {
	return &ProgressBar{W: w, Color: c, TTY: isTerminal(w), Width: 32, Total: total}
}

// Step advances the bar by one step and renders label as the current phase.
func (p *ProgressBar) Step(label string) {
	if p.done < p.Total {
		p.done++
	}
	p.render(label)
}

// Percent returns the current completion percentage (0-100).
func (p *ProgressBar) Percent() int {
	if p.Total <= 0 {
		return 100
	}
	pct := p.done * 100 / p.Total
	if pct > 100 {
		pct = 100
	}
	return pct
}

func (p *ProgressBar) render(label string) {
	pct := p.Percent()
	if p.TTY {
		bar := barGauge(p.Width, pct)
		fmt.Fprintf(p.W, "\r%s %3d%% %s\x1b[K", p.Color.Cyan(bar), pct, label)
		return
	}
	fmt.Fprintf(p.W, "[%3d%%] %s\n", pct, label)
}

// Finish completes the bar. On a terminal it moves past the redrawn line;
// off a terminal, every step already ended its own line, so this is a
// no-op.
func (p *ProgressBar) Finish() {
	if p.TTY {
		fmt.Fprintln(p.W)
	}
}

// barGauge renders a fixed-width [====----] gauge for pct (0-100).
func barGauge(width, pct int) string {
	if width <= 0 {
		return ""
	}
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	filled := width * pct / 100
	return "[" + strings.Repeat("=", filled) + strings.Repeat("-", width-filled) + "]"
}
