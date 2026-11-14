package commands

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

func TestLabMCPRecoversLegacyReceiptAfterControllerUpgrade(t *testing.T) {
	options, deps, _ := labMCPTestFixture(t)
	dir := t.TempDir()
	old := []byte("# original installed fixture\n")
	sum := sha256.Sum256(old)
	original := filepath.Join(dir, "lab-mcp-fixture-"+hex.EncodeToString(sum[:8])+".py")
	if err := os.WriteFile(original, old, 0o644); err != nil {
		t.Fatal(err)
	}
	deps.ScriptPath = original
	first, err := executeLabMCP(context.Background(), options, deps)
	if err != nil {
		t.Fatal(err)
	}
	deps.ScriptPath = filepath.Join(dir, "lab-mcp-fixture-0000000000000000.py")
	deps.ResolveEntry = func(hash, nonce string) (string, error) {
		return resolveLabMCPEntry(dir, deps.ScriptPath, hash, nonce, fsx.Current())
	}
	originalRun := deps.Run
	deps.Run = func(ctx context.Context, request map[string]any) (labMCPResult, error) {
		if request["entryScriptPath"] != original {
			t.Fatal("upgraded controller lost original entry identity")
		}
		return originalRun(ctx, request)
	}
	// Replay uses the same secret and preserves the original serve entry; only
	// the current fixed controller is executed by the production Run closure.
	replay, err := executeLabMCP(context.Background(), options, deps)
	if err != nil || replay.Secret != first.Secret || !replay.Replayed {
		t.Fatalf("legacy replay: %+v %v", replay, err)
	}
	options.Action = "receipts"
	if _, err := executeLabMCP(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	options.Action = "remove"
	if _, err := executeLabMCP(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(original); err != nil {
		t.Fatal(err)
	}
	// Terminal receipts require no worker or retained executable asset.
	if _, err := executeLabMCP(context.Background(), options, deps); err != nil {
		t.Fatal(err)
	}
}

func TestLabMCPUpgradeRefusesUntrustedOrChangedOriginalAsset(t *testing.T) {
	for _, kind := range []string{"missing", "content", "mode", "symlink", "foreign-owner", "outside"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			content := []byte("# old fixture\n")
			sum := sha256.Sum256(content)
			path := filepath.Join(dir, "lab-mcp-fixture-"+hex.EncodeToString(sum[:8])+".py")
			if kind == "outside" {
				path = filepath.Join(t.TempDir(), filepath.Base(path))
			}
			if kind != "missing" {
				if err := os.WriteFile(path, content, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			owner := fsx.Current()
			switch kind {
			case "content":
				if err := os.WriteFile(path, []byte("changed"), 0o644); err != nil {
					t.Fatal(err)
				}
			case "mode":
				if err := os.Chmod(path, 0o666); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("/etc/passwd", path); err != nil {
					t.Fatal(err)
				}
			case "foreign-owner":
				owner.UID++
			}
			if _, err := resolveLabMCPEntry(dir, filepath.Join(dir, "current"), labMCPEntryHash(path, labTestNonce), labTestNonce, owner); err == nil {
				t.Fatal("unsafe legacy asset accepted")
			}
		})
	}
}
