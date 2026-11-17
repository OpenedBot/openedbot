package operator

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestACPFeaturesAndRoutesAgree(t *testing.T) {
	h := ACPHost()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/capabilities", nil))
	var doc struct {
		Features []string `json:"features"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || doc.Features == nil || len(doc.Features) != len(ACPFeatures()) || len(doc.Features) != 0 {
		t.Fatalf("capabilities: %s", w.Body.String())
	}
	for _, route := range []struct{ method, path string }{{"GET", "/usage"}, {"GET", "/provider-sdks"}, {"POST", "/providers/openai/credentials"}, {"GET", "/model-context"}, {"GET", "/inventory/fingerprint"}, {"GET", "/skills"}, {"GET", "/toolsets"}, {"GET", "/mcp/servers"}, {"GET", "/gateway"}, {"POST", "/gateway/restart"}, {"GET", "/profiles"}, {"GET", "/profiles/demo/memory"}, {"POST", "/profiles/demo/model"}, {"GET", "/profiles/demo/approval-policy"}, {"GET", "/sessions-inventory"}, {"GET", "/workspace/files/a"}, {"GET", "/a2a/agent-card"}, {"GET", "/a2a/audit"}, {"GET", "/a2a/peers"}} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(route.method, route.path, nil))
		if w.Code != 404 {
			t.Errorf("%s %s: %d", route.method, route.path, w.Code)
		}
	}
}
