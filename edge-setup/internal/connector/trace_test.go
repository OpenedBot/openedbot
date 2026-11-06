package connector

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const validTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

func TestParseTraceparent(t *testing.T) {
	cases := []struct {
		value string
		ok    bool
	}{
		{validTraceparent, true},
		{" " + validTraceparent + " ", true},
		{"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00", true},
		{"01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-future", true},
		{"", false},
		{"garbage", false},
		{validTraceparent + "-extra", false},
		{"00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01", false},
		{"00-00000000000000000000000000000000-00f067aa0ba902b7-01", false},
		{"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01", false},
		{"ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", false},
		{"01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01x", false},
		{"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\nrelay GET /forged", false},
	}
	for _, tc := range cases {
		got, ok := parseTraceparent(tc.value)
		if ok != tc.ok {
			t.Fatalf("parseTraceparent(%q) ok=%v, want %v", tc.value, ok, tc.ok)
		}
		if ok && (got.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || got.SpanID != "00f067aa0ba902b7") {
			t.Fatalf("parseTraceparent(%q) = %+v", tc.value, got)
		}
	}
}

// TestRelayTraceparent: a well-formed traceparent reaches the gateway unchanged
// and leaves one journal line naming the trace and span; a malformed,
// ambiguous or absent one is neither relayed nor journaled, and the request is
// served exactly as before. A refused route is never journaled.
func TestRelayTraceparent(t *testing.T) {
	broker := newBroker(t)
	var mu sync.Mutex
	seen := map[string][]string{}
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen[r.URL.Query().Get("case")] = r.Header.Values("Traceparent")
		mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(gw.Close)
	var logs []string
	c := New(broker.wsURL(), Auth{RuntimeID: "rt-1", LinkToken: "tok"}, gw.URL, bearer, nil)
	c.HTTP = gw.Client()
	c.Logf = func(format string, args ...any) {
		mu.Lock()
		logs = append(logs, fmt.Sprintf(format, args...))
		mu.Unlock()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = c.Session(ctx) }()
	<-broker.ready

	cases := []struct {
		name    string
		path    string
		headers map[string]string
		relayed []string
	}{
		{"valid", "/v1/capabilities?case=valid", map[string]string{"accept": "application/json", "traceparent": validTraceparent}, []string{validTraceparent}},
		{"mixed-case", "/v1/capabilities?case=mixed-case", map[string]string{"Traceparent": validTraceparent}, []string{validTraceparent}},
		{"malformed", "/v1/capabilities?case=malformed", map[string]string{"traceparent": "00-xyz"}, nil},
		{"ambiguous", "/v1/capabilities?case=ambiguous", map[string]string{"traceparent": validTraceparent, "Traceparent": validTraceparent}, nil},
		{"absent", "/v1/capabilities?case=absent", map[string]string{"accept": "application/json"}, nil},
	}
	for i, tc := range cases {
		id := uint32(i + 1)
		broker.send(Text{T: TReq, ID: id, Method: "GET", Path: tc.path, Headers: tc.headers, Body: "none"})
		if res := broker.next(t); res.T != TRes || res.Status != 200 {
			t.Fatalf("%s: %+v", tc.name, res)
		}
		_ = broker.body(t, id)
		mu.Lock()
		got := seen[tc.name]
		mu.Unlock()
		if strings.Join(got, ",") != strings.Join(tc.relayed, ",") {
			t.Fatalf("%s: gateway saw traceparent %q, want %q", tc.name, got, tc.relayed)
		}
	}
	broker.send(Text{T: TReq, ID: 99, Method: "DELETE", Path: "/api/credentials/pool", Headers: map[string]string{"traceparent": validTraceparent}, Body: "none"})
	if e := broker.next(t); e.T != TErr || e.Code != "HERMES_LINK_PATH_FORBIDDEN" {
		t.Fatalf("%+v", e)
	}

	mu.Lock()
	defer mu.Unlock()
	var traced []string
	for _, line := range logs {
		if strings.HasPrefix(line, "relay ") {
			traced = append(traced, line)
		}
	}
	want := "relay GET /v1/capabilities trace=4bf92f3577b34da6a3ce929d0e0e4736 span=00f067aa0ba902b7"
	if len(traced) != 2 || traced[0] != want || traced[1] != want {
		t.Fatalf("journal %q, want two lines %q", traced, want)
	}
}
