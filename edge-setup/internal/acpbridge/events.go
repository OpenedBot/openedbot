package acpbridge

import (
	"encoding/json"
	"net/http"
	"strings"
)

func (b *Bridge) incoming(client *rpcClient, m rpcMessage) {
	b.mu.Lock()
	defer b.unlockAndSend()
	if m.JSONRPC == "" {
		for _, r := range b.disk.Runs {
			if r.client == client && !terminal(r.Status) {
				r.InvalidLines++
				if r.InvalidLines > b.opts.Limits.MaxInvalidLines {
					b.failActiveLocked(r, errInvalidLines.Error())
				}
			}
		}
		return
	}
	if b.codex() {
		b.codexEventLocked(client, m)
		return
	}
	var params struct {
		SessionID string `json:"sessionId"`
		Update    struct {
			Kind    string `json:"sessionUpdate"`
			Content struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			ToolID   string `json:"toolCallId"`
			Title    string `json:"title"`
			ToolKind string `json:"kind"`
			Status   string `json:"status"`
			Places   []struct {
				Path string `json:"path"`
			} `json:"locations"`
		} `json:"update"`
		ToolCall struct {
			Title string `json:"title"`
		} `json:"toolCall"`
		Options []struct {
			ID   string `json:"optionId"`
			Kind string `json:"kind"`
		} `json:"options"`
	}
	if json.Unmarshal(m.Params, &params) != nil {
		return
	}
	var r *run
	for _, candidate := range b.disk.Runs {
		if candidate.client == client && candidate.acpID == params.SessionID && !terminal(candidate.Status) {
			r = candidate
			break
		}
	}
	if m.Method == "session/request_permission" && len(m.ID) > 0 {
		if r == nil || r.Cancel {
			b.outgoing = append(b.outgoing, agentWrite{client: client, id: m.ID, value: b.permissionResponse("")})
			return
		}
		options := map[string]string{}
		for _, o := range params.Options {
			switch o.Kind {
			case "allow_once":
				options["once"] = o.ID
			case "allow_always":
				options["always"] = o.ID
			case "reject_once":
				options["deny"] = o.ID
			}
		}
		choices := []string{}
		for _, choice := range []string{"once", "deny", "always"} {
			if options[choice] != "" {
				choices = append(choices, choice)
			}
		}
		if options["once"] == "" || options["deny"] == "" {
			b.outgoing = append(b.outgoing, agentWrite{client: client, id: m.ID, value: b.permissionResponse("")})
			b.failActiveLocked(r, "ACP permission lacks allow_once or reject_once")
			return
		}
		id := uniqueID()
		r.permissions[id] = permission{id: append(json.RawMessage(nil), m.ID...), options: options}
		r.Status = "waiting_for_approval"
		b.eventLocked(r, "approval.request", Event{"request_id": id, "execution_generation": r.Generation, "command": params.ToolCall.Title, "description": params.ToolCall.Title, "choices": choices})
		return
	}
	if len(m.ID) > 0 {
		b.outgoing = append(b.outgoing, agentWrite{client: client, id: m.ID, rpcError: &rpcError{Code: -32601, Message: "method not supported"}})
		return
	}
	if r == nil || m.Method != "session/update" {
		return
	}
	u := params.Update
	switch u.Kind {
	case "agent_message_chunk":
		if u.Content.Type == "text" {
			b.appendMessageLocked(r, u.Content.Text)
		}
	case "tool_call":
		if u.ToolID == "" || len(u.ToolID) > 200 || u.Title == "" {
			b.failActiveLocked(r, "invalid ACP tool identity")
			return
		}
		path := ""
		if len(u.Places) > 0 {
			path = u.Places[0].Path
		}
		name, preview := acpToolName(u.ToolKind, u.Title, path)
		r.tools[u.ToolID] = name
		started := Event{"tool": name, "tool_call_id": u.ToolID}
		if preview != "" {
			started["preview"] = preview
		}
		b.eventLocked(r, "tool.started", started)
		if u.Status == "completed" || u.Status == "failed" {
			delete(r.tools, u.ToolID)
			b.eventLocked(r, "tool.completed", Event{"tool": name, "tool_call_id": u.ToolID, "duration": 0, "error": u.Status == "failed"})
		}

	case "tool_call_update":
		if u.Status == "completed" || u.Status == "failed" {
			title := r.tools[u.ToolID]
			if title == "" {
				r.UnmatchedTools++
				return
			}
			delete(r.tools, u.ToolID)
			b.eventLocked(r, "tool.completed", Event{"tool": title, "tool_call_id": u.ToolID, "duration": 0, "error": u.Status == "failed"})
		}
		// Thought, plan and cumulative usage updates intentionally have no projection.
	}
}
func (b *Bridge) cancelPermissionsLocked(r *run) {
	for id, p := range r.permissions {
		if r.client != nil {
			b.outgoing = append(b.outgoing, agentWrite{client: r.client, id: p.id, value: b.permissionResponse("")})
		}
		delete(r.permissions, id)
	}
}
func (b *Bridge) approveLocked(w http.ResponseWriter, r *run, body approvalInput) {
	id, choice, gen := body.RequestID, body.Choice, body.Generation
	p, ok := r.permissions[id]
	if !ok || gen != r.Generation || terminal(r.Status) || r.Cancel {
		http.Error(w, "approval is no longer pending", 409)
		return
	}
	option, ok := p.options[choice]
	if !ok {
		http.Error(w, "choice not offered", 400)
		return
	}
	delete(r.permissions, id)
	if len(r.permissions) == 0 {
		r.Status = "running"
	}
	// Journal the accepted decision before releasing the lock so a fast agent
	// cannot finish the run before its approval.responded event is recorded.
	b.eventLocked(r, "approval.responded", Event{"choice": choice, "resolved": 1})
	b.outgoing = append(b.outgoing, agentWrite{client: r.client, id: p.id, value: b.permissionResponse(option)})
	err := b.unlockAndSend()
	b.mu.Lock()
	if err != nil {
		http.Error(w, "agent unavailable", 502)
		return
	}
	if b.diskErr != nil {
		http.Error(w, "persistence failed", 500)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// A protocol or stream limit violation makes this shared agent unusable.
func (b *Bridge) failActiveLocked(r *run, message string) {
	b.cancelPermissionsLocked(r)
	b.finishLocked(r, "failed", message)
	if r.client != nil {
		b.outgoing = append(b.outgoing, agentWrite{client: r.client, kill: true})
	}
}

// acpToolName names an ACP tool call with the Hermes tool the console already
// reads, from the `kind` every ACP agent sends. A title is free text that
// differs per agent (« Read /src/a.ts », a whole shell command, « web_fetch »):
// it becomes the preview, where the console takes only what it can show
// safely, and stays the name only when the kind says nothing. A file tool
// previews the path of its first location, as Hermes previews a path.
func acpToolName(kind, title, path string) (name, preview string) {
	switch kind {
	case "execute":
		return "terminal", title
	case "read":
		return "read_file", path
	case "edit", "delete", "move":
		return "edit_file", path
	case "search", "fetch":
		lower := strings.ToLower(strings.TrimSpace(title))
		for _, prefix := range []string{"web search", "web_search"} {
			if strings.HasPrefix(lower, prefix) {
				return "web_search", strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(title)[len(prefix):], ":"))
			}
		}
		if kind == "search" {
			return "search_files", title
		}
		return "web_extract", title
	}
	return title, ""
}
