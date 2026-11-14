package hardening

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// ufwRulesFile is /etc/ufw/user.rules around its RULES block, the lines UFW
// writes for a `deny out` rule and for the DNS exception of a resolver ahead of
// it (UFW 0.36).
func ufwRulesFile(rules string) string {
	return "*filter\n:ufw-user-output - [0:0]\n### RULES ###\n" + rules + "\n### END RULES ###\nCOMMIT\n"
}

const hardenedRules = "\n### tuple ### allow tcp 53 169.254.169.254 any 0.0.0.0/0 out comment=4865726d65732d6d616e61676564\n" +
	"-A ufw-user-output -p tcp -d 169.254.169.254 --dport 53 -j ACCEPT\n" +
	"\n### tuple ### allow udp 53 169.254.169.254 any 0.0.0.0/0 out comment=4865726d65732d6d616e61676564\n" +
	"-A ufw-user-output -p udp -d 169.254.169.254 --dport 53 -j ACCEPT\n" +
	"\n### tuple ### deny any any 169.254.0.0/16 any 0.0.0.0/0 out comment=4865726d65732d6d616e61676564\n" +
	"-A ufw-user-output -d 169.254.0.0/16 -j DROP\n"

// reloadProbe runs the fake and, when UFW is enabled again, records what
// /etc/ufw/user.rules held at that moment: the policy the firewall reloads.
type reloadProbe struct {
	*exectest.Fake
	userRules string
	reloaded  string
}

func (p *reloadProbe) Run(ctx context.Context, c exec.Cmd) (exec.Result, error) {
	if c.String() == "/usr/sbin/ufw --force enable" {
		data, err := os.ReadFile(p.userRules)
		if err != nil {
			return exec.Result{}, err
		}
		p.reloaded = string(data)
	}
	return p.Fake.Run(ctx, c)
}

// The rollback restores the four UFW files from the backups taken before the
// policy: the deny out rules and the DNS exception ahead of them live in those
// files, so both go, and UFW comes back (when it was active) with neither.
func TestRollbackRemovesTheDenyAndTheResolverExceptionWithTheUFWFiles(t *testing.T) {
	for _, wasActive := range []bool{true, false} {
		root := t.TempDir()
		// Rollback demands root-owned markers and backups: the test is its own root.
		prevRoot, prevFiles := fsx.Root, ufwFiles
		fsx.Root = fsx.Current()
		t.Cleanup(func() { fsx.Root, ufwFiles = prevRoot, prevFiles })
		etc := filepath.Join(root, "etc")
		if err := os.MkdirAll(etc, 0o755); err != nil {
			t.Fatal(err)
		}
		ufwFiles = []struct{ Path, Backup string }{
			{filepath.Join(etc, "ufw"), "ufw.default"}, {filepath.Join(etc, "ufw.conf"), "ufw.conf"},
			{filepath.Join(etc, "user.rules"), "ufw.user.rules"}, {filepath.Join(etc, "user6.rules"), "ufw.user6.rules"},
		}
		fake := exectest.NewFake()
		fake.Default = &exec.Result{}
		probe := &reloadProbe{Fake: fake, userRules: ufwFiles[2].Path}
		g := guard.New(filepath.Join(root, "state"), filepath.Join(root, "backup"), layout.HardeningRollbackUnit, fsx.Current(), probe)
		if err := g.EnsureDirs(); err != nil {
			t.Fatal(err)
		}
		pristine := ufwRulesFile("")
		for _, f := range ufwFiles {
			if err := os.WriteFile(f.Path, []byte(pristine), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := g.Backup(f.Path, f.Backup); err != nil {
				t.Fatal(err)
			}
		}
		// The policy is in place: the deny and the exception sit in user.rules.
		if err := os.WriteFile(ufwFiles[2].Path, []byte(ufwRulesFile(hardenedRules)), 0o640); err != nil {
			t.Fatal(err)
		}
		if wasActive {
			if err := g.Snapshot("ufw.was-active"); err != nil {
				t.Fatal(err)
			}
		}
		if err := fsx.WriteAtomic(g.Active(), []byte("version=2\nstate=armed\nenforced_at=1\nfeatures=firewall\n"), 0o600, fsx.Current()); err != nil {
			t.Fatal(err)
		}
		h := New(probe, nil)
		h.Guard = g
		if out, err := h.Rollback(context.Background()); err != nil || out != "rolled-back" {
			t.Fatalf("wasActive=%v: rollback = %q, %v", wasActive, out, err)
		}
		got, err := os.ReadFile(ufwFiles[2].Path)
		if err != nil || string(got) != pristine {
			t.Errorf("wasActive=%v: user.rules after the rollback = %q, %v; want the backup %q", wasActive, got, err, pristine)
		}
		if !fake.Ran("/usr/sbin/ufw --force disable") {
			t.Errorf("wasActive=%v: UFW was not disabled before the files came back", wasActive)
		}
		switch {
		case wasActive && probe.reloaded != pristine:
			t.Errorf("UFW was enabled again with %q, not the pristine rules", probe.reloaded)
		case !wasActive && fake.Ran("/usr/sbin/ufw --force enable"):
			t.Error("UFW was inactive before the policy and must stay so")
		}
		if strings.Contains(string(got), "169.254") {
			t.Errorf("wasActive=%v: a rule for the metadata range remains: %s", wasActive, got)
		}
	}
}
