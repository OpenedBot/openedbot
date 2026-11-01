package guard

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec/exectest"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

const unit = "hermes-hardening-rollback"

func timerWaiting(f *exectest.Fake, waiting bool) {
	active, sub, next := "active", "waiting", "123456789"
	if !waiting {
		active, sub, next = "inactive", "dead", "0"
	}
	f.On("/usr/bin/systemctl show "+unit+".timer --property=ActiveState --value", exec.Result{Stdout: active + "\n"})
	f.On("/usr/bin/systemctl show "+unit+".timer --property=SubState --value", exec.Result{Stdout: sub + "\n"})
	f.On("/usr/bin/systemctl show "+unit+".timer --property=NextElapseUSecMonotonic --value", exec.Result{Stdout: next + "\n"})
}

func newGuard(t *testing.T) (*Guard, *exectest.Fake) {
	t.Helper()
	f := exectest.NewFake()
	f.OnPrefix("/usr/bin/systemctl enable", exec.Result{})
	f.OnPrefix("/usr/bin/systemctl restart", exec.Result{})
	f.OnPrefix("/usr/bin/systemctl stop", exec.Result{})
	timerWaiting(f, true)
	root := t.TempDir()
	g := New(filepath.Join(root, "state"), filepath.Join(root, "backup"), unit, fsx.Current(), f)
	g.LockWait = time.Second
	if err := g.EnsureDirs(); err != nil {
		t.Fatal(err)
	}
	return g, f
}

var ctx = context.Background()

func TestArmWritesMarkerAndProvesTimer(t *testing.T) {
	g, f := newGuard(t)
	if err := g.Arm(ctx, ArmParams{AdminUser: "hermes-admin", AdminKeyFingerprint: "SHA256:x", EnforcedAt: time.Unix(1700000000, 0)}); err != nil {
		t.Fatal(err)
	}
	kv, err := g.ReadMarker(g.Active())
	if err != nil {
		t.Fatal(err)
	}
	if kv["state"] != "armed" || kv["admin"] != "hermes-admin" || kv["enforced_at"] != "1700000000" {
		t.Fatalf("marker %v", kv)
	}
	if !f.Ran("/usr/bin/systemctl enable "+unit+".timer") || !f.Ran("/usr/bin/systemctl restart "+unit+".timer") {
		t.Fatalf("timer was not enabled+restarted: %v", f.Commands())
	}
	if err := g.Arm(ctx, ArmParams{}); err == nil {
		t.Fatal("arming twice must be refused")
	}
}

func TestArmFailsClosedWhenTimerDoesNotWait(t *testing.T) {
	g, f := newGuard(t)
	timerWaiting(f, false)
	err := g.Arm(ctx, ArmParams{AdminUser: "a", AdminKeyFingerprint: "k", EnforcedAt: time.Now()})
	if err == nil {
		t.Fatal("arm must fail when the timer is not waiting")
	}
	if fsx.Exists(g.Active()) {
		t.Fatal("active marker must be removed after a failed arm")
	}
}

func TestExecRefusesWithoutLiveTransaction(t *testing.T) {
	g, f := newGuard(t)
	f.On("/usr/sbin/ufw --force enable", exec.Result{})
	if _, err := g.Exec(ctx, exec.Cmd{Path: "/usr/sbin/ufw", Args: []string{"--force", "enable"}}); !errors.Is(err, ErrNotArmed) {
		t.Fatalf("unarmed exec must be refused: %v", err)
	}
	if f.Ran("/usr/sbin/ufw --force enable") {
		t.Fatal("the mutation ran without a transaction")
	}
	if err := g.Arm(ctx, ArmParams{AdminUser: "a", AdminKeyFingerprint: "k", EnforcedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Exec(ctx, exec.Cmd{Path: "/usr/sbin/ufw", Args: []string{"--force", "enable"}}); err != nil {
		t.Fatal(err)
	}
	// Timer fired (rollback won): every further mutation is refused.
	timerWaiting(f, false)
	if _, err := g.Exec(ctx, exec.Cmd{Path: "/usr/sbin/ufw", Args: []string{"--force", "enable"}}); !errors.Is(err, ErrNotArmed) {
		t.Fatalf("exec after timer fired must be refused: %v", err)
	}
	// Active marker with the wrong mode is refused too.
	timerWaiting(f, true)
	_ = os.Chmod(g.Active(), 0o644)
	if _, err := g.Exec(ctx, exec.Cmd{Path: "/usr/sbin/ufw", Args: []string{"--force", "enable"}}); !errors.Is(err, ErrNotArmed) {
		t.Fatalf("world-readable active marker must be refused: %v", err)
	}
}

func TestCommitLifecycle(t *testing.T) {
	g, f := newGuard(t)
	if _, err := g.Commit(ctx, "a", "k"); err == nil {
		t.Fatal("commit without active must be refused")
	}
	if err := g.Arm(ctx, ArmParams{AdminUser: "a", AdminKeyFingerprint: "k", EnforcedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	res, err := g.Commit(ctx, "hermes-admin", "SHA256:k")
	if err != nil || res != Committed {
		t.Fatalf("commit: %v %v", res, err)
	}
	if fsx.Exists(g.Active()) || !fsx.Exists(g.Finalized()) {
		t.Fatal("markers after commit are wrong")
	}
	if !f.Ran("/usr/bin/systemctl stop " + unit + ".timer") {
		t.Fatal("timer must be stopped on commit")
	}
	kv, _ := g.ReadMarker(g.Finalized())
	if kv["admin"] != "hermes-admin" || kv["admin_key"] != "SHA256:k" {
		t.Fatalf("finalized marker %v", kv)
	}
	res, err = g.Commit(ctx, "a", "k")
	if err != nil || res != AlreadyFinalized {
		t.Fatalf("second commit: %v %v", res, err)
	}
	if _, err := g.Exec(ctx, exec.Cmd{Path: "/bin/true"}); !errors.Is(err, ErrNotArmed) {
		t.Fatal("exec after finalize must be refused")
	}
	if err := g.Arm(ctx, ArmParams{Features: []string{"firewall"}, EnforcedAt: time.Now()}); err != nil {
		t.Fatalf("a later independently selected policy must start a new guarded transaction: %v", err)
	}
	if !fsx.Exists(g.Active()) || fsx.Exists(g.Finalized()) {
		t.Fatal("the new active transaction must replace the previous finalized marker")
	}
}

func TestCommitRefusedAfterRollback(t *testing.T) {
	g, _ := newGuard(t)
	if err := g.Arm(ctx, ArmParams{AdminUser: "a", AdminKeyFingerprint: "k", EnforcedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if err := g.MarkRolledBack(); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Commit(ctx, "a", "k"); err == nil || !strings.Contains(err.Error(), "rollback already won") {
		t.Fatalf("commit after rollback must be refused: %v", err)
	}
}

func TestResetAfterRollback(t *testing.T) {
	g, _ := newGuard(t)
	if out, err := g.ResetAfterRollback(); err != nil || out != Clean {
		t.Fatalf("clean: %v %v", out, err)
	}
	// Leftover artifact without a rolled-back marker: refuse.
	if err := g.Snapshot("ufw.was-inactive"); err != nil {
		t.Fatal(err)
	}
	if _, err := g.ResetAfterRollback(); err == nil {
		t.Fatal("incomplete state without rollback must be refused")
	}
	// A reboot checkpoint with exactly the pre-arm snapshots resumes.
	_ = g.Snapshot("fail2ban.was-inactive")
	_ = g.Snapshot("ssh-dropin.was-absent")
	if err := g.WriteRebootCheckpoint("firewall", "fail2ban", "ssh"); err != nil {
		t.Fatal(err)
	}
	if out, err := g.ResetAfterRollback(); err != nil || out != ResumeAfterReboot {
		t.Fatalf("resume: %v %v", out, err)
	}
	// A later artifact at the checkpoint is refused.
	_ = g.Snapshot("admin.created-by-bootstrap")
	if _, err := g.ResetAfterRollback(); err == nil {
		t.Fatal("unexpected artifact at checkpoint must be refused")
	}
	_ = fsx.Remove(g.RebootCheckpoint())
	// After a rollback, artifacts are wiped.
	if err := g.MarkRolledBack(); err != nil {
		t.Fatal(err)
	}
	if out, err := g.ResetAfterRollback(); err != nil || out != Reset {
		t.Fatalf("reset: %v %v", out, err)
	}
	for _, a := range StateArtifacts {
		if g.HasSnapshot(a) {
			t.Fatalf("artifact %s survived reset", a)
		}
	}
	if fsx.Exists(g.RolledBack()) {
		t.Fatal("rolled-back marker must be consumed")
	}
}

// Artifacts names what ResetAfterRollback would refuse to start over from, and
// clearing those names is what lets a refused prepare leave the host clean.
func TestArtifactsNameWhatBlocksAFreshStartAndClearSnapshotsLiftsIt(t *testing.T) {
	g, _ := newGuard(t)
	if got := g.Artifacts(); len(got) != 0 {
		t.Fatalf("a clean host has no artifact, got %v", got)
	}
	src := filepath.Join(t.TempDir(), "sshd.conf")
	if err := os.WriteFile(src, []byte("x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"ufw.was-inactive", "fail2ban.was-inactive"} {
		if err := g.Snapshot(name); err != nil {
			t.Fatal(err)
		}
	}
	if err := g.Backup(src, "ssh-dropin.original"); err != nil {
		t.Fatal(err)
	}
	// Not an artifact: the active marker, and a file nobody lists.
	if err := os.WriteFile(filepath.Join(g.StateDir, "unrelated"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	got := g.Artifacts()
	if len(got) != 3 || !got["ufw.was-inactive"] || !got["fail2ban.was-inactive"] || !got["ssh-dropin.original"] {
		t.Fatalf("Artifacts = %v, want the two markers and the backup", got)
	}
	if _, err := g.ResetAfterRollback(); err == nil {
		t.Fatal("leftover artifacts must block a fresh start")
	}
	if err := g.ClearSnapshots("ufw.was-inactive", "fail2ban.was-inactive", "ssh-dropin.original"); err != nil {
		t.Fatal(err)
	}
	if got := g.Artifacts(); len(got) != 0 {
		t.Fatalf("artifacts survived the clearing: %v", got)
	}
	if out, err := g.ResetAfterRollback(); err != nil || out != Clean {
		t.Fatalf("after clearing: %v %v", out, err)
	}
}

func TestRebootCheckpointAcceptsOnlySelectedSnapshots(t *testing.T) {
	g, _ := newGuard(t)
	if err := g.Snapshot("ufw.was-active"); err != nil {
		t.Fatal(err)
	}
	if err := g.WriteRebootCheckpoint("firewall"); err != nil {
		t.Fatal(err)
	}
	if out, err := g.ResetAfterRollback(); err != nil || out != ResumeAfterReboot {
		t.Fatalf("firewall-only checkpoint: %v %v", out, err)
	}
}

// What Prepare leaves on a clean Debian 13 cloud image with the full profile
// when the security upgrade it just applied requires a reboot: the access
// snapshots, plus the unattended-upgrades ownership records written before
// the upgrade (Debian ships 20auto-upgrades, not 52-hermes-unattended).
// Resuming after the reboot used to be refused on those records.
func TestRebootResumeAcceptsTheUnattendedUpgradesRecords(t *testing.T) {
	g, _ := newGuard(t)
	for _, s := range []string{"ufw.was-inactive", "fail2ban.was-inactive", "ssh-dropin.was-absent", "unattended.created-by-bootstrap"} {
		if err := g.Snapshot(s); err != nil {
			t.Fatal(err)
		}
	}
	shipped := filepath.Join(t.TempDir(), "20auto-upgrades")
	_ = os.WriteFile(shipped, []byte("APT::Periodic::Update-Package-Lists \"1\";\n"), 0o644)
	if err := g.Backup(shipped, "auto-upgrades.original"); err != nil {
		t.Fatal(err)
	}
	if err := g.WriteRebootCheckpoint("firewall", "fail2ban", "ssh", "quarantine"); err != nil {
		t.Fatal(err)
	}
	// The reboot, then the same `up`: twice, as an interrupted resume would.
	for range 2 {
		if out, err := g.ResetAfterRollback(); err != nil || out != ResumeAfterReboot {
			t.Fatalf("resume after reboot: %v %v", out, err)
		}
	}
	if !fsx.Exists(g.BackupPath("auto-upgrades.original")) || !g.HasSnapshot("unattended.created-by-bootstrap") {
		t.Fatal("the resume must keep the records reset relies on")
	}
}

func TestRebootResumeAcceptsACreatedAutoUpgrades(t *testing.T) {
	g, _ := newGuard(t)
	for _, s := range []string{"ufw.was-active", "auto-upgrades.created-by-bootstrap", "unattended.created-by-bootstrap"} {
		if err := g.Snapshot(s); err != nil {
			t.Fatal(err)
		}
	}
	if err := g.WriteRebootCheckpoint("firewall"); err != nil {
		t.Fatal(err)
	}
	if out, err := g.ResetAfterRollback(); err != nil || out != ResumeAfterReboot {
		t.Fatalf("resume after reboot: %v %v", out, err)
	}
}

func TestRebootResumeRefusesContradictoryAutoUpgradesRecords(t *testing.T) {
	g, _ := newGuard(t)
	_ = g.Snapshot("ufw.was-active")
	_ = g.Snapshot("auto-upgrades.created-by-bootstrap")
	src := filepath.Join(t.TempDir(), "20auto-upgrades")
	_ = os.WriteFile(src, []byte("x"), 0o644)
	if err := g.Backup(src, "auto-upgrades.original"); err != nil {
		t.Fatal(err)
	}
	if err := g.WriteRebootCheckpoint("firewall"); err != nil {
		t.Fatal(err)
	}
	if _, err := g.ResetAfterRollback(); err == nil || !strings.Contains(err.Error(), "both created and pre-existing") {
		t.Fatalf("contradictory records must be refused: %v", err)
	}
}

func TestBackupKeepsFirstSnapshot(t *testing.T) {
	g, _ := newGuard(t)
	src := filepath.Join(t.TempDir(), "user.rules")
	_ = os.WriteFile(src, []byte("v1"), 0o640)
	if err := g.Backup(src, "ufw.user.rules"); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(src, []byte("v2"), 0o640)
	if err := g.Backup(src, "ufw.user.rules"); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(g.BackupPath("ufw.user.rules"))
	if string(got) != "v1" {
		t.Fatalf("the first backup must be kept, got %q", got)
	}
}
