package connector

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/acpbridge"
)

// This smaller agent exercises the connector test binary as an ACP subprocess.
// The richer ACP wire scenarios live in acpbridge/bridge_test.go.
func TestConnectorACPAgent(t *testing.T) {
	enabled := false
	for _, arg := range os.Args {
		if arg == "--connector-acp" {
			enabled = true
		}
	}
	if !enabled {
		return
	}
	enc := json.NewEncoder(os.Stdout)
	send := func(id any, result any) { _ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result}) }
	var promptID any
	sid := ""
	mode := ""
	answer := func(text string) {
		_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": text}}}})
		send(promptID, map[string]string{"stopReason": "end_turn"})
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var m struct {
			ID     any            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
			Result map[string]any `json:"result"`
		}
		if json.Unmarshal(scanner.Bytes(), &m) != nil {
			os.Exit(2)
		}
		switch m.Method {
		case "initialize":
			send(m.ID, map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]bool{"loadSession": true}})
		case "session/new":
			send(m.ID, map[string]string{"sessionId": "connector-session"})
		case "session/load":
			send(m.ID, map[string]any{})
		case "session/prompt":
			promptID = m.ID
			sid = m.Params["sessionId"].(string)
			prompt := m.Params["prompt"].([]any)
			mode = prompt[len(prompt)-1].(map[string]any)["text"].(string)
			if mode == "plain" {
				answer("bridge answer")
				continue
			}
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": "gate", "method": "session/request_permission", "params": map[string]any{"sessionId": sid, "toolCall": map[string]string{"toolCallId": "write", "title": "write file"}, "options": []any{map[string]string{"optionId": "allow", "name": "Allow", "kind": "allow_once"}, map[string]string{"optionId": "reject", "name": "Reject", "kind": "reject_once"}}}})
		case "session/cancel":
			send(promptID, map[string]string{"stopReason": "end_turn"})
		case "":
			outcome := m.Result["outcome"].(map[string]any)
			if outcome["outcome"] == "selected" {
				answer(outcome["optionId"].(string))
			}
		default:
			os.Exit(3)
		}
	}
	os.Exit(0)
}

func TestACPBridgeThroughConnectorRelayAndJournal(t *testing.T) {
	profiles := t.TempDir()
	if err := os.Mkdir(filepath.Join(profiles, "demo"), 0700); err != nil {
		t.Fatal(err)
	}
	opts := acpbridge.Options{ListenAddress: "127.0.0.1:0", Bearer: "local-test-bearer", StateDirectory: t.TempDir(), ProfilesRoot: profiles, AgentCommand: os.Args[0], AgentArguments: []string{"-test.run=^TestConnectorACPAgent$", "--", "--connector-acp"}}
	bridge, err := acpbridge.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	var handlerMu sync.RWMutex
	current := bridge
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlerMu.RLock()
		h := current
		handlerMu.RUnlock()
		h.ServeHTTP(w, r)
	}))
	defer gateway.Close()
	defer func() { _ = current.Close() }()
	broker := newBroker(t)
	journalDir := t.TempDir()
	journal, err := NewJournal(journalDir)
	if err != nil {
		t.Fatal(err)
	}
	client := New(broker.wsURL(), Auth{}, gateway.URL, opts.Bearer, journal)
	client.HTTP = gateway.Client()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- client.Session(ctx) }()
	defer func() { cancel(); <-finished }()
	select {
	case <-broker.ready:
	case <-ctx.Done():
		t.Fatal("connector did not connect")
	}
	var requestID uint32
	request := func(method, path string, body any, key string) (int, string) {
		t.Helper()
		requestID++
		headers := map[string]string{"content-type": "application/json"}
		if key != "" {
			headers["idempotency-key"] = key
		}
		kind := "none"
		if body != nil {
			kind = "stream"
		}
		broker.send(Text{T: TReq, ID: requestID, Method: method, Path: "/p/demo" + path, Headers: headers, Body: kind})
		if body != nil {
			raw, _ := json.Marshal(body)
			broker.sendBinary(requestID, raw)
			broker.send(Text{T: TEnd, ID: requestID})
		}
		res := broker.next(t)
		if res.T != TRes || res.ID != requestID {
			t.Fatalf("relay response %+v", res)
		}
		return res.Status, broker.body(t, requestID)
	}
	if status, body := request("GET", "/v1/capabilities", nil, ""); status != 200 || !strings.Contains(body, `"event_replay":true`) || !strings.Contains(body, `"run_steer":false`) {
		t.Fatalf("capabilities %d %s", status, body)
	}
	if status, body := request("POST", "/api/sessions", map[string]string{"id": "cloud", "title": "relay"}, ""); status != 201 {
		t.Fatalf("session %d %s", status, body)
	}
	create := func(mode, key string) string {
		t.Helper()
		status, raw := request("POST", "/v1/runs", map[string]string{"session_id": "cloud", "input": mode, "instructions": "be concise"}, key)
		var v map[string]string
		_ = json.Unmarshal([]byte(raw), &v)
		if status/100 != 2 || v["run_id"] == "" {
			t.Fatalf("run %d %s", status, raw)
		}
		return v["run_id"]
	}
	waitEvent := func(id, event string) map[string]any {
		t.Helper()
		var cursor uint64
		for {
			entries, err := journal.After(id, cursor)
			if err != nil {
				t.Fatal(err)
			}
			for _, e := range entries {
				cursor = e.Seq
				for _, line := range strings.Split(e.Event, "\n") {
					if strings.HasPrefix(line, "data: ") {
						var v map[string]any
						_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &v)
						if v["event"] == event {
							return v
						}
					}
				}
			}
			if !journal.Wait(id, cursor, ctx.Done()) && ctx.Err() != nil {
				t.Fatalf("missing event %s", event)
			}
		}
	}
	replay := func(id string, since int) string {
		t.Helper()
		status, body := request("GET", fmt.Sprintf("/v1/runs/%s/events?since=%d", id, since), nil, "")
		if status != 200 {
			t.Fatal(status)
		}
		return body
	}
	plain := create("plain", "plain-key")
	waitEvent(plain, "run.completed")
	first := replay(plain, 0)
	if !strings.Contains(first, "id: 1\n") || !strings.Contains(first, "bridge answer") {
		t.Fatalf("numbered run %s", first)
	}
	if create("plain", "plain-key") != plain {
		t.Fatal("relayed idempotency lost")
	}
	if replay(plain, 0) != first {
		t.Fatal("late resubscription differs")
	}
	if strings.Contains(replay(plain, 1), "id: 1\n") {
		t.Fatal("connector cursor ignored")
	}
	for _, choice := range []string{"once", "deny"} {
		id := create("approval", "")
		gate := waitEvent(id, "approval.request")
		status, body := request("POST", "/v1/runs/"+id+"/approval", map[string]any{"request_id": gate["request_id"], "execution_generation": gate["execution_generation"], "choice": choice}, "")
		if status != 200 {
			t.Fatalf("approval %d %s", status, body)
		}
		waitEvent(id, "run.completed")
		body = replay(id, 0)
		if !strings.Contains(body, "approval.responded") || !strings.Contains(body, `"choice":"`+choice+`"`) {
			t.Fatalf("approval journal %s", body)
		}
	}
	stopped := create("stop", "")
	waitEvent(stopped, "approval.request")
	if status, body := request("POST", "/v1/runs/"+stopped+"/stop", nil, ""); status != 200 {
		t.Fatalf("stop %d %s", status, body)
	}
	waitEvent(stopped, "run.cancelled")
	if strings.Contains(replay(stopped, 0), `"event":"run.completed"`) {
		t.Fatal("agent end_turn overrode stop")
	}
	interrupted := create("restart", "")
	waitEvent(interrupted, "approval.request")
	if err := current.Close(); err != nil {
		t.Fatal(err)
	}
	waitEvent(interrupted, "run.interrupted")
	reopened, err := acpbridge.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	handlerMu.Lock()
	current = reopened
	handlerMu.Unlock()
	for _, id := range []string{plain, interrupted} {
		status, body := request("GET", "/v1/runs/"+id, nil, "")
		if status != 200 {
			t.Fatalf("restart status %d %s", status, body)
		}
		if id == plain && !strings.Contains(body, `"status":"completed"`) {
			t.Fatal(body)
		}
		if id == interrupted && !strings.Contains(body, `"status":"interrupted"`) {
			t.Fatal(body)
		}
	}
	reloaded, err := NewJournal(journalDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{plain, stopped, interrupted} {
		if !reloaded.Status(id).Terminal {
			t.Fatalf("journal not durable %s", id)
		}
	}
	after := create("plain", "")
	waitEvent(after, "run.completed")
	if body := replay(after, 0); !strings.Contains(body, "bridge answer") {
		t.Fatal(body)
	}
	t.Log("real connector WebSocket relay and durable journal: run, both approvals, stop overriding end_turn, numbered late replay, bridge restart and continued session")
}

func TestACPBridgeRootProbeAndRunRefusalThroughConnector(t *testing.T) {
	opts := acpbridge.Options{ListenAddress: "127.0.0.1:0", Bearer: "probe-fixture-bearer", StateDirectory: t.TempDir(), ProfilesRoot: t.TempDir(), AgentCommand: os.Args[0]}
	bridge, err := acpbridge.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	defer bridge.Close()
	gateway := httptest.NewServer(bridge)
	defer gateway.Close()
	broker := newBroker(t)
	client := New(broker.wsURL(), Auth{}, gateway.URL, opts.Bearer, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.Session(ctx) }()
	defer func() { cancel(); <-done }()
	select {
	case <-broker.ready:
	case <-ctx.Done():
		t.Fatal("connector not ready")
	}
	var id uint32
	relay := func(method, path string) (int, string) {
		t.Helper()
		id++
		broker.send(Text{T: TReq, ID: id, Method: method, Path: path, Body: "none"})
		res := broker.next(t)
		if res.T != TRes {
			t.Fatalf("unexpected relay frame %+v", res)
		}
		return res.Status, broker.body(t, id)
	}
	for _, path := range []string{"/health", "/v1/capabilities", "/v1/toolsets", "/api/model/options"} {
		if status, body := relay("GET", path); status != 200 {
			t.Fatalf("root probe %s: %d %s", path, status, body)
		}
		if status, _ := relay("GET", "/p/missing"+path); status != 404 {
			t.Fatalf("unknown profile %s: %d", path, status)
		}
	}
	for _, path := range []string{"/api/sessions", "/v1/runs"} {
		status, body := relay("POST", path)
		var failure struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		decodeErr := json.Unmarshal([]byte(body), &failure)
		if status != 400 || decodeErr != nil || failure.Error.Code != "profile_required" || !strings.Contains(failure.Error.Message, "/p/<slug>") {
			t.Fatalf("root mutation %d %s", status, body)
		}
	}
}
