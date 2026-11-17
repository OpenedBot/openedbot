package operator

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestACPFeaturesAndRoutesAgree(t *testing.T) {
	h := acpHost(t.TempDir(), func() (int, int, error) { return os.Getuid(), os.Getgid(), nil })
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/capabilities", nil))
	var doc struct {
		Features []string `json:"features"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || doc.Features == nil || len(doc.Features) != len(ACPFeatures()) || len(doc.Features) != 1 || doc.Features[0] != "profile_management" {
		t.Fatalf("capabilities: %s", w.Body.String())
	}
	for _, route := range []struct{ method, path string }{{"GET", "/usage"}, {"GET", "/provider-sdks"}, {"POST", "/providers/openai/credentials"}, {"GET", "/model-context"}, {"GET", "/inventory/fingerprint"}, {"GET", "/skills"}, {"GET", "/toolsets"}, {"GET", "/mcp/servers"}, {"GET", "/gateway"}, {"POST", "/gateway/restart"}, {"GET", "/profiles/demo/memory"}, {"POST", "/profiles/demo/model"}, {"GET", "/profiles/demo/approval-policy"}, {"GET", "/sessions-inventory"}, {"GET", "/workspace/files/a"}, {"GET", "/a2a/agent-card"}, {"GET", "/a2a/audit"}, {"GET", "/a2a/peers"}} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(route.method, route.path, nil))
		if w.Code != 404 {
			t.Errorf("%s %s: %d", route.method, route.path, w.Code)
		}
	}
}

func TestACPProfileLifecycle(t *testing.T) {
	root := t.TempDir()
	h := acpHost(root, func() (int, int, error) { return os.Getuid(), os.Getgid(), nil })
	request := func(method, path, body string, status int) *httptest.ResponseRecorder {
		t.Helper()
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		if w.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		return w
	}
	for _, name := range []string{"default", "../escape", "-bad", "Upper", strings.Repeat("a", 64)} {
		request("POST", "/profiles", `{"name":"`+name+`"}`, 400)
	}
	request("POST", "/profiles", `{"name":"demo","provider":"fake","model":"fake/model"}`, 400)
	request("POST", "/profiles", `{"name":"demo","displayName":"Demo"}`, 201)
	info, err := os.Stat(filepath.Join(root, "demo"))
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("profile mode: %v %v", info, err)
	}
	stat := info.Sys().(*syscall.Stat_t)
	if int(stat.Uid) != os.Getuid() || int(stat.Gid) != os.Getgid() {
		t.Fatalf("profile ownership: %d:%d", stat.Uid, stat.Gid)
	}
	request("POST", "/profiles", `{"name":"demo"}`, 409)
	var inventory ProfileInventory
	if err := json.Unmarshal(request("GET", "/profiles", "", 200).Body.Bytes(), &inventory); err != nil || len(inventory.Profiles) != 1 || inventory.Profiles[0].Name != "demo" {
		t.Fatalf("inventory: %+v %v", inventory, err)
	}
	if err := os.WriteFile(filepath.Join(root, "demo", "work"), []byte("work"), 0600); err != nil {
		t.Fatal(err)
	}
	request("DELETE", "/profiles/demo", "", 204)
	if _, err := os.Stat(filepath.Join(root, "demo")); !os.IsNotExist(err) {
		t.Fatalf("profile remains: %v", err)
	}
	request("DELETE", "/profiles/demo", "", 404)
	request("DELETE", "/profiles/default", "", 400)
	request("GET", "/profiles", "", 200)
}

func TestACPProfileOwnerFailureCreatesNothing(t *testing.T) {
	root := t.TempDir()
	h := acpHost(root, func() (int, int, error) { return 0, 0, errors.New("service user unavailable") })
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/profiles", strings.NewReader(`{"name":"demo"}`)))
	if w.Code != 502 {
		t.Fatalf("owner failure: %d", w.Code)
	}
	if _, err := os.Stat(filepath.Join(root, "demo")); !os.IsNotExist(err) {
		t.Fatalf("partial profile created: %v", err)
	}
}
