package operator

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"time"
	"unicode/utf8"
)

const (
	a2aPolicyProbeURL         = "http://127.0.0.1:9900/"
	a2aErrTaskNotFound        = -32001
	a2aErrUnauthorized        = -32050
	a2aErrUntrustedPeer       = -32052
	maxA2APolicyProbeResponse = 8 << 10
	maxA2APolicyProbeTimeout  = 2 * time.Second
)

var a2aPolicyProbeIDRe = regexp.MustCompile(`^task-[0-9a-f]{16}$`)

type a2aPolicyProbeVerdict string

const (
	a2aPolicyProbeAllowed    a2aPolicyProbeVerdict = "allowed"
	a2aPolicyProbeDenied     a2aPolicyProbeVerdict = "denied"
	a2aPolicyProbeUnverified a2aPolicyProbeVerdict = "unverified"
)

// A2APolicyDenialReceipt contains only bounded metadata for a named policy
// probe. It must not be extended with request headers, JSON-RPC bodies, or
// task/message contents.
type A2APolicyDenialReceipt struct {
	Direction string `json:"direction"`
	Peer      string `json:"peer"`
	TaskID    string `json:"task_id"`
	Timestamp string `json:"ts"`
	Summary   string `json:"summary"`
	Source    string `json:"source"`
}

type a2aPolicyProbeDeps struct {
	Doer       a2aCardDoer
	ProveBind  a2aBindProof
	AppendDeny func(context.Context, A2APolicyDenialReceipt) error
	NewTaskID  func() (string, error)
	Now        func() time.Time
}

type a2aPolicyProbeResult struct {
	verdict a2aPolicyProbeVerdict
	code    int
}

// probeA2APeerPolicy verifies one named peer against the fixed loopback A2A
// listener. The only JSON-RPC method sent is tasks/get for a fresh random ID,
// which is read-only and cannot create a task or dispatch a message.
func probeA2APeerPolicy(ctx context.Context, peerName, token string, expected A2APeerAccess, deps a2aPolicyProbeDeps) (a2aPolicyProbeResult, error) {
	if !validA2APeerName(peerName) || !validA2APeerToken(token, 1) || (expected != A2APeerAllow && expected != A2APeerDeny) || deps.Doer == nil || deps.ProveBind == nil || deps.NewTaskID == nil {
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified}, errors.New("A2A peer policy probe is unavailable")
	}
	if err := deps.ProveBind(ctx); err != nil {
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified}, errors.New("A2A loopback binding is not proven")
	}
	taskID, err := deps.NewTaskID()
	if err != nil || !a2aPolicyProbeIDRe.MatchString(taskID) {
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified}, errors.New("A2A peer policy probe identifier is invalid")
	}
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      taskID,
		"method":  "tasks/get",
		"params":  map[string]string{"taskId": taskID},
	})
	if err != nil {
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified}, errors.New("A2A peer policy probe request could not be built")
	}
	probeCtx, cancel := context.WithTimeout(ctx, maxA2APolicyProbeTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(probeCtx, http.MethodPost, a2aPolicyProbeURL, bytes.NewReader(body))
	if err != nil {
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified}, errors.New("A2A peer policy probe request could not be built")
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := deps.Doer.Do(request)
	if err != nil || response == nil || response.Body == nil {
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified}, errors.New("A2A peer policy probe did not receive a response")
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxA2APolicyProbeResponse+1))
	if err != nil || len(responseBody) > maxA2APolicyProbeResponse {
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified}, errors.New("A2A peer policy probe response is unavailable")
	}
	envelope, err := parseA2APolicyProbeResponse(responseBody)
	if err != nil || envelope.ID != taskID {
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified}, errors.New("A2A peer policy probe response is invalid")
	}
	if err := deps.ProveBind(ctx); err != nil {
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified}, errors.New("A2A loopback binding changed during the policy probe")
	}

	if response.StatusCode == http.StatusOK && envelope.Error != nil && envelope.Error.Code == a2aErrTaskNotFound {
		if expected == A2APeerAllow {
			return a2aPolicyProbeResult{verdict: a2aPolicyProbeAllowed, code: envelope.Error.Code}, nil
		}
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified, code: envelope.Error.Code}, errors.New("A2A peer access did not match the requested deny policy")
	}
	if response.StatusCode == http.StatusUnauthorized && envelope.Error != nil && envelope.Error.Code == a2aErrUnauthorized {
		if expected == A2APeerDeny {
			return a2aPolicyProbeResult{verdict: a2aPolicyProbeDenied, code: envelope.Error.Code}, nil
		}
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified, code: envelope.Error.Code}, errors.New("A2A peer access did not match the requested allow policy")
	}
	if response.StatusCode == http.StatusForbidden && envelope.Error != nil && envelope.Error.Code == a2aErrUntrustedPeer {
		if expected != A2APeerDeny {
			return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified, code: envelope.Error.Code}, errors.New("A2A peer access did not match the requested allow policy")
		}
		if deps.AppendDeny == nil {
			return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified, code: envelope.Error.Code}, errors.New("A2A peer denial could not be journaled")
		}
		now := time.Now
		if deps.Now != nil {
			now = deps.Now
		}
		receipt := A2APolicyDenialReceipt{
			Direction: "denied",
			Peer:      peerName,
			TaskID:    taskID,
			Timestamp: now().UTC().Format(time.RFC3339Nano),
			Summary:   "",
			Source:    "operator.policy_probe",
		}
		if err := deps.AppendDeny(ctx, receipt); err != nil {
			return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified, code: envelope.Error.Code}, errors.New("A2A peer denial could not be journaled")
		}
		return a2aPolicyProbeResult{verdict: a2aPolicyProbeDenied, code: envelope.Error.Code}, nil
	}
	return a2aPolicyProbeResult{verdict: a2aPolicyProbeUnverified}, errors.New("A2A peer policy result did not match the expected proof")
}

type a2aPolicyProbeError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type a2aPolicyProbeEnvelope struct {
	JSONRPC string               `json:"jsonrpc"`
	ID      string               `json:"id"`
	Error   *a2aPolicyProbeError `json:"error,omitempty"`
	Result  json.RawMessage      `json:"result,omitempty"`
}

func parseA2APolicyProbeResponse(body []byte) (a2aPolicyProbeEnvelope, error) {
	if len(body) == 0 || len(body) > maxA2APolicyProbeResponse || !utf8.Valid(body) {
		return a2aPolicyProbeEnvelope{}, errors.New("invalid response")
	}
	if err := rejectDuplicateJSONKeys(body); err != nil {
		return a2aPolicyProbeEnvelope{}, errors.New("ambiguous response")
	}
	var envelope a2aPolicyProbeEnvelope
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return a2aPolicyProbeEnvelope{}, errors.New("invalid response")
	}
	if err := decoder.Decode(new(any)); err != io.EOF || envelope.JSONRPC != "2.0" || envelope.ID == "" || (envelope.Error == nil) == (len(envelope.Result) == 0) {
		return a2aPolicyProbeEnvelope{}, errors.New("invalid response")
	}
	return envelope, nil
}

func newA2APolicyProbeID() (string, error) {
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", errors.New("A2A peer probe identifier could not be generated")
	}
	return "task-" + hex.EncodeToString(random[:]), nil
}
