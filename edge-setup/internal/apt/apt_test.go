package apt

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

const policySample = `docker-ce:
  Installed: (none)
  Candidate: 5:29.7.2-1~debian.13~trixie
  Version table:
     5:29.7.2-1~debian.13~trixie 500
        500 https://download.docker.com/linux/debian trixie/stable amd64 Packages
     5:29.7.1-1~debian.13~trixie 500
`

func TestPolicyLists(t *testing.T) {
	if !PolicyLists(policySample, "5:29.7.2-1~debian.13~trixie") {
		t.Fatal("pinned version should be listed")
	}
	if PolicyLists(policySample, "5:29.7.3-1~debian.13~trixie") {
		t.Fatal("missing version must not be listed")
	}
}

func TestInstallUsesPolicyRcDAndRemovesIt(t *testing.T) {
	f := exectest.NewFake()
	p := filepath.Join(t.TempDir(), "policy-rc.d")
	c := Client{Runner: f, PolicyRcD: p}
	f.OnPrefix("/usr/bin/apt-get install", exec.Result{})
	seen := false
	f.Default = nil
	// Observe the policy file while apt "runs".
	fWrapped := &observer{Fake: f, path: p, seen: &seen}
	c.Runner = fWrapped
	if err := c.Install(context.Background(), "ufw", "fail2ban"); err != nil {
		t.Fatal(err)
	}
	if !seen {
		t.Fatal("policy-rc.d was not present during apt-get install")
	}
	if fsx.Exists(p) {
		t.Fatal("policy-rc.d was not removed after install")
	}
	if !f.Ran("/usr/bin/apt-get install -y --no-install-recommends ufw fail2ban") {
		t.Fatalf("commands: %v", f.Commands())
	}
}

type observer struct {
	*exectest.Fake
	path string
	seen *bool
}

func (o *observer) Run(ctx context.Context, c exec.Cmd) (exec.Result, error) {
	if data, err := os.ReadFile(o.path); err == nil && string(data) != "" {
		*o.seen = true
	}
	return o.Fake.Run(ctx, c)
}

func TestInstallHeldHoldsThePinnedPackages(t *testing.T) {
	f := exectest.NewFake()
	f.OnPrefix("/usr/bin/apt-get install", exec.Result{})
	f.OnPrefix("/usr/bin/apt-mark hold", exec.Result{Stdout: "docker-ce set on hold.\n"})
	c := Client{Runner: f, PolicyRcD: filepath.Join(t.TempDir(), "policy-rc.d")}
	for range 2 {
		if err := c.InstallHeld(context.Background(), "docker-ce=5:29.7.2-1~debian.13~trixie", "containerd.io=2.3.4-1~debian.13~trixie"); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{
		"/usr/bin/apt-get install -y --no-install-recommends --allow-change-held-packages docker-ce=5:29.7.2-1~debian.13~trixie containerd.io=2.3.4-1~debian.13~trixie",
		"/usr/bin/apt-mark hold docker-ce containerd.io",
	}
	got := f.Commands()
	if len(got) != 4 || got[0] != want[0] || got[1] != want[1] || got[2] != want[0] || got[3] != want[1] {
		t.Fatalf("commands: %v", got)
	}
}

func TestInstallHeldDoesNotHoldAFailedInstall(t *testing.T) {
	f := exectest.NewFake()
	f.OnPrefix("/usr/bin/apt-get install", exec.Result{ExitCode: 100, Stderr: "E: Unable to locate package"})
	c := Client{Runner: f, PolicyRcD: filepath.Join(t.TempDir(), "policy-rc.d")}
	if err := c.InstallHeld(context.Background(), "docker-ce=1"); err == nil {
		t.Fatal("a failed install must fail")
	}
	for _, cmd := range f.Commands() {
		if strings.HasPrefix(cmd, "/usr/bin/apt-mark") {
			t.Fatalf("nothing to hold after a failed install: %v", f.Commands())
		}
	}
}

// The field defect: P7's `apt-get upgrade` moved Docker past its pin, and
// the next `up` failed on the downgrade back to it.
func TestUpgradeSafeHoldsInstalledPinsBeforeUpgrading(t *testing.T) {
	f := exectest.NewFake()
	f.On("/usr/bin/apt-get update", exec.Result{})
	f.On("/usr/bin/dpkg-query -W -f=${Status}\t${Version}\n docker-ce", exec.Result{Stdout: "install ok installed\t5:29.7.2-1~debian.13~trixie\n"})
	f.On("/usr/bin/dpkg-query -W -f=${Status}\t${Version}\n containerd.io", exec.Result{Stdout: "install ok installed\t2.3.4-1~debian.13~trixie\n"})
	f.On("/usr/bin/dpkg-query -W -f=${Status}\t${Version}\n docker-ce-cli", exec.Result{ExitCode: 1, Stderr: "dpkg-query: no packages found matching docker-ce-cli"})
	f.On("/usr/bin/apt-mark hold docker-ce containerd.io", exec.Result{})
	f.On("/usr/bin/apt-get upgrade -y --no-install-recommends", exec.Result{})
	c := New(f)
	if err := c.UpgradeSafe(context.Background(), "docker-ce", "docker-ce-cli", "containerd.io"); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(f.Commands(), "\n")
	hold := strings.Index(got, "/usr/bin/apt-mark hold docker-ce containerd.io")
	upgrade := strings.Index(got, "/usr/bin/apt-get upgrade")
	if hold < 0 || upgrade < 0 || hold > upgrade {
		t.Fatalf("installed pins must be held before the upgrade:\n%s", got)
	}
}

func TestUpgradeSafeWithoutInstalledPinsHoldsNothing(t *testing.T) {
	f := exectest.NewFake()
	f.On("/usr/bin/apt-get update", exec.Result{})
	f.OnPrefix("/usr/bin/dpkg-query", exec.Result{ExitCode: 1})
	f.On("/usr/bin/apt-get upgrade -y --no-install-recommends", exec.Result{})
	if err := New(f).UpgradeSafe(context.Background(), "docker-ce"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(f.Commands(), "\n"), "apt-mark") {
		t.Fatalf("a host without the sandbox holds nothing: %v", f.Commands())
	}
}

func TestRequireRefusesMissingPin(t *testing.T) {
	f := exectest.NewFake()
	f.On("/usr/bin/apt-cache policy docker-ce", exec.Result{Stdout: policySample})
	c := New(f)
	if err := c.Require(context.Background(), "docker-ce=5:29.7.2-1~debian.13~trixie"); err != nil {
		t.Fatal(err)
	}
	if err := c.Require(context.Background(), "docker-ce=9.9.9"); err == nil {
		t.Fatal("missing pin must be refused")
	}
}

func TestParsers(t *testing.T) {
	if got := ConffileMD5From(" /etc/default/ufw 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d\n /etc/ufw/ufw.conf ffffffffffffffffffffffffffffffff\n", "/etc/default/ufw"); got != "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d" {
		t.Fatalf("md5 %q", got)
	}
	fps := FingerprintsFrom("pub:-:4096:1:8D81803C0EBFCD88:1487788586:::-:::scESC::::::23::0:\nfpr:::::::::9DC858229FC7DD38854AE2D88D81803C0EBFCD88:\n")
	if len(fps) != 1 || fps[0] != "9DC858229FC7DD38854AE2D88D81803C0EBFCD88" {
		t.Fatalf("fingerprints %v", fps)
	}
}
