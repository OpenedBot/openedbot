package hermes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

func TestMirrorBridgeCopiesEveryFileTheSidecarNeeds(t *testing.T) {
	// Upstream mirrors a fixed list of four files and misses two that its own
	// entry point imports; every regular file of the source is copied here.
	source, mirror := t.TempDir(), filepath.Join(t.TempDir(), "sidecar")
	files := map[string]string{
		"index.mjs":                            "import './send-format.mjs'\n",
		"send-format.mjs":                      "export const format = 1\n",
		"stream-staleness.mjs":                 "export const stale = 2\n",
		"package.json":                         `{"name":"sidecar"}`,
		"package-lock.json":                    `{"lockfileVersion":3}`,
		"patch-spectrum-mixed-attachments.mjs": "// patch\n",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(source, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(source, "node_modules", "left-over"), 0o755); err != nil {
		t.Fatal(err)
	}

	changed, err := mirrorBridge(source, mirror, fsx.Current())
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	for name, body := range files {
		got, err := os.ReadFile(filepath.Join(mirror, name))
		if err != nil {
			t.Fatalf("%s missing from the mirror: %v", name, err)
		}
		if string(got) != body {
			t.Fatalf("%s = %q", name, got)
		}
	}
	if fsx.Exists(filepath.Join(mirror, "node_modules")) {
		t.Fatal("node_modules belongs to the mirror, it must not be copied into it")
	}
}

func TestMirrorBridgeRefreshesAStaleCopyAndLeavesAnIdenticalOneAlone(t *testing.T) {
	// The bug this fixes: upstream returns an existing copy untouched, so a
	// Hermes bump leaves an old bridge.js against a new adapter.
	source, mirror := t.TempDir(), filepath.Join(t.TempDir(), "bridge")
	if err := os.WriteFile(filepath.Join(source, "bridge.js"), []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(mirror, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mirror, "bridge.js"), []byte("v1\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(mirror, "node_modules"), 0o750); err != nil {
		t.Fatal(err)
	}

	changed, err := mirrorBridge(source, mirror, fsx.Current())
	if err != nil || !changed {
		t.Fatalf("a stale mirror must be refreshed: changed=%v err=%v", changed, err)
	}
	got, err := os.ReadFile(filepath.Join(mirror, "bridge.js"))
	if err != nil || string(got) != "v2\n" {
		t.Fatalf("bridge.js = %q, err=%v", got, err)
	}
	if !fsx.Exists(filepath.Join(mirror, "node_modules")) {
		t.Fatal("the installed dependencies must survive a refresh")
	}

	changed, err = mirrorBridge(source, mirror, fsx.Current())
	if err != nil || changed {
		t.Fatalf("an identical mirror must not be rewritten: changed=%v err=%v", changed, err)
	}
}

func npmCount(fake *exectest.Fake) int {
	n := 0
	for _, c := range fake.Commands() {
		if strings.Contains(c, "/npm ci ") {
			n++
		}
	}
	return n
}

func TestPrepareBridgeRetriesAnInstallThatFailedAfterCreatingNodeModules(t *testing.T) {
	// The bug this fixes: npm ci creates node_modules before it fails, and the
	// next pass took that directory as proof of a finished install.
	source, mirror := t.TempDir(), filepath.Join(t.TempDir(), "sidecar")
	lock := `{"lockfileVersion":3}`
	for name, body := range map[string]string{"index.mjs": "1\n", "package.json": `{}`, "package-lock.json": lock} {
		if err := os.WriteFile(filepath.Join(source, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b := nodeBridge{name: "photon", source: source, mirror: mirror}
	if err := os.MkdirAll(filepath.Join(mirror, "node_modules"), 0o750); err != nil {
		t.Fatal(err)
	}
	failing := exectest.NewFake().OnPrefix("/usr/sbin/runuser", exec.Result{ExitCode: 1, Stderr: "ECONNRESET"})
	i := &Installer{Runner: failing, Log: func(string, ...any) {}}

	if w := i.prepareBridge(context.Background(), b, fsx.Current()); !strings.Contains(w, "dependencies not installed") {
		t.Fatalf("warning = %q", w)
	}
	if fsx.Exists(filepath.Join(mirror, depsMarker)) {
		t.Fatal("a failed npm ci must not leave a success marker")
	}

	ok := exectest.NewFake().OnPrefix("/usr/sbin/runuser", exec.Result{})
	i.Runner = ok
	if w := i.prepareBridge(context.Background(), b, fsx.Current()); w != "" {
		t.Fatalf("warning = %q", w)
	}
	if npmCount(ok) != 1 {
		t.Fatalf("the unchanged mirror must retry npm ci, ran %v", ok.Commands())
	}
	sum := sha256.Sum256([]byte(lock))
	got, err := os.ReadFile(filepath.Join(mirror, depsMarker))
	if err != nil || strings.TrimSpace(string(got)) != hex.EncodeToString(sum[:]) {
		t.Fatalf("marker = %q, err=%v", got, err)
	}

	again := exectest.NewFake()
	i.Runner = again
	if w := i.prepareBridge(context.Background(), b, fsx.Current()); w != "" || npmCount(again) != 0 {
		t.Fatalf("a matching marker must skip npm: warning=%q ran=%v", w, again.Commands())
	}
}

func TestPrepareBridgeReinstallsWhenTheLockfileMovesAndKeepsTheAdapterStamp(t *testing.T) {
	source, mirror := t.TempDir(), filepath.Join(t.TempDir(), "bridge")
	pkg := `{"name":"bridge"}`
	for name, body := range map[string]string{"bridge.js": "1\n", "package.json": pkg} {
		if err := os.WriteFile(filepath.Join(source, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(mirror, "node_modules"), 0o750); err != nil {
		t.Fatal(err)
	}
	if _, err := mirrorBridge(source, mirror, fsx.Current()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mirror, depsMarker), []byte("stale\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	b := nodeBridge{name: "whatsapp", source: source, mirror: mirror, stamp: "node_modules/.hermes-pkg-hash"}
	fake := exectest.NewFake().OnPrefix("/usr/sbin/runuser", exec.Result{})
	i := &Installer{Runner: fake, Log: func(string, ...any) {}}

	if w := i.prepareBridge(context.Background(), b, fsx.Current()); w != "" {
		t.Fatalf("warning = %q", w)
	}
	if npmCount(fake) != 1 {
		t.Fatalf("a marker for another package.json must not skip npm, ran %v", fake.Commands())
	}
	sum := sha256.Sum256([]byte(pkg))
	stamp, err := os.ReadFile(filepath.Join(mirror, b.stamp))
	if err != nil || string(stamp) != hex.EncodeToString(sum[:])[:16] {
		t.Fatalf("adapter stamp = %q, err=%v", stamp, err)
	}
	marker, err := os.ReadFile(filepath.Join(mirror, depsMarker))
	if err != nil || strings.TrimSpace(string(marker)) != hex.EncodeToString(sum[:]) {
		t.Fatalf("without a lockfile the marker hashes package.json: %q, err=%v", marker, err)
	}
}

func TestNodeBridgesMirrorOutsideTheRootOwnedCheckout(t *testing.T) {
	for _, b := range nodeBridges() {
		if !strings.HasPrefix(b.source, "/usr/local/lib/hermes-agent/") {
			t.Fatalf("%s source %q is not in the managed checkout", b.name, b.source)
		}
		if !strings.HasPrefix(b.mirror, "/srv/hermes/data/") {
			t.Fatalf("%s mirror %q must live where the service user may write", b.name, b.mirror)
		}
	}
}
