package operator

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func profileWorkspaceGet(s *Server, profile, file string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/profiles/"+profile+"/workspace/files/"+file, nil))
	return rec
}

func workspaceProof(profile string, isolated bool) Probe {
	return func(_ context.Context, verb string, request []byte) ([]byte, error) {
		if verb != "profile-workspace" {
			return []byte(`{}`), nil
		}
		var input struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(request, &input); err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"profile": profile, "isolated": isolated && input.Name == profile})
	}
}

func TestProfileWorkspaceFilesStayBoundToTheNamedProfile(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"alpha", "beta"} {
		directory := filepath.Join(root, "profiles", name, "workspace")
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "same.pdf"), []byte("%PDF-"+name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	shared := filepath.Join(root, "workspaces")
	if err := os.Mkdir(shared, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shared, "shared.pdf"), []byte("%PDF-shared-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"alpha", "beta"} {
		s := &Server{InventoryRoots: InventoryRoots{RuntimeRoot: root}, WorkspaceRoot: shared, Probe: workspaceProof(name, true)}
		got := profileWorkspaceGet(s, name, "same.pdf")
		if got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), []byte("%PDF-"+name)) {
			t.Fatalf("wrong owned file: %d %q", got.Code, got.Body.String())
		}
		if got.Header().Get("Content-Type") != "application/pdf" {
			t.Fatal("magic type missing")
		}
		if got = profileWorkspaceGet(s, name, "shared.pdf"); got.Code != http.StatusNotFound {
			t.Fatalf("root workspace fallback: %d", got.Code)
		}
	}
	// A proof for alpha cannot authorize beta, nor can an unproven old profile.
	for _, proof := range []Probe{workspaceProof("alpha", true), workspaceProof("beta", false)} {
		s := &Server{InventoryRoots: InventoryRoots{RuntimeRoot: root}, Probe: proof}
		if got := profileWorkspaceGet(s, "beta", "same.pdf"); got.Code != http.StatusConflict {
			t.Fatalf("unproven workspace served: %d", got.Code)
		}
	}
}

func TestProfileWorkspaceRefusesSymlinksFIFOAndUnsafeFiles(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "profiles", "alpha", "workspace")
	beta := filepath.Join(root, "profiles", "beta", "workspace")
	for _, directory := range []string{workspace, beta} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(beta, "private.pdf")
	if err := os.WriteFile(outside, []byte("%PDF-beta-private"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "escape.pdf")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(workspace, "pipe.pdf"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "opaque.pdf"), []byte("not an image or PDF"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "huge.pdf"), append([]byte("%PDF-"), make([]byte, maxWorkspaceFileBytes)...), 0o600); err != nil {
		t.Fatal(err)
	}
	s := &Server{InventoryRoots: InventoryRoots{RuntimeRoot: root}, Probe: workspaceProof("alpha", true)}
	for _, tc := range []struct {
		file   string
		status int
	}{{"escape.pdf", 404}, {"pipe.pdf", 404}, {"opaque.pdf", 415}, {"huge.pdf", 413}} {
		got := profileWorkspaceGet(s, "alpha", tc.file)
		if got.Code != tc.status {
			t.Fatalf("%s: %d, want %d", tc.file, got.Code, tc.status)
		}
		if strings.Contains(got.Body.String(), "beta-private") || strings.Contains(got.Body.String(), root) {
			t.Fatal("private file data or host path escaped")
		}
	}
	// Reject a profile workspace symlink even if a compromised/stale proof said true.
	if err := os.Rename(workspace, workspace+"-saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(beta, workspace); err != nil {
		t.Fatal(err)
	}
	if got := profileWorkspaceGet(s, "alpha", "private.pdf"); got.Code != http.StatusConflict {
		t.Fatalf("workspace symlink served: %d", got.Code)
	}
}

func TestProfileWorkspaceRejectsTraversalAndProfileDirectorySymlink(t *testing.T) {
	root := t.TempDir()
	beta := filepath.Join(root, "profiles", "beta", "workspace")
	if err := os.MkdirAll(beta, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(beta, "private.pdf"), []byte("%PDF-private"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(beta), filepath.Join(root, "profiles", "alpha")); err != nil {
		t.Fatal(err)
	}
	s := &Server{InventoryRoots: InventoryRoots{RuntimeRoot: root}, Probe: workspaceProof("alpha", true)}
	if got := profileWorkspaceGet(s, "alpha", "private.pdf"); got.Code != http.StatusConflict {
		t.Fatalf("profile symlink served: %d", got.Code)
	}
	for _, path := range []string{"/profiles/../workspace/files/a.pdf", "/profiles/alpha/workspace/files/../a.pdf", "/profiles/alpha/workspace/files/a%2Fb.pdf", "/profiles/default/workspace/files/a.pdf"} {
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code < 400 {
			t.Fatalf("unsafe route %s answered %d", path, rec.Code)
		}
	}
}

func TestProfileWorkspaceProofIsRefreshedBeforeEveryFileRead(t *testing.T) {
	root := t.TempDir()
	workspace := filepath.Join(root, "profiles", "alpha", "workspace")
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "chart.png"), tinyPNG, 0o600); err != nil {
		t.Fatal(err)
	}
	isolated, calls := true, 0
	s := &Server{InventoryRoots: InventoryRoots{RuntimeRoot: root}, Probe: func(_ context.Context, verb string, _ []byte) ([]byte, error) {
		calls++
		return json.Marshal(map[string]any{"profile": "alpha", "isolated": isolated})
	}}
	if got := profileWorkspaceGet(s, "alpha", "chart.png"); got.Code != http.StatusOK {
		t.Fatalf("first read: %d", got.Code)
	}
	isolated = false
	if got := profileWorkspaceGet(s, "alpha", "chart.png"); got.Code != http.StatusConflict {
		t.Fatalf("stale proof reused: %d", got.Code)
	}
	if calls != 2 {
		t.Fatalf("proof calls: %d", calls)
	}
}

func sharedRootProof(profile string) Probe {
	return func(_ context.Context, verb string, _ []byte) ([]byte, error) {
		return json.Marshal(map[string]any{"profile": profile, "isolated": false, "sharedRoot": true})
	}
}

// A profile made before isolation mounts the root `workspaces` shared by every
// such profile: a file written there within Hermes' trust window is served,
// an older one stays invisible, and nothing outside that root is reachable.
func TestSharedRootProfileServesOnlyRecentFiles(t *testing.T) {
	root := t.TempDir()
	shared := filepath.Join(root, "workspaces")
	if err := os.Mkdir(shared, 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 11, 15, 0, 0, 0, time.UTC)
	write := func(name string, data []byte, modified time.Time) {
		t.Helper()
		path := filepath.Join(shared, name)
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, modified, modified); err != nil {
			t.Fatal(err)
		}
	}
	write("fresh.png", tinyPNG, now.Add(-2*time.Minute))
	write("stale.png", tinyPNG, now.Add(-11*time.Minute))
	write("future.png", tinyPNG, now.Add(5*time.Minute))
	write("skew.png", tinyPNG, now.Add(30*time.Second))
	secret := filepath.Join(root, "secret.pdf")
	if err := os.WriteFile(secret, []byte("%PDF-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(secret, now, now); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(shared, "escape.pdf")); err != nil {
		t.Fatal(err)
	}
	s := &Server{
		InventoryRoots: InventoryRoots{RuntimeRoot: root},
		WorkspaceRoot:  shared,
		Probe:          sharedRootProof("alpha"),
		Now:            func() time.Time { return now },
	}
	for _, tc := range []struct {
		file   string
		status int
	}{{"fresh.png", 200}, {"skew.png", 200}, {"stale.png", 404}, {"future.png", 404}, {"escape.pdf", 404}, {"missing.png", 404}} {
		got := profileWorkspaceGet(s, "alpha", tc.file)
		if got.Code != tc.status {
			t.Fatalf("%s: %d, want %d", tc.file, got.Code, tc.status)
		}
		if tc.status == 200 && !bytes.Equal(got.Body.Bytes(), tinyPNG) {
			t.Fatalf("%s: wrong bytes", tc.file)
		}
		if strings.Contains(got.Body.String(), "secret") || strings.Contains(got.Body.String(), root) {
			t.Fatal("data or host path escaped")
		}
	}
	// A stale file answers exactly like a missing one.
	stale, missing := profileWorkspaceGet(s, "alpha", "stale.png"), profileWorkspaceGet(s, "alpha", "missing.png")
	if stale.Body.String() != missing.Body.String() {
		t.Fatalf("stale file distinguishable: %q vs %q", stale.Body.String(), missing.Body.String())
	}
	// The proof must name this profile and the root must be the runtime's own.
	other := &Server{InventoryRoots: InventoryRoots{RuntimeRoot: root}, WorkspaceRoot: shared, Probe: sharedRootProof("beta"), Now: s.Now}
	if got := profileWorkspaceGet(other, "alpha", "fresh.png"); got.Code != http.StatusConflict {
		t.Fatalf("proof for another profile served: %d", got.Code)
	}
	elsewhere := t.TempDir()
	moved := &Server{InventoryRoots: InventoryRoots{RuntimeRoot: elsewhere}, WorkspaceRoot: shared, Probe: sharedRootProof("alpha"), Now: s.Now}
	if got := profileWorkspaceGet(moved, "alpha", "fresh.png"); got.Code != http.StatusConflict {
		t.Fatalf("foreign shared root served: %d", got.Code)
	}
	// A symlinked shared root is never followed.
	linked := filepath.Join(root, "linked")
	if err := os.Rename(shared, linked); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(linked, shared); err != nil {
		t.Fatal(err)
	}
	if got := profileWorkspaceGet(s, "alpha", "fresh.png"); got.Code != http.StatusConflict {
		t.Fatalf("symlinked shared root served: %d", got.Code)
	}
}
