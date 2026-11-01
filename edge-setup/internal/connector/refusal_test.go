package connector

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"
)

// A refused link does not heal by knocking fast, but a refusal caused on the
// openedbot side does heal: past MaxLinkRefusals the link is reported
// refused once and retried every RefusedRetryInterval, never stopped.
func TestRunSlowsDownAfterConsecutiveRefusals(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		c := New("ws://127.0.0.1:1/api/runtime-links/ws", Auth{}, "", "", nil)
		var reported []error
		c.OnLinkRefused = func(err error) { reported = append(reported, err) }
		var dialedAt []time.Time
		c.Dial = func(context.Context, string, *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
			dialedAt = append(dialedAt, time.Now())
			if len(dialedAt) == MaxLinkRefusals+3 {
				cancel()
			}
			return nil, &http.Response{StatusCode: http.StatusUnauthorized}, errors.New("expected handshake response status code 101 but got 401")
		}
		if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("refusals must not stop the link, got %v after %d dials", err, len(dialedAt))
		}
		if len(reported) != 1 || !errors.Is(reported[0], ErrLinkRefused) {
			t.Fatalf("refusal reported %d times: %v", len(reported), reported)
		}
		for i := MaxLinkRefusals; i < len(dialedAt); i++ {
			if gap := dialedAt[i].Sub(dialedAt[i-1]); gap < RefusedRetryInterval*9/10 {
				t.Fatalf("dial %d came %s after the previous one, want about %s", i+1, gap, RefusedRetryInterval)
			}
		}
	})
}

// A revocation is final: the link stops at once.
func TestRunStopsWhenRevoked(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := New("ws://127.0.0.1:1/api/runtime-links/ws", Auth{}, "", "", nil)
		dials := 0
		c.Dial = func(context.Context, string, *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
			dials++
			return nil, nil, websocket.CloseError{Code: CloseRevoked, Reason: "LINK_REVOKED"}
		}
		if err := c.Run(context.Background()); !errors.Is(err, ErrLinkRefused) || dials != 1 {
			t.Fatalf("want ErrLinkRefused after one dial, got %v after %d", err, dials)
		}
	})
}

// A close 4005 means openedbot hung up a dead session: the link redials
// after about a second every time, and never counts it as a refusal.
func TestRunRedialsQuicklyAfterReconnectRequest(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		c := New("ws://127.0.0.1:1/api/runtime-links/ws", Auth{}, "", "", nil)
		dials := 0
		start := time.Now()
		c.Dial = func(context.Context, string, *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
			dials++
			if dials == 2*MaxLinkRefusals {
				cancel()
			}
			return nil, nil, websocket.CloseError{Code: CloseReconnect, Reason: "LINK_RECONNECT_REQUESTED"}
		}
		if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("a reconnect request must not stop the link, got %v after %d dials", err, dials)
		}
		// 19 waits of 1 s +/- 10 %; an escalating backoff would need minutes.
		if elapsed := time.Since(start); elapsed > 25*time.Second {
			t.Fatalf("%d redials took %s: the backoff was not reset to 1 s", dials, elapsed)
		}
	})
}

// A network outage is not a refusal: the link keeps retrying as long as it
// lasts.
func TestRunKeepsRetryingNetworkFailures(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		c := New("ws://127.0.0.1:1/api/runtime-links/ws", Auth{}, "", "", nil)
		dials := 0
		c.Dial = func(context.Context, string, *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
			dials++
			if dials == 3*MaxLinkRefusals {
				cancel()
			}
			return nil, nil, errors.New("dial tcp 127.0.0.1:1: connect: connection refused")
		}
		if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("network failures must not stop the link, got %v after %d dials", err, dials)
		}
	})
}
