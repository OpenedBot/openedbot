package acpbridge

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The execution contract retains terminal runs for seven days, like the
// connector journal. Sweep hourly as well as at startup.
const runRetention = 7 * 24 * time.Hour

func (b *Bridge) eventPath(id string) string {
	return filepath.Join(b.opts.StateDirectory, "events", id+".jsonl")
}
func (b *Bridge) wakeLocked() { close(b.changed); b.changed = make(chan struct{}) }
func (b *Bridge) appendEvent(r *run, raw []byte) error {
	f, err := os.OpenFile(b.eventPath(r.ID), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		return fmt.Errorf("open run events: %w", err)
	}
	_, err = f.Write(append(raw, '\n'))
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("append run event: %w", err)
	}
	b.dirtyEvents[r.ID] = true
	return nil
}
func (b *Bridge) syncEventsLocked() error {
	for id := range b.dirtyEvents {
		f, err := os.OpenFile(b.eventPath(id), os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		err = f.Sync()
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		delete(b.dirtyEvents, id)
	}
	d, err := os.Open(filepath.Join(b.opts.StateDirectory, "events"))
	if err != nil {
		return err
	}
	err = d.Sync()
	closeErr := d.Close()
	if err == nil {
		err = closeErr
	}
	return err
}
func (b *Bridge) readEvents(r *run) error {
	if r.ID == "" || r.ID == "." || r.ID == ".." || strings.ContainsAny(r.ID, "/\\") {
		return errors.New("invalid stored run id")
	}
	f, err := os.OpenFile(b.eventPath(r.ID), os.O_RDWR, 0600)
	if errors.Is(err, os.ErrNotExist) {
		if terminal(r.Status) {
			return errors.New("terminal run events missing")
		}
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	reader := bufio.NewReader(f)
	var offset int64
	for {
		raw, readErr := reader.ReadBytes('\n')
		if readErr == io.EOF {
			if len(raw) > 0 {
				if err = f.Truncate(offset); err != nil {
					return err
				}
				if err = f.Sync(); err != nil {
					return err
				}
			}
			break
		}
		if readErr != nil {
			return readErr
		}
		var e Event
		if len(raw) > 1024*1024 || json.Unmarshal(raw, &e) != nil || e["run_id"] != r.ID {
			return errors.New("invalid stored run event")
		}
		offset += int64(len(raw))
		r.Events = append(r.Events, e)
		r.bytes += len(raw) + 7
		switch e["event"] {
		case "message.delta":
			if text, ok := e["delta"].(string); ok {
				r.Output += text
			}
		case "run.completed", "run.failed", "run.cancelled", "run.interrupted":
			r.Status = strings.TrimPrefix(e["event"].(string), "run.")
			if text, ok := e["output"].(string); ok {
				r.Output = text
			}
			if ts, ok := e["timestamp"].(float64); ok {
				r.TerminalAt = time.UnixMilli(int64(ts * 1000))
			}
		}
	}
	return nil
}
func (b *Bridge) pruneLocked(now time.Time) {
	expired := []string{}
	for id, r := range b.disk.Runs {
		if terminal(r.Status) && !r.TerminalAt.IsZero() && now.Sub(r.TerminalAt) > runRetention {
			expired = append(expired, id)
			delete(b.disk.Runs, id)
			delete(b.dirtyEvents, id)
		}
	}
	entries, err := os.ReadDir(filepath.Join(b.opts.StateDirectory, "events"))
	if err != nil {
		b.diskErr = err
		return
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".jsonl") {
			id := strings.TrimSuffix(entry.Name(), ".jsonl")
			if b.disk.Runs[id] == nil {
				found := false
				for _, old := range expired {
					if old == id {
						found = true
					}
				}
				if !found {
					expired = append(expired, id)
				}
			}
		}
	}
	if len(expired) == 0 {
		return
	}
	// Persist removal before unlinking journals so a crash cannot leave a live
	// header pointing at an event file removed by retention.
	b.saveLocked()
	if b.diskErr != nil {
		return
	}
	for _, id := range expired {
		if err := os.Remove(b.eventPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
			b.diskErr = err
			return
		}
	}
	if err := b.syncEventsLocked(); err != nil {
		b.diskErr = err
	}
}
func (b *Bridge) maintain() {
	defer close(b.maintenanceDone)
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case now := <-ticker.C:
			b.mu.Lock()
			b.pruneLocked(now)
			b.unlockAndSend()
		case <-b.ctx.Done():
			return
		}
	}
}
