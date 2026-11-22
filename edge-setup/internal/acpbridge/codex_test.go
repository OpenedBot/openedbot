package acpbridge

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestCodexAppServerFixture(t *testing.T) {
	if os.Args[len(os.Args)-1] != "--codex-fixture" {
		return
	}
	encoder := json.NewEncoder(os.Stdout)
	reply := func(id json.RawMessage, result any) {
		if err := encoder.Encode(map[string]any{"id": id, "result": result}); err != nil {
			os.Exit(2)
		}
	}
	event := func(method string, params ...map[string]any) {
		message := map[string]any{"method": method, "params": params[0]}
		if method == "item/commandExecution/requestApproval" {
			message["id"] = "approval-1"
		}
		if err := encoder.Encode(message); err != nil {
			os.Exit(2)
		}
	}
	turn := func(status string) map[string]any {
		return map[string]any{"threadId": "thread", "turn": map[string]string{"id": "turn", "status": status}}
	}
	resumed := false
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var m rpcMessage
		if json.Unmarshal(scanner.Bytes(), &m) != nil {
			os.Exit(2)
		}
		switch m.Method {
		case "initialize":
			reply(m.ID, map[string]string{"userAgent": "fixture"})
		case "initialized":
		case "thread/resume", "thread/start":
			resumed = m.Method == "thread/resume"
			reply(m.ID, map[string]any{"thread": map[string]string{"id": "thread"}})
		case "turn/start":
			reply(m.ID, turn("inProgress"))
			event("turn/started", turn("inProgress"))
			delta := "from Codex"
			if resumed {
				delta = "resumed Codex thread"
			}
			var params map[string]any
			_ = json.Unmarshal(m.Params, &params)
			if params["effort"] != nil {
				delta = fmt.Sprintf("model=%v effort=%v tier=%v", params["model"], params["effort"], params["serviceTierForTurn"])
			}
			event("item/agentMessage/delta", map[string]any{"threadId": "thread", "turnId": "turn", "delta": delta})
			event("item/commandExecution/requestApproval", map[string]any{"threadId": "thread", "turnId": "turn", "command": "fixture command", "availableDecisions": []string{"accept", "decline"}})
		case "turn/interrupt":
			reply(m.ID, map[string]string{})
			event("turn/completed", turn("interrupted"))
		case "":
			var result map[string]string
			if json.Unmarshal(m.Result, &result) != nil {
				os.Exit(2)
			}
			if result["decision"] == "decline" {
				event("turn/completed", turn("completed"))
			}
		default:
			os.Exit(2)
		}
	}
	os.Exit(0)
}

func TestCodexRunApprovalAndResume(t *testing.T) {
	f := newFixture(t, "codex")
	f.opts.Protocol, f.opts.Workspace = ProtocolCodex, t.TempDir()
	f.opts.Catalogue = &Catalogue{Provider: CodexProvider, Name: "Codex CLI", Models: []AgentModel{{ID: "gpt-6.2-sol", Default: true}}}
	f.opts.AgentArguments = []string{"-test.run=^TestCodexAppServerFixture$", "--", "--codex-fixture"}
	f.restart()
	f.session("session")
	run := f.run(input("session"), "first")
	approval := f.await(run, "approval.request")
	status, body := f.request("POST", "/v1/runs/"+run+"/approval", map[string]any{
		"request_id": approval["request_id"], "execution_generation": approval["execution_generation"], "choice": "deny",
	}, "")
	if status != 200 {
		t.Fatalf("approval: %d %s", status, body)
	}
	expectTerminal(t, f.events(run), "run.completed")
	f.restart()
	run = f.run(input("session"), "second")
	chunk := f.await(run, "message.delta")
	if chunk["delta"] != "resumed Codex thread" {
		t.Fatalf("unexpected chunk: %v", chunk)
	}
	f.await(run, "approval.request")
	status, body = f.request("POST", "/v1/runs/"+run+"/stop", nil, "")
	if status != 200 {
		t.Fatalf("stop: %d %s", status, body)
	}
	expectTerminal(t, f.events(run), "run.cancelled")
}

func TestCodexModelChoiceReachesTurn(t *testing.T) {
	f := newFixture(t, "codex")
	f.opts.Protocol, f.opts.Workspace = ProtocolCodex, t.TempDir()
	f.opts.Catalogue = &Catalogue{Provider: CodexProvider, Name: "Codex CLI", Models: []AgentModel{
		{ID: "gpt-6.2-sol", Default: true, DefaultEffort: "low", Efforts: []string{"low", "medium", "high"}, Fast: true},
		{ID: "gpt-6-luna", DefaultEffort: "medium", Efforts: []string{"low", "medium"}},
	}}
	f.opts.AgentArguments = []string{"-test.run=^TestCodexAppServerFixture$", "--", "--codex-fixture"}
	f.restart()
	status, raw := f.request("GET", "/api/model/options", nil, "")
	if status != 200 || !strings.Contains(string(raw), `"model":"gpt-6.2-sol"`) || !strings.Contains(string(raw), `"gpt-6-luna":{"efforts":["low","medium"],"fast":false,"reasoning":true}`) {
		t.Fatalf("catalogue: %d %s", status, raw)
	}
	f.session("session")
	body := input("session")
	body["provider"], body["model"] = CodexProvider, "gpt-6.2-sol"
	body["model_options"] = map[string]any{"reasoning_effort": "high", "fast": true}
	run := f.run(body, "chosen")
	if chunk := f.await(run, "message.delta"); chunk["delta"] != "model=gpt-6.2-sol effort=high tier=priority" {
		t.Fatalf("turn overrides: %v", chunk)
	}
	f.await(run, "approval.request")
	if status, raw := f.request("POST", "/v1/runs/"+run+"/stop", nil, ""); status != 200 {
		t.Fatalf("stop: %d %s", status, raw)
	}
	expectTerminal(t, f.events(run), "run.cancelled")
	// Nothing chosen on the next turn: the defaults are sent again, so the
	// thread never keeps the previous turn's effort or speed.
	delete(body, "model")
	delete(body, "model_options")
	run = f.run(body, "defaults")
	if chunk := f.await(run, "message.delta"); chunk["delta"] != "model=gpt-6.2-sol effort=low tier=default" {
		t.Fatalf("turn defaults: %v", chunk)
	}
	f.await(run, "approval.request")
	if status, raw := f.request("POST", "/v1/runs/"+run+"/stop", nil, ""); status != 200 {
		t.Fatalf("stop: %d %s", status, raw)
	}
	expectTerminal(t, f.events(run), "run.cancelled")
	body["model"], body["model_options"] = "gpt-6-luna", map[string]any{"reasoning_effort": "high"}
	run = f.run(body, "unsupported")
	f.await(run, "run.failed")
	expectTerminal(t, f.events(run), "run.failed")
}
