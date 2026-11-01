package operator

import (
	"regexp"
	"strings"
)

// loginParser extracts the verification URL and the user code from the
// upstream CLI output (`hermes auth add <provider> --no-browser`). The
// upstream prints, with ANSI colours:
//
//  1. Open this URL in your browser:
//     https://auth.openai.com/codex/device
//  2. Enter this code:
//     ABCD-EFGH
//
// Other device-code providers print variants (« enter code: X »). The parser
// takes the first URL and the first code-looking token that follows a line
// mentioning a code.
type loginParser struct {
	uri, code string
	wantCode  bool
	tail      []string
}

var (
	ansiRe    = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
	urlRe     = regexp.MustCompile(`https?://[^\s"'<>]+`)
	codeRe    = regexp.MustCompile(`\b[A-Z0-9]{4,10}(?:-[A-Z0-9]{4,10})+\b|\b[A-Z0-9]{6,12}\b`)
	codeLabel = regexp.MustCompile(`(?i)\bcode\b`)
)

func (p *loginParser) feed(raw string) {
	line := strings.TrimSpace(ansiRe.ReplaceAllString(raw, ""))
	if line != "" {
		p.tail = append(p.tail, line)
		if len(p.tail) > 8 {
			p.tail = p.tail[1:]
		}
	}
	if p.uri == "" {
		if m := urlRe.FindString(line); m != "" {
			p.uri = strings.TrimRight(m, ".,;:)")
		}
	}
	if p.code != "" {
		return
	}
	if codeLabel.MatchString(line) {
		// « Enter this code: ABCD-EFGH » on one line, or the code on the next.
		after := line
		if i := strings.LastIndex(strings.ToLower(line), "code"); i >= 0 {
			after = line[i+4:]
		}
		if m := codeRe.FindString(after); m != "" && !strings.Contains(after, "://") {
			p.code = m
			return
		}
		p.wantCode = true
		return
	}
	if p.wantCode && line != "" {
		if m := codeRe.FindString(line); m != "" && !strings.Contains(line, "://") {
			p.code = m
		}
		p.wantCode = false
	}
}

// lastError renders the process failure without leaking anything but the
// CLI's own last words.
func (p *loginParser) lastError(err error) string {
	for i := len(p.tail) - 1; i >= 0; i-- {
		if l := p.tail[i]; l != "" && !strings.Contains(l, "://") {
			return l
		}
	}
	return err.Error()
}
