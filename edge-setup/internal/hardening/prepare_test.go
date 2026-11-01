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
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

// guardedHost is a hardener over a fake host whose guard lives on tmpfs. A
// fresh guard is what a host sees the first time `up` reaches Prepare.
func guardedHost(t *testing.T, etc string) (*Hardener, *exectest.Fake) {
	t.Helper()
	h, fake, _ := resolverHost(t, etc, "")
	root := t.TempDir()
	h.Guard = guard.New(filepath.Join(root, "state"), filepath.Join(root, "backup"), layout.HardeningRollbackUnit, fsx.Current(), fake)
	h.Apt.PolicyRcD = filepath.Join(root, "policy-rc.d")
	return h, fake
}

// requireRefusedTwice runs Prepare twice: a refusal that stranded the host
// would be met, the second time, by ResetAfterRollback's "incomplete pre-arm
// hardening state" instead of the same refusal.
func requireRefusedTwice(t *testing.T, h *Hardener, o Options, want string) {
	t.Helper()
	for attempt := 1; attempt <= 2; attempt++ {
		_, err := h.Prepare(context.Background(), o)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("attempt %d: Prepare = %v, want the refusal %q", attempt, err, want)
		}
		if left := h.Guard.Artifacts(); len(left) != 0 {
			t.Fatalf("attempt %d: the refusal left %v behind", attempt, left)
		}
	}
}

// The dry run asks the installed ufw before the first snapshot: a refusal
// leaves nothing to recover from.
func TestPrepareRefusedByTheDryRunDoesNotBlockTheNextGuardedRun(t *testing.T) {
	h, fake := guardedHost(t, "nameserver fd00:ec2::253\n")
	fake.OnPrefix("/usr/sbin/ufw --dry-run", exec.Result{ExitCode: 1, Stderr: "ERROR: Adding IPv6 rule failed: IPv6 not enabled\n"})
	requireRefusedTwice(t, h, Options{Features: state.Features{Firewall: true}, Guarded: true}, "refusing to enable the firewall")
	for _, command := range fake.Commands() {
		if !strings.Contains(command, "--dry-run") {
			t.Errorf("the refusal came after %q: the snapshot was already taken", command)
		}
	}
}

// With no ufw on the host the dry run has nobody to ask, and runs nothing.
func TestPreflightWithoutUFWAsksNobody(t *testing.T) {
	h, _ := guardedHost(t, "nameserver 169.254.169.254\n")
	bare := exectest.NewFake()
	h.Runner = bare
	h.UFWInstalled = func() bool { return false }
	if err := h.requireResolverException(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(bare.Calls) != 0 {
		t.Errorf("ran %v", bare.Commands())
	}
}

// A refusal after the snapshots and the package install (a third-party fail2ban
// jail already there) used to leave them for a manual recovery.
func TestPrepareRefusedAfterTheSnapshotsAndTheInstallDoesNotBlockTheNextGuardedRun(t *testing.T) {
	h, fake := guardedHost(t, "")
	h.Fail2banJail = filepath.Join(t.TempDir(), "sshd.local")
	if err := os.WriteFile(h.Fail2banJail, []byte("[sshd]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fake.On("/usr/bin/systemctl is-active --quiet fail2ban", exec.Result{ExitCode: 3})
	requireRefusedTwice(t, h, Options{Features: state.Features{Fail2Ban: true}, Guarded: true}, "pre-exists; reconcile that policy manually")
	if !fake.Ran("/usr/bin/systemctl is-active --quiet fail2ban") || !strings.Contains(strings.Join(fake.Commands(), "\n"), "apt-get install") {
		t.Errorf("the refusal must come after the snapshot and the install, ran %v", fake.Commands())
	}
}

// A snapshot refused after an earlier one was taken (sshd does not validate
// after the fail2ban snapshot) takes that one back.
func TestPrepareRefusedByALaterSnapshotTakesTheEarlierOnesBack(t *testing.T) {
	h, fake := guardedHost(t, "")
	h.SSHDropin = filepath.Join(t.TempDir(), "00-hermes.conf")
	fake.On("/usr/bin/systemctl is-active --quiet fail2ban", exec.Result{ExitCode: 3})
	fake.On("/usr/sbin/sshd -t", exec.Result{ExitCode: 255, Stderr: "bad configuration\n"})
	requireRefusedTwice(t, h, Options{Features: state.Features{Fail2Ban: true, SSHHardening: true}, Guarded: true}, "does not validate")
}

// Only what the refused run itself took goes: the snapshots of an earlier run
// stay, and so does everything once a change it made is on record.
func TestDiscardNewSnapshotsKeepsWhatARefusedRunMustNotLose(t *testing.T) {
	newGuard := func(t *testing.T) *Hardener {
		t.Helper()
		h, _ := guardedHost(t, "")
		if err := h.Guard.EnsureDirs(); err != nil {
			t.Fatal(err)
		}
		return h
	}
	snap := func(t *testing.T, h *Hardener, names ...string) {
		t.Helper()
		for _, n := range names {
			if err := h.Guard.Snapshot(n); err != nil {
				t.Fatal(err)
			}
		}
	}

	h := newGuard(t)
	snap(t, h, "ufw.was-inactive")
	before := h.Guard.Artifacts()
	snap(t, h, "fail2ban.was-inactive")
	h.discardNewSnapshots(before)
	if got := h.Guard.Artifacts(); len(got) != 1 || !got["ufw.was-inactive"] {
		t.Errorf("only the snapshot taken by the refused run goes, left %v", got)
	}

	h = newGuard(t)
	before = h.Guard.Artifacts()
	snap(t, h, "ufw.was-inactive", "admin.created-by-bootstrap")
	h.discardNewSnapshots(before)
	if got := h.Guard.Artifacts(); len(got) != 2 {
		t.Errorf("an account on record is a change made: everything stays for the manual recovery, left %v", got)
	}

	// The same account recorded by an earlier run does not hold a new snapshot back.
	h = newGuard(t)
	snap(t, h, "admin.created-by-bootstrap")
	before = h.Guard.Artifacts()
	snap(t, h, "ufw.was-active")
	h.discardNewSnapshots(before)
	if got := h.Guard.Artifacts(); len(got) != 1 || !got["admin.created-by-bootstrap"] {
		t.Errorf("left %v, want only the earlier run's record", got)
	}
}
