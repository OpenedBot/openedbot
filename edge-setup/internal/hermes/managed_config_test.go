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

func TestManagedConfigCapsWebExtractPages(t *testing.T) {
	// Hermes clamps web.extract_char_limit to [2000, 500000] and falls back to
	// 15000 on anything non-numeric (web_tools_truncate.py).
	if !strings.Contains(ManagedConfig, "web:\n  extract_char_limit: 10000\n") {
		t.Fatalf("managed config lost the web extract cap: %q", ManagedConfig)
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

func TestManagedConfigReplacesTheAPIServerHint(t *testing.T) {
	// Hermes's own api_server hint says "assume plain text" and "state the
	// plain file path instead of a MEDIA: tag", which contradicts openedbot's
	// Markdown rendering and `MEDIA:/workspace/<name>` attachments. `replace`
	// must stay non-empty: a blank value restores the built-in hint
	// (agent/system_prompt.py, _resolve_platform_hint).
	const prefix = "platform_hints:\n  api_server:\n    replace: \""
	start := strings.Index(ManagedConfig, prefix)
	if start < 0 {
		t.Fatalf("managed config lost the api_server hint: %q", ManagedConfig)
	}
	rest := ManagedConfig[start+len(prefix):]
	end := strings.Index(rest, "\"\n")
	if end <= 0 {
		t.Fatalf("the api_server hint is not one non-empty double-quoted line: %q", rest)
	}
	hint := rest[:end]
	if strings.ContainsAny(hint, "\"\\\n") {
		t.Fatalf("the api_server hint must need no YAML escape: %q", hint)
	}
	for _, want := range []string{"MEDIA:/workspace/<name>", "Markdown", "plain text"} {
		if !strings.Contains(hint, want) {
			t.Fatalf("the api_server hint lost %q: %q", want, hint)
		}
	}
	if strings.Contains(hint, "instead of a MEDIA") {
		t.Fatalf("the api_server hint must not forbid MEDIA tags: %q", hint)
	}
}
