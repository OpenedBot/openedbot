package hermes

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
)

func TestSweepProbesTakesRuntimeWriteProbesOutOfTheCheckout(t *testing.T) {
	checkout, quarantine := t.TempDir(), filepath.Join(t.TempDir(), "pass")
	probe := filepath.Join(checkout, "plugins/platforms/photon/sidecar/.hermes-write-probe")
	if err := os.MkdirAll(filepath.Dir(probe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(probe, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(checkout, "plugins/platforms/photon/sidecar/index.mjs")
	if err := os.WriteFile(source, []byte("export {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	moved, err := sweepProbes(checkout, quarantine, fsx.Current())
	if err != nil {
		t.Fatal(err)
	}
	if len(moved) != 1 || moved[0] != "plugins/platforms/photon/sidecar/.hermes-write-probe" {
		t.Fatalf("moved = %v", moved)
	}
	if fsx.Exists(probe) {
		t.Fatal("the probe is still in the checkout")
	}
	if !fsx.Exists(filepath.Join(quarantine, "plugins/platforms/photon/sidecar/.hermes-write-probe")) {
		t.Fatal("the probe was destroyed instead of being quarantined")
	}
	// Quarantined content belongs to the client and is never world-readable.
	for _, dir := range []string{quarantine, filepath.Dir(quarantine)} {
		st, err := os.Stat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o700 {
			t.Fatalf("%s is %04o, want 0700", dir, st.Mode().Perm())
		}
	}
	if !fsx.Exists(source) {
		t.Fatal("a sibling source file was taken away")
	}
}

func TestSweepProbesIsANoOpOnACleanCheckout(t *testing.T) {
	quarantine := filepath.Join(t.TempDir(), "pass")
	moved, err := sweepProbes(t.TempDir(), quarantine, fsx.Current())
	if err != nil {
		t.Fatal(err)
	}
	if len(moved) != 0 {
		t.Fatalf("moved = %v", moved)
	}
	if fsx.Exists(quarantine) {
		t.Fatal("an empty pass must not create a quarantine directory")
	}
}

func TestQuarantineUntrackedKeepsWhatGitCleanWouldDelete(t *testing.T) {
	checkout, quarantine := t.TempDir(), filepath.Join(t.TempDir(), "pass")
	if err := os.MkdirAll(filepath.Join(checkout, "plugins/platforms/acme"), 0o755); err != nil {
		t.Fatal(err)
	}
	dropped := filepath.Join(checkout, "plugins/platforms/acme/adapter.py")
	if err := os.WriteFile(dropped, []byte("# client plugin\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	porcelain := " M pyproject.toml\n?? plugins/platforms/acme/adapter.py\n"

	moved, err := quarantineUntracked(checkout, quarantine, porcelain, fsx.Current())
	if err != nil {
		t.Fatal(err)
	}
	if len(moved) != 1 {
		t.Fatalf("moved = %v", moved)
	}
	kept := filepath.Join(quarantine, "plugins/platforms/acme/adapter.py")
	data, err := os.ReadFile(kept)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "# client plugin\n" {
		t.Fatalf("quarantined content = %q", data)
	}
	manifest, err := os.ReadFile(filepath.Join(quarantine, "git-status.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), "?? plugins/platforms/acme/adapter.py") {
		t.Fatalf("manifest = %q", manifest)
	}
}

func TestUntrackedPathsReadsOnlyUntrackedEntriesAndUnquotes(t *testing.T) {
	porcelain := " M gateway/run.py\nA  cron/new.py\n?? scripts/whatsapp-bridge/.write_test\n?? \"plugins/oh no/adapter.py\"\n?? logs/\n"
	got := untrackedPaths(porcelain)
	want := []string{"scripts/whatsapp-bridge/.write_test", "plugins/oh no/adapter.py", "logs"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestRepairRootsReducesANodeModulesTreeToOneDirectory(t *testing.T) {
	offenders := []string{
		"/usr/local/lib/hermes-agent/scripts/whatsapp-bridge/node_modules/baileys/lib/index.js",
		"/usr/local/lib/hermes-agent/scripts/whatsapp-bridge/node_modules/.package-lock.json",
		"/usr/local/lib/hermes-agent/hermes_agent.egg-info/PKG-INFO",
		"",
	}
	got := repairRoots(offenders, maxRepairRoots)
	want := []string{
		"/usr/local/lib/hermes-agent/scripts/whatsapp-bridge/node_modules",
		"/usr/local/lib/hermes-agent/hermes_agent.egg-info/PKG-INFO",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %v, want %v", got, want)
	}
	if bounded := repairRoots([]string{"/a", "/b", "/c"}, 2); len(bounded) != 2 {
		t.Fatalf("a repair pass must stay bounded: %v", bounded)
	}
}

func TestQuarantineDirIsOnePerPassAndSortable(t *testing.T) {
	at := time.Date(2026, 9, 17, 18, 4, 5, 0, time.UTC)
	if got := quarantineDir("/var/lib/hermes-setup/quarantine", at); got != "/var/lib/hermes-setup/quarantine/20260917T180405Z" {
		t.Fatalf("quarantine dir = %q", got)
	}
}

func TestTightenSecretFileRepairsAModeNobodyMeantToChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("approvals:\n  mode: manual\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var logged []string
	if err := TightenSecretFile(path, fsx.Owner{UID: -1, GID: -1}, func(f string, a ...any) {
		logged = append(logged, fmt.Sprintf(f, a...))
	}); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %04o, want 0600", st.Mode().Perm())
	}
	if len(logged) != 1 || !strings.Contains(logged[0], "0644") {
		t.Fatalf("the repair must be said out loud: %v", logged)
	}
	// Replayed on an already tight file, it changes nothing and says nothing.
	logged = nil
	if err := TightenSecretFile(path, fsx.Owner{UID: -1, GID: -1}, func(f string, a ...any) {
		logged = append(logged, fmt.Sprintf(f, a...))
	}); err != nil || len(logged) != 0 {
		t.Fatalf("replay: err=%v logged=%v", err, logged)
	}
}

func TestTightenSecretFileAcceptsAMissingFileAndRefusesASymlink(t *testing.T) {
	dir := t.TempDir()
	if err := TightenSecretFile(filepath.Join(dir, "absent"), fsx.Owner{UID: -1, GID: -1}, nil); err != nil {
		t.Fatalf("a missing secret is not an error: %v", err)
	}
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(target, 0o644); err != nil { // not the umask's version of 0644
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := TightenSecretFile(link, fsx.Owner{UID: -1, GID: -1}, nil); err == nil {
		t.Fatal("a symlinked secret must still be refused")
	}
	if st, err := os.Stat(target); err != nil || st.Mode().Perm() != 0o644 {
		t.Fatalf("a refused symlink must leave its target alone: %v %v", st, err)
	}
}

func TestReconcileCheckoutIsANoOpWithoutAManagedCheckout(t *testing.T) {
	// layout.InstallDir does not exist on a workstation: the reconciliation
	// an upgrade runs on every host must stay silent there, never fail.
	fake := exectest.NewFake()
	if err := ReconcileCheckout(context.Background(), fake, nil); err != nil {
		t.Fatalf("no checkout, no error: %v", err)
	}
	if len(fake.Commands()) != 0 {
		t.Fatalf("no command expected, got %v", fake.Commands())
	}
}

func TestInstallNodeIsSkippedWhenThePinIsAlreadyInPlace(t *testing.T) {
	fake := exectest.NewFake().
		On("/usr/local/lib/hermes-node/bin/node --version", exec.Result{Stdout: pins.NodeVersion + "\n"}).
		OnPrefix("/bin/ln -sfn", exec.Result{})
	i := &Installer{Runner: fake, Arch: pins.Arches["amd64"], Log: func(string, ...any) {}}

	changed, err := i.installNode(context.Background())
	if err != nil || changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	for _, name := range nodeCommands {
		want := "/bin/ln -sfn /usr/local/lib/hermes-node/bin/" + name + " /usr/local/bin/" + name
		if !fake.Ran(want) {
			t.Fatalf("%s was not published on PATH: %v", name, fake.Commands())
		}
	}
	for _, cmd := range fake.Commands() {
		if strings.HasPrefix(cmd, "/usr/bin/tar") {
			t.Fatalf("an already pinned Node must not be unpacked again: %v", fake.Commands())
		}
	}
}

func TestNodeExtractArgsDropTheVersionDirectory(t *testing.T) {
	got := strings.Join(nodeExtractArgs("/var/tmp/node.tar.xz"), " ")
	want := "-xJf /var/tmp/node.tar.xz -C /usr/local/lib/hermes-node --strip-components=1"
	if got != want {
		t.Fatalf("tar args = %q, want %q", got, want)
	}
}
