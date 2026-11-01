package connector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/yolohardline"
)

// The client side of YOLO mode: what the link reads of a run for a thread
// lease, the loopback answer to a native approval, and the three operator
// verbs the connector alone calls (never relayed: not in the allowlist).

// serves reports whether a feature the operator lists is one this connector
// can back: the yolo names need the lease store.
func (c *Client) serves(name string) bool {
	if name == FeatureYoloLease || name == FeatureYoloThreadScope {
		return c.Yolo != nil
	}
	return true
}

// cappedBuffer keeps the first max bytes written to it.
type cappedBuffer struct {
	bytes.Buffer
	max int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// captureRunSession tees the body of POST /v1/runs to read its session_id,
// the session a thread lease is bound to. The returned function, called once
// the gateway answered, files it under the request id for relayStream.
func (c *Client) captureRunSession(f Text, req *http.Request) func(uint32) {
	if c.Yolo == nil || req.Method != http.MethodPost || strippedPath(f.Path) != "/v1/runs" || req.Body == nil || req.Body == http.NoBody {
		return func(uint32) {}
	}
	captured := &cappedBuffer{max: MaxRequestBody}
	req.Body = struct {
		io.Reader
		io.Closer
	}{io.TeeReader(req.Body, captured), req.Body}
	return func(id uint32) {
		var body struct {
			SessionID string `json:"session_id"`
		}
		if json.Unmarshal(captured.Bytes(), &body) != nil || body.SessionID == "" {
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.yoloSessions == nil {
			c.yoloSessions = map[uint32]string{}
		}
		c.yoloSessions[id] = body.SessionID
	}
}

// noteYoloRun binds a dispatched run to its profile and session.
func (c *Client) noteYoloRun(requestID uint32, runID, profilePrefix string) {
	if c.Yolo == nil {
		return
	}
	c.mu.Lock()
	sessionID := c.yoloSessions[requestID]
	delete(c.yoloSessions, requestID)
	c.mu.Unlock()
	c.Yolo.NoteRun(runID, profilePrefix, sessionID)
}

// AnswerApproval answers one native gate "once" on the loopback gateway, the
// route openedbot uses through the link. A 409 means it was already answered.
func (c *Client) AnswerApproval(ctx context.Context, profilePrefix, runID, requestID string) error {
	if !runIDRe.MatchString(runID) || (profilePrefix != "" && profilePrefix != profileOf(profilePrefix)) {
		return errors.New("approval target is invalid")
	}
	body := map[string]any{"choice": "once", "approved": true}
	if requestID != "" {
		body["request_id"] = requestID
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Gateway+profilePrefix+"/v1/runs/"+runID+"/approval", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Bearer)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("gateway answered HTTP %d", resp.StatusCode)
	}
	return nil
}

// YoloApplied is one lease as the plugin reads it in yolo.json: what to
// match and what to refuse, nothing that identifies the person who granted it.
type YoloApplied struct {
	LeaseID    string            `json:"leaseId"`
	Scope      string            `json:"scope"`
	Profile    *string           `json:"profile"`
	SessionKey *string           `json:"sessionKey"`
	NotBefore  int64             `json:"notBefore"`
	ExpiresAt  int64             `json:"expiresAt"`
	Deny       yolohardline.Deny `json:"deny"`
	Protect    []string          `json:"protect"`
}

func appliedOf(active []YoloLease) []YoloApplied {
	out := make([]YoloApplied, 0, len(active))
	for _, l := range active {
		out = append(out, YoloApplied{LeaseID: l.LeaseID, Scope: l.Scope, Profile: l.Profile, SessionKey: l.SessionKey,
			NotBefore: l.NotBefore - YoloClockSkewSeconds, ExpiresAt: l.ExpiresAt, Deny: l.Deny, Protect: l.Protect})
	}
	return out
}

func (c *Client) operatorCall(ctx context.Context, method, path string, body any, into any) error {
	if !c.operatorAvailable() {
		return errors.New("the host operator is not running")
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://hermes-operator"+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.operatorClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBody+1))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("operator %s %s: HTTP %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(data[:min(len(data), 256)])))
	}
	if into != nil {
		return json.Unmarshal(data, into)
	}
	return nil
}

// ApplyYolo asks the operator to write each profile's yolo.json.
func (c *Client) ApplyYolo(ctx context.Context, active []YoloLease) error {
	return c.operatorCall(ctx, http.MethodPut, "/yolo", map[string]any{"leases": appliedOf(active)}, nil)
}

// DrainYolo reads the plugin spools; DrainedYolo drops what was read.
func (c *Client) DrainYolo(ctx context.Context) ([]YoloSpoolRecord, error) {
	var out struct {
		Records []YoloSpoolRecord `json:"records"`
	}
	if err := c.operatorCall(ctx, http.MethodPost, "/yolo/audit/drain", map[string]any{}, &out); err != nil {
		return nil, err
	}
	return out.Records, nil
}

func (c *Client) DrainedYolo(ctx context.Context) error {
	return c.operatorCall(ctx, http.MethodDelete, "/yolo/audit/drain", nil, nil)
}
