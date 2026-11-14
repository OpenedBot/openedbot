package operator

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

const callbackRuntime = "750b6e7c-6fb3-4fbd-8d79-b4bb8451b69a"
const callbackOrganization = "00000000-0000-4000-8000-000000000201"

func TestDevelopmentCallbackOnlyUsesEnrolledDevLoopback(t *testing.T) {
	for _, tc := range []struct {
		name, origin, environment string
		allowed                   bool
	}{
		{"private SSH tunnel", "http://127.0.0.1:8857", "dev", true},
		{"production", "http://127.0.0.1:8857", "prod", false},
		{"LAN", "http://192.168.50.20:8790", "dev", false},
		{"public", "http://example.com:8790", "dev", false},
		{"credentials", "http://user:pass@127.0.0.1:8857", "dev", false},
		{"path", "http://127.0.0.1:8857/admin", "dev", false},
		{"port", "http://127.0.0.1:99999", "dev", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "workstation")
			os.Mkdir(dir, 0o700)
			data, _ := json.Marshal(map[string]string{"runtime_id": callbackRuntime, "openedbot": tc.origin, "openedbot_environment": tc.environment})
			if err := os.WriteFile(filepath.Join(dir, "link.json"), data, 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := developmentCallbackOrigin(root, fsx.Current(), callbackRuntime)
			if (err == nil) != tc.allowed {
				t.Fatalf("origin %q error %v", got, err)
			}
			if tc.allowed && got != tc.origin {
				t.Fatalf("origin changed: %q", got)
			}
			if _, err := developmentCallbackOrigin(root, fsx.Current(), callbackOrganization); err == nil {
				t.Fatal("another runtime selected this link")
			}
		})
	}
}

func TestDevelopmentCallbackFixedServerAndPath(t *testing.T) {
	s := &Server{DevelopmentCallbackOrigin: func(id string) (string, error) {
		if id != callbackRuntime {
			t.Fatalf("unexpected runtime: %s", id)
		}
		return "http://127.0.0.1:8857", nil
	}}
	valid := mcpAddBody{Name: "openedbot_routines", Auth: "header", URL: "openedbot-dev://" + callbackRuntime + "/api/mcp/routines/" + callbackOrganization}
	got, ok := s.resolveDevelopmentCallback(valid)
	if !ok || got != "http://127.0.0.1:8857/api/mcp/routines/"+callbackOrganization {
		t.Fatal(got, ok)
	}
	for _, altered := range []mcpAddBody{
		{Name: "other", Auth: "header", URL: valid.URL},
		{Name: valid.Name, Auth: "none", URL: valid.URL},
		{Name: valid.Name, Auth: "header", URL: "openedbot-dev://" + callbackRuntime + "/admin"},
		{Name: valid.Name, Auth: "header", URL: valid.URL + "?redirect=other"},
		{Name: valid.Name, Auth: "header", URL: valid.URL + "#fragment"},
	} {
		if _, ok := s.resolveDevelopmentCallback(altered); ok {
			t.Fatal("unowned callback allowed", altered.Name)
		}
	}
}

func TestDevelopmentCallbackHandlerForwardsOnlyResolvedLoopback(t *testing.T) {
	recorder := &probeRecorder{replies: map[string]string{"mcp-add": `{"server":{"name":"openedbot_routines","transport":"http","auth":"header","configEnabled":true,"platformEnabled":true,"envKeys":[]}}`}}
	s := &Server{Probe: recorder.probe(), DevelopmentCallbackOrigin: func(string) (string, error) { return "http://127.0.0.1:8857", nil }}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	path := "/api/mcp/routines/" + callbackOrganization
	body := `{"name":"openedbot_routines","url":"openedbot-dev://` + callbackRuntime + path + `","auth":"header","token":"synthetic-test-token"}`
	status, _ := call(t, srv, "POST", "/mcp/servers", body)
	if status != 200 || len(recorder.bodies) != 1 {
		t.Fatal("callback failed", status)
	}
	var forwarded map[string]any
	if err := json.Unmarshal([]byte(recorder.bodies[0]), &forwarded); err != nil {
		t.Fatal(err)
	}
	if forwarded["url"] != "http://127.0.0.1:8857"+path || forwarded["development_callback"] != true {
		t.Fatal("callback was not resolved")
	}
	status, _ = call(t, srv, "POST", "/mcp/servers", `{"name":"openedbot_routines","url":"http://127.0.0.1:8857`+path+`","auth":"header","token":"synthetic-test-token"}`)
	if status != 400 || len(recorder.bodies) != 1 {
		t.Fatal("arbitrary HTTP was allowed")
	}
}
