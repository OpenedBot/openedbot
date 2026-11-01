package connector

import (
	"context"
	"errors"
	"github.com/coder/websocket"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

type readinessTransport func(*http.Request) (*http.Response, error)

func (f readinessTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestHelloWaitsForOperator(t *testing.T) {
	for _, available := range []bool{true, false} {
		name := "timeout"
		if available {
			name = "ready"
		}
		t.Run(name, func(t *testing.T) {
			broker := newBroker(t)
			c := New(broker.wsURL(), Auth{}, "", "", nil)
			c.OperatorSocket = "/configured/operator.sock"
			now := time.Now()
			start := now
			attempts := 0
			var sent atomic.Bool
			c.now = func() time.Time { return now }
			c.wait = func(ctx context.Context, delay time.Duration) error {
				if sent.Load() {
					<-ctx.Done()
					return ctx.Err()
				}
				now = now.Add(delay)
				return nil
			}
			c.operator = &http.Client{Transport: readinessTransport(func(r *http.Request) (*http.Response, error) {
				attempts++
				status := 503
				if available && attempts >= 3 {
					status = 200
				}
				if r.URL.Path != "/capabilities" {
					t.Errorf("unexpected probe %s", r.URL.Path)
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{"features":["profile_capabilities"]}`)), Header: http.Header{}}, nil
			})}
			dial := c.Dial
			c.Dial = func(ctx context.Context, url string, opts *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
				sent.Store(true)
				return dial(ctx, url, opts)
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- c.Session(ctx) }()
			<-broker.ready
			if available {
				if len(broker.hello.Features) != 1 || broker.hello.Features[0] != "profile_capabilities" || now.Sub(start) != time.Second {
					t.Fatalf("hello=%+v elapsed=%s", broker.hello, now.Sub(start))
				}
			} else if len(broker.hello.Features) != 0 || now.Sub(start) != 15*time.Second {
				t.Fatalf("hello=%+v elapsed=%s", broker.hello, now.Sub(start))
			}
			cancel()
			<-done
		})
	}
}

func TestLateOperatorRecoveryPreservesSessionAndInflightRequest(t *testing.T) {
	broker := newBroker(t)
	started, release := make(chan struct{}), make(chan struct{})
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-release:
			_, _ = io.WriteString(w, `{"ok":true}`)
		case <-r.Context().Done():
		}
	}))
	defer gateway.Close()
	c := New(broker.wsURL(), Auth{}, gateway.URL, "", nil)
	c.HTTP = gateway.Client()
	c.OperatorSocket = "/configured/operator.sock"
	var ready atomic.Bool
	c.operator = &http.Client{Transport: readinessTransport(func(r *http.Request) (*http.Response, error) {
		status := 503
		if ready.Load() {
			status = 200
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{"features":["profile_capabilities"]}`)), Header: http.Header{}}, nil
	})}
	now := time.Now()
	startTime := now
	c.now = func() time.Time { return now }
	recovery := make(chan struct{})
	c.wait = func(ctx context.Context, delay time.Duration) error {
		if now.Sub(startTime) < 15*time.Second {
			now = now.Add(delay)
			return nil
		}
		select {
		case <-recovery:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	alerts, _ := NewAlerts("https://discord.com/api/webhooks/123/test-secret", func(string, ...any) {})
	c.Health = alerts.Update
	var dials atomic.Int32
	dial := c.Dial
	c.Dial = func(ctx context.Context, url string, opts *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
		dials.Add(1)
		return dial(ctx, url, opts)
	}
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()
	<-broker.ready
	if len(broker.hello.Features) != 0 {
		t.Fatal(broker.hello.Features)
	}
	broker.send(Text{T: TReq, ID: 1, Method: "GET", Path: "/health", Body: "none"})
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("gateway request did not start")
	}
	ready.Store(true)
	close(recovery)
	if update := broker.next(t); update.T != TCapabilities || len(update.Features) != 1 || update.Features[0] != "profile_capabilities" {
		t.Fatalf("expected in-place capabilities update, got %+v", update)
	}
	close(release)
	if response := broker.next(t); response.T != TRes || response.ID != 1 || response.Status != 200 {
		t.Fatalf("in-flight request interrupted: %+v", response)
	}
	// Read binary and end separately: their test channels do not preserve
	// ordering with each other, unlike frames on the actual WebSocket.
	select {
	case chunk := <-broker.chunks:
		id, body, err := DecodeBinary(chunk)
		if err != nil || id != 1 || string(body) != `{"ok":true}` {
			t.Fatalf("response body: id=%d body=%s err=%v", id, body, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("in-flight response body missing")
	}
	if end := broker.next(t); end.T != TEnd || end.ID != 1 {
		t.Fatalf("in-flight response did not finish: %+v", end)
	}
	if dials.Load() != 1 {
		t.Fatalf("operator recovery opened %d connections", dials.Load())
	}
	alerts.mu.Lock()
	link := alerts.states["link"]
	alerts.mu.Unlock()
	if !link.available || link.incident || link.dirty {
		t.Fatalf("operator recovery created a link incident: %+v", link)
	}
	cancel()
	<-done
}

func TestOperatorResponseMayTakeLongerThanRetryInterval(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := New("", Auth{}, "", "", nil)
		c.OperatorSocket = "/configured/operator.sock"
		c.operator = &http.Client{Transport: readinessTransport(func(r *http.Request) (*http.Response, error) {
			// Virtual time: reproduce the measured 738 ms capability read without wall-clock sleep.
			timer := time.NewTimer(750 * time.Millisecond)
			defer timer.Stop()
			select {
			case <-r.Context().Done():
				return nil, r.Context().Err()
			case <-timer.C:
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"features":["profile_capabilities"]}`))}, nil
			}
		})}
		start := time.Now()
		features := c.helloFeatures(context.Background())
		if len(features) != 1 || features[0] != "profile_capabilities" || time.Since(start) != 750*time.Millisecond {
			t.Fatalf("features=%v elapsed=%s", features, time.Since(start))
		}
	})
}

func TestOperatorRecoveryRetriesAnnouncementWithoutEndingSession(t *testing.T) {
	c := New("", Auth{}, "", "", nil)
	c.OperatorSocket = "/configured/operator.sock"
	c.operator = &http.Client{Transport: readinessTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"features":["provider_management"]}`))}, nil
	})}
	waits := 0
	c.wait = func(ctx context.Context, delay time.Duration) error {
		waits++
		if delay != 500*time.Millisecond {
			t.Fatalf("unexpected retry interval %s", delay)
		}
		if waits > 2 {
			return errors.New("unexpected extra retry")
		}
		return nil
	}
	sends := 0
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.watchOperator(ctx, func(kind websocket.MessageType, data []byte) error {
		sends++
		if kind != websocket.MessageText {
			t.Fatal("capabilities must be a control frame")
		}
		frame, err := DecodeText(data)
		if err != nil || frame.T != TCapabilities || len(frame.Features) != 1 || frame.Features[0] != FeatureProviderManagement {
			t.Fatalf("invalid announcement: %+v %v", frame, err)
		}
		if sends == 1 {
			return errors.New("temporary write failure")
		}
		return nil
	})
	if sends != 2 || waits != 2 || ctx.Err() != nil {
		t.Fatalf("sends=%d waits=%d session error=%v", sends, waits, ctx.Err())
	}
}

func TestHungOperatorStillBoundsHelloWaitToFifteenSeconds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := New("", Auth{}, "", "", nil)
		c.OperatorSocket = "/configured/operator.sock"
		c.operator = &http.Client{Transport: readinessTransport(func(r *http.Request) (*http.Response, error) {
			<-r.Context().Done()
			return nil, r.Context().Err()
		})}
		start := time.Now()
		if features := c.helloFeatures(context.Background()); len(features) != 0 || time.Since(start) != 15*time.Second {
			t.Fatalf("features=%v elapsed=%s", features, time.Since(start))
		}
	})
}
