package connector

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// manifestRoute is one line of the shared allowlist manifest. openedbot's
// relay-allowlist.ts is tested against a byte-identical copy of the same file
// (OpenedBot/openedbot: platform/hermes/tests/fixtures/relay-allowlist.json), and `make
// contract-check` at the repository root compares the two copies.
type manifestRoute struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Events bool   `json:"events"`
	Host   bool   `json:"host"`
}

func sortedManifest() []manifestRoute {
	out := make([]manifestRoute, 0, len(Allowlist))
	for _, r := range Allowlist {
		out = append(out, manifestRoute{Method: r.Method, Path: r.Path.String(), Events: r.Events, Host: r.Host})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Method < out[j].Method
	})
	return out
}

func TestAllowlistManifest(t *testing.T) {
	path := filepath.Join("..", "..", "test", "golden", "relay-allowlist", "allowlist.json")
	want, err := json.MarshalIndent(sortedManifest(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	if os.Getenv("UPDATE_ALLOWLIST_MANIFEST") == "1" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing shared allowlist manifest (UPDATE_ALLOWLIST_MANIFEST=1 writes it): %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("allowlist.go and %s disagree: a route changed on one side only.\nRegenerate with UPDATE_ALLOWLIST_MANIFEST=1, copy it to openedbot, and read the diff as a contract change.", path)
	}
}
