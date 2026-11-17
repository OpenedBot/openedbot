package acpbridge

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// TestACPAgent is a deterministic subprocess, not a mock of the RPC client.
// Its transcript is emitted in the answer so tests can inspect exact wire data.
func TestACPAgent(t *testing.T) {
	marker := -1
	for i, a := range os.Args {
		if a == "--acp-fake" {
			marker = i
			break
		}
	}
	if marker < 0 {
		return
	}
	scenario := os.Args[marker+1]
	enc := json.NewEncoder(os.Stdout)
	send := func(id json.RawMessage, result any) {
		_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	}
	update := func(sid string, u any) {
		_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": sid, "update": u}})
	}
	var promptID json.RawMessage
	var sessionID string
	var trace []rpcMessage
	var decisions []any
	newCount := 0
	permissionCount := 0
	permission := func() {
		permissionCount++
		_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": fmt.Sprintf("permission-%d", permissionCount), "method": "session/request_permission", "params": map[string]any{"sessionId": sessionID, "toolCall": map[string]any{"toolCallId": "t1", "title": "write a file"}, "options": func() []any {
			options := []any{map[string]string{"optionId": "a", "name": "Allow", "kind": "allow_once"}, map[string]string{"optionId": "d", "name": "Deny", "kind": "reject_once"}}
			if scenario != "permission-basic" {
				options = append(options, map[string]string{"optionId": "aa", "name": "Always", "kind": "allow_always"}, map[string]string{"optionId": "dd", "name": "Never", "kind": "reject_always"})
			}
			return options
		}()}})
	}
	answer := func() {
		raw, _ := json.Marshal(map[string]any{"trace": trace, "decisions": decisions, "cwd": func() string { s, _ := os.Getwd(); return s }()})
		update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": textBlock(string(raw))})
		send(promptID, map[string]string{"stopReason": "end_turn"})
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 8*1024*1024)
	for scanner.Scan() {
		var m rpcMessage
		if json.Unmarshal(scanner.Bytes(), &m) != nil {
			os.Exit(12)
		}
		if m.Method != "" {
			trace = append(trace, m)
		}
		var p map[string]any
		_ = json.Unmarshal(m.Params, &p)
		switch m.Method {
		case "initialize":
			caps := map[string]any{"loadSession": strings.Contains(scenario, "load"), "promptCapabilities": map[string]bool{"image": strings.Contains(scenario, "image")}}
			if strings.Contains(scenario, "system") {
				caps["sessionCapabilities"] = map[string]any{"systemPrompt": map[string]any{}}
			}
			send(m.ID, map[string]any{"protocolVersion": 1, "agentCapabilities": caps})
		case "session/new":
			newCount++
			send(m.ID, map[string]string{"sessionId": fmt.Sprintf("s%d", newCount)})
		case "session/load":
			update(p["sessionId"].(string), map[string]any{"sessionUpdate": "agent_message_chunk", "content": textBlock("OLD HISTORY MUST BE DROPPED")})
			send(m.ID, map[string]any{})
		case "session/prompt":
			promptID = m.ID
			sessionID = p["sessionId"].(string)
			switch scenario {
			case "environment":
				found := false
				for _, entry := range os.Environ() {
					if strings.Contains(entry, "fixture-bearer") {
						found = true
					}
				}
				raw, _ := json.Marshal(map[string]bool{"private": os.Getenv("ACP_BRIDGE_PRIVATE") != "", "bearer": found, "operator": os.Getenv("ACP_AGENT_ALLOWED") != "", "path": os.Getenv("PATH") != ""})
				update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": textBlock(string(raw))})
				send(m.ID, map[string]string{"stopReason": "end_turn"})
			case "crash":
				update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": textBlock("before crash")})
				os.Exit(7)
			case "error":
				_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{"code": -32603, "message": "private error detail"}})
			case "refusal", "max_tokens", "max_turn_requests", "cancelled":
				send(m.ID, map[string]string{"stopReason": scenario})
			case "logs":
				fmt.Fprintln(os.Stdout, "agent log line")
				answer()
			case "unicode":
				update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": textBlock(strings.Repeat("é", 40001))})
				send(m.ID, map[string]string{"stopReason": "end_turn"})
			case "huge":
				update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": textBlock(strings.Repeat("x", 200*1024))})
				send(m.ID, map[string]string{"stopReason": "end_turn"})
			case "log-flood":
				for i := 0; i < 10; i++ {
					fmt.Fprintln(os.Stdout, "agent log line")
				}
			case "permission", "permission-basic", "cancel", "cancel-end_turn", "cancel-no-response", "timeout", "timeout-ignore":
				permission()
			case "tools":
				update(sessionID, map[string]any{"sessionUpdate": "agent_thought_chunk", "content": textBlock("PRIVATE THOUGHT")})
				for _, id := range []string{"first", "second"} {
					update(sessionID, map[string]any{"sessionUpdate": "tool_call", "toolCallId": id, "title": "shell", "status": "in_progress"})
				}
				update(sessionID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "second", "status": "failed"})
				update(sessionID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "first", "status": "completed"})
				update(sessionID, map[string]any{"sessionUpdate": "plan", "entries": []any{}})
				update(sessionID, map[string]any{"sessionUpdate": "usage_update", "used": 10, "size": 100})
				answer()
			default:
				answer()
			}
		case "session/cancel":
			if strings.HasPrefix(scenario, "timeout") {
				update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": textBlock("cancel received")})
			}
			if scenario == "timeout-ignore" {
				continue
			}
			if scenario == "cancel-no-response" {
				continue
			}
			reason := "cancelled"
			if scenario == "cancel-end_turn" {
				reason = "end_turn"
			}
			send(promptID, map[string]string{"stopReason": reason})
		case "":
			var result any
			_ = json.Unmarshal(m.Result, &result)
			decisions = append(decisions, result)
			if scenario == "cancel" || scenario == "cancel-end_turn" {
				v := result.(map[string]any)
				if v["outcome"].(map[string]any)["outcome"] != "cancelled" {
					os.Exit(14)
				}
				update(sessionID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": textBlock("permission cancelled")})
			}
			if scenario == "permission" {
				if permissionCount == 1 {
					permission()
				} else {
					answer()
				}
			}
		default:
			os.Exit(13)
		}
	}
	os.Exit(0)
}

type fixture struct {
	t       *testing.T
	b       *Bridge
	server  *httptest.Server
	opts    Options
	profile string
}

func newFixture(t *testing.T, scenario string) *fixture {
	t.Helper()
	profiles := t.TempDir()
	if err := os.Mkdir(filepath.Join(profiles, "demo"), 0700); err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, profile: "demo", opts: Options{ListenAddress: "127.0.0.1:0", Bearer: "fixture-bearer", StateDirectory: t.TempDir(), ProfilesRoot: profiles, AgentCommand: os.Args[0], AgentArguments: []string{"-test.run=^TestACPAgent$", "--", "--acp-fake", scenario}, Limits: Limits{RPCTimeout: 5 * time.Second, CancelTimeout: time.Second}}}
	f.open()
	t.Cleanup(func() { _ = f.b.Close(); f.server.Close() })
	return f
}
func (f *fixture) open() {
	var err error
	f.b, err = New(f.opts)
	if err != nil {
		f.t.Fatal(err)
	}
	f.server = httptest.NewServer(f.b)
}
func (f *fixture) restart() {
	if err := f.b.Close(); err != nil {
		f.t.Fatal(err)
	}
	f.server.Close()
	f.open()
}
func (f *fixture) request(method, path string, body any, key string) (int, []byte) {
	f.t.Helper()
	raw, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, method, f.server.URL+"/p/"+f.profile+path, strings.NewReader(string(raw)))
	req.Header.Set("Authorization", "Bearer "+f.opts.Bearer)
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	return res.StatusCode, data
}
func (f *fixture) session(id string) {
	f.t.Helper()
	status, raw := f.request("POST", "/api/sessions", map[string]string{"id": id, "title": "test"}, "")
	if status != 201 {
		f.t.Fatalf("create session %d %s", status, raw)
	}
}
func (f *fixture) run(body any, key string) string {
	f.t.Helper()
	status, raw := f.request("POST", "/v1/runs", body, key)
	var v map[string]string
	_ = json.Unmarshal(raw, &v)
	if status/100 != 2 || v["run_id"] == "" {
		f.t.Fatalf("create run %d %s", status, raw)
	}
	return v["run_id"]
}
func input(session string) map[string]any {
	return map[string]any{"session_id": session, "input": "hello", "instructions": "be concise"}
}
func (f *fixture) events(id string) []Event {
	f.t.Helper()
	status, raw := f.request("GET", "/v1/runs/"+id+"/events", nil, "")
	if status != 200 {
		f.t.Fatalf("events %d %s", status, raw)
	}
	events := []Event{}
	scanner := bufio.NewScanner(strings.NewReader(string(raw)))
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "data: ") {
			var e Event
			if err := json.Unmarshal([]byte(strings.TrimPrefix(scanner.Text(), "data: ")), &e); err != nil {
				f.t.Fatal(err)
			}
			events = append(events, e)
		}
	}
	if err := scanner.Err(); err != nil {
		f.t.Fatal(err)
	}
	return events
}
func (f *fixture) await(id, event string) Event {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	for {
		f.b.mu.Lock()
		r := f.b.disk.Runs[id]
		for _, e := range r.Events {
			if e["event"] == event {
				f.b.mu.Unlock()
				return e
			}
		}
		wake := f.b.changed
		f.b.mu.Unlock()
		select {
		case <-wake:
		case <-ctx.Done():
			f.t.Fatalf("waiting for %s", event)
		}
	}
}
func expectTerminal(t *testing.T, events []Event, want string) {
	t.Helper()
	count := 0
	for _, e := range events {
		if strings.HasPrefix(e["event"].(string), "run.") {
			count++
			if e["event"] != want {
				t.Fatalf("terminal %+v want %s", e, want)
			}
		}
	}
	if count != 1 {
		t.Fatalf("terminal count %d: %+v", count, events)
	}
}
func completedTrace(t *testing.T, events []Event) []rpcMessage {
	t.Helper()
	var v struct {
		Trace []rpcMessage `json:"trace"`
	}
	out := events[len(events)-1]["output"].(string)
	start := strings.Index(out, `{"cwd"`)
	if start < 0 {
		start = 0
	}
	if err := json.Unmarshal([]byte(out[start:]), &v); err != nil {
		t.Fatalf("trace output %q: %v", out, err)
	}
	return v.Trace
}
func lastPrompt(t *testing.T, trace []rpcMessage) string {
	t.Helper()
	for i := len(trace) - 1; i >= 0; i-- {
		if trace[i].Method == "session/prompt" {
			return string(trace[i].Params)
		}
	}
	t.Fatal("no prompt")
	return ""
}

func TestRoutesAuthAndProfile(t *testing.T) {
	f := newFixture(t, "plain")
	raw, err := os.ReadFile("../../test/golden/run-contract/routes.json")
	if err != nil {
		t.Fatal(err)
	}
	var routes []struct {
		Method, Path string
		Mandatory    bool
	}
	if err = json.Unmarshal(raw, &routes); err != nil {
		t.Fatal(err)
	}
	for _, r := range routes {
		path := strings.ReplaceAll(strings.ReplaceAll(r.Path, "{id}", "absent"), "{slug}", "demo")
		path = strings.ReplaceAll(path, "{file}", "x")
		t.Run(r.Method+path, func(t *testing.T) {
			for _, profile := range []string{"demo", "missing"} {
				req, _ := http.NewRequest(r.Method, f.server.URL+"/p/"+profile+path, nil)
				res, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				res.Body.Close()
				if res.StatusCode != 401 {
					t.Fatalf("unprotected %d", res.StatusCode)
				}
				req.Header.Set("Authorization", "Bearer "+f.opts.Bearer)
				res, err = http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				res.Body.Close()
				if profile == "missing" && res.StatusCode != 404 {
					t.Fatalf("unknown profile %d", res.StatusCode)
				}
				if profile == "demo" && !r.Mandatory && path != "/api/model/options" && res.StatusCode != 404 {
					t.Fatalf("unsupported route %d", res.StatusCode)
				}
			}
		})
	}
	for _, path := range []string{"/health", "/v1/capabilities", "/v1/toolsets", "/api/model/options"} {
		status, raw := f.request("GET", path, nil, "")
		if status != 200 {
			t.Fatalf("%s %d %s", path, status, raw)
		}
	}
	for _, address := range []string{":0", "0.0.0.0:0", "localhost:0", "192.0.2.1:1"} {
		opts := f.opts
		opts.ListenAddress = address
		if b, err := New(opts); err == nil {
			_ = b.Close()
			t.Fatalf("accepted non-loopback %s", address)
		}
	}
}
func TestPlainAnswerReplayAndIdempotency(t *testing.T) {
	f := newFixture(t, "plain")
	f.session("cloud")
	id := f.run(input("cloud"), "same")
	events := f.events(id)
	expectTerminal(t, events, "run.completed")
	if f.run(input("cloud"), "same") != id {
		t.Fatal("idempotency lost")
	}
	if got := f.events(id); fmt.Sprint(got) != fmt.Sprint(events) {
		t.Fatal("late replay differs")
	}
	trace := completedTrace(t, events)
	if len(trace) != 3 {
		t.Fatalf("trace %+v", trace)
	}
	var init map[string]any
	_ = json.Unmarshal(trace[0].Params, &init)
	caps := init["clientCapabilities"].(map[string]any)
	fs := caps["fs"].(map[string]any)
	if caps["terminal"] != false || fs["readTextFile"] != false || fs["writeTextFile"] != false {
		t.Fatalf("client capabilities %v", caps)
	}
	f.restart()
	if f.run(input("cloud"), "same") != id {
		t.Fatal("durable idempotency lost")
	}
	expectTerminal(t, f.events(id), "run.completed")
}
func TestStopReasonsAndProcessDeath(t *testing.T) {
	for _, tc := range []struct{ scenario, want string }{{"refusal", "failed"}, {"max_tokens", "failed"}, {"max_turn_requests", "failed"}, {"cancelled", "cancelled"}, {"error", "failed"}, {"crash", "interrupted"}, {"logs", "completed"}, {"log-flood", "failed"}} {
		t.Run(tc.scenario, func(t *testing.T) {
			f := newFixture(t, tc.scenario)
			f.session("cloud")
			id := f.run(input("cloud"), "")
			events := f.events(id)
			expectTerminal(t, events, "run."+tc.want)
			_, raw := f.request("GET", "/v1/runs/"+id, nil, "")
			if strings.Contains(string(raw), "private error detail") {
				t.Fatal("RPC message leaked")
			}
			if tc.scenario == "logs" && !strings.Contains(string(raw), `"invalid_stdout_lines":1`) {
				t.Fatalf("logs not counted %s", raw)
			}
		})
	}
}
func TestToolIdentityAndDroppedThoughts(t *testing.T) {
	f := newFixture(t, "tools")
	f.session("cloud")
	events := f.events(f.run(input("cloud"), ""))
	expectTerminal(t, events, "run.completed")
	if events[0]["tool_call_id"] != "first" || events[1]["tool_call_id"] != "second" || events[2]["tool_call_id"] != "second" || events[2]["error"] != true || events[3]["tool_call_id"] != "first" {
		t.Fatalf("tool events %+v", events)
	}
	raw, _ := json.Marshal(events)
	if strings.Contains(string(raw), "PRIVATE THOUGHT") || strings.Contains(string(raw), "usage_update") {
		t.Fatal("thought/usage leaked")
	}
}
func TestPermissionAllowThenReject(t *testing.T) {
	f := newFixture(t, "permission")
	f.session("cloud")
	id := f.run(input("cloud"), "")
	first := f.await(id, "approval.request")
	for i, choice := range []string{"once", "deny"} {
		var e Event
		if i == 0 {
			e = first
		} else {
			f.b.mu.Lock()
			for _, candidate := range f.b.disk.Runs[id].Events {
				if candidate["event"] == "approval.request" && candidate["request_id"] != first["request_id"] {
					e = candidate
				}
			}
			f.b.mu.Unlock()
			if e == nil {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				for e == nil {
					f.b.mu.Lock()
					for _, candidate := range f.b.disk.Runs[id].Events {
						if candidate["event"] == "approval.request" && candidate["request_id"] != first["request_id"] {
							e = candidate
						}
					}
					wake := f.b.changed
					f.b.mu.Unlock()
					if e == nil {
						select {
						case <-wake:
						case <-ctx.Done():
							t.Fatal("second permission missing")
						}
					}
				}
			}
		}
		body := map[string]any{"request_id": e["request_id"], "execution_generation": e["execution_generation"], "choice": choice}
		if i == 0 {
			bad := map[string]any{"request_id": e["request_id"], "execution_generation": 999, "choice": choice}
			if status, _ := f.request("POST", "/v1/runs/"+id+"/approval", bad, ""); status != 409 {
				t.Fatal("accepted stale generation")
			}
			bad["execution_generation"] = 1
			bad["choice"] = "session"
			if status, _ := f.request("POST", "/v1/runs/"+id+"/approval", bad, ""); status != 400 {
				t.Fatal("accepted session scope")
			}
		}
		if status, raw := f.request("POST", "/v1/runs/"+id+"/approval", body, ""); status != 200 {
			t.Fatalf("approval %d %s", status, raw)
		}
	}
	events := f.events(id)
	expectTerminal(t, events, "run.completed")
	output := events[len(events)-1]["output"].(string)
	if !strings.Contains(output, `"optionId":"a"`) || !strings.Contains(output, `"optionId":"d"`) {
		t.Fatalf("ACP outcomes %s", output)
	}
}
func TestStopDominatesAgentEndTurn(t *testing.T) {
	for _, scenario := range []string{"cancel", "cancel-end_turn"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, scenario)
			f.session("cloud")
			id := f.run(input("cloud"), "")
			f.await(id, "approval.request")
			status, _ := f.request("POST", "/v1/runs/"+id+"/stop", nil, "")
			if status != 200 {
				t.Fatal(status)
			}
			expectTerminal(t, f.events(id), "run.cancelled")
			f.b.mu.Lock()
			if len(f.b.disk.Runs[id].permissions) != 0 {
				t.Error("permissions left open")
			}
			f.b.mu.Unlock()
		})
	}
}
func TestSessionAndCapacityAdmission(t *testing.T) {
	f := newFixture(t, "permission")
	f.session("one")
	id := f.run(input("one"), "pending-key")
	f.await(id, "approval.request")
	if f.run(input("one"), "pending-key") != id {
		t.Fatal("active idempotency lost")
	}
	if status, _ := f.request("POST", "/v1/runs", input("one"), ""); status != 409 {
		t.Fatal("concurrent session accepted")
	}
	f.b.mu.Lock()
	f.b.opts.Limits.MaxConcurrentRuns = 1
	f.b.mu.Unlock()
	f.session("two")
	if status, _ := f.request("POST", "/v1/runs", input("two"), ""); status != 429 {
		t.Fatal("capacity exceeded")
	}
}
func TestInstructionsAndHistory(t *testing.T) {
	for _, scenario := range []string{"plain", "system", "load", "load-system"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, scenario)
			f.session("cloud")
			body := input("cloud")
			body["conversation_history"] = []any{map[string]string{"role": "user", "content": "old question"}, map[string]string{"role": "assistant", "content": "old answer"}}
			events := f.events(f.run(body, ""))
			trace := completedTrace(t, events)
			prompt := lastPrompt(t, trace)
			if strings.Contains(prompt, "old question") {
				t.Fatal("history injected into fresh session")
			}
			hasSystem := strings.Contains(scenario, "system")
			if strings.Contains(string(trace[1].Params), `"systemPrompt"`) != hasSystem {
				t.Fatalf("session creation %s", trace[1].Params)
			}
			if strings.Contains(prompt, "Instructions:") == hasSystem {
				t.Fatalf("instruction delivery %s", prompt)
			}
			body["instructions"] = "new instructions"
			events = f.events(f.run(body, ""))
			prompt = lastPrompt(t, completedTrace(t, events))
			if !strings.Contains(prompt, "new instructions") {
				t.Fatal("changed instructions missing")
			}
			events = f.events(f.run(body, ""))
			if strings.Contains(lastPrompt(t, completedTrace(t, events)), "Instructions:") {
				t.Fatal("repeated unchanged instructions")
			}
			f.restart()
			events = f.events(f.run(body, ""))
			trace = completedTrace(t, events)
			prompt = lastPrompt(t, trace)
			if strings.Contains(scenario, "load") {
				if trace[1].Method != "session/load" || strings.Contains(prompt, "old question") {
					t.Fatalf("load %s %s", trace[1].Method, prompt)
				}
			} else {
				if !strings.Contains(prompt, "old question") || strings.Index(prompt, "old question") > strings.Index(prompt, "old answer") {
					t.Fatalf("ordered history missing %s", prompt)
				}
				if events[0]["event"] != "context.rebuilt" {
					t.Fatal("rebuild event missing")
				}
			}
			raw, _ := json.Marshal(events)
			if strings.Contains(string(raw), "OLD HISTORY MUST BE DROPPED") {
				t.Fatal("loaded history leaked into current output")
			}
		})
	}
}
func TestRebuildWithoutHistoryAndInterruptedRestart(t *testing.T) {
	f := newFixture(t, "cancel")
	f.session("cloud")
	id := f.run(input("cloud"), "")
	f.await(id, "approval.request")
	f.restart()
	expectTerminal(t, f.events(id), "run.interrupted")
	f.opts.AgentArguments[len(f.opts.AgentArguments)-1] = "plain"
	f.restart()
	events := f.events(f.run(input("cloud"), ""))
	if events[0]["event"] != "context.rebuilt" || events[0]["history_restored"] != false {
		t.Fatal("missing no-history rebuild notice")
	}
}
func TestImagesAndModelSelection(t *testing.T) {
	for _, scenario := range []string{"plain", "image"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, scenario)
			f.session("cloud")
			body := input("cloud")
			body["input"] = []any{map[string]any{"role": "user", "content": []any{map[string]string{"type": "text", "text": "look"}, map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:image/png;base64,aGVsbG8="}}}}}
			events := f.events(f.run(body, ""))
			want := "run.failed"
			if scenario == "image" {
				want = "run.completed"
				if !strings.Contains(lastPrompt(t, completedTrace(t, events)), `"mimeType":"image/png"`) {
					t.Fatal("image shape missing")
				}
			}
			expectTerminal(t, events, want)
			body = input("cloud")
			body["model"] = "unavailable"
			expectTerminal(t, f.events(f.run(body, "")), "run.failed")
		})
	}
}

func TestIdleAgentIsStoppedAndContextRebuilt(t *testing.T) {
	f := newFixture(t, "plain")
	f.b.opts.Limits.IdleTimeout = 10 * time.Millisecond
	f.session("cloud")
	expectTerminal(t, f.events(f.run(input("cloud"), "")), "run.completed")
	f.b.wg.Wait()
	f.b.mu.Lock()
	p := f.b.profiles["demo"]
	f.b.mu.Unlock()
	p.mu.Lock()
	client := p.client
	p.mu.Unlock()
	select {
	case <-client.done:
	case <-time.After(5 * time.Second):
		t.Fatal("idle agent was not stopped")
	}
	events := f.events(f.run(input("cloud"), ""))
	expectTerminal(t, events, "run.completed")
	if events[0]["event"] != "context.rebuilt" {
		t.Fatal("idle restart lost rebuild notice")
	}
	trace := completedTrace(t, events)
	var result struct {
		CWD string `json:"cwd"`
	}
	out := events[len(events)-1]["output"].(string)
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if result.CWD != filepath.Join(f.opts.ProfilesRoot, "demo") {
		t.Fatalf("agent cwd %s", result.CWD)
	}
	if trace[0].Method != "initialize" {
		t.Fatal("new process was not initialized")
	}
}
func TestUncleanRestartRecoversPersistedInflightRun(t *testing.T) {
	f := newFixture(t, "plain")
	if err := f.b.Close(); err != nil {
		t.Fatal(err)
	}
	f.server.Close()
	seed := diskState{Sessions: map[string]*session{"demo/cloud": {Profile: "demo", ID: "cloud", ACPID: "old", Used: true}}, Runs: map[string]*run{"lost": {ID: "lost", Profile: "demo", SessionID: "cloud", Key: "lost-key", Status: "running", Events: []Event{{"event": "message.delta", "run_id": "lost", "timestamp": 1, "delta": "partial"}}}}}
	raw, err := json.Marshal(seed)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(f.opts.StateDirectory, "state.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}

	if err = os.MkdirAll(filepath.Join(f.opts.StateDirectory, "events"), 0700); err != nil {
		t.Fatal(err)
	}
	event, _ := json.Marshal(seed.Runs["lost"].Events[0])
	if err = os.WriteFile(filepath.Join(f.opts.StateDirectory, "events", "lost.jsonl"), append(append(event, '\n'), []byte(`{"event":`)...), 0600); err != nil {
		t.Fatal(err)
	}
	f.open()
	events := f.events("lost")
	expectTerminal(t, events, "run.interrupted")
	if len(events) != 2 {
		t.Fatalf("lost prefix %+v", events)
	}
	if f.run(input("cloud"), "lost-key") != "lost" {
		t.Fatal("inflight idempotency not retained")
	}
	f.restart()
	if len(f.events("lost")) != 2 {
		t.Fatal("duplicate interruption after restart")
	}
}
func TestPermissionChoicesMatchAgentOptions(t *testing.T) {
	for _, scenario := range []string{"permission-basic", "permission"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, scenario)
			f.session("cloud")
			id := f.run(input("cloud"), "")
			e := f.await(id, "approval.request")
			choices := e["choices"].([]string)
			want := []string{"once", "deny"}
			if scenario == "permission" {
				want = append(want, "always")
			}
			if fmt.Sprint(choices) != fmt.Sprint(want) {
				t.Fatalf("choices %v", choices)
			}
			body := map[string]any{"request_id": e["request_id"], "execution_generation": 1, "choice": "always"}
			status, _ := f.request("POST", "/v1/runs/"+id+"/approval", body, "")
			if scenario == "permission-basic" && status != 400 {
				t.Fatal("accepted unoffered always")
			}
			if scenario == "permission" && status != 200 {
				t.Fatal("rejected offered always")
			}
		})
	}
}
func TestCancelWithoutAgentReplyIsBounded(t *testing.T) {
	f := newFixture(t, "cancel-no-response")
	f.b.opts.Limits.CancelTimeout = 10 * time.Millisecond
	f.session("cloud")
	id := f.run(input("cloud"), "")
	f.await(id, "approval.request")
	f.request("POST", "/v1/runs/"+id+"/stop", nil, "")
	expectTerminal(t, f.events(id), "run.cancelled")
}
func TestOutputBoundAndPerRunInvalidLineCount(t *testing.T) {
	f := newFixture(t, "huge")
	f.session("cloud")
	expectTerminal(t, f.events(f.run(input("cloud"), "")), "run.failed")
	logs := newFixture(t, "logs")
	logs.b.opts.Limits.MaxInvalidLines = 1
	logs.session("cloud")
	for i := 0; i < 3; i++ {
		id := logs.run(input("cloud"), "")
		expectTerminal(t, logs.events(id), "run.completed")
		_, raw := logs.request("GET", "/v1/runs/"+id, nil, "")
		if !strings.Contains(string(raw), `"invalid_stdout_lines":1`) {
			t.Fatalf("stdout count %s", raw)
		}
	}
}
func TestProfileRunOwnership(t *testing.T) {
	f := newFixture(t, "plain")
	f.session("cloud")
	id := f.run(input("cloud"), "")
	f.events(id)
	if err := os.Mkdir(filepath.Join(f.opts.ProfilesRoot, "other"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "/events", "/stop", "/approval"} {
		method := "GET"
		if suffix == "/stop" || suffix == "/approval" {
			method = "POST"
		}
		req, _ := http.NewRequest(method, f.server.URL+"/p/other/v1/runs/"+id+suffix, nil)
		req.Header.Set("Authorization", "Bearer "+f.opts.Bearer)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 404 {
			t.Fatalf("cross-profile run %s %d", suffix, res.StatusCode)
		}
	}
}

func TestMessageChunksKeepUTF8AndContractBounds(t *testing.T) {
	f := newFixture(t, "unicode")
	f.session("cloud")
	events := f.events(f.run(input("cloud"), ""))
	expectTerminal(t, events, "run.completed")
	text := ""
	for _, e := range events {
		if e["event"] == "message.delta" {
			delta := e["delta"].(string)
			if len(delta) > 64*1024 || !utf8.ValidString(delta) {
				t.Fatal("invalid chunk boundary")
			}
			text += delta
		}
	}
	if text != strings.Repeat("é", 40001) || events[len(events)-1]["output"] != text {
		t.Fatal("chunked full output differs")
	}
}

func TestOneProcessPerProfile(t *testing.T) {
	f := newFixture(t, "plain")
	f.session("cloud")
	f.events(f.run(input("cloud"), ""))
	f.b.mu.Lock()
	p := f.b.profiles["demo"]
	f.b.mu.Unlock()
	p.mu.Lock()
	first := p.client
	p.mu.Unlock()
	f.session("second")
	f.events(f.run(input("second"), ""))
	p.mu.Lock()
	same := p.client
	p.mu.Unlock()
	if same != first {
		t.Fatal("one profile started another agent")
	}
	if err := os.Mkdir(filepath.Join(f.opts.ProfilesRoot, "other"), 0700); err != nil {
		t.Fatal(err)
	}
	f.profile = "other"
	f.session("cloud")
	events := f.events(f.run(input("cloud"), ""))
	if !strings.Contains(events[len(events)-1]["output"].(string), filepath.Join(f.opts.ProfilesRoot, "other")) {
		t.Fatal("other profile working directory missing")
	}
	f.b.mu.Lock()
	other := f.b.profiles["other"]
	f.b.mu.Unlock()
	other.mu.Lock()
	second := other.client
	other.mu.Unlock()
	if second == first || second.cmd.Process.Pid == first.cmd.Process.Pid {
		t.Fatal("profiles share agent process")
	}
}

func TestAgentEnvironmentExcludesBridgeSecrets(t *testing.T) {
	f := newFixture(t, "environment")
	t.Setenv("ACP_BRIDGE_PRIVATE", "fixture-private")
	t.Setenv("ACP_BRIDGE_BEARER", f.opts.Bearer)
	t.Setenv("ACP_AGENT_ALLOWED", "fixture-allowed")
	f.b.opts.AgentEnvironment = []string{"ACP_AGENT_ALLOWED", "ACP_BRIDGE_BEARER"}
	f.session("cloud")
	events := f.events(f.run(input("cloud"), ""))
	expectTerminal(t, events, "run.completed")
	var visible map[string]bool
	if err := json.Unmarshal([]byte(events[len(events)-1]["output"].(string)), &visible); err != nil {
		t.Fatal(err)
	}
	if visible["private"] || visible["bearer"] {
		t.Fatal("agent inherited bridge-only environment or bearer")
	}
	if !visible["operator"] {
		t.Fatal("operator allowlist missing")
	}
	if !visible["path"] {
		t.Fatal("default PATH missing")
	}
}

func TestAppendOnlyStorageRetentionAndSessionDeletion(t *testing.T) {
	t.Run("periodic retention", func(t *testing.T) {
		f := newFixture(t, "plain")
		f.session("cloud")
		id := f.run(input("cloud"), "")
		f.events(id)
		f.b.mu.Lock()
		f.b.pruneLocked(time.Now().Add(8 * 24 * time.Hour))
		f.b.mu.Unlock()
		if status, _ := f.request("GET", "/v1/runs/"+id, nil, ""); status != 404 {
			t.Fatal("periodic sweep retained expired run")
		}
	})

	t.Run("chunks do not rewrite headers", func(t *testing.T) {
		f := newFixture(t, "cancel")
		f.session("cloud")
		id := f.run(input("cloud"), "")
		f.await(id, "approval.request")
		before, err := os.ReadFile(filepath.Join(f.opts.StateDirectory, "state.json"))
		if err != nil {
			t.Fatal(err)
		}
		f.b.mu.Lock()
		f.b.eventLocked(f.b.disk.Runs[id], "message.delta", Event{"delta": "stored chunk"})
		f.b.mu.Unlock()
		after, err := os.ReadFile(filepath.Join(f.opts.StateDirectory, "state.json"))
		if err != nil {
			t.Fatal(err)
		}
		if string(before) != string(after) || strings.Contains(string(after), `"events"`) {
			t.Fatal("message chunk rewrote all run events into state.json")
		}
		events, err := os.ReadFile(filepath.Join(f.opts.StateDirectory, "events", id+".jsonl"))
		if err != nil || !strings.Contains(string(events), "stored chunk") {
			t.Fatal("append-only event missing")
		}
	})
	t.Run("session deletion persists", func(t *testing.T) {
		f := newFixture(t, "plain")
		f.session("cloud")
		if status, raw := f.request("DELETE", "/api/sessions/cloud", nil, ""); status != 204 {
			t.Fatalf("delete %d %s", status, raw)
		}
		f.restart()
		if status, _ := f.request("POST", "/v1/runs", input("cloud"), ""); status != 404 {
			t.Fatal("deleted session retained")
		}
		_, raw := f.request("GET", "/v1/capabilities", nil, "")
		if !strings.Contains(string(raw), "session_delete") {
			t.Fatal("delete endpoint not announced")
		}
	})
	t.Run("startup retention", func(t *testing.T) {
		f := newFixture(t, "plain")
		_ = f.b.Close()
		f.server.Close()
		past := time.Now().Add(-8 * 24 * time.Hour)
		seed := map[string]any{"sessions": map[string]any{}, "runs": map[string]any{"expired": map[string]any{"run_id": "expired", "profile": "demo", "session_id": "cloud", "status": "completed", "terminal_at": past}}}
		raw, _ := json.Marshal(seed)
		if err := os.WriteFile(filepath.Join(f.opts.StateDirectory, "state.json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(f.opts.StateDirectory, "events"), 0700); err != nil {
			t.Fatal(err)
		}
		event, _ := json.Marshal(Event{"event": "run.completed", "run_id": "expired", "timestamp": float64(past.Unix()), "output": "old"})
		if err := os.WriteFile(filepath.Join(f.opts.StateDirectory, "events", "expired.jsonl"), append(event, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
		f.open()
		if status, _ := f.request("GET", "/v1/runs/expired", nil, ""); status != 404 {
			t.Fatal("expired run retained")
		}
		if _, err := os.Stat(filepath.Join(f.opts.StateDirectory, "events", "expired.jsonl")); !os.IsNotExist(err) {
			t.Fatal("expired events retained")
		}
	})
}

func TestContextRebuildMetadataDoesNotChangeAnswer(t *testing.T) {
	f := newFixture(t, "plain")
	f.session("cloud")
	f.events(f.run(input("cloud"), ""))
	f.restart()
	events := f.events(f.run(input("cloud"), ""))
	text := ""
	metadata := false
	for _, e := range events {
		if e["event"] == "message.delta" {
			text += e["delta"].(string)
		}
		if e["event"] == "context.rebuilt" {
			metadata = true
		}
	}
	if text != events[len(events)-1]["output"] {
		t.Fatal("rebuild notice changed deltas without changing completed output")
	}
	if !metadata {
		t.Fatal("dedicated rebuild metadata missing")
	}
}

func TestTurnTimeoutCancelsBeforeKillingSharedAgent(t *testing.T) {
	for _, scenario := range []string{"timeout", "timeout-ignore"} {
		t.Run(scenario, func(t *testing.T) {
			f := newFixture(t, scenario)
			f.b.opts.Limits.CancelTimeout = 40 * time.Millisecond
			f.b.opts.Limits.TurnTimeout = 80 * time.Millisecond
			f.session("cloud")
			id := f.run(input("cloud"), "")
			f.await(id, "approval.request")
			events := f.events(id)
			expectTerminal(t, events, "run.failed")
			if !strings.Contains(events[len(events)-1]["message"].(string), "timeout") {
				t.Fatal("turn timeout has no explicit timeout diagnostic")
			}
			cancelled := false
			for _, e := range events {
				if e["delta"] == "cancel received" {
					cancelled = true
				}
			}
			if !cancelled {
				t.Fatal("agent was killed without session/cancel")
			}
			f.b.mu.Lock()
			p := f.b.profiles["demo"]
			f.b.mu.Unlock()
			p.mu.Lock()
			alive := p.client.alive()
			p.mu.Unlock()
			if (scenario == "timeout") != alive {
				t.Fatalf("unexpected agent liveness for %s: %t", scenario, alive)
			}
		})
	}
}

func TestPromptCacheHintsDoNotRejectDefaultModel(t *testing.T) {
	f := newFixture(t, "plain")
	f.session("cloud")
	for _, ttl := range []string{"5m", "1h"} {
		body := input("cloud")
		body["model_options"] = map[string]any{"prompt_cache_ttl": ttl}
		events := f.events(f.run(body, ""))
		expectTerminal(t, events, "run.completed")
		if strings.Contains(lastPrompt(t, completedTrace(t, events)), "prompt_cache_ttl") {
			t.Fatal("cache hint changed the ACP prompt")
		}
	}
	for _, options := range []map[string]any{{"reasoning_effort": "high"}, {"fast": true}, {"unknown": true}} {
		body := input("cloud")
		body["model_options"] = options
		expectTerminal(t, f.events(f.run(body, "")), "run.failed")
	}
	for _, field := range []string{"model", "provider"} {
		body := input("cloud")
		body[field] = "unknown"
		expectTerminal(t, f.events(f.run(body, "")), "run.failed")
	}
}
