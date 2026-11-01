package connector

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Real Go client -> WebSocket -> production TypeScript broker. Only persistence
// and operator readiness are fixtures; no account or deployed host is touched.
func TestBrokerE2ELateCapabilitiesPreserveInflightRequest(t *testing.T) {
	if os.Getenv("OPENEDBOT_BROKER_E2E") != "1" {
		t.Skip("set OPENEDBOT_BROKER_E2E=1 to run the Bun/Go network E2E")
	}
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Fatal("Bun is required for the requested cross-language E2E")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// The TypeScript broker lives in OpenedBot/openedbot, checked out next to
	// this repository unless OPENEDBOT_DIR says otherwise.
	repo := os.Getenv("OPENEDBOT_DIR")
	if repo == "" {
		_, file, _, _ := runtime.Caller(0)
		repo = filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
	}
	if _, err := os.Stat(filepath.Join(repo, "tests/e2e/connector-broker-fixture.ts")); err != nil {
		t.Fatalf("openedbot repository not found at %s: expected the root of the OpenedBot/openedbot monorepo, or set OPENEDBOT_DIR", repo)
	}
	cmd := exec.CommandContext(ctx, bun, "tests/e2e/connector-broker-fixture.ts")
	cmd.Dir = repo
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = cmd.Wait() }()
	line := make(chan string, 1)
	go func() { scanner := bufio.NewScanner(stdout); scanner.Scan(); line <- scanner.Text() }()
	var address struct {
		URL string `json:"url"`
	}
	select {
	case raw := <-line:
		if err := json.Unmarshal([]byte(raw), &address); err != nil {
			t.Fatalf("fixture startup: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("fixture did not start")
	}
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
	client := New("ws"+strings.TrimPrefix(address.URL, "http")+"/ws", Auth{}, gateway.URL, "", nil)
	spoolDir := t.TempDir()
	client.Diagnostics, err = NewDiagnosticSpool(spoolDir)
	if err != nil {
		t.Fatal(err)
	}
	client.HTTP = gateway.Client()
	client.OperatorSocket = "/fixture/operator.sock"
	var ready atomic.Bool
	client.operator = &http.Client{Transport: readinessTransport(func(*http.Request) (*http.Response, error) {
		status := 503
		if ready.Load() {
			status = 200
		}
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"features":["provider_management"]}`))}, nil
	})}
	now := time.Now()
	initial := now
	client.now = func() time.Time { return now }
	recovered := make(chan struct{})
	client.wait = func(ctx context.Context, delay time.Duration) error {
		if now.Sub(initial) < 15*time.Second {
			now = now.Add(delay)
			return nil
		}
		select {
		case <-recovered:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	defer func() { cancel(); <-done }()
	type snapshot struct {
		Sockets, Closes  int
		Connected        bool
		Features, Events []string
		Diagnostics      []struct{ EventID, Code, State, Stack string }
	}
	readState := func() snapshot {
		request, _ := http.NewRequestWithContext(ctx, "GET", address.URL+"/state", nil)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var state snapshot
		if err := json.NewDecoder(response.Body).Decode(&state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	await := func(condition func(snapshot) bool) snapshot {
		for ctx.Err() == nil {
			state := readState()
			if condition(state) {
				return state
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("broker state deadline exceeded")
		return snapshot{}
	}
	before := await(func(s snapshot) bool { return s.Connected })
	if len(before.Features) != 0 {
		t.Fatalf("expected degraded hello: %+v", before)
	}
	response := make(chan string, 1)
	go func() {
		request, _ := http.NewRequestWithContext(ctx, "GET", address.URL+"/relay", nil)
		res, err := http.DefaultClient.Do(request)
		if err != nil {
			response <- err.Error()
			return
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		response <- string(body)
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("relayed request did not reach gateway")
	}
	ready.Store(true)
	close(recovered)
	after := await(func(s snapshot) bool { return len(s.Features) == 1 })
	if after.Features[0] != "provider_management" {
		t.Fatalf("capabilities not parsed: %+v", after)
	}
	close(release)
	select {
	case body := <-response:
		if body != `{"ok":true}` {
			t.Fatalf("inflight response: %s", body)
		}
	case <-ctx.Done():
		t.Fatal("inflight request did not complete")
	}
	after = await(func(s snapshot) bool { return len(s.Diagnostics) == 2 && len(client.Diagnostics.Pending()) == 0 })
	codes := map[string]bool{}
	for _, event := range after.Diagnostics {
		codes[event.Code] = true
		switch event.Code {
		case "OPERATOR_NOT_READY":
			if event.State != "unavailable" || !strings.Contains(event.Stack, "helloFeatures") || !strings.Contains(event.Stack, "client.go:") {
				t.Fatalf("missing operator failure reporting stack: %+v", event)
			}
		case "OPERATOR_RECOVERED":
			if event.State != "recovered" {
				t.Fatalf("invalid recovery diagnostic: %+v", event)
			}
		default:
			t.Fatalf("unexpected diagnostic: %+v", event)
		}
	}
	if !codes["OPERATOR_NOT_READY"] || !codes["OPERATOR_RECOVERED"] {
		t.Fatalf("missing unavailable/recovered diagnostic pair: %+v", after.Diagnostics)
	}
	reloaded, err := NewDiagnosticSpool(spoolDir)
	if err != nil || len(reloaded.Pending()) != 0 {
		t.Fatalf("broker ACK did not persist spool removal: %v", err)
	}
	if !after.Connected || after.Sockets != 1 || after.Closes != 0 || strings.Join(after.Events, ",") != "connected" {
		t.Fatalf("link changed during capability recovery: %+v", after)
	}
	t.Log("Go -> actual TS broker: capabilities and failure/recovery diagnostics with reporting stack persisted and ACKed on one WebSocket; spool durably empty; active HTTP request completed; no disconnect/replacement event")
}
