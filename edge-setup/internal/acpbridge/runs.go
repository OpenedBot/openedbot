package acpbridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

type runInput struct {
	Input        json.RawMessage `json:"input"`
	Instructions string          `json:"instructions"`
	SessionID    string          `json:"session_id"`
	Model        string          `json:"model"`
	Provider     string          `json:"provider"`
	ModelOptions map[string]any  `json:"model_options"`
	History      []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"conversation_history"`
}

func (b *Bridge) createRunLocked(w http.ResponseWriter, req *http.Request, slug string, input runInput) {
	key := req.Header.Get("Idempotency-Key")
	if key != "" {
		for _, r := range b.disk.Runs {
			if r.Profile == slug && r.Key == key {
				writeJSON(w, 200, map[string]string{"run_id": r.ID})
				return
			}
		}
	}
	s := b.disk.Sessions[sessionKey(slug, input.SessionID)]
	if s == nil {
		http.Error(w, "session missing", 404)
		return
	}
	if s.active != "" {
		http.Error(w, "session has an active turn", 409)
		return
	}
	count := 0
	for _, r := range b.disk.Runs {
		if !terminal(r.Status) {
			count++
		}
	}
	if count >= b.opts.Limits.MaxConcurrentRuns {
		http.Error(w, "run capacity reached", 429)
		return
	}
	r := &run{ID: uniqueID(), Profile: slug, SessionID: s.ID, Key: key, Status: "queued", Generation: 1, Events: []Event{}, permissions: map[string]permission{}, tools: map[string]string{}}
	b.disk.Runs[r.ID] = r
	s.active = r.ID
	s.LastUsed = time.Now()
	b.saveLocked()
	if b.diskErr != nil {
		http.Error(w, "persistence failed", 500)
		return
	}
	b.wg.Add(1)
	go func() { defer b.wg.Done(); b.execute(r, s, input) }()
	writeJSON(w, 201, map[string]string{"run_id": r.ID})
}
func textBlock(text string) map[string]any { return map[string]any{"type": "text", "text": text} }
func promptBlocks(raw json.RawMessage, image bool) ([]any, error) {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return []any{textBlock(text)}, nil
	}
	var messages []struct {
		Role    string `json:"role"`
		Content []struct {
			Type  string `json:"type"`
			Text  string `json:"text"`
			Image struct {
				URL string `json:"url"`
			} `json:"image_url"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &messages) != nil || len(messages) == 0 {
		return nil, errors.New("input must be text or user messages")
	}
	blocks := []any{}
	for _, m := range messages {
		if m.Role != "user" {
			return nil, errors.New("input messages must have user role")
		}
		for _, c := range m.Content {
			switch c.Type {
			case "text":
				blocks = append(blocks, textBlock(c.Text))
			case "image_url":
				if !image {
					return nil, errors.New("ACP agent does not support image prompts")
				}
				// ACP requires inline base64 data. Never fetch arbitrary image URLs on the host.
				header, data, ok := strings.Cut(c.Image.URL, ",")
				if !ok || !strings.HasPrefix(header, "data:image/") || !strings.HasSuffix(header, ";base64") {
					return nil, errors.New("ACP image prompts require a base64 image data URL")
				}
				if _, err := base64.StdEncoding.DecodeString(data); err != nil {
					return nil, errors.New("invalid image base64")
				}
				blocks = append(blocks, map[string]any{"type": "image", "data": data, "mimeType": strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")})
			default:
				return nil, errors.New("unsupported input content")
			}
		}
	}
	return blocks, nil
}
func (b *Bridge) execute(r *run, s *session, input runInput) {
	ctx := b.ctx
	b.mu.Lock()
	p := b.profiles[r.Profile]
	if p == nil {
		p = &profile{}
		b.profiles[r.Profile] = p
	}
	b.unlockAndSend()
	p.mu.Lock()
	if p.idle != nil {
		p.idle.Stop()
	}
	p.busy++
	defer func() {
		p.mu.Lock()
		p.busy--
		b.mu.Lock()
		closed := b.closed
		b.unlockAndSend()
		if p.busy == 0 && !closed {
			p.idle = time.AfterFunc(b.opts.Limits.IdleTimeout, func() {
				p.mu.Lock()
				defer p.mu.Unlock()
				if p.busy == 0 && p.client != nil {
					p.client.stop()
					p.client = nil
				}
			})
		}
		p.mu.Unlock()
	}()
	// startup is serialized per profile; callbacks never acquire profile.mu.
	b.mu.Lock()
	closed := b.closed || terminal(r.Status)
	b.unlockAndSend()
	var err error
	if closed {
		p.mu.Unlock()
		b.releaseSession(s, r)
		return
	}
	if p.client == nil || !p.client.alive() {
		p.client, err = startRPC(b.opts.AgentCommand, b.opts.AgentArguments, b.agentEnvironment(), filepath.Join(b.opts.ProfilesRoot, r.Profile), b.opts.Limits.MaxInvalidLines, b.opts.Limits.CancelTimeout, b.incoming)
		if err == nil {
			var init struct {
				Version int               `json:"protocolVersion"`
				Caps    agentCapabilities `json:"agentCapabilities"`
			}
			err = b.setupCall(p.client, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{"fs": map[string]bool{"readTextFile": false, "writeTextFile": false}, "terminal": false}}, &init)
			if err == nil && init.Version != 1 {
				err = errors.New("unsupported ACP protocol version")
			}
			p.caps = init.Caps
		}
	}
	client, caps := p.client, p.caps
	p.mu.Unlock()
	if err != nil {
		if client != nil {
			client.stop()
		}
		b.endExecution(r, s, err)
		return
	}
	b.mu.Lock()
	if b.closed || terminal(r.Status) {
		b.unlockAndSend()
		b.releaseSession(s, r)
		return
	}
	r.client = client
	cancelled := r.Cancel
	oldID, oldClient, used, oldInstructions := s.ACPID, s.client, s.Used, s.Instructions
	b.unlockAndSend()
	if cancelled {
		b.endExecution(r, s, nil)
		return
	}
	// The catalogue names the agent's configured default, not a model switch.
	if (input.Model != "" && input.Model != "agent-default") || (input.Provider != "" && input.Provider != "acp") {
		b.endExecution(r, s, errors.New("ACP bridge serves only the configured agent default"))
		return
	}
	for option := range input.ModelOptions {
		if option != "prompt_cache_ttl" {
			b.endExecution(r, s, errors.New("ACP bridge does not support behavior-changing or unknown model options"))
			return
		}
	}
	blocks, err := promptBlocks(input.Input, caps.Prompt.Image)
	if err != nil {
		b.endExecution(r, s, err)
		return
	}
	acpID := oldID
	rebuilt := false
	created := false
	if oldClient != client || oldID == "" {
		params := map[string]any{"cwd": filepath.Join(b.opts.ProfilesRoot, r.Profile), "mcpServers": []any{}}
		if oldID != "" && caps.LoadSession {
			params["sessionId"] = oldID
			var result map[string]any
			err = b.setupCall(client, "session/load", params, &result)
		} else {
			if caps.Session.SystemPrompt != nil {
				params["systemPrompt"] = map[string]any{"mode": "append", "content": []any{textBlock(input.Instructions)}}
			}
			var result struct {
				SessionID string `json:"sessionId"`
			}
			err = b.setupCall(client, "session/new", params, &result)
			acpID = result.SessionID
			created = true
			rebuilt = used || len(input.History) > 0
			if err == nil && acpID == "" {
				err = errors.New("ACP returned an empty session id")
			}
		}
	}
	if err != nil {
		b.endExecution(r, s, err)
		return
	}
	prefix := []any{}
	if rebuilt {
		history := ""
		for _, m := range input.History {
			history += m.Role + ": " + m.Content + "\n"
		}
		if history != "" {
			prefix = append(prefix, textBlock("Conversation history (context rebuilt):\n"+history))
		}
	}
	// systemPrompt is creation-only in this bridge. Changed instructions on an
	// existing session are transmitted as text, including after session/load.
	if (created && caps.Session.SystemPrompt == nil) || (!created && (!used || oldInstructions != input.Instructions)) {
		prefix = append(prefix, textBlock("Instructions:\n"+input.Instructions))
	}
	blocks = append(prefix, blocks...)
	b.mu.Lock()
	s.ACPID = acpID
	s.client = client
	s.Instructions = input.Instructions
	s.Used = true
	r.acpID = acpID
	if rebuilt {
		b.eventLocked(r, "context.rebuilt", Event{"history_restored": len(input.History) > 0})
	}
	if r.Cancel || b.closed || terminal(r.Status) {
		b.unlockAndSend()
		b.endExecution(r, s, nil)
		return
	}
	r.Status = "running"
	b.saveLocked()
	b.unlockAndSend()

	type promptResult struct {
		reason string
		err    error
	}
	done := make(chan promptResult, 1)
	go func() {
		var response struct {
			StopReason string `json:"stopReason"`
		}
		err := client.call(ctx, "session/prompt", map[string]any{"sessionId": acpID, "prompt": blocks}, &response)
		done <- promptResult{response.StopReason, err}
	}()
	timer := time.NewTimer(b.opts.Limits.TurnTimeout)
	defer timer.Stop()
	var result promptResult
	select {
	case result = <-done:
	case <-timer.C:
		b.mu.Lock()
		if !terminal(r.Status) && !r.Cancel {
			r.timedOut = true
			r.Status = "stopping"
			b.cancelPermissionsLocked(r)
			b.saveLocked()
			b.outgoing = append(b.outgoing, agentWrite{client: client, method: "session/cancel", value: map[string]string{"sessionId": acpID}})
		}
		b.unlockAndSend()
		grace := time.NewTimer(b.opts.Limits.CancelTimeout)
		select {
		case result = <-done:
		case <-grace.C:
			client.stop()
			result = <-done
		}
		grace.Stop()
	}
	err = result.err
	if err != nil {
		client.stop()
	}
	b.mu.Lock()

	if !terminal(r.Status) {
		status := "failed"
		message := "ACP prompt failed"
		switch {
		case r.timedOut:
			status = "failed"
			message = "ACP turn timeout"
		case r.Cancel:
			status = "cancelled"
		case errors.Is(err, errAgentExited):
			status = "interrupted"
		case err != nil:
			message = err.Error()
		case result.reason == "end_turn":
			status = "completed"
		case result.reason == "cancelled":
			status = "cancelled"
		default:
			message = "ACP stop reason: " + result.reason
		}
		b.cancelPermissionsLocked(r)
		b.finishLocked(r, status, message)
	}
	s.active = ""
	b.unlockAndSend()
}
func (b *Bridge) releaseSession(s *session, r *run) {
	b.mu.Lock()
	if s.active == r.ID {
		s.active = ""
	}
	b.unlockAndSend()
}
func (b *Bridge) endExecution(r *run, s *session, err error) {
	b.mu.Lock()
	defer b.unlockAndSend()
	status := "failed"
	message := "ACP run failed"
	if err != nil {
		message = err.Error()
	}
	if errors.Is(err, errAgentExited) {
		status = "interrupted"
	}
	if r.Cancel {
		status = "cancelled"
	}
	b.cancelPermissionsLocked(r)
	b.finishLocked(r, status, message)
	s.active = ""
}
func (b *Bridge) stopLocked(r *run) {
	if terminal(r.Status) {
		return
	}
	r.Cancel = true
	r.Status = "stopping"
	b.cancelPermissionsLocked(r)
	b.saveLocked()
	if r.client != nil && r.acpID != "" {
		b.outgoing = append(b.outgoing, agentWrite{client: r.client, method: "session/cancel", value: map[string]string{"sessionId": r.acpID}})
	}
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		timer := time.NewTimer(b.opts.Limits.CancelTimeout)
		defer timer.Stop()
		for {
			b.mu.Lock()
			done := terminal(r.Status)
			wake := b.changed
			b.unlockAndSend()
			if done {
				return
			}
			select {
			case <-wake:
			case <-timer.C:
				b.mu.Lock()
				client := r.client
				if !terminal(r.Status) {
					b.finishLocked(r, "cancelled", "")
				}
				b.unlockAndSend()
				if client != nil {
					client.stop()
				}
				return
			}
		}
	}()
}
func (b *Bridge) streamLocked(w http.ResponseWriter, req *http.Request, r *run) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	controller := http.NewResponseController(w)
	_ = controller.Flush()
	index := 0
	for {
		events := append([]Event(nil), r.Events[index:]...)
		index = len(r.Events)
		done := terminal(r.Status)
		wake := b.changed
		b.unlockAndSend()
		failed := false
		for _, e := range events {
			raw, _ := json.Marshal(e)
			_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
				failed = true
				break
			}
		}
		_ = controller.Flush()
		if !done && !failed {
			select {
			case <-wake:
			case <-req.Context().Done():
				done = true
			}
		}
		b.mu.Lock()
		if done || failed {
			return
		}
	}
}
func (b *Bridge) appendMessageLocked(r *run, text string) {
	if !utf8.ValidString(text) {
		b.failActiveLocked(r, "invalid UTF-8 message")
		return
	}
	if len(r.Output)+len(text) > 128*1024 {
		b.failActiveLocked(r, "ACP output limit exceeded")
		return
	}
	r.Output += text
	for len(text) > 0 {
		n := min(len(text), 60*1024)
		for n < len(text) && !utf8.RuneStart(text[n]) {
			n--
		}
		chunk := text[:n]
		text = text[n:]
		b.eventLocked(r, "message.delta", Event{"delta": chunk})
	}
}

func (b *Bridge) setupCall(client *rpcClient, method string, params, out any) error {
	ctx, cancel := context.WithTimeout(b.ctx, b.opts.Limits.RPCTimeout)
	defer cancel()
	err := client.call(ctx, method, params, out)
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("ACP setup timeout: %s", method)
	}
	return err
}
