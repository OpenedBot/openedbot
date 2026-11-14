package hermes

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/apt"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hostfacts"
)

func TestChromiumDependenciesMatchSupportedDistros(t *testing.T) {
	for _, facts := range []hostfacts.Facts{{OSID: "debian", OSVersionID: 12, OSCodename: "bookworm", Arch: "amd64"}, {OSID: "debian", OSVersionID: 13, OSCodename: "trixie", Arch: "arm64"}, {OSID: "ubuntu", OSVersionID: 24, OSCodename: "noble", Arch: "amd64"}} {
		packages, err := chromiumDependencyPackages(facts)
		if err != nil {
			t.Fatal(err)
		}
		suffix := "t64"
		if facts.OSVersionID == 12 {
			suffix = ""
		}
		for _, name := range []string{"libasound2", "libatk-bridge2.0-0", "libatk1.0-0", "libatspi2.0-0", "libcups2", "libglib2.0-0"} {
			if !slices.Contains(packages, name+suffix) {
				t.Fatalf("missing %s for %#v", name+suffix, facts)
			}
		}
		for _, name := range []string{"libnspr4", "libnss3", "libxcb1", "libx11-6", "libxkbcommon0", "libcairo2", "libpango-1.0-0", "libgbm1", "fonts-liberation"} {
			if !slices.Contains(packages, name) {
				t.Fatalf("missing fixed library %s", name)
			}
		}
	}
}
func TestChromiumDependenciesUnsupportedFailsBeforeAPT(t *testing.T) {
	for _, facts := range []hostfacts.Facts{{OSID: "alpine", OSVersionID: 3, Arch: "amd64"}, {OSID: "ubuntu", OSVersionID: 24, OSCodename: "oracular", Arch: "amd64"}, {OSID: "ubuntu", OSVersionID: 26, OSCodename: "resolute", Arch: "amd64"}, {OSID: "debian", OSVersionID: 14, OSCodename: "forky", Arch: "amd64"}, {OSID: "debian", OSVersionID: 13, OSCodename: "trixie", Arch: "386"}} {
		fake := exectest.NewFake()
		client := apt.Client{Runner: fake, PolicyRcD: filepath.Join(t.TempDir(), "policy")}
		if err := ensureChromiumDependencies(context.Background(), client, facts); err == nil {
			t.Fatalf("unsupported distro accepted: %#v", facts)
		}
		if len(fake.Commands()) != 0 {
			t.Fatal("unsupported distro reached APT")
		}
	}
}
func TestChromiumDependenciesInstalledDoesNotMutateHost(t *testing.T) {
	fake := exectest.NewFake()
	fake.OnPrefix("/usr/bin/dpkg-query", exec.Result{Stdout: "install ok installed\n"})
	if err := ensureChromiumDependencies(context.Background(), apt.Client{Runner: fake, PolicyRcD: filepath.Join(t.TempDir(), "policy")}, hostfacts.Facts{OSID: "debian", OSVersionID: 13, OSCodename: "trixie", Arch: "amd64"}); err != nil {
		t.Fatal(err)
	}
	for _, command := range fake.Commands() {
		if !strings.HasPrefix(command, "/usr/bin/dpkg-query ") {
			t.Fatalf("unexpected mutation: %s", command)
		}
	}
}
