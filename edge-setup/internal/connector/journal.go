package connector

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Journal bounds, from the wire contract.
const (
	JournalMaxEvents = 10000
	JournalMaxBytes  = 50 << 20
	JournalRetention = 7 * 24 * time.Hour
)

var runIDRe = regexp.MustCompile(`^[A-Za-z0-9._~-]{1,128}$`)

// Entry is one journaled SSE event.
type Entry struct {
	Seq   uint64 `json:"seq"`
	TS    int64  `json:"ts"`
	Event string `json:"event"`
}

// Journal stores events per run under a state directory and serves replays
// by sequence. Files are append-only JSON lines.
type Journal struct {
	Dir string
	mu  sync.Mutex
	// live holds the open runs: subscribers waiting for new events.
	live map[string]*runState
}

type runState struct {
	seq       uint64
	bytes     int64
	terminal  bool
	truncated bool
	waiters   []chan struct{}
}

// NewJournal opens or creates the directory.
func NewJournal(dir string) (*Journal, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Journal{Dir: dir, live: map[string]*runState{}}, nil
}

func (j *Journal) path(runID string) (string, error) {
	if !runIDRe.MatchString(runID) {
		return "", fmt.Errorf("invalid run id %q", runID)
	}
	return filepath.Join(j.Dir, runID+".jsonl"), nil
}

func (j *Journal) state(runID string) *runState {
	s, ok := j.live[runID]
	if !ok {
		s = &runState{}
		if entries, err := j.readAll(runID); err == nil && len(entries) > 0 {
			s.seq = entries[len(entries)-1].Seq
			// Replay what Append tracked: the terminal flag, from the same
			// IsTerminal the caller feeds it, and the bytes the size cap counts.
			// Without them a restart leaves finished runs unswept forever.
			for _, e := range entries {
				line, _ := json.Marshal(e)
				s.bytes += int64(len(line)) + 1
				if IsTerminal(e.Event) {
					s.terminal = true
				}
			}
		}
		j.live[runID] = s
	}
	return s
}

// Append records an event and wakes replay subscribers. It returns the
// sequence, or (0, false) when the journal is truncated.
func (j *Journal) Append(runID, event string, terminal bool) (uint64, bool, error) {
	p, err := j.path(runID)
	if err != nil {
		return 0, false, err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	s := j.state(runID)
	if s.truncated {
		return 0, false, nil
	}
	line, _ := json.Marshal(Entry{Seq: s.seq + 1, TS: time.Now().Unix(), Event: event})
	if s.seq+1 > JournalMaxEvents || s.bytes+int64(len(line))+1 > JournalMaxBytes {
		s.truncated = true
		j.wake(s)
		return 0, false, nil
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return 0, false, err
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		_ = f.Close()
		return 0, false, err
	}
	if err := f.Close(); err != nil {
		return 0, false, err
	}
	s.seq++
	s.bytes += int64(len(line)) + 1
	if terminal {
		s.terminal = true
	}
	j.wake(s)
	return s.seq, true, nil
}

func (j *Journal) wake(s *runState) {
	for _, w := range s.waiters {
		close(w)
	}
	s.waiters = nil
}

// MarkTerminal flags the run as finished without appending.
func (j *Journal) MarkTerminal(runID string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	s := j.state(runID)
	s.terminal = true
	j.wake(s)
}

// Status reports the run's journal state.
type Status struct {
	Seq       uint64
	Terminal  bool
	Truncated bool
	Exists    bool
}

// Status returns the current state of a run.
func (j *Journal) Status(runID string) Status {
	j.mu.Lock()
	defer j.mu.Unlock()
	p, err := j.path(runID)
	if err != nil {
		return Status{}
	}
	_, statErr := os.Stat(p)
	s := j.state(runID)
	return Status{Seq: s.seq, Terminal: s.terminal, Truncated: s.truncated, Exists: statErr == nil || s.seq > 0}
}

// readAll reads the file; a missing file is an empty journal.
func (j *Journal) readAll(runID string) ([]Entry, error) {
	p, err := j.path(runID)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []Entry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		var e Entry
		if json.Unmarshal(sc.Bytes(), &e) == nil {
			out = append(out, e)
		}
	}
	return out, sc.Err()
}

// After returns entries with seq > since.
func (j *Journal) After(runID string, since uint64) ([]Entry, error) {
	all, err := j.readAll(runID)
	if err != nil {
		return nil, err
	}
	var out []Entry
	for _, e := range all {
		if e.Seq > since {
			out = append(out, e)
		}
	}
	return out, nil
}

// Wait blocks until an event after `since` exists, the run is terminal or
// truncated, or the channel `done` closes. It returns true when there may
// be new entries.
func (j *Journal) Wait(runID string, since uint64, done <-chan struct{}) bool {
	j.mu.Lock()
	s := j.state(runID)
	if s.seq > since || s.terminal || s.truncated {
		j.mu.Unlock()
		return s.seq > since
	}
	w := make(chan struct{})
	s.waiters = append(s.waiters, w)
	j.mu.Unlock()
	select {
	case <-w:
		return true
	case <-done:
		return false
	}
}

// Sweep removes journals of terminal runs older than the retention. A run
// that has not reached a terminal event is kept whatever its mtime: the
// contract is "7 days after the terminal event", and a long run would
// otherwise be swept from under itself while still streaming.
func (j *Journal) Sweep(now time.Time) error {
	entries, err := os.ReadDir(j.Dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		runID := strings.TrimSuffix(e.Name(), ".jsonl")
		if !j.Status(runID).Terminal {
			continue
		}
		if now.Sub(info.ModTime()) > JournalRetention {
			_ = os.Remove(filepath.Join(j.Dir, e.Name()))
			j.mu.Lock()
			delete(j.live, runID)
			j.mu.Unlock()
		}
	}
	return nil
}

// SSEFrame renders one journal entry as an SSE frame with its sequence id.
func SSEFrame(e Entry) []byte {
	// The stored event is the raw SSE block minus its id line.
	body := strings.TrimRight(e.Event, "\n")
	return []byte(fmt.Sprintf("id: %d\n%s\n\n", e.Seq, body))
}

// ParseSSEBlocks splits a raw SSE stream into blocks (without trailing
// blank line), keeping `event:`/`data:` lines and dropping `id:`/comments.
func ParseSSEBlocks(raw string) []string {
	var out []string
	for _, block := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n\n") {
		var keep []string
		for _, line := range strings.Split(block, "\n") {
			if line == "" || strings.HasPrefix(line, ":") || strings.HasPrefix(line, "id:") {
				continue
			}
			keep = append(keep, line)
		}
		if len(keep) > 0 {
			out = append(out, strings.Join(keep, "\n"))
		}
	}
	return out
}

// ActiveRuns counts the journaled runs of dir that look in progress: the file
// changed within window and its last event is not terminal. A run abandoned
// without a terminal event stops counting once window has passed. It reads
// only the tail of each recent file and never fails: an unreadable journal
// counts nothing.
func ActiveRuns(dir string, now time.Time, window time.Duration) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	active := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil || now.Sub(info.ModTime()) > window {
			continue
		}
		last, ok := lastJournalEntry(filepath.Join(dir, e.Name()), info.Size())
		if ok && !IsTerminal(last.Event) {
			active++
		}
	}
	return active
}

// lastJournalEntry decodes the last complete line of a journal file.
func lastJournalEntry(path string, size int64) (Entry, bool) {
	f, err := os.Open(path)
	if err != nil {
		return Entry{}, false
	}
	defer f.Close()
	const tail = 1 << 20
	offset := size - tail
	if offset < 0 {
		offset = 0
	}
	buf := make([]byte, size-offset)
	if _, err := f.ReadAt(buf, offset); err != nil {
		return Entry{}, false
	}
	lines := strings.Split(strings.TrimRight(string(buf), "\n"), "\n")
	var e Entry
	if len(lines) == 0 || json.Unmarshal([]byte(lines[len(lines)-1]), &e) != nil {
		return Entry{}, false
	}
	return e, true
}

// IsTerminal reports whether an SSE block carries a terminal run event.
func IsTerminal(block string) bool {
	var event string
	var data []string
	for _, line := range strings.Split(strings.ReplaceAll(block, "\r\n", "\n"), "\n") {
		if value, ok := strings.CutPrefix(line, "event:"); ok {
			event = strings.TrimSpace(value)
		}
		if value, ok := strings.CutPrefix(line, "data:"); ok {
			data = append(data, strings.TrimPrefix(value, " "))
		}
	}
	// Hermes also emits unnamed SSE messages whose JSON envelope owns the
	// event name. Decode the top-level field rather than searching payload text.
	if event == "" || event == "message" {
		var envelope struct {
			Event string `json:"event"`
		}
		if json.Unmarshal([]byte(strings.Join(data, "\n")), &envelope) == nil {
			event = envelope.Event
		}
	}
	switch event {
	case "run.completed", "run.error", "run.failed", "run.cancelled", "run.canceled", "run.stopped":
		return true
	}
	return false
}
