package operator

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Several API routes ask /capabilities at once when a console screen opens;
// they share one profiles read instead of starting one Python probe each.
func TestConcurrentCapabilitiesShareOneProfilesRead(t *testing.T) {
	var reads atomic.Int32
	release := make(chan struct{})
	s := &Server{Probe: func(_ context.Context, verb string, _ []byte) ([]byte, error) {
		if verb == "profiles" {
			reads.Add(1)
			<-release
			return []byte(`{"multiplex":true,"profiles":[]}`), nil
		}
		return []byte(`{}`), nil
	}, SkillsHubReady: true}
	handler := s.Handler()
	var wg sync.WaitGroup
	features := make([]string, 4)
	for i := range features {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/capabilities", nil))
			features[i] = rec.Body.String()
		}()
	}
	for reads.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if got := reads.Load(); got != 1 {
		t.Fatalf("4 concurrent /capabilities ran %d profiles reads, want 1", got)
	}
	for _, body := range features {
		if !strings.Contains(body, "profile_management") {
			t.Fatalf("a joined request lost the multiplex answer: %s", body)
		}
	}
}
