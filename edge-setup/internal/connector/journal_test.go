package connector

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A run is in progress when its journal moved recently and its last event is
// not terminal; an abandoned run stops counting once the window has passed.
func TestActiveRunsCountsRecentUnfinishedJournals(t *testing.T) {
	dir := t.TempDir()
	j, err := NewJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range []struct {
		run, event string
		terminal   bool
	}{
		{"running", "event: message.delta\ndata: {}", false},
		{"finished", "event: message.delta\ndata: {}", false},
		{"finished", "event: run.completed\ndata: {}", true},
		{"abandoned", "event: message.delta\ndata: {}", false},
	} {
		if _, _, err := j.Append(step.run, step.event, step.terminal); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	old := now.Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "abandoned.jsonl"), old, old); err != nil {
		t.Fatal(err)
	}
	if got := ActiveRuns(dir, now, 15*time.Minute); got != 1 {
		t.Fatalf("active runs = %d, want 1", got)
	}
	if got := ActiveRuns(filepath.Join(dir, "absent"), now, time.Minute); got != 0 {
		t.Fatalf("absent directory: %d", got)
	}
}

// A restart empties the in-memory run state, and Sweep must rebuild it from
// the files: a journal that holds a terminal event goes once it is older than
// the retention, one that never got a terminal event stays whatever its age.
func TestSweepRemovesFinishedJournalsAfterRestart(t *testing.T) {
	dir := t.TempDir()
	j, err := NewJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	old := now.Add(-JournalRetention - time.Hour)
	runs := []struct {
		id, last string
		mtime    time.Time
		kept     bool
	}{
		{"finished-old", "event: run.completed\ndata: {}", old, false},
		{"finished-unnamed-old", "data: {\"event\":\"run.failed\"}", old, false},
		{"finished-recent", "event: run.completed\ndata: {}", now, true},
		{"unfinished-old", "event: message.delta\ndata: {}", old, true},
	}
	for _, r := range runs {
		for _, event := range []string{"event: message.delta\ndata: {}", r.last} {
			// The flag startTail hands to Append for every block it journals.
			if _, _, err := j.Append(r.id, event, IsTerminal(event)); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.Chtimes(filepath.Join(dir, r.id+".jsonl"), r.mtime, r.mtime); err != nil {
			t.Fatal(err)
		}
	}
	restarted, err := NewJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Sweep(now); err != nil {
		t.Fatal(err)
	}
	for _, r := range runs {
		_, err := os.Stat(filepath.Join(dir, r.id+".jsonl"))
		if kept := err == nil; kept != r.kept {
			t.Errorf("%s: kept = %v, want %v", r.id, kept, r.kept)
		}
	}
}

// The state a run had in memory comes back from its file after a restart: the
// sequence, the terminal flag, and the bytes the size cap is counted against.
func TestJournalRestoresRunStateAfterRestart(t *testing.T) {
	dir := t.TempDir()
	j, err := NewJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	// "<" and "&" are escaped on disk, so the file is longer than the events.
	for _, step := range []struct{ run, event string }{
		{"finished", "event: message.delta\ndata: {\"text\":\"a < b & c\"}"},
		{"finished", "event: run.completed\ndata: {}"},
		{"running", "event: message.delta\ndata: {}"},
	} {
		if _, _, err := j.Append(step.run, step.event, IsTerminal(step.event)); err != nil {
			t.Fatal(err)
		}
	}
	restarted, err := NewJournal(dir)
	if err != nil {
		t.Fatal(err)
	}
	for run, want := range map[string]Status{
		"finished": {Seq: 2, Terminal: true, Exists: true},
		"running":  {Seq: 1, Exists: true},
	} {
		if got := restarted.Status(run); got != want {
			t.Errorf("%s: status after restart = %+v, want %+v", run, got, want)
		}
		info, err := os.Stat(filepath.Join(dir, run+".jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		restarted.mu.Lock()
		got := restarted.state(run).bytes
		restarted.mu.Unlock()
		if got != info.Size() {
			t.Errorf("%s: bytes after restart = %d, the file holds %d", run, got, info.Size())
		}
	}
}
