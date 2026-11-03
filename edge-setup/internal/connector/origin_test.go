package connector

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestMovedWSURLOnlyWithinOneHTTPSDomain(t *testing.T) {
	const legacy = "wss://console.openedbot.app/api/runtime-links/ws"
	for _, tc := range []struct {
		name, current, ohb, want string
	}{
		{"subdomain to apex", legacy, "https://openedbot.app", "wss://openedbot.app/api/runtime-links/ws"},
		{"apex to subdomain", "wss://openedbot.app/api/runtime-links/ws", "https://console.openedbot.app/", "wss://console.openedbot.app/api/runtime-links/ws"},
		{"same origin", legacy, "https://console.openedbot.app", ""},
		{"another domain", legacy, "https://evil.example", ""},
		{"look-alike suffix", legacy, "https://xopenedbot.app", ""},
		{"sibling", legacy, "https://other.openedbot.app", ""},
		{"plain http announced", legacy, "http://openedbot.app", ""},
		{"development tunnel", "ws://127.0.0.1:8790/api/runtime-links/ws", "https://openedbot.app", ""},
		{"announced path", legacy, "https://openedbot.app/x", ""},
		{"announced port", legacy, "https://openedbot.app:8443", ""},
		{"bare public suffix", "wss://openedbot.app/api/runtime-links/ws", "https://app", ""},
		{"address", legacy, "https://203.0.113.10", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := MovedWSURL(tc.current, tc.ohb)
			if got != tc.want || ok != (tc.want != "") {
				t.Fatalf("MovedWSURL(%q, %q) = %q, %v; want %q", tc.current, tc.ohb, got, ok, tc.want)
			}
		})
	}
}

// A production link told by link.context that openedbot now lives on the
// apex ends its session; Run persists the move and dials the new endpoint.
func TestLinkContextAnnouncingTheApexEndsTheSessionForAMove(t *testing.T) {
	broker := newBroker(t)
	gw, _ := fakeGateway(t)
	c := New("wss://console.openedbot.app/api/runtime-links/ws", Auth{RuntimeID: "rt-1", LinkToken: "tok"}, gw.URL, bearer, nil)
	c.HTTP = gw.Client()
	// The production URL is what the client dials and signs; the test routes
	// it to the plain fake broker.
	c.Dial = func(ctx context.Context, _ string, o *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
		return websocket.Dial(ctx, broker.wsURL(), o)
	}
	c.OnOriginMoved = func(string) error { return nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.Session(ctx) }()
	<-broker.ready
	broker.send(Text{T: TLinkContext, Environment: "prod", OHB: "https://openedbot.app"})
	select {
	case err := <-done:
		if !errors.Is(err, errOriginMoved) || c.pendingWSURL != "wss://openedbot.app/api/runtime-links/ws" {
			t.Fatalf("session ended with %v, pending %q", err, c.pendingWSURL)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("session did not end on the announced origin")
	}
}

func TestAfterSessionPersistsConfirmsAndRollsBackAMove(t *testing.T) {
	const legacy = "wss://console.openedbot.app/api/runtime-links/ws"
	const apex = "wss://openedbot.app/api/runtime-links/ws"
	var persisted []string
	newClient := func() *Client {
		c := New(legacy, Auth{RuntimeID: "rt-1", LinkToken: "tok"}, "http://127.0.0.1:1", bearer, nil)
		c.OnOriginMoved = func(u string) error { persisted = append(persisted, u); return nil }
		return c
	}

	// Moved, then confirmed: the previous endpoint is retired.
	c := newClient()
	c.pendingWSURL = apex
	if !c.afterSession(errOriginMoved, true) || c.WSURL != apex || c.originFallback != legacy {
		t.Fatalf("move not applied: ws=%q fallback=%q", c.WSURL, c.originFallback)
	}
	if c.afterSession(errors.New("closed"), true) || c.originFallback != "" {
		t.Fatalf("confirmation did not retire the fallback")
	}

	// Moved, then three unconfirmed sessions: back to the legacy endpoint,
	// persisted, and the failed target is not retried.
	persisted = nil
	c = newClient()
	c.pendingWSURL = apex
	c.afterSession(errOriginMoved, true)
	for i := 1; i < MaxOriginMoveFailures; i++ {
		if c.afterSession(errors.New("dial: refused"), false) || c.WSURL != apex {
			t.Fatalf("rolled back after %d failures", i)
		}
	}
	if !c.afterSession(errors.New("dial: refused"), false) || c.WSURL != legacy || c.originRefused != apex {
		t.Fatalf("no rollback: ws=%q refused=%q", c.WSURL, c.originRefused)
	}
	if len(persisted) != 2 || persisted[0] != apex || persisted[1] != legacy {
		t.Fatalf("persisted %v", persisted)
	}

	// A move that cannot be persisted is not dialled.
	c = newClient()
	c.OnOriginMoved = func(string) error { return errors.New("read-only") }
	c.pendingWSURL = apex
	c.afterSession(errOriginMoved, true)
	if c.WSURL != legacy || c.originRefused != apex {
		t.Fatalf("unpersisted move applied: ws=%q", c.WSURL)
	}
}
