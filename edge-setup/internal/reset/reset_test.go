package reset

import (
	"context"
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hardening"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

const visudoCheck = "/usr/sbin/visudo -cf /etc/sudoers"

// removals replaces removeFile for one test and records, for every path,
// how many runner commands had already run (to assert ordering).
type removals struct {
	fake  *exectest.Fake
	paths []string
	at    map[string]int
}

func hookRemovals(t *testing.T, f *exectest.Fake) *removals {
	t.Helper()
	rec := &removals{fake: f, at: map[string]int{}}
	prev := removeFile
	removeFile = func(p string) error {
		rec.paths = append(rec.paths, p)
		rec.at[p] = len(f.Calls)
		return nil
	}
	t.Cleanup(func() { removeFile = prev })
	return rec
}

func (r *removals) removed(p string) bool {
	for _, q := range r.paths {
		if q == p {
			return true
		}
	}
	return false
}

// newTestResetter wires a resetter over a fake runner, temp guard dirs and
// an account lookup that knows hermes-admin only when adminExists.
func newTestResetter(t *testing.T, adminExists bool, sudoUser string) (*Resetter, *exectest.Fake) {
	t.Helper()
	f := exectest.NewFake()
	f.Default = &exec.Result{}
	f.On("/usr/bin/getent passwd "+layout.AdminUser, exec.Result{Stdout: layout.AdminUser + ":x:1000:1000::/home/" + layout.AdminUser + ":/bin/bash\n"})
	lookup := func(name string) (*user.User, error) {
		if adminExists && name == layout.AdminUser {
			return &user.User{Uid: "1000", Gid: "1000", Username: name, HomeDir: "/home/" + name}, nil
		}
		return nil, user.UnknownUserError(name)
	}
	r := &Resetter{
		Runner:   f,
		Systemd:  systemd.Client{Runner: f},
		Accounts: account.Client{Runner: f, Lookup: lookup},
		Guard:    guard.New(t.TempDir(), t.TempDir(), layout.HardeningRollbackUnit, fsx.Current(), f),
		Out:      func(string, ...any) {},
		SudoUser: sudoUser,
	}
	return r, f
}

func visudoAfter(f *exectest.Fake, index int) bool {
	for i, c := range f.Commands() {
		if i >= index && c == visudoCheck {
			return true
		}
	}
	return false
}

// A plain reset restores access, it never closes it: hermes-admin keeps
// its sudoers file. Regression: the file was removed unconditionally and
// the admin session lost sudo right after the reset.
func TestRestoreAccessKeepsAdminSudoersWhileAccountExists(t *testing.T) {
	r, f := newTestResetter(t, true, "root")
	if err := r.Guard.EnsureDirs(); err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{
		"resolved-dropin.created-by-bootstrap", "pwquality-dropin.created-by-bootstrap",
		"81-hermes-logging.created-by-bootstrap", "sudo-logrotate.created-by-bootstrap",
		hardening.SnapUnattendedCreated,
	} {
		if err := r.Guard.Snapshot(marker); err != nil {
			t.Fatal(err)
		}
	}
	rec := hookRemovals(t, f)
	if err := r.restoreAccess(context.Background(), hardening.New(f, nil), Options{}); err != nil {
		t.Fatal(err)
	}
	if rec.removed(layout.SudoersAdmin) {
		t.Fatalf("%s removed while %s exists and --remove-admin is not set; removed: %v", layout.SudoersAdmin, layout.AdminUser, rec.paths)
	}
	for _, p := range []string{layout.SudoersLogging, layout.SudoLogrotate, layout.ResolvedDropin, layout.PwqualityDropin, layout.AptUnattended} {
		if !rec.removed(p) {
			t.Errorf("%s not removed", p)
		}
	}
	if !f.Ran(visudoCheck) {
		t.Error("visudo -cf not run")
	}
	if f.Ran("/usr/sbin/userdel --force --remove " + layout.AdminUser) {
		t.Error("account removed without --remove-admin")
	}
}

func TestRestoreAccessRemoveAdminDropsAccountThenSudoersThenVisudo(t *testing.T) {
	r, f := newTestResetter(t, true, "root")
	rec := hookRemovals(t, f)
	if err := r.restoreAccess(context.Background(), hardening.New(f, nil), Options{RemoveAdmin: true}); err != nil {
		t.Fatal(err)
	}
	if !rec.removed(layout.SudoersAdmin) {
		t.Fatalf("%s kept despite --remove-admin; removed: %v", layout.SudoersAdmin, rec.paths)
	}
	userdel := -1
	for i, c := range f.Commands() {
		if c == "/usr/sbin/userdel --force --remove "+layout.AdminUser {
			userdel = i
		}
	}
	if userdel < 0 {
		t.Fatalf("account not removed; commands: %v", f.Commands())
	}
	if at := rec.at[layout.SudoersAdmin]; at <= userdel {
		t.Errorf("sudoers file removed (after %d commands) before userdel (command %d)", at, userdel)
	}
	if !visudoAfter(f, rec.at[layout.SudoersAdmin]) {
		t.Errorf("visudo -cf did not follow the sudoers removal; commands: %v", f.Commands())
	}
}

func TestRestoreAccessRemovesOrphanAdminSudoers(t *testing.T) {
	r, f := newTestResetter(t, false, "root")
	if err := r.Guard.EnsureDirs(); err != nil {
		t.Fatal(err)
	}
	if err := r.Guard.Snapshot("admin.created-by-bootstrap"); err != nil {
		t.Fatal(err)
	}
	rec := hookRemovals(t, f)
	if err := r.restoreAccess(context.Background(), hardening.New(f, nil), Options{}); err != nil {
		t.Fatal(err)
	}
	if !rec.removed(layout.SudoersAdmin) {
		t.Fatalf("orphan %s kept although %s does not exist", layout.SudoersAdmin, layout.AdminUser)
	}
	if !visudoAfter(f, rec.at[layout.SudoersAdmin]) {
		t.Error("visudo -cf did not follow the sudoers removal")
	}
}

func TestRestoreAccessKeepsForeignOrphanAdminSudoers(t *testing.T) {
	r, f := newTestResetter(t, false, "root")
	rec := hookRemovals(t, f)
	if err := r.restoreAccess(context.Background(), hardening.New(f, nil), Options{}); err != nil {
		t.Fatal(err)
	}
	if rec.removed(layout.SudoersAdmin) {
		t.Fatal("an unmarked foreign sudoers file must remain untouched")
	}
}

// --remove-admin from the admin session is refused before anything moves.
func TestRunRefusesRemoveAdminFromOwnSessionBeforeAnyChange(t *testing.T) {
	r, f := newTestResetter(t, true, layout.AdminUser)
	rec := hookRemovals(t, f)
	err := r.Run(context.Background(), Options{RemoveAdmin: true})
	if err == nil || !strings.Contains(err.Error(), "own session") {
		t.Fatalf("err = %v", err)
	}
	if len(f.Calls) != 0 || len(rec.paths) != 0 {
		t.Fatalf("changes before the refusal: commands %v, removed %v", f.Commands(), rec.paths)
	}
	if errors.Is(err, context.Canceled) {
		t.Fatal("unexpected cancellation")
	}
}

func TestPlanStatesAdminSudoersFate(t *testing.T) {
	r := &Resetter{Out: func(string, ...any) {}}
	keep := strings.Join(r.Plan(Options{}), "\n")
	if !strings.Contains(keep, "keep the "+layout.AdminUser+" account and its sudoers file "+layout.SudoersAdmin) {
		t.Errorf("default plan does not say the admin sudoers file is kept:\n%s", keep)
	}
	drop := strings.Join(r.Plan(Options{RemoveAdmin: true}), "\n")
	if !strings.Contains(drop, "remove the "+layout.AdminUser+" account and its sudoers file "+layout.SudoersAdmin+", then visudo -cf") {
		t.Errorf("--remove-admin plan does not say the sudoers file goes with the account:\n%s", drop)
	}
	if strings.Contains(drop, "keep the "+layout.AdminUser) {
		t.Error("--remove-admin plan still says the account is kept")
	}
}

func TestPlanCoversEveryNamespace(t *testing.T) {
	r := &Resetter{Out: func(string, ...any) {}}
	plan := strings.Join(r.Plan(Options{PurgeData: true, PurgePackages: true, Legacy: true, RemoveAdmin: true}), "\n")
	for _, want := range []string{
		"hermes-gateway.service", "hermes-connector.service", "hermes-hardening-rollback.timer", "hermes-proxy-rollback.timer",
		"/var/lib/hermes-host-hardening", "/var/backups/hermes-access", "/etc/hermes", "/usr/local/lib/hermes-agent",
		"/srv/hermes/data", "docker-ce", "caddy", "openhermesbot-hardening-rollback.timer", "/var/lib/openhermesbot", "tailscale",
		"/usr/local/lib/hermes-setup/edge-setup", "hermes-admin", "/usr/local/bin/edge-setup", "/usr/local/bin/hermes-setup",
	} {
		if !strings.Contains(plan, want) {
			t.Errorf("plan does not mention %q", want)
		}
	}
	short := strings.Join(r.Plan(Options{}), "\n")
	if strings.Contains(short, "PURGE DATA") || strings.Contains(short, "legacy") {
		t.Error("a default reset must not purge data or the legacy namespace")
	}
}

func TestManagedRuleNumbers(t *testing.T) {
	out := "     To                         Action      From\n[ 1] 22/tcp                     ALLOW IN    Anywhere                   # Hermes-managed\n[ 2] 8080/tcp                   ALLOW IN    Anywhere\n[ 3] 443/tcp                    ALLOW IN    Anywhere                   # Hermes-managed\n"
	got := managedRuleNumbers(out)
	if strings.Join(got, ",") != "3,1" {
		t.Fatalf("%v", got)
	}
}

// With a resolver inside a denied range the firewall also carries the DNS
// exception ahead of the deny out rule (internal/hardening). Both are tagged,
// so the tag-based cleanup removes them together, highest number first, and
// leaves the operator's own rules.
func TestManagedRuleNumbersCoversTheResolverException(t *testing.T) {
	out := "Status: active\n\n     To                         Action      From\n     --                         ------      ----\n" +
		"[ 1] 169.254.169.254 53/tcp     ALLOW OUT   Anywhere                   (out) # Hermes-managed\n" +
		"[ 2] 169.254.169.254 53/udp     ALLOW OUT   Anywhere                   (out) # Hermes-managed\n" +
		"[ 3] 169.254.0.0/16             DENY OUT    Anywhere                   (out) # Hermes-managed\n" +
		"[ 4] 10.0.0.0/8                 DENY OUT    Anywhere                   (out)\n" +
		"[ 5] 22/tcp                     ALLOW IN    Anywhere                   # Hermes-managed\n" +
		"[ 6] fd00:ec2::253 53/udp       ALLOW OUT   Anywhere (v6)              (out) # Hermes-managed\n" +
		"[ 7] fd00:ec2::/64              DENY OUT    Anywhere (v6)              (out) # Hermes-managed\n"
	if got := strings.Join(managedRuleNumbers(out), ","); got != "7,6,5,3,2,1" {
		t.Fatalf("managedRuleNumbers = %s, want 7,6,5,3,2,1 (rule 4 is the operator's)", got)
	}
}

// ufwLikeUFW answers `ufw status numbered` as ufw does: the rules while the
// firewall is active, "Status: inactive" and nothing else once it is disabled.
type ufwLikeUFW struct {
	*exectest.Fake
	active   string
	disabled bool
}

func (u *ufwLikeUFW) Run(ctx context.Context, c exec.Cmd) (exec.Result, error) {
	switch c.String() {
	case "/usr/sbin/ufw --force disable":
		u.disabled = true
	case "/usr/sbin/ufw --force enable":
		u.disabled = false
	case "/usr/sbin/ufw status numbered":
		answer := u.active
		if u.disabled {
			answer = "Status: inactive\n"
		}
		u.Fake.On(c.String(), exec.Result{Stdout: answer})
	}
	return u.Fake.Run(ctx, c)
}

// Without a backup of the UFW files, reset gives back only the rules it
// tagged, the deny out of the metadata ranges and the DNS exception ahead of it
// included. It must list and delete them while UFW is active: once disabled,
// UFW lists no rule and nothing is found.
func TestRestoreAccessWithoutBackupsDeletesTheTaggedRulesBeforeDisablingUFW(t *testing.T) {
	const numbered = "Status: active\n\n     To                         Action      From\n     --                         ------      ----\n" +
		"[ 1] 169.254.169.254 53/tcp     ALLOW OUT   Anywhere                   (out) # Hermes-managed\n" +
		"[ 2] 169.254.169.254 53/udp     ALLOW OUT   Anywhere                   (out) # Hermes-managed\n" +
		"[ 3] 169.254.0.0/16             DENY OUT    Anywhere                   (out) # Hermes-managed\n" +
		"[ 4] 10.0.0.0/8                 DENY OUT    Anywhere                   (out)\n" +
		"[ 5] 22/tcp                     ALLOW IN    Anywhere                   # Hermes-managed\n"
	for _, wasActive := range []bool{false, true} {
		prev := ufwInstalled
		ufwInstalled = func() bool { return true }
		t.Cleanup(func() { ufwInstalled = prev })
		r, f := newTestResetter(t, false, "")
		if err := r.Guard.EnsureDirs(); err != nil {
			t.Fatal(err)
		}
		marker := "ufw.was-inactive"
		if wasActive {
			marker = "ufw.was-active"
		}
		if err := r.Guard.Snapshot(marker); err != nil {
			t.Fatal(err)
		}
		hookRemovals(t, f)
		u := &ufwLikeUFW{Fake: f, active: numbered}
		r.Runner = u
		if err := r.restoreAccess(context.Background(), hardening.New(u, nil), Options{}); err != nil {
			t.Fatal(err)
		}
		var ufwCommands []string
		for _, c := range f.Commands() {
			if strings.HasPrefix(c, "/usr/sbin/ufw") {
				ufwCommands = append(ufwCommands, strings.TrimPrefix(c, "/usr/sbin/ufw "))
			}
		}
		want := "status numbered|--force delete 5|--force delete 3|--force delete 2|--force delete 1|--force disable"
		if wasActive {
			want += "|--force enable"
		}
		if got := strings.Join(ufwCommands, "|"); got != want {
			t.Errorf("wasActive=%v: ufw commands %q, want %q (rule 4 is the operator's)", wasActive, got, want)
		}
	}
}

// Debian ships 20auto-upgrades with unattended-upgrades. reset removes it
// only when the hardening phase created it: deleting the distribution's own
// file would silently stop security updates on a host we are leaving.
func TestAutoUpgradesIsNotRemovedUnlessWeCreatedIt(t *testing.T) {
	root := t.TempDir()
	g := guard.New(filepath.Join(root, "state"), filepath.Join(root, "backup"), "rollback", fsx.Current(), exectest.NewFake())
	for _, p := range accessFilesToRemove(g, Options{}, true) {
		if p == layout.AptAutoUpgrades {
			t.Fatal("20auto-upgrades is removed unconditionally")
		}
	}
}

// --legacy purges the previous tool's namespace, but tailscale is often the
// operator's own way into a homelab: it needs its own opt-in.
func TestLegacyKeepsTailscaleWithoutItsOwnFlag(t *testing.T) {
	r := New(exectest.NewFake(), func(string, ...any) {})
	joined := strings.Join(r.Plan(Options{Legacy: true}), "\n")
	if !strings.Contains(joined, "tailscale is kept") {
		t.Fatalf("plan does not say tailscale is kept:\n%s", joined)
	}
	if strings.Contains(joined, "package tailscale") {
		t.Fatalf("plan purges tailscale without --purge-tailscale:\n%s", joined)
	}
	joined = strings.Join(r.Plan(Options{Legacy: true, PurgeTailscale: true}), "\n")
	if !strings.Contains(joined, "package tailscale") {
		t.Fatalf("--purge-tailscale does not purge it:\n%s", joined)
	}
	if !isTailscaleUnit("tailscaled.service") || isTailscaleUnit("openhermesbot-gateway.service") {
		t.Fatal("isTailscaleUnit misclassifies a unit")
	}
}

func TestRemoveToolPathEntriesKeepsPackageFiles(t *testing.T) {
	dir := t.TempDir()
	link, copied, owned, other := filepath.Join(dir, "edge-setup"), filepath.Join(dir, "hermes-setup"), filepath.Join(dir, "sbin-edge-setup"), filepath.Join(dir, "absent")
	if err := os.Symlink("/usr/local/lib/hermes-setup/edge-setup", link); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{copied, owned} {
		if err := os.WriteFile(p, []byte("bin"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	list := filepath.Join(dir, "edge-setup.list")
	if err := os.WriteFile(list, []byte("/.\n"+owned+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	kept := RemoveToolPathEntries([]string{link, copied, owned, other}, list)
	if len(kept) != 1 || kept[0] != owned {
		t.Fatalf("kept = %v, want only the package file %s", kept, owned)
	}
	for _, p := range []string{link, copied} {
		if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s still present: %v", p, err)
		}
	}
	if _, err := os.Lstat(owned); err != nil {
		t.Errorf("package file removed: %v", err)
	}
}

func TestUnitsAndPlanCoverLoopbackGuard(t *testing.T) {
	unit := layout.LoopbackGuardUnit + ".service"
	found := false
	for _, u := range Units {
		found = found || u == unit
	}
	if !found {
		t.Errorf("Units does not remove %s", unit)
	}
	r := &Resetter{Out: func(string, ...any) {}}
	plan := strings.Join(r.Plan(Options{}), "\n")
	if !strings.Contains(plan, unit) || !strings.Contains(plan, "iptables OUTPUT rules") {
		t.Errorf("plan does not mention the guard unit and its iptables rules:\n%s", plan)
	}
}

// hermes-operator.service keeps its RuntimeDirectory across restarts
// (RuntimeDirectoryPreserve=yes), so stopping the unit no longer empties
// /run/hermes-operator. Its socket and the gateway « restart pending » marker
// would outlive a reset or an uninstall until the next boot, and a later
// install could inherit a marker it never wrote: reset removes the directory.
func TestRuntimePathsAndPlanCoverOperatorRunDir(t *testing.T) {
	removed := func(p string) bool {
		for _, root := range RuntimePaths {
			if p == root || strings.HasPrefix(p, root+"/") {
				return true
			}
		}
		return false
	}
	for _, p := range []string{layout.OperatorRunDir, layout.OperatorSocket, layout.GatewayRestartMarker} {
		if !removed(p) {
			t.Errorf("%s survives a reset: no RuntimePaths entry removes it", p)
		}
	}
	r := &Resetter{Out: func(string, ...any) {}}
	if plan := strings.Join(r.Plan(Options{}), "\n"); !strings.Contains(plan, layout.OperatorRunDir) {
		t.Errorf("plan does not mention %s:\n%s", layout.OperatorRunDir, plan)
	}
}

func TestRemoveLoopbackGuardRulesDeletesEachRule(t *testing.T) {
	r, f := newTestResetter(t, false, "")
	f.On("/usr/bin/getent passwd "+layout.ServiceUser, exec.Result{Stdout: layout.ServiceUser + ":x:999:999::/home/" + layout.ServiceUser + ":/bin/bash\n"})
	r.Accounts = account.Client{Runner: f, Lookup: func(name string) (*user.User, error) {
		if name == layout.ServiceUser {
			return &user.User{Uid: "999", Gid: "999", Username: name}, nil
		}
		return nil, user.UnknownUserError(name)
	}}
	r.removeLoopbackGuardRules(context.Background())
	got := strings.Join(f.Commands(), "\n")
	for _, want := range []string{
		"/usr/sbin/iptables -w -D OUTPUT -o lo -p tcp -m tcp --dport 8642 -j REJECT --reject-with icmp-port-unreachable",
		"/usr/sbin/iptables -w -D OUTPUT -o lo -p tcp -m tcp --dport 9119 -m owner --uid-owner 999 -j ACCEPT",
		"/usr/sbin/iptables -w -D OUTPUT -o lo -p tcp -m tcp --dport 8642 -m owner --uid-owner 0 -j ACCEPT",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing deletion %q in:\n%s", want, got)
		}
	}
}

func TestRemoveLoopbackGuardRulesSurvivesFailure(t *testing.T) {
	r, f := newTestResetter(t, false, "")
	f.Default = &exec.Result{ExitCode: 1}
	r.removeLoopbackGuardRules(context.Background())
	if n := len(f.Commands()); n < 4 {
		t.Errorf("a failing deletion stopped the loop after %d commands", n)
	}
}
