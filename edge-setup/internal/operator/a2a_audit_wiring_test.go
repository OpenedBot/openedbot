package operator

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"
)

func TestA2AAuditAdvertisementRequiresLiveLoopbackCard(t *testing.T) {
	available := true
	server := &Server{A2ACard: func(context.Context) (A2AAgentCard, error) {
		if !available {
			return A2AAgentCard{}, errors.New("listener unavailable")
		}
		return A2AAgentCard{}, nil
	}, A2AAudit: func(context.Context, int) (a2aAuditSnapshot, error) { return emptyA2AAuditSnapshot("missing", 50), nil }}
	for _, state := range []bool{true, false} {
		available = state
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/capabilities", nil))
		var payload struct {
			Features []string `json:"features"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, feature := range payload.Features {
			if feature == "a2a_audit" {
				found = true
			}
		}
		if found != state {
			t.Fatalf("live card=%v, audit advertisement=%v", state, found)
		}
	}
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/a2a/audit", nil))
	if response.Code != 200 {
		t.Fatalf("named audit read HTTP %d", response.Code)
	}
}
