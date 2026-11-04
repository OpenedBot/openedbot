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

// A body refused as too big before its request frame arrived must not keep
// its in-flight slot: MaxInFlight of them made every later request LINK_BUSY.
func TestEarlyBodyTooBigReleasesTheInFlightSlot(t *testing.T) {
	c := New("", Auth{}, "http://127.0.0.1:1", "secret", nil)
	for id := uint32(1); id <= MaxInFlight+1; id++ {
		c.mu.Lock()
		c.early[id] = &earlyBody{tooBig: true}
		c.mu.Unlock()
		var got Text
		c.serve(context.Background(), Text{T: TReq, ID: id, Method: "POST", Path: "/v1/runs", Body: "stream"}, func(_ websocket.MessageType, data []byte) error {
			got, _ = DecodeText(data)
			return nil
		})
		if got.Code != "HERMES_PROTOCOL_LIMIT" {
			t.Fatalf("request %d: %+v", id, got)
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.inflight) != 0 {
		t.Fatalf("%d slots still held", len(c.inflight))
	}
}

// replayGateway serves the run's events: each subscription gets the next
// script (blocks then EOF), and GET /v1/runs/<id> answers status.
func replayGateway(t *testing.T, runID, status string, scripts ...[]string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var subscriptions atomic.Int32
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/runs/" + runID + "/events":
			n := int(subscriptions.Add(1))
			w.Header().Set("Content-Type", "text/event-stream")
			if n <= len(scripts) {
				for _, block := range scripts[n-1] {
					fmt.Fprint(w, block+"\n\n")
				}
			}
		case "/v1/runs/" + runID:
			if status == "" {
				w.WriteHeader(404)
				return
			}
			fmt.Fprintf(w, `{"id":%q,"status":%q}`, runID, status)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(gw.Close)
	return gw, &subscriptions
}

func fastResubscribe(t *testing.T) {
	prevLimit, prevDelay := tailResubscribeLimit, tailResubscribeDelay
	tailResubscribeLimit, tailResubscribeDelay = 3, time.Millisecond
	t.Cleanup(func() { tailResubscribeLimit, tailResubscribeDelay = prevLimit, prevDelay })
}

const (
	deltaBlock     = `data: {"event": "message.delta", "delta": "hi"}`
	completedBlock = `data: {"event": "run.completed"}`
)

// After a connector restart the journal exists but nobody tails the run: a
// replay must subscribe again, and an upstream that sends the run from its
// start must not journal the known events twice.
func TestReplayOfAnOpenJournalResubscribesWithoutDuplicates(t *testing.T) {
	fastResubscribe(t)
	journal, err := NewJournal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := journal.Append("run-1", deltaBlock, false); err != nil {
		t.Fatal(err)
	}
	gw, subscriptions := replayGateway(t, "run-1", "running", []string{deltaBlock, completedBlock})
	c := New("", Auth{}, gw.URL, "secret", journal)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var bodies []string
	ended := false
	c.serveReplay(ctx, Text{ID: 1, Path: "/v1/runs/run-1/events"}, func(kind websocket.MessageType, data []byte) error {
		if kind == websocket.MessageBinary {
			_, body, _ := DecodeBinary(data)
			bodies = append(bodies, string(body))
		} else if frame, _ := DecodeText(data); frame.T == TEnd {
			ended = true
		}
		return nil
	}, 1)
	if ctx.Err() != nil || !ended {
		t.Fatalf("replay never ended: %q", bodies)
	}
	if len(bodies) != 1 || !strings.HasPrefix(bodies[0], "id: 2\n") || !strings.Contains(bodies[0], "run.completed") {
		t.Fatalf("replay after cursor 1 = %q", bodies)
	}
	entries, _ := journal.After("run-1", 0)
	if len(entries) != 2 || subscriptions.Load() != 1 {
		t.Fatalf("journal %+v after %d subscriptions", entries, subscriptions.Load())
	}
}

// An upstream stream that ends without a terminal event is a transport break:
// the run stays open, is subscribed again, and ends with its real terminal
// event, or with the gateway's word that it is over.
func TestTailTransportEndIsNotTheEndOfTheRun(t *testing.T) {
	fastResubscribe(t)
	for _, tc := range []struct {
		name        string
		status      string
		scripts     [][]string
		wantEntries int
		terminal    bool
	}{
		{"resubscribed until the terminal event", "running", [][]string{{deltaBlock}, {completedBlock}}, 2, true},
		{"finished according to the gateway", "completed", [][]string{{deltaBlock}}, 1, true},
		{"unknown to the gateway", "", [][]string{{deltaBlock}}, 1, true},
		{"gives up but stays open", "running", [][]string{{deltaBlock}}, 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			journal, err := NewJournal(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			gw, _ := replayGateway(t, "run-2", tc.status, tc.scripts...)
			c := New("", Auth{}, gw.URL, "secret", journal)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			c.tailRun(ctx, "run-2", "")
			entries, _ := journal.After("run-2", 0)
			if len(entries) != tc.wantEntries || journal.Status("run-2").Terminal != tc.terminal {
				t.Fatalf("entries %d terminal %v, want %d %v", len(entries), journal.Status("run-2").Terminal, tc.wantEntries, tc.terminal)
			}
		})
	}
}
