package operator

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	a2aPolicyTestTokenA = "fixture-peer-token-alpha-0123456789abcdef"
	a2aPolicyTestTokenB = "fixture-peer-token-bravo-0123456789abcdef"
)

func TestProjectA2APolicyUsesUpstreamPrecedenceAndHidesTokens(t *testing.T) {
	view, err := projectA2APolicy(
		"alpha:"+a2aPolicyTestTokenA+",beta:"+a2aPolicyTestTokenB,
		" alpha ", []string{"beta"}, false,
	)
	if err != nil {
		t.Fatal("projecting policy failed")
	}
	if view.AccessMode != "trusted_peers" || view.TrustedPeersSource != "environment" || len(view.Peers) != 2 {
		t.Fatalf("unexpected policy metadata: mode=%q source=%q peers=%d", view.AccessMode, view.TrustedPeersSource, len(view.Peers))
	}
	if view.Peers[0].Identity != "alpha" || view.Peers[0].Access != A2APeerAllow || !view.Peers[0].TokenConfigured {
		t.Fatalf("first peer projection is incorrect: %#v", view.Peers[0])
	}
	if view.Peers[1].Identity != "beta" || view.Peers[1].Access != A2APeerDeny || !view.Peers[1].TokenConfigured {
		t.Fatalf("second peer projection is incorrect: %#v", view.Peers[1])
	}
	encoded, err := json.Marshal(view)
	if err != nil {
		t.Fatal("marshalling policy metadata failed")
	}
	if strings.Contains(string(encoded), a2aPolicyTestTokenA) || strings.Contains(string(encoded), a2aPolicyTestTokenB) {
		t.Fatal("peer token escaped into the metadata projection")
	}

	configView, err := projectA2APolicy("alpha:"+a2aPolicyTestTokenA, "", []string{"alpha"}, false)
	if err != nil || configView.TrustedPeersSource != "config" || configView.Peers[0].Access != A2APeerAllow {
		t.Fatal("config trusted-peer policy was not used when the environment is empty")
	}
	defaultView, err := projectA2APolicy("alpha:"+a2aPolicyTestTokenA, "", nil, false)
	if err != nil || defaultView.AccessMode != "default_allow" || defaultView.Peers[0].Access != A2APeerAllow {
		t.Fatal("empty upstream trusted-peer list did not retain default allow semantics")
	}
	allowAllView, err := projectA2APolicy("alpha:"+a2aPolicyTestTokenA, "alpha", nil, true)
	if err != nil || allowAllView.AccessMode != "allow_all_override" || allowAllView.Peers[0].Access != A2APeerAllow {
		t.Fatal("A2A_ALLOW_ALL_USERS override was not represented")
	}
}

func TestParseA2APeerTokensRejectsAmbiguousOrUnboundedState(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  string
	}{
		{name: "missing separator", raw: "alpha"},
		{name: "missing name", raw: ":" + a2aPolicyTestTokenA},
		{name: "missing token", raw: "alpha:"},
		{name: "duplicate token", raw: "alpha:" + a2aPolicyTestTokenA + ",beta:" + a2aPolicyTestTokenA},
		{name: "comma token", raw: "alpha:bad,token"},
		{name: "control token", raw: "alpha:bad\ntoken"},
		{name: "too many peers", raw: strings.TrimSuffix(strings.Repeat("p:"+a2aPolicyTestTokenA+",", maxA2APolicyPeers+1), ",")},
		{name: "oversized input", raw: strings.Repeat("x", maxA2APeerTokens+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseA2APeerTokens(tc.raw); err == nil {
				t.Fatal("invalid peer token state was accepted")
			}
		})
	}
	rotating, err := parseA2APeerTokens("alpha:" + a2aPolicyTestTokenA + ",alpha:" + a2aPolicyTestTokenB)
	if err != nil || len(rotating) != 2 || rotating[0].name != "alpha" || rotating[1].name != "alpha" {
		t.Fatal("upstream's overlapping old/new tokens for one peer were not preserved")
	}
}

func TestDecodeA2APeerMutationIsBoundedAndStrict(t *testing.T) {
	trust, err := decodeA2APeerTrustMutation("alpha", []byte(`{"trusted":true}`))
	if err != nil || trust.name != "alpha" || trust.kind != a2aPeerTrustMutation || trust.trusted == nil || !*trust.trusted {
		t.Fatal("valid named-peer trust request was not decoded")
	}
	validToken := `{"token":"` + a2aPolicyTestTokenA + `"}`
	token, err := decodeA2APeerTokenMutation("alpha", []byte(validToken))
	if err != nil || token.kind != a2aPeerTokenMutation || token.token == nil || *token.token != a2aPolicyTestTokenA {
		t.Fatal("valid write-only peer token request was not decoded")
	}
	if deleted, err := decodeA2APeerTokenDeleteMutation("alpha"); err != nil || deleted.kind != a2aPeerDeleteTokenMutation {
		t.Fatal("valid named-peer token delete was not decoded")
	}
	for _, body := range []string{
		`{"trusted":true,"trusted":false}`,
		`{"trusted":true,"unknown":true}`,
		`{"trusted":"true"}`,
		`{"token":"short"}`,
		`{"token":"` + strings.Repeat("x", maxA2APeerToken+1) + `"}`,
		validToken + ` {}`,
		strings.Repeat(" ", MaxBody+1),
	} {
		var err error
		if strings.Contains(body, "trusted") {
			_, err = decodeA2APeerTrustMutation("alpha", []byte(body))
		} else {
			_, err = decodeA2APeerTokenMutation("alpha", []byte(body))
		}
		if err == nil {
			t.Fatal("invalid A2A peer write request was accepted")
		}
	}
	if _, err := decodeA2APeerTrustMutation("BadName", []byte(`{"trusted":true}`)); err == nil {
		t.Fatal("uppercase peer path segment was accepted")
	}
}

func TestApplyA2APeerTrustNeverTurnsEmptyAllowlistIntoAllowAll(t *testing.T) {
	if _, err := applyA2APeerTrust("alpha:"+a2aPolicyTestTokenA, "", []string{"alpha"}, false, "alpha", false); err == nil {
		t.Fatal("denying the last trusted peer would have opened the empty upstream list")
	}
	if _, err := applyA2APeerTrust("alpha:"+a2aPolicyTestTokenA, "", nil, false, "alpha", false); err == nil {
		t.Fatal("deny from default-allow mode was represented as an empty allow-list")
	}

	trustedFirst, err := applyA2APeerTrust("alpha:"+a2aPolicyTestTokenA, "", nil, false, "alpha", true)
	if err != nil || !equalStrings(trustedFirst.trustedPeers, []string{"alpha"}) || !trustedFirst.trustedPeersChanged || trustedFirst.needsGatewayRestart {
		t.Fatal("adding the first named trust did not create a hot-reloaded allow-list")
	}
	delta, err := applyA2APeerTrust("alpha:"+a2aPolicyTestTokenA+",beta:"+a2aPolicyTestTokenB, "", []string{"alpha", "beta"}, false, "beta", false)
	if err != nil || !equalStrings(delta.trustedPeers, []string{"alpha"}) || delta.needsGatewayRestart {
		t.Fatal("denying one of two peers changed tokens or requested an unnecessary restart")
	}
	view, err := projectA2APolicy("alpha:"+a2aPolicyTestTokenA+",beta:"+a2aPolicyTestTokenB, "", delta.trustedPeers, false)
	if err != nil || len(view.Peers) != 2 || view.Peers[0].Access != A2APeerAllow || view.Peers[1].Access != A2APeerDeny {
		t.Fatal("two-peer allow/deny projection is not effective")
	}
}

func TestApplyA2APeerTokenRotationAndDeletionRequireRestart(t *testing.T) {
	delta, err := applyA2APeerToken("alpha:"+a2aPolicyTestTokenA+",alpha:"+a2aPolicyTestTokenB, "alpha", stringPtr(a2aPolicyTestTokenB))
	if err != nil || delta.peerTokens != "alpha:"+a2aPolicyTestTokenB || !delta.peerTokensChanged || !delta.needsGatewayRestart {
		t.Fatal("peer token rotation did not replace old tokens and require restart")
	}
	delta, err = applyA2APeerToken(delta.peerTokens, "alpha", nil)
	if err != nil || delta.peerTokens != "" || !delta.peerTokensChanged || !delta.needsGatewayRestart {
		t.Fatal("peer token deletion did not require restart")
	}
}

func TestApplyA2APeerTrustFailsClosedOnEnvironmentOverrides(t *testing.T) {
	for _, tc := range []struct {
		name       string
		trustedEnv string
		allowAll   bool
	}{
		{name: "trusted peer environment", trustedEnv: "alpha"},
		{name: "allow all environment", allowAll: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := applyA2APeerTrust("alpha:"+a2aPolicyTestTokenA, tc.trustedEnv, []string{"alpha"}, tc.allowAll, "alpha", false); err == nil {
				t.Fatal("policy write ignored an upstream environment override")
			}
		})
	}
}

type a2aPolicyTestDoer func(*http.Request) (*http.Response, error)

func (doer a2aPolicyTestDoer) Do(request *http.Request) (*http.Response, error) {
	return doer(request)
}

func TestProbeA2APeerPolicyUsesOnlyReadOnlyTasksGet(t *testing.T) {
	const token = "fixture-probe-token-never-returned-012345"
	var bindChecks, audits int
	var gotID string
	result, err := probeA2APeerPolicy(context.Background(), "alpha", token, A2APeerAllow, a2aPolicyProbeDeps{
		Doer: a2aPolicyTestDoer(func(request *http.Request) (*http.Response, error) {
			if request.Method != http.MethodPost || request.URL.String() != a2aPolicyProbeURL || request.Header.Get("Authorization") != "Bearer "+token {
				t.Fatal("probe did not use the fixed local endpoint and supplied bearer")
			}
			var body struct {
				JSONRPC string            `json:"jsonrpc"`
				ID      string            `json:"id"`
				Method  string            `json:"method"`
				Params  map[string]string `json:"params"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal("probe request body is invalid")
			}
			gotID = body.ID
			if body.JSONRPC != "2.0" || body.Method != "tasks/get" || body.Params["taskId"] != body.ID || !a2aPolicyProbeIDRe.MatchString(body.ID) {
				t.Fatal("probe attempted anything other than read-only tasks/get for a random task id")
			}
			return a2aPolicyProbeHTTPResponse(http.StatusOK, `{"jsonrpc":"2.0","id":"`+body.ID+`","error":{"code":-32001,"message":"task not found"}}`), nil
		}),
		ProveBind:  func(context.Context) error { bindChecks++; return nil },
		AppendDeny: func(context.Context, A2APolicyDenialReceipt) error { audits++; return nil },
		NewTaskID:  func() (string, error) { return "task-0123456789abcdef", nil },
	})
	if err != nil || result.verdict != a2aPolicyProbeAllowed || result.code != a2aErrTaskNotFound || gotID != "task-0123456789abcdef" || bindChecks != 2 || audits != 0 {
		t.Fatal("known peer allow proof did not use task-not-found after both bind checks")
	}
}

func TestProbeA2APeerPolicyJournalsOnlyPinnedTrustedPeerDenials(t *testing.T) {
	const probeToken = "fixture-probe-token-never-returned-012345"
	var receipt A2APolicyDenialReceipt
	var audits int
	result, err := probeA2APeerPolicy(context.Background(), "beta", probeToken, A2APeerDeny, a2aPolicyProbeDeps{
		Doer: a2aPolicyTestDoer(func(request *http.Request) (*http.Response, error) {
			var body struct {
				ID string `json:"id"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal("probe request body is invalid")
			}
			return a2aPolicyProbeHTTPResponse(http.StatusForbidden, `{"jsonrpc":"2.0","id":"`+body.ID+`","error":{"code":-32052,"message":"peer denied"}}`), nil
		}),
		ProveBind:  func(context.Context) error { return nil },
		AppendDeny: func(_ context.Context, value A2APolicyDenialReceipt) error { audits++; receipt = value; return nil },
		NewTaskID:  func() (string, error) { return "task-fedcba9876543210", nil },
		Now:        func() time.Time { return time.Date(2026, 10, 4, 12, 0, 0, 123, time.FixedZone("offset", 3600)) },
	})
	if err != nil || result.verdict != a2aPolicyProbeDenied || result.code != a2aErrUntrustedPeer || audits != 1 {
		t.Fatal("pinned trust denial was not proven and recorded")
	}
	if receipt.Direction != "denied" || receipt.Peer != "beta" || receipt.TaskID != "task-fedcba9876543210" || receipt.Timestamp != "2026-10-04T11:00:00.000000123Z" || receipt.Summary != "" || receipt.Source != "operator.policy_probe" {
		t.Fatal("denial receipt contains incorrect or nonminimal metadata")
	}
	receiptJSON, err := json.Marshal(receipt)
	if err != nil || !strings.Contains(string(receiptJSON), `"ts":"2026-10-04T11:00:00.000000123Z"`) || strings.Contains(string(receiptJSON), "message") || strings.Contains(string(receiptJSON), "token") {
		t.Fatal("denial receipt JSON did not preserve the metadata-only audit contract")
	}

	result, err = probeA2APeerPolicy(context.Background(), "beta", probeToken, A2APeerDeny, a2aPolicyProbeDeps{
		Doer: a2aPolicyTestDoer(func(request *http.Request) (*http.Response, error) {
			var body struct {
				ID string `json:"id"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			return a2aPolicyProbeHTTPResponse(http.StatusUnauthorized, `{"jsonrpc":"2.0","id":"`+body.ID+`","error":{"code":-32050,"message":"unauthorized"}}`), nil
		}),
		ProveBind: func(context.Context) error { return nil },
		NewTaskID: func() (string, error) { return "task-fedcba9876543210", nil },
	})
	if err != nil || result.verdict != a2aPolicyProbeDenied || result.code != a2aErrUnauthorized {
		t.Fatal("pinned authentication refusal was not recognized as denial")
	}
}

func TestProbeA2APeerPolicyFailsUnverifiedForUnexpectedResponsesOrAuditFailure(t *testing.T) {
	const token = "fixture-probe-token-never-returned-012345"
	response := func(status int, payload string) a2aPolicyTestDoer {
		return func(request *http.Request) (*http.Response, error) {
			var body struct {
				ID string `json:"id"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			return a2aPolicyProbeHTTPResponse(status, strings.ReplaceAll(payload, "$ID", body.ID)), nil
		}
	}
	cases := []struct {
		name     string
		expected A2APeerAccess
		status   int
		body     string
		audit    func(context.Context, A2APolicyDenialReceipt) error
	}{
		{name: "rate limit", expected: A2APeerDeny, status: http.StatusTooManyRequests, body: `{"jsonrpc":"2.0","id":"$ID","error":{"code":-32051,"message":"slow down"}}`},
		{name: "wrong trust code", expected: A2APeerDeny, status: http.StatusForbidden, body: `{"jsonrpc":"2.0","id":"$ID","error":{"code":-32050,"message":"unauthorized"}}`},
		{name: "allow result is not expected task missing", expected: A2APeerAllow, status: http.StatusOK, body: `{"jsonrpc":"2.0","id":"$ID","result":{"id":"other-task"}}`},
		{name: "deny receipt failed", expected: A2APeerDeny, status: http.StatusForbidden, body: `{"jsonrpc":"2.0","id":"$ID","error":{"code":-32052,"message":"peer denied"}}`, audit: func(context.Context, A2APolicyDenialReceipt) error { return errors.New("private sink failure") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			deps := a2aPolicyProbeDeps{
				Doer:       response(tc.status, tc.body),
				ProveBind:  func(context.Context) error { return nil },
				NewTaskID:  func() (string, error) { return "task-0123456789abcdef", nil },
				AppendDeny: tc.audit,
			}
			result, err := probeA2APeerPolicy(context.Background(), "beta", token, tc.expected, deps)
			if err == nil || result.verdict != a2aPolicyProbeUnverified {
				t.Fatal("unexpected or unjournaled proof was marked effective")
			}
		})
	}
}

func TestProbeA2APeerPolicyRejectsBadIDAndBindingBeforeNetwork(t *testing.T) {
	calls := 0
	deps := a2aPolicyProbeDeps{
		Doer:      a2aPolicyTestDoer(func(*http.Request) (*http.Response, error) { calls++; return nil, nil }),
		ProveBind: func(context.Context) error { return errors.New("private listener diagnostic") },
		NewTaskID: func() (string, error) { return "caller-controlled", nil },
	}
	result, err := probeA2APeerPolicy(context.Background(), "alpha", "fixture-token", A2APeerAllow, deps)
	if err == nil || result.verdict != a2aPolicyProbeUnverified || calls != 0 {
		t.Fatal("probe did not fail closed before network on unknown listener binding")
	}
	deps.ProveBind = func(context.Context) error { return nil }
	result, err = probeA2APeerPolicy(context.Background(), "alpha", "fixture-token", A2APeerAllow, deps)
	if err == nil || result.verdict != a2aPolicyProbeUnverified || calls != 0 {
		t.Fatal("probe accepted a non-random ID or called the listener")
	}
	bindChecks := 0
	deps.NewTaskID = func() (string, error) { return "task-0123456789abcdef", nil }
	deps.Doer = a2aPolicyTestDoer(func(request *http.Request) (*http.Response, error) {
		var body struct {
			ID string `json:"id"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		return a2aPolicyProbeHTTPResponse(http.StatusOK, `{"jsonrpc":"2.0","id":"`+body.ID+`","error":{"code":-32001,"message":"task not found"}}`), nil
	})
	deps.ProveBind = func(context.Context) error {
		bindChecks++
		if bindChecks == 2 {
			return errors.New("listener changed")
		}
		return nil
	}
	result, err = probeA2APeerPolicy(context.Background(), "alpha", "fixture-token", A2APeerAllow, deps)
	if err == nil || result.verdict != a2aPolicyProbeUnverified || bindChecks != 2 {
		t.Fatal("probe accepted an effective-looking response after bind proof changed")
	}
}

func TestA2APolicyHandlersUseInjectedProofAndNeverReturnTokens(t *testing.T) {
	const submitted = "fixture-write-token-alpha-0123456789abcdef"
	statusToReturn := a2aPolicyWriteStatus{Persisted: true, Effective: false, NeedsGatewayRestart: true}
	var gotName string
	mux := http.NewServeMux()
	mux.Handle("GET /a2a/peers", a2aPolicyListHandler(func(context.Context) (A2APolicyView, error) {
		return A2APolicyView{AccessMode: "trusted_peers", TrustedPeersSource: "config", Peers: []A2APeerPolicy{{Name: "alpha", Identity: "alpha", TokenConfigured: true, Access: A2APeerAllow}}}, nil
	}))
	mux.Handle("POST /a2a/peers/{peer}/token", a2aPolicyTokenHandler(func(_ context.Context, mutation a2aPeerMutation) (a2aPolicyWriteStatus, error) {
		gotName = mutation.name
		if mutation.token == nil || *mutation.token != submitted || mutation.kind != a2aPeerTokenMutation {
			t.Fatal("write handler did not pass the bounded write-only request to its injected backend")
		}
		return statusToReturn, nil
	}))
	mux.Handle("POST /a2a/peers/{peer}/trust", a2aPolicyTrustHandler(func(_ context.Context, mutation a2aPeerMutation) (a2aPolicyWriteStatus, error) {
		gotName = mutation.name
		if mutation.trusted == nil || !*mutation.trusted || mutation.kind != a2aPeerTrustMutation {
			t.Fatal("trust endpoint did not decode the ADR trusted boolean")
		}
		return a2aPolicyWriteStatus{Persisted: true, Effective: true}, nil
	}))
	mux.Handle("DELETE /a2a/peers/{peer}/token", a2aPolicyTokenDeleteHandler(func(_ context.Context, mutation a2aPeerMutation) (a2aPolicyWriteStatus, error) {
		if mutation.kind != a2aPeerDeleteTokenMutation || mutation.token != nil {
			t.Fatal("delete endpoint did not produce a token-free delete mutation")
		}
		return statusToReturn, nil
	}))

	get := httptest.NewRecorder()
	mux.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/a2a/peers", nil))
	if get.Code != http.StatusOK || strings.Contains(get.Body.String(), submitted) || !strings.Contains(get.Body.String(), `"tokenPresent":true`) {
		t.Fatal("A2A peer list did not return metadata without a token")
	}

	request := httptest.NewRequest(http.MethodPost, "/a2a/peers/alpha/token", strings.NewReader(`{"token":"`+submitted+`"}`))
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || gotName != "alpha" || strings.Contains(response.Body.String(), submitted) || !strings.Contains(response.Body.String(), `"needsGatewayRestart":true`) {
		t.Fatal("pending token write was reported effective or leaked its write-only token")
	}
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/a2a/peers/alpha/trust", strings.NewReader(`{"trusted":true}`)))
	if response.Code != http.StatusOK || gotName != "alpha" {
		t.Fatal("named trust route did not return effective readback")
	}
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodDelete, "/a2a/peers/alpha/token", nil))
	if response.Code != http.StatusAccepted {
		t.Fatal("token deletion did not return pending restart status")
	}

	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/a2a/peers?token=secret", nil))
	if response.Code != http.StatusBadRequest || strings.Contains(response.Body.String(), submitted) {
		t.Fatal("query-bearing inventory request was not rejected")
	}

	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/a2a/peers/alpha/trust?token=secret", strings.NewReader(`{"trusted":false}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatal("query-bearing trust write was not rejected")
	}
}

func TestA2APolicyWriteHandlerRejectsFalseEffectivenessAndHidesErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status a2aPolicyWriteStatus
		want   int
	}{
		{name: "effective without persisted state", status: a2aPolicyWriteStatus{Effective: true}, want: http.StatusBadGateway},
		{name: "effective before required restart", status: a2aPolicyWriteStatus{Persisted: true, Effective: true, NeedsGatewayRestart: true}, want: http.StatusBadGateway},
		{name: "persisted but unverified without restart", status: a2aPolicyWriteStatus{Persisted: true}, want: http.StatusBadGateway},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := a2aPolicyTokenHandler(func(context.Context, a2aPeerMutation) (a2aPolicyWriteStatus, error) { return tc.status, nil })
			mux := http.NewServeMux()
			mux.Handle("POST /a2a/peers/{peer}/token", handler)
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/a2a/peers/alpha/token", strings.NewReader(`{"token":"`+a2aPolicyTestTokenA+`"}`)))
			if response.Code != tc.want || strings.Contains(response.Body.String(), `"effective":true`) {
				t.Fatal("handler claimed an unproven policy state was effective")
			}
		})
	}
	private := "private backend diagnostic"
	mux := http.NewServeMux()
	mux.Handle("POST /a2a/peers/{peer}/token", a2aPolicyTokenHandler(func(context.Context, a2aPeerMutation) (a2aPolicyWriteStatus, error) {
		return a2aPolicyWriteStatus{}, errors.New(private)
	}))
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/a2a/peers/alpha/token", strings.NewReader(`{"token":"`+a2aPolicyTestTokenA+`"}`)))
	if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), private) {
		t.Fatal("handler exposed a private backend diagnostic")
	}
}

func a2aPolicyProbeHTTPResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

func stringPtr(value string) *string { return &value }
