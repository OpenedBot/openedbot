package connector

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"
)

func TestReconnectBackoffRetiresOldIncidentsOnlyAfterHealthySession(t *testing.T) {
	for _, tc := range []struct {
		name    string
		healthy time.Duration
		want    time.Duration
	}{
		{"no confirmation", 0, time.Minute},
		{"immediate flap", time.Millisecond, time.Minute},
		{"below stable threshold", 30*time.Second - time.Nanosecond, time.Minute},
		{"stable threshold", 30 * time.Second, time.Second},
		{"long healthy session", time.Hour, time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := reconnectBackoff(time.Minute, tc.healthy); got != tc.want {
				t.Fatalf("backoff after %s healthy = %s; want %s", tc.healthy, got, tc.want)
			}
		})
	}
	if got := reconnectBackoff(2*time.Second, time.Second); got != 2*time.Second {
		t.Fatalf("short flap reset an escalating delay: %s", got)
	}
}

func TestLoopbackRefusalOnlyForRefusedLoopbackOrigins(t *testing.T) {
	refused := errors.New("dial tcp 127.0.0.1:8790: connect: connection refused")
	for _, tc := range []struct {
		name  string
		wsURL string
		err   error
		want  bool
	}{
		{"loopback ipv4 refused", "ws://127.0.0.1:8790/api/runtime-links/ws", refused, true},
		{"localhost refused", "ws://localhost:8790/api/runtime-links/ws", refused, true},
		{"loopback ipv6 refused", "ws://[::1]:8790/api/runtime-links/ws", refused, true},
		{"loopback errno", "ws://127.0.0.1:8790/api/runtime-links/ws", fmt.Errorf("dial: %w", syscall.ECONNREFUSED), true},
		{"public origin refused", "wss://console.openedbot.app/api/runtime-links/ws", refused, false},
		{"lan origin refused", "ws://172.16.0.10:8790/api/runtime-links/ws", refused, false},
		{"loopback other failure", "ws://127.0.0.1:8790/api/runtime-links/ws", errors.New("read: connection reset by peer"), false},
		{"no error", "ws://127.0.0.1:8790/api/runtime-links/ws", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := loopbackRefusal(tc.wsURL, tc.err); got != tc.want {
				t.Fatalf("loopbackRefusal(%q, %v) = %v; want %v", tc.wsURL, tc.err, got, tc.want)
			}
		})
	}
}

// The dev tunnel case: a loopback origin refusing the dial keeps the link
// knocking every LoopbackRefusedBackoff instead of climbing to the 60 s cap.
func TestRunKeepsShortBackoffWhileLoopbackOriginRefuses(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		c := New("ws://127.0.0.1:8790/api/runtime-links/ws", Auth{}, "", "", nil)
		start := time.Now()
		dials := 0
		c.Dial = func(context.Context, string, *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
			dials++
			if dials == 20 {
				cancel()
			}
			return nil, nil, errors.New("dial tcp 127.0.0.1:8790: connect: connection refused")
		}
		if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("Run = %v", err)
		}
		// 19 waits of at most LoopbackRefusedBackoff plus 10 % jitter; at the
		// 60 s cap the same 19 waits would exceed ten minutes.
		if elapsed := time.Since(start); elapsed > 19*(LoopbackRefusedBackoff+LoopbackRefusedBackoff/10) {
			t.Fatalf("20 refused dials on loopback took %s; the backoff climbed past %s", elapsed, LoopbackRefusedBackoff)
		}
	})
}

// A public origin refusing the dial keeps the incident backoff: knocking a
// production host every two seconds is what the cap exists to prevent.
func TestRunKeepsIncidentBackoffWhilePublicOriginRefuses(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		c := New("wss://console.openedbot.app/api/runtime-links/ws", Auth{}, "", "", nil)
		start := time.Now()
		dials := 0
		c.Dial = func(context.Context, string, *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
			dials++
			if dials == 8 {
				cancel()
			}
			return nil, nil, errors.New("dial tcp 203.0.113.10:443: connect: connection refused")
		}
		if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("Run = %v", err)
		}
		// 1+2+4+8+16+32+60 = 123 s of waits before the eighth dial; the jitter
		// shortens each wait by at most 10 %.
		if elapsed := time.Since(start); elapsed < 110*time.Second {
			t.Fatalf("8 refused dials on a public origin took only %s; the incident backoff was shortened", elapsed)
		}
	})
}

// A loopback origin that stays down must not ask the operator for its
// features on every redial: each read runs a Python probe on the host. The
// features read for a hello that never left are reused for UnsentFeaturesTTL.
// Past LoopbackDownLimit the connector slows to LoopbackDormantInterval but
// keeps going: when the tunnel reopens, the link comes back by itself.
func TestDeadLoopbackOriginGoesDormantAndHealsWhenTheTunnelReturns(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		c := New("ws://127.0.0.1:8790/api/runtime-links/ws", Auth{}, "", "", nil)
		c.OperatorSocket = "/configured/operator.sock"
		var reads atomic.Int32
		body := []byte(`{"features":["provider_management"]}`)
		c.operator = &http.Client{Transport: readinessTransport(func(*http.Request) (*http.Response, error) {
			reads.Add(1)
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: http.Header{}}, nil
		})}
		var logs []string
		c.Logf = func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) }
		start := time.Now()
		tunnelBack := start.Add(30 * time.Minute)
		var dialTimes []time.Time
		c.Dial = func(context.Context, string, *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
			dialTimes = append(dialTimes, time.Now())
			if !time.Now().Before(tunnelBack) {
				// The tunnel is back: the test only needs the redial to happen.
				cancel()
			}
			return nil, nil, errors.New("dial tcp 127.0.0.1:8790: connect: connection refused")
		}
		if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("Run = %v, want to keep redialing until the tunnel is back", err)
		}
		last := dialTimes[len(dialTimes)-1]
		if late := last.Sub(tunnelBack); late < 0 || late > LoopbackDormantInterval+LoopbackDormantInterval/10 {
			t.Fatalf("redialed %s after the tunnel came back, want within %s", late, LoopbackDormantInterval)
		}
		// Dormant pace after the first minute: about 30 + 58 dials, not 900.
		if len(dialTimes) > 120 {
			t.Fatalf("%d dials in 30 min: the dormant pace was not applied", len(dialTimes))
		}
		// At most one operator read per UnsentFeaturesTTL, plus the first.
		if got := reads.Load(); got > 32 {
			t.Fatalf("%d operator reads in 30 min", got)
		}
		// Dormant lines are bounded: one on entering, then one per 10 min.
		dormantLines := 0
		for _, line := range logs {
			if strings.Contains(line, "retrying every") {
				dormantLines++
			}
		}
		if dormantLines < 1 || dormantLines > 4 {
			t.Fatalf("%d dormant log lines in 30 min, want 1 to 4", dormantLines)
		}
	})
}

// A public origin that refuses every dial never stops the connector: an
// openedbot outage must heal without anyone on the host.
func TestDeadPublicOriginNeverStopsTheConnector(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		c := New("wss://console.openedbot.app/api/runtime-links/ws", Auth{}, "", "", nil)
		start := time.Now()
		c.Dial = func(context.Context, string, *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
			if time.Since(start) > 10*time.Minute {
				cancel()
			}
			return nil, nil, errors.New("dial tcp 203.0.113.10:443: connect: connection refused")
		}
		if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("Run = %v, want to keep redialing until cancelled", err)
		}
	})
}
