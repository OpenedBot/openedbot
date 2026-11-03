package hermes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

func TestManagedDefaultsWriteOnceAndRepairDrift(t *testing.T) {
	path := filepath.Join(t.TempDir(), "etc-hermes", "config.yaml")
	changed, err := applyManagedDefaultsAt(path, fsx.Current(), nil)
	if err != nil || !changed {
		t.Fatalf("first write: changed=%v err=%v", changed, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o644 {
		t.Fatalf("managed config must be world-readable for the service user: %v %v", info, err)
	}
	if changed, err := applyManagedDefaultsAt(path, fsx.Current(), nil); err != nil || changed {
		t.Fatalf("an identical file must not be rewritten: changed=%v err=%v", changed, err)
	}
	if err := os.WriteFile(path, []byte("prompt_caching:\n  cache_ttl: 5m\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if changed, err := applyManagedDefaultsAt(path, fsx.Current(), nil); err != nil || !changed {
		t.Fatalf("a drifted file must be repaired: changed=%v err=%v", changed, err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != ManagedConfig {
		t.Fatalf("managed config = %q", got)
	}
}

func TestManagedConfigPinsTheAutoPromptCacheTier(t *testing.T) {
	// Hermes accepts exactly "5m", "1h" or "auto" (agent_init.py); anything
	// else silently keeps 5m.
	if !strings.Contains(ManagedConfig, "prompt_caching:\n  cache_ttl: auto\n") {
		t.Fatalf("managed config lost the prompt cache TTL: %q", ManagedConfig)
	}
}

func TestManagedDefaultsRefuseASymlinkedTarget(t *testing.T) {
	dir := t.TempDir()
	elsewhere := filepath.Join(dir, "elsewhere.yaml")
	if err := os.WriteFile(elsewhere, []byte("keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.yaml")
	if err := os.Symlink(elsewhere, path); err != nil {
		t.Fatal(err)
	}
	if _, err := applyManagedDefaultsAt(path, fsx.Current(), nil); err == nil {
		t.Fatal("a symlinked managed config was followed")
	}
	if got, _ := os.ReadFile(elsewhere); string(got) != "keep\n" {
		t.Fatalf("the symlink target was overwritten: %q", got)
	}
}
