package operator

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// touch moves a file's modification time without changing its size, the way
// an editor that rewrites the same bytes would.
func touch(t *testing.T, path string, at time.Time) {
	t.Helper()
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}

func fingerprintOf(t *testing.T, root string) string {
	t.Helper()
	fingerprint, err := InventoryFingerprint(InventoryRoots{RuntimeRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	return fingerprint
}

func seededHome(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "config.yaml"), "mcp_servers: {}\n")
	writeFile(t, filepath.Join(root, ".env"), "TOKEN=secret\n")
	writeFile(t, filepath.Join(root, "skills", "github", "pr", "SKILL.md"), "# PR\n")
	writeFile(t, filepath.Join(root, "profiles", "dev", "config.yaml"), "toolsets: []\n")
	return root
}

func TestInventoryFingerprintMovesOnWatchedFilesOnly(t *testing.T) {
	root := seededHome(t)
	base := fingerprintOf(t, root)
	if again := fingerprintOf(t, root); again != base {
		t.Fatalf("an unchanged home moved: %s then %s", base, again)
	}

	// Noise Hermes writes all the time: sessions, logs, hub indexes.
	writeFile(t, filepath.Join(root, "state.db"), "x")
	writeFile(t, filepath.Join(root, "logs", "gateway.log"), "line\n")
	writeFile(t, filepath.Join(root, "skills", ".hub", "index.json"), "{}")
	writeFile(t, filepath.Join(root, "skills", "github", "pr", "notes.txt"), "draft")
	if moved := fingerprintOf(t, root); moved != base {
		t.Fatal("a file outside the inventory moved the fingerprint")
	}

	cases := map[string]func(){
		"root config rewritten": func() {
			touch(t, filepath.Join(root, "config.yaml"), time.Now().Add(time.Hour))
		},
		"skill installed": func() {
			writeFile(t, filepath.Join(root, "skills", "notes", "SKILL.md"), "# Notes\n")
		},
		"profile env edited": func() {
			writeFile(t, filepath.Join(root, "profiles", "dev", ".env"), "LINEAR=1\n")
		},
		"MCP login stored": func() {
			writeFile(t, filepath.Join(root, "profiles", "dev", "mcp-tokens", "linear.json"), "{}")
		},
		"profile created": func() {
			writeFile(t, filepath.Join(root, "profiles", "ops", "config.yaml"), "")
		},
	}
	for name, change := range cases {
		before := fingerprintOf(t, root)
		change()
		if after := fingerprintOf(t, root); after == before {
			t.Fatalf("%s: the fingerprint did not move", name)
		}
	}
}

func TestInventoryFingerprintNeverHashesSecrets(t *testing.T) {
	root := seededHome(t)
	base := fingerprintOf(t, root)
	// Same size, same mtime, different secret: the content is never read.
	envPath := filepath.Join(root, ".env")
	info, err := os.Stat(envPath)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, envPath, "TOKEN=SECRET\n")
	touch(t, envPath, info.ModTime())
	if after := fingerprintOf(t, root); after != base {
		t.Fatal("the fingerprint depends on a file's content")
	}
}

func TestInventoryFingerprintRouteDropsTheReadCacheWhenItMoves(t *testing.T) {
	root := seededHome(t)
	s := &Server{InventoryRoots: InventoryRoots{RuntimeRoot: root}}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)

	status, out := call(t, srv, "GET", "/inventory/fingerprint", "")
	if status != 200 || out["fingerprint"] == "" {
		t.Fatalf("%d %v", status, out)
	}
	first := s.probeGeneration

	// Unchanged: the cache stays.
	if status, _ := call(t, srv, "GET", "/inventory/fingerprint", ""); status != 200 || s.probeGeneration != first {
		t.Fatal("an unchanged fingerprint dropped the read cache")
	}

	writeFile(t, filepath.Join(root, "skills", "notes", "SKILL.md"), "# Notes\n")
	status, moved := call(t, srv, "GET", "/inventory/fingerprint", "")
	if status != 200 || moved["fingerprint"] == out["fingerprint"] {
		t.Fatalf("%d %v", status, moved)
	}
	if s.probeGeneration == first {
		t.Fatal("a moved fingerprint kept the read cache")
	}
}

func TestInventoryFingerprintMovedUnderProfilesOnlyKeepsTheRootReads(t *testing.T) {
	root := seededHome(t)
	s := &Server{InventoryRoots: InventoryRoots{RuntimeRoot: root}}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	call(t, srv, "GET", "/inventory/fingerprint", "")
	rootGeneration, profilesGeneration := s.probeGeneration, s.profilesGeneration

	// A new bot's profile being written: the profile inventory goes, the
	// root reads (settable toolsets, MCP, skills) stay.
	writeFile(t, filepath.Join(root, "profiles", "scout", "config.yaml"), "model: {}\n")
	if status, _ := call(t, srv, "GET", "/inventory/fingerprint", ""); status != 200 {
		t.Fatal("fingerprint")
	}
	if s.probeGeneration != rootGeneration || s.profilesGeneration == profilesGeneration {
		t.Fatalf("profile move: root %d→%d, profiles %d→%d", rootGeneration, s.probeGeneration, profilesGeneration, s.profilesGeneration)
	}

	writeFile(t, filepath.Join(root, "config.yaml"), "platform_toolsets: {}\n")
	call(t, srv, "GET", "/inventory/fingerprint", "")
	if s.probeGeneration == rootGeneration {
		t.Fatal("a root move kept the root reads")
	}
}

func TestInventoryFingerprintRouteWithoutRootIsNotFound(t *testing.T) {
	srv := httptest.NewServer((&Server{}).Handler())
	t.Cleanup(srv.Close)
	if status, out := call(t, srv, "GET", "/inventory/fingerprint", ""); status != 404 {
		t.Fatalf("%d %v", status, out)
	}
}
