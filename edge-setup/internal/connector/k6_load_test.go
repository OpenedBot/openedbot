package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// Opt-in fixture: production connector, synthetic loopback gateway, real TS broker.
func TestK6LoadHost(t *testing.T) {
	broker := os.Getenv("K6_BROKER_URL")
	if broker == "" {
		t.Skip("opt-in fixture: set K6_BROKER_URL to the broker under test")
	}
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/events") {
			id := strings.Split(r.URL.Path, "/")[3]
			w.Header().Set("Content-Type", "text/event-stream")
			for sequence := 0; sequence < 3; sequence++ {
				select {
				case <-r.Context().Done():
					return
				case <-time.After(25 * time.Millisecond):
				}
				fmt.Fprintf(w, "data: {\"id\":%q,\"seq\":%d}\n\n", id, sequence)
				w.(http.Flusher).Flush()
			}
			return
		}
		var body struct {
			ID    string `json:"id"`
			Delay int    `json:"delay"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad payload", 400)
			return
		}
		if body.Delay < 0 || body.Delay > 1000 {
			http.Error(w, "bad delay", 400)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Duration(body.Delay) * time.Millisecond):
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"id": body.ID, "payload_intact": true})
	}))
	defer gateway.Close()
	c := New(strings.Replace(broker, "http://", "ws://", 1)+"/link", Auth{RuntimeID: "load-runtime", LinkToken: "load-only"}, gateway.URL, "synthetic-gateway-token", nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			t.Fatalf("connector stopped unexpectedly: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
		response, err := client.Get(broker + "/finished")
		if err != nil {
			continue
		}
		response.Body.Close()
		if response.StatusCode == http.StatusNoContent {
			cancel()
			<-done
			return
		}
	}
	t.Fatal("load runner did not stop within 90 seconds")
}
