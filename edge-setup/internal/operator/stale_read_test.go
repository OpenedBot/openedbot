package operator

import (
	"context"
	"sync"
	"testing"
	"time"
)

// A read past ReadCacheTTL but within StaleReadLimit answers at once with the
// cached document and refreshes it in the background; a write drops it, and
// the next read waits for a fresh probe again.
func TestExpiredReadIsServedAtOnceAndRefreshedInTheBackground(t *testing.T) {
	var mu sync.Mutex
	clock := time.Date(2026, 10, 21, 21, 0, 0, 0, time.UTC)
	reply := `{"v":1}`
	release := make(chan struct{}, 4)
	calls := 0
	s := &Server{Now: func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }}
	s.Probe = func(context.Context, string, []byte) ([]byte, error) {
		<-release
		mu.Lock()
		defer mu.Unlock()
		calls++
		return []byte(reply), nil
	}
	read := func() string {
		t.Helper()
		doc, err := s.readCached(context.Background(), "toolsets")
		if err != nil {
			t.Fatal(err)
		}
		return string(doc)
	}
	advance := func(d time.Duration) { mu.Lock(); clock = clock.Add(d); mu.Unlock() }
	waitIdle := func() {
		for {
			s.mu.Lock()
			idle := len(s.probeFlights) == 0
			s.mu.Unlock()
			if idle {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}

	release <- struct{}{}
	if got := read(); got != `{"v":1}` {
		t.Fatalf("cold read = %s", got)
	}
	mu.Lock()
	reply = `{"v":2}`
	mu.Unlock()
	advance(ReadCacheTTL + time.Second)
	// No release yet: an expired read must not wait for the probe.
	done := make(chan string, 1)
	go func() { done <- read() }()
	select {
	case got := <-done:
		if got != `{"v":1}` {
			t.Fatalf("expired read = %s, want the cached document", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("an expired read waited for the probe")
	}
	release <- struct{}{}
	waitIdle()
	if got := read(); got != `{"v":2}` {
		t.Fatalf("read after the background refresh = %s", got)
	}

	// A write drops the cache: the next read is fresh, never stale.
	s.dropReadCache()
	mu.Lock()
	reply = `{"v":3}`
	mu.Unlock()
	advance(ReadCacheTTL + time.Second)
	release <- struct{}{}
	if got := read(); got != `{"v":3}` {
		t.Fatalf("read after a write = %s, want a fresh probe", got)
	}

	// Past StaleReadLimit the read waits for a fresh probe.
	mu.Lock()
	reply = `{"v":4}`
	mu.Unlock()
	advance(ReadCacheTTL + StaleReadLimit + time.Second)
	release <- struct{}{}
	if got := read(); got != `{"v":4}` {
		t.Fatalf("read past the stale limit = %s, want a fresh probe", got)
	}
	if calls != 4 {
		t.Fatalf("probe ran %d times, want 4", calls)
	}
}
