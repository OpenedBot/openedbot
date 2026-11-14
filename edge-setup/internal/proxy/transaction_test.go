package proxy

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
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// newTestTransaction wires a transaction over a temporary state directory
// and a fake runner, so the arming and rollback logic is exercised without
// touching the host.
func newTestTransaction(t *testing.T) (*Transaction, *exectest.Fake, string) {
	t.Helper()
	dir := t.TempDir()
	f := exectest.NewFake()
	// systemd and ufw answer as on a host whose rollback timer is armed.
	const timer = "hermes-proxy-rollback.timer"
	f.On("/usr/bin/systemctl show "+timer+" --property=ActiveState --value", exec.Result{Stdout: "active\n"})
	f.On("/usr/bin/systemctl show "+timer+" --property=SubState --value", exec.Result{Stdout: "waiting\n"})
	f.On("/usr/bin/systemctl show "+timer+" --property=NextElapseUSecMonotonic --value", exec.Result{Stdout: "123456789\n"})
	f.OnPrefix("/usr/bin/systemctl show", exec.Result{Stdout: "inactive\n"})
	f.OnPrefix("/usr/bin/systemctl", exec.Result{})
	f.On("/usr/sbin/ufw status numbered", exec.Result{Stdout: "Status: active\n[ 1] 80/tcp ALLOW IN Anywhere # Hermes-managed\n[ 2] 443/tcp ALLOW IN Anywhere # Hermes-managed\n"})
	f.OnPrefix("/usr/sbin/ufw status", exec.Result{Stdout: "Status: active\n"})
	f.OnPrefix("/usr/sbin/ufw", exec.Result{})
	f.OnPrefix("/usr/bin/logger", exec.Result{})
	g := guard.New(filepath.Join(dir, "state"), filepath.Join(dir, "backup"), "hermes-proxy-rollback", fsx.Current(), f)
	tx := &Transaction{
		Guard:     g,
		Systemd:   systemd.Client{Runner: f},
		Runner:    f,
		Caddyfile: filepath.Join(dir, "Caddyfile"),
		Owner:     fsx.Current(),
		Log:       func(string, ...any) {},
	}
	return tx, f, dir
}

// arm without writing the real systemd units (they live under /etc).
func armForTest(t *testing.T, tx *Transaction) {
	t.Helper()
	if err := tx.Guard.EnsureDirs(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := tx.Guard.ClearSnapshots(SnapCaddyfileAbsent, SnapCaddyWasActive, BackupCaddyfile); err != nil {
		t.Fatal(err)
	}
	st, err := fsx.Lstat(tx.Caddyfile)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Exists {
		if err := tx.Guard.Snapshot(SnapCaddyfileAbsent); err != nil {
			t.Fatal(err)
		}
	} else if err := tx.Guard.Backup(tx.Caddyfile, BackupCaddyfile); err != nil {
		t.Fatal(err)
	}
	if err := tx.Guard.Arm(ctx, guard.ArmParams{}); err != nil {
		t.Fatal(err)
	}
}

func TestRollbackRemovesManagedCaddyfileAndPorts(t *testing.T) {
	tx, f, _ := newTestTransaction(t)
	armForTest(t, tx) // no Caddyfile yet: was-absent
	if !tx.Guard.HasSnapshot(SnapCaddyfileAbsent) {
		t.Fatal("the absent Caddyfile was not snapshotted")
	}
	// The exposure writes a managed Caddyfile, then the process dies.
	if err := os.WriteFile(tx.Caddyfile, []byte(ManagedMarker+"\nx\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	out, err := tx.Rollback(context.Background())
	if err != nil || out != "rolled-back" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	if fsx.Exists(tx.Caddyfile) {
		t.Error("the managed Caddyfile survived the rollback")
	}
	for _, number := range []string{"2", "1"} {
		if !f.Ran("/usr/sbin/ufw --force delete " + number) {
			t.Errorf("rule %s was not removed; commands=%v", number, f.Commands())
		}
	}
	if !f.Ran("/usr/bin/systemctl stop caddy") {
		t.Errorf("caddy was not stopped; commands=%v", f.Commands())
	}
	if !fsx.Exists(tx.Guard.RolledBack()) || fsx.Exists(tx.Guard.Active()) {
		t.Error("markers were not moved to rolled-back")
	}
}

func TestRollbackRestoresTheOriginalCaddyfile(t *testing.T) {
	tx, _, _ := newTestTransaction(t)
	original := ManagedMarker + "\nprevious exposure\n"
	if err := os.WriteFile(tx.Caddyfile, []byte(original), 0o640); err != nil {
		t.Fatal(err)
	}
	armForTest(t, tx)
	if err := os.WriteFile(tx.Caddyfile, []byte(ManagedMarker+"\nnew exposure\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(tx.Caddyfile)
	if err != nil || string(got) != original {
		t.Fatalf("got %q err=%v", got, err)
	}
}

// A file replaced by someone else after the snapshot is left alone: the
// rollback undoes its own work, never a third party's.
func TestRollbackKeepsAForeignCaddyfile(t *testing.T) {
	tx, _, _ := newTestTransaction(t)
	armForTest(t, tx)
	foreign := "# someone else's proxy\n"
	if err := os.WriteFile(tx.Caddyfile, []byte(foreign), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(tx.Caddyfile)
	if string(got) != foreign {
		t.Fatalf("a foreign Caddyfile was touched: %q", got)
	}
}

func TestRollbackRefusesWhenPortsStayOpen(t *testing.T) {
	tx, f, _ := newTestTransaction(t)
	armForTest(t, tx)
	f.On("/usr/sbin/ufw status", exec.Result{Stdout: "Status: active\n443/tcp                    ALLOW       Anywhere\n"})
	out, err := tx.Rollback(context.Background())
	if err == nil || !strings.Contains(err.Error(), "still allows") {
		t.Fatalf("unproven rollback reported success: out=%q err=%v", out, err)
	}
	if fsx.Exists(tx.Guard.RolledBack()) {
		t.Error("rolled-back was written although the ports are still open")
	}
}

func TestRollbackWithoutArmingDoesNothing(t *testing.T) {
	tx, f, _ := newTestTransaction(t)
	if err := tx.Guard.EnsureDirs(); err != nil {
		t.Fatal(err)
	}
	out, err := tx.Rollback(context.Background())
	if err != nil || out != "not-armed" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	if len(f.Commands()) != 0 {
		t.Fatalf("an unarmed rollback ran commands: %v", f.Commands())
	}
}

func TestCommitDisarmsAndClearsSnapshots(t *testing.T) {
	tx, f, _ := newTestTransaction(t)
	armForTest(t, tx)
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	if fsx.Exists(tx.Guard.Active()) {
		t.Error("the active marker survived the commit")
	}
	if tx.Guard.HasSnapshot(SnapCaddyfileAbsent) {
		t.Error("snapshots survived the commit")
	}
	if !f.Ran("/usr/bin/systemctl stop hermes-proxy-rollback.timer") {
		t.Errorf("the timer was not stopped; commands=%v", f.Commands())
	}
	// The transaction can be armed again (an exposure is replayable).
	armForTest(t, tx)
}

func TestClearSnapshotsRefusedWhileArmed(t *testing.T) {
	tx, _, _ := newTestTransaction(t)
	armForTest(t, tx)
	if err := tx.Guard.ClearSnapshots(SnapCaddyfileAbsent); err == nil {
		t.Fatal("snapshots were cleared while the transaction was armed")
	}
}

func TestDisarmRefusedAfterRollback(t *testing.T) {
	tx, _, _ := newTestTransaction(t)
	armForTest(t, tx)
	if _, err := tx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := tx.Guard.Disarm(context.Background()); err == nil {
		t.Fatal("disarm was accepted after the rollback won")
	}
	_ = filepath.Join
}
