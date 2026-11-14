// Package journal keeps the install journal: what every command that changes
// the host printed, one JSON line per output line, in a root-only file. It is
// what an operator reads after the fact ("what did up do last Tuesday"), so it
// must never hold a secret: every line goes through Redact first, on top of
// the rule that no command prints one.
package journal

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

// MaxSize is where the journal rotates: the current file becomes Path+".1"
// (replacing the previous one) and a new file starts.
const MaxSize = 1 << 20

// Record is one line of the journal.
type Record struct {
	At      string `json:"at"`
	Command string `json:"cmd"`
	// Event is start, out, err or end.
	Event   string `json:"event"`
	Line    string `json:"line,omitempty"`
	Version string `json:"version,omitempty"`
	Exit    *int   `json:"exit,omitempty"`
}

// Journal appends the records of one command run.
type Journal struct {
	mu      sync.Mutex
	f       *os.File
	command string
	now     func() time.Time
}

// Open appends to path, created 0600 (never through a symlink), and records
// the start of command with its arguments, redacted.
func Open(path, command, version string, args []string) (*Journal, error) {
	if st, err := os.Lstat(path); err == nil && st.Mode().IsRegular() && st.Size() >= MaxSize {
		if err := os.Rename(path, path+".1"); err != nil {
			return nil, fmt.Errorf("journal: rotate: %w", err)
		}
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, fmt.Errorf("journal: %w", err)
	}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0o077 != 0 {
		_ = f.Close()
		return nil, errors.New("journal: " + path + " must be a regular owner-only file")
	}
	j := &Journal{f: f, command: command, now: time.Now}
	line := strings.TrimSpace(command + " " + strings.Join(args, " "))
	j.write(Record{Event: "start", Line: line, Version: version})
	return j, nil
}

// Tee returns a writer that writes to w and records each complete line under
// event (out or err). When w is a file (a terminal), the tee exposes its
// descriptor, so terminal detection still sees it.
func (j *Journal) Tee(w io.Writer, event string) io.Writer {
	t := &tee{w: w, j: j, event: event}
	if f, ok := w.(*os.File); ok {
		return fileTee{tee: t, f: f}
	}
	return t
}

type fileTee struct {
	*tee
	f *os.File
}

func (t fileTee) Fd() uintptr { return t.f.Fd() }

// Close records the exit code and closes the file.
func (j *Journal) Close(code int) {
	j.write(Record{Event: "end", Exit: &code})
	j.mu.Lock()
	defer j.mu.Unlock()
	_ = j.f.Close()
}

func (j *Journal) write(r Record) {
	r.At = j.now().UTC().Format(time.RFC3339)
	r.Command = j.command
	r.Line = Redact(r.Line)
	data, err := json.Marshal(r)
	if err != nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	// Best effort: a full disk must not fail the command it journals.
	_, _ = j.f.Write(append(data, '\n'))
}

type tee struct {
	w     io.Writer
	j     *Journal
	event string
	mu    sync.Mutex
	buf   []byte
}

func (t *tee) Write(p []byte) (int, error) {
	n, err := t.w.Write(p)
	t.mu.Lock()
	t.buf = append(t.buf, p[:n]...)
	for {
		i := bytes.IndexByte(t.buf, '\n')
		if i < 0 {
			break
		}
		line := string(t.buf[:i])
		t.buf = t.buf[i+1:]
		// A progress bar redraws its line after \r: keep the last drawing.
		if r := strings.LastIndexByte(line, '\r'); r >= 0 {
			line = line[r+1:]
		}
		if line = strings.TrimSpace(ansi.ReplaceAllString(line, "")); line != "" {
			t.j.write(Record{Event: t.event, Line: line})
		}
	}
	t.mu.Unlock()
	return n, err
}

var (
	ansi = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)
	// Ordered: specific shapes first, then any long token.
	redactions = []struct {
		re   *regexp.Regexp
		with string
	}{
		// Authorization values.
		{regexp.MustCompile(`(?i)\b(bearer|basic)\s+[^\s"']+`), "$1 [redacted]"},
		// An enrollment ticket: <uuid>.<secret>.
		{regexp.MustCompile(`\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.[A-Za-z0-9._~+/=-]{8,}`), "[redacted-ticket]"},
		// KEY=value and key: value where the name says secret.
		// The name must end with the word (API_SERVER_KEY=, openai_api_key:),
		// so keyring= or DEVICE_KEY_PATH= keep their value.
		{regexp.MustCompile(`(?i)\b([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|BEARER))(\s*[=:]\s*)[^\s"',]+`), "$1$3[redacted]"},
		// URL credentials.
		{regexp.MustCompile(`(https?://)[^/\s:@]+:[^/\s@]+@`), "$1[redacted]@"},
		// Any long run of token characters: keys, tokens, seeds, digests. No
		// '/' or '-', so paths and unit names survive; a key cut by '-' still
		// has its long random tail masked.
		{regexp.MustCompile(`[A-Za-z0-9_+=]{32,}`), "[redacted]"},
	}
)

// Redact masks what can be a secret in s.
func Redact(s string) string {
	for _, r := range redactions {
		s = r.re.ReplaceAllString(s, r.with)
	}
	return s
}
