package acpbridge

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"time"
)

// CodexProvider is the catalogue slug of the local Codex CLI.
const CodexProvider = "openai-codex"

func initializeCodex(ctx context.Context, client *rpcClient) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var result struct {
		UserAgent string `json:"userAgent"`
	}
	if err := client.call(ctx, "initialize", map[string]any{
		"clientInfo": map[string]string{"name": "openedbot", "version": "1"},
	}, &result); err != nil {
		return errors.New("the Codex App Server did not initialize")
	}
	return client.notify(ctx, "initialized", nil)
}

// ProbeCodex checks the protocol and the CLI's local login without running a
// turn, and returns the models the CLI offers to this account.
func ProbeCodex(ctx context.Context, path string, env []string, workspace string) (*Catalogue, error) {
	client, err := startRPC(path, []string{"app-server"}, env, workspace, true, 4, 5*time.Second, func(*rpcClient, rpcMessage) {})
	if err != nil {
		return nil, errors.New("could not start the detected Codex CLI")
	}
	defer client.stop()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := initializeCodex(ctx, client); err != nil {
		return nil, err
	}
	var result struct {
		Account      json.RawMessage `json:"account"`
		RequiresAuth bool            `json:"requiresOpenaiAuth"`
	}
	if err := client.call(ctx, "account/read", map[string]bool{"refreshToken": false}, &result); err != nil {
		return nil, errors.New("could not check the local Codex login")
	}
	if result.RequiresAuth && (len(result.Account) == 0 || string(result.Account) == "null") {
		return nil, ErrLoginRequired
	}
	models, err := codexModels(ctx, client)
	if err != nil {
		return nil, err
	}
	return &Catalogue{Provider: CodexProvider, Name: "Codex CLI", Models: models}, nil
}

func codexModels(ctx context.Context, client *rpcClient) ([]AgentModel, error) {
	var models []AgentModel
	cursor := ""
	for page := 0; page < 20; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var result struct {
			Data []struct {
				Model         string `json:"model"`
				Hidden        bool   `json:"hidden"`
				IsDefault     bool   `json:"isDefault"`
				DefaultEffort string `json:"defaultReasoningEffort"`
				Efforts       []struct {
					ReasoningEffort string `json:"reasoningEffort"`
				} `json:"supportedReasoningEfforts"`
				ServiceTiers []struct {
					ID string `json:"id"`
				} `json:"serviceTiers"`
			} `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		if err := client.call(ctx, "model/list", params, &result); err != nil {
			return nil, errors.New("could not read the Codex model list")
		}
		for _, entry := range result.Data {
			if entry.Hidden || entry.Model == "" {
				continue
			}
			model := AgentModel{ID: entry.Model, Default: entry.IsDefault, DefaultEffort: entry.DefaultEffort}
			for _, effort := range entry.Efforts {
				model.Efforts = append(model.Efforts, effort.ReasoningEffort)
			}
			for _, tier := range entry.ServiceTiers {
				model.Fast = model.Fast || tier.ID == "priority"
			}
			models = append(models, model)
		}
		if result.NextCursor == nil || *result.NextCursor == "" {
			break
		}
		cursor = *result.NextCursor
	}
	if len(models) == 0 {
		return nil, errors.New("the Codex account offers no model")
	}
	return models, nil
}

// codexTurnParams are the `turn/start` overrides of a choice. Codex keeps
// `model` and `effort` for the thread's next turns, so both are always sent;
// the speed goes through `serviceTierForTurn`, which never sticks.
func codexTurnParams(choice turnChoice) map[string]any {
	params := map[string]any{"model": choice.Model.ID, "serviceTierForTurn": "default"}
	if choice.Effort != "" {
		params["effort"] = choice.Effort
	}
	if choice.Fast {
		params["serviceTierForTurn"] = "priority"
	}
	return params
}

func (b *Bridge) workspace(profile string) string {
	if b.opts.Workspace != "" {
		return b.opts.Workspace
	}
	return filepath.Join(b.opts.ProfilesRoot, profile)
}

func (b *Bridge) codexThread(client *rpcClient, threadID string) (string, error) {
	params := map[string]any{"cwd": b.opts.Workspace, "approvalPolicy": "on-request", "sandbox": "workspace-write"}
	method := "thread/start"
	if threadID != "" {
		method = "thread/resume"
		params["threadId"] = threadID
	}
	var result struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := b.setupCall(client, method, params, &result); err != nil || result.Thread.ID == "" {
		return "", errors.New("the Codex conversation could not open")
	}
	return result.Thread.ID, nil
}

func (b *Bridge) codexPrompt(ctx context.Context, r *run, client *rpcClient, blocks []any, overrides map[string]any) (string, error) {
	b.mu.Lock()
	if r.Cancel || terminal(r.Status) {
		b.unlockAndSend()
		return "cancelled", nil
	}
	done := make(chan rpcReply, 1)
	r.codexDone = done
	threadID := r.acpID
	b.unlockAndSend()
	var result struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	params := map[string]any{
		"threadId": threadID, "input": blocks, "cwd": b.opts.Workspace,
		"approvalPolicy": "on-request", "sandboxPolicy": map[string]any{
			"type": "workspaceWrite", "writableRoots": []string{b.opts.Workspace}, "networkAccess": false,
		},
	}
	for name, value := range overrides {
		params[name] = value
	}
	if err := b.setupCall(client, "turn/start", params, &result); err != nil || result.Turn.ID == "" {
		return "", errors.New("the Codex turn could not start")
	}
	b.mu.Lock()
	if r.codexTurn == "" {
		r.codexTurn = result.Turn.ID
		if r.Cancel || r.timedOut {
			b.requestStopLocked(r)
		}
	}
	b.unlockAndSend()
	select {
	case reply := <-done:
		return string(reply.result), reply.err
	case <-client.done:
		return "", errAgentExited
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func (b *Bridge) requestStopLocked(r *run) {
	if b.codex() {
		if r.codexTurn != "" {
			b.outgoing = append(b.outgoing, agentWrite{client: r.client, method: "turn/interrupt", value: map[string]string{"threadId": r.acpID, "turnId": r.codexTurn}})
		}
		return
	}
	b.outgoing = append(b.outgoing, agentWrite{client: r.client, method: "session/cancel", value: map[string]string{"sessionId": r.acpID}})
}

func (b *Bridge) permissionResponse(option string) any {
	if b.codex() {
		if option == "" {
			option = "cancel"
		}
		return map[string]string{"decision": option}
	}
	if option == "" {
		return map[string]any{"outcome": map[string]string{"outcome": "cancelled"}}
	}
	return map[string]any{"outcome": map[string]string{"outcome": "selected", "optionId": option}}
}

func (b *Bridge) codexEventLocked(client *rpcClient, m rpcMessage) {
	var p struct {
		ThreadID  string            `json:"threadId"`
		TurnID    string            `json:"turnId"`
		Delta     string            `json:"delta"`
		Command   string            `json:"command"`
		Reason    string            `json:"reason"`
		Available []json.RawMessage `json:"availableDecisions"`
		Turn      struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"turn"`
	}
	if json.Unmarshal(m.Params, &p) != nil {
		return
	}
	var r *run
	for _, candidate := range b.disk.Runs {
		if candidate.client == client && candidate.acpID == p.ThreadID && candidate.codexDone != nil && !terminal(candidate.Status) {
			r = candidate
			break
		}
	}
	if len(m.ID) > 0 {
		if m.Method != "item/commandExecution/requestApproval" && m.Method != "item/fileChange/requestApproval" {
			b.outgoing = append(b.outgoing, agentWrite{client: client, id: m.ID, rpcError: &rpcError{Code: -32601, Message: "request not supported"}})
			return
		}
		canAccept := len(p.Available) == 0
		for _, decision := range p.Available {
			canAccept = canAccept || string(decision) == `"accept"`
		}
		if !canAccept || r == nil || r.Cancel || r.timedOut || r.codexTurn == "" || r.codexTurn != p.TurnID {
			b.outgoing = append(b.outgoing, agentWrite{client: client, id: m.ID, value: b.permissionResponse("")})
			return
		}
		title := p.Command
		if title == "" {
			title = "Codex file change"
		}
		id := uniqueID()
		r.permissions[id] = permission{id: append(json.RawMessage(nil), m.ID...), options: map[string]string{"once": "accept", "deny": "decline"}}
		r.Status = "waiting_for_approval"
		b.eventLocked(r, "approval.request", Event{"request_id": id, "execution_generation": r.Generation, "command": title, "description": p.Reason, "choices": []string{"once", "deny"}})
		return
	}
	if r == nil {
		return
	}
	switch m.Method {
	case "turn/started":
		if r.codexTurn == "" && p.Turn.ID != "" {
			r.codexTurn = p.Turn.ID
			if r.Cancel || r.timedOut {
				b.requestStopLocked(r)
			}
		}
	case "item/agentMessage/delta":
		if r.codexTurn != "" && p.TurnID == r.codexTurn {
			b.appendMessageLocked(r, p.Delta)
		}
	case "turn/completed":
		if r.codexTurn == "" || p.Turn.ID != r.codexTurn {
			return
		}
		reply := rpcReply{}
		switch p.Turn.Status {
		case "completed":
			reply.result = []byte("end_turn")
		case "interrupted":
			reply.result = []byte("cancelled")
		default:
			reply.err = errors.New("the Codex turn failed")
		}
		select {
		case r.codexDone <- reply:
		default:
		}
	}
}
