package operator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestA2AManagementReplacesAuditOnlyWhilePolicyIsObserved(t *testing.T) {
	ready := true
	server := &Server{
		A2ACard:  func(context.Context) (A2AAgentCard, error) { return A2AAgentCard{}, nil },
		A2AAudit: func(context.Context, int) (a2aAuditSnapshot, error) { return a2aAuditSnapshot{}, nil },
		A2APeers: func(context.Context) (A2APolicyView, error) { return A2APolicyView{}, nil },
		WriteA2APeer: func(context.Context, a2aPeerMutation) (a2aPolicyWriteStatus, error) {
			return a2aPolicyWriteStatus{}, nil
		},
		A2APolicyReady: func(context.Context) bool { return ready },
	}
	read := func() map[string]bool {
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/capabilities", nil))
		var body struct {
			Features []string `json:"features"`
		}
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &body) != nil {
			t.Fatal("capability response failed")
		}
		features := make(map[string]bool)
		for _, name := range body.Features {
			features[name] = true
		}
		if len(features) > 16 {
			t.Fatal("operator exceeded the existing feature bound")
		}
		return features
	}
	features := read()
	if !features["a2a_management"] || features["a2a_audit"] || !features["a2a_card"] {
		t.Fatal("management did not replace the audit-only flag")
	}
	ready = false
	features = read()
	if features["a2a_management"] || !features["a2a_audit"] {
		t.Fatal("unobserved policy retained a management flag")
	}
}
