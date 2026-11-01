package connector

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRunIDFromUsesTopLevelJSON(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{`{"run_id": "spaced-id"}`, "spaced-id"},
		{"{\n  \"run_id\": \"escaped\\u002did\"\n}", "escaped-id"},
		{`{"id": "legacy-id"}`, "legacy-id"},
		{`{"nested":{"run_id":"wrong"},"run_id":"actual"}`, "actual"},
		{`{"nested":{"run_id":"wrong"}}`, ""},
		{`{"run_id":"../unsafe"}`, ""},
		{`{"run_id":42}`, ""},
		{`{"run_id":"truncated"`, ""},
	} {
		if got := runIDFrom([]byte(tc.body)); got != tc.want {
			t.Errorf("%s => %q, want %q", tc.body, got, tc.want)
		}
	}
}

func TestReplayNewRunWaitsForFirstNumberedEntry(t *testing.T) {
	journal, err := NewJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tailStarted := make(chan struct{})
	releaseEvent := make(chan struct{})
	var subscriptions atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/p/test-profile/v1/runs":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"run_id": "new-run"}`)
		case "/p/test-profile/v1/runs/new-run/events":
			if subscriptions.Add(1) == 1 {
				close(tailStarted)
			}
			select {
			case <-releaseEvent:
			case <-r.Context().Done():
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"event\": \"run.completed\", \"run_id\": \"new-run\"}\n\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer gateway.Close()
	client := New("", Auth{}, gateway.URL, "secret", journal)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client.serve(ctx, Text{T: TReq, ID: 1, Method: "POST", Path: "/p/test-profile/v1/runs"}, func(websocket.MessageType, []byte) error { return nil })
	select {
	case <-tailStarted:
	case <-ctx.Done():
		t.Fatal("spaced creation response did not start journal subscription")
	}
	if journal.Status("new-run").Exists {
		t.Fatal("fixture should have no journal before first event")
	}
	var bodies []string
	ended := false
	client.serveReplay(ctx, Text{T: TReq, ID: 2, Method: "GET", Path: "/p/test-profile/v1/runs/new-run/events"}, func(kind websocket.MessageType, data []byte) error {
		if kind == websocket.MessageText {
			frame, _ := DecodeText(data)
			if frame.T == TRes {
				close(releaseEvent)
			}
			if frame.T == TEnd {
				ended = true
			}
		} else {
			_, body, err := DecodeBinary(data)
			if err != nil {
				t.Fatal(err)
			}
			bodies = append(bodies, string(body))
		}
		return nil
	}, 0)
	if len(bodies) != 1 || !strings.HasPrefix(bodies[0], "id: 1\n") || !strings.Contains(bodies[0], `"event": "run.completed"`) || !ended {
		t.Fatalf("initial replay lacks numbered event: %q", bodies)
	}
	if subscriptions.Load() != 1 {
		t.Fatalf("duplicate upstream subscriptions: %d", subscriptions.Load())
	}
}

func TestReplayPositiveMissingCursorStillReportsGap(t *testing.T) {
	journal, err := NewJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	client := New("", Auth{}, "http://127.0.0.1:1", "secret", journal)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var first string
	client.serveReplay(ctx, Text{ID: 1, Path: "/v1/runs/missing/events"}, func(kind websocket.MessageType, data []byte) error {
		if kind == websocket.MessageBinary {
			_, body, _ := DecodeBinary(data)
			first = string(body)
			cancel()
			return context.Canceled
		}
		return nil
	}, 7)
	if first != "event: replay-gap\ndata: {}\n\n" {
		t.Fatalf("lost cursor gap hidden: %q", first)
	}
}

func TestTerminalEventUsesNamedOrJSONEnvelope(t *testing.T) {
	for _, block := range []string{
		"event: run.completed\ndata: {}",
		`data: {"event": "run.completed", "run_id": "run-1"}`,
		"data: {\ndata: \"event\": \"run.error\"}",
		"event: message\ndata: {\"event\":\"run.stopped\"}",
	} {
		if !IsTerminal(block) {
			t.Errorf("terminal event missed: %s", block)
		}
	}
	for _, block := range []string{
		`data: {"event":"message.delta","text":"run.completed"}`,
		`data: {"nested":{"event":"run.completed"}}`,
		`data: {"event":"run.completed"`,
		"event: message.delta\ndata: {\"event\":\"run.completed\"}",
	} {
		if IsTerminal(block) {
			t.Errorf("nonterminal event accepted: %s", block)
		}
	}
}
