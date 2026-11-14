// Package guard implements the anti-lockout transaction around host
// hardening: an `active` marker, a persistent systemd rollback timer, a
// lock shared with the rollback, and a guarded executor that refuses to
// mutate once the timer fired or commit happened.
//
// Semantics are carried verbatim from the previous tool's guarded-exec,
// commit-access and prepare-arm scripts: the marker files, their modes and
// the ordering of checks are a contract with hosts already provisioned.
package guard

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// Guard binds a state directory, a rollback timer unit and an owner. The
// zero value is not usable; use Default or New.
type Guard struct {
	StateDir  string
	BackupDir string
	Unit      string
	Owner     fsx.Owner
	Systemd   systemd.Client
	Runner    exec.Runner
	// LockWait bounds the wait for the shared lock.
	LockWait time.Duration
}

// Default is the host-hardening guard at the canonical paths.
func Default(r exec.Runner) *Guard {
	return New(layout.HardeningStateDir, layout.HardeningBackupDir, layout.HardeningRollbackUnit, fsx.Root, r)
}

// New builds a guard over explicit paths (tests).
func New(stateDir, backupDir, unit string, owner fsx.Owner, r exec.Runner) *Guard {
	return &Guard{
		StateDir:  stateDir,
		BackupDir: backupDir,
		Unit:      unit,
		Owner:     owner,
		Systemd:   systemd.Client{Runner: r},
		Runner:    r,
		LockWait:  30 * time.Second,
	}
}

// Marker paths.
func (g *Guard) Active() string     { return filepath.Join(g.StateDir, "active") }
func (g *Guard) Finalized() string  { return filepath.Join(g.StateDir, "finalized") }
func (g *Guard) RolledBack() string { return filepath.Join(g.StateDir, "rolled-back") }
func (g *Guard) RebootCheckpoint() string {
	return filepath.Join(g.StateDir, "awaiting-reboot")
}
func (g *Guard) LockFile() string { return filepath.Join(g.StateDir, "rollback.lock") }
func (g *Guard) Timer() string    { return g.Unit + ".timer" }

// EnsureDirs creates the root-only state and backup directories.
func (g *Guard) EnsureDirs() error {
	for _, d := range []string{g.StateDir, g.BackupDir} {
		if err := fsx.EnsureDir(d, 0o700, g.Owner); err != nil {
			return err
		}
	}
	return nil
}

// Lock takes the shared flock. The returned function releases it.
func (g *Guard) Lock() (func(), error) {
	if err := fsx.EnsureDir(g.StateDir, 0o700, g.Owner); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(g.LockFile(), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("lock: %w", err)
	}
	deadline := time.Now().Add(g.LockWait)
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) || time.Now().After(deadline) {
			_ = f.Close()
			return nil, fmt.Errorf("lock %s: %w", g.LockFile(), err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

// requireMarker checks a marker is a regular 0600 file owned by g.Owner.
func (g *Guard) requireMarker(path string) error {
	exists, err := fsx.RequireRegular(path, 0o600, g.Owner)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%s: missing", path)
	}
	return nil
}

// writeMarker writes a marker atomically, 0600.
func (g *Guard) writeMarker(path, content string) error {
	return fsx.WriteAtomic(path, []byte(content), 0o600, g.Owner)
}

// ReadMarker returns key=value pairs of a marker file.
func (g *Guard) ReadMarker(path string) (map[string]string, error) {
	data, err := fsx.ReadRegular(path, 0o600, g.Owner)
	if err != nil {
		return nil, err
	}
	kv := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			kv[k] = v
		}
	}
	return kv, nil
}

// State summarises the transaction markers.
type State struct {
	Active, Finalized, RolledBack, AwaitingReboot bool
}

// State reads the markers without validating them.
func (g *Guard) State() State {
	return State{
		Active:         fsx.Exists(g.Active()),
		Finalized:      fsx.Exists(g.Finalized()),
		RolledBack:     fsx.Exists(g.RolledBack()),
		AwaitingReboot: fsx.Exists(g.RebootCheckpoint()),
	}
}

// ArmParams are recorded in the active marker so verify-access can prove a
// session opened after the lockdown.
type ArmParams struct {
	AdminUser           string
	AdminKeyFingerprint string
	EnforcedAt          time.Time
	Features            []string
}

// Arm installs the active marker and starts the rollback timer, proving the
// timer is waiting before returning. On failure the marker is removed.
func (g *Guard) Arm(ctx context.Context, p ArmParams) (err error) {
	unlock, err := g.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	if fsx.Exists(g.Active()) {
		return errors.New("a rollback is already armed; refusing to arm another")
	}
	var previousFinalized []byte
	if fsx.Exists(g.Finalized()) {
		previousFinalized, err = fsx.ReadRegular(g.Finalized(), 0o600, g.Owner)
		if err != nil {
			return fmt.Errorf("previous finalized transaction: %w", err)
		}
	}
	armed := false
	defer func() {
		if !armed {
			_ = g.Systemd.Stop(ctx, g.Timer())
			_ = fsx.Remove(g.Active())
			if len(previousFinalized) > 0 {
				_ = fsx.WriteAtomic(g.Finalized(), previousFinalized, 0o600, g.Owner)
			}
		}
	}()
	if err := g.Systemd.Enable(ctx, g.Timer()); err != nil {
		return err
	}
	content := fmt.Sprintf("version=2\nstate=armed\nadmin=%s\nadmin_key=%s\nenforced_at=%d\nfeatures=%s\n",
		p.AdminUser, p.AdminKeyFingerprint, p.EnforcedAt.Unix(), strings.Join(p.Features, ","))
	if err := g.writeMarker(g.Active(), content); err != nil {
		return err
	}
	if err := fsx.Remove(g.Finalized()); err != nil {
		return err
	}
	if err := fsx.Remove(g.RolledBack()); err != nil {
		return err
	}
	if err := g.Systemd.Restart(ctx, g.Timer()); err != nil {
		return err
	}
	if err := g.Systemd.RequireTimerWaiting(ctx, g.Timer()); err != nil {
		return err
	}
	armed = true
	return nil
}

// RequireActive checks the active marker is a regular 0600 file owned by the
// transaction. A rollback calls it before touching anything.
func (g *Guard) RequireActive() error { return g.requireMarker(g.Active()) }

// ErrNotArmed is returned by Exec when the transaction is no longer live.
var ErrNotArmed = errors.New("hardening transaction is not armed; rollback may have won")

// check validates the live transaction under the lock: active marker
// regular 0600, no finalized marker, timer waiting.
func (g *Guard) check(ctx context.Context) error {
	if err := g.requireMarker(g.Active()); err != nil {
		return fmt.Errorf("%w: %v", ErrNotArmed, err)
	}
	if fsx.Exists(g.Finalized()) {
		return fmt.Errorf("%w: finalized marker present", ErrNotArmed)
	}
	if err := g.Systemd.RequireTimerWaiting(ctx, g.Timer()); err != nil {
		return fmt.Errorf("%w: %v", ErrNotArmed, err)
	}
	return nil
}

// Exec runs one live mutation under the lock, after re-verifying the
// transaction. This is the only path through which the harden phase may
// change sshd, ufw, fail2ban or accounts.
func (g *Guard) Exec(ctx context.Context, c exec.Cmd) (exec.Result, error) {
	unlock, err := g.Lock()
	if err != nil {
		return exec.Result{}, err
	}
	defer unlock()
	if err := g.check(ctx); err != nil {
		return exec.Result{}, err
	}
	return exec.Must(ctx, g.Runner, c)
}

// Do runs fn under the lock after re-verifying the transaction, for
// mutations that are file writes rather than commands.
func (g *Guard) Do(ctx context.Context, fn func() error) error {
	unlock, err := g.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	if err := g.check(ctx); err != nil {
		return err
	}
	return fn()
}

// CommitResult tells what Commit did.
type CommitResult string

// Commit outcomes.
const (
	Committed        CommitResult = "finalized"
	AlreadyFinalized CommitResult = "already-finalized"
)

// Commit atomically finalizes the transaction: writes the durable finalized
// marker, removes active, stops the timer. It refuses if rollback won.
func (g *Guard) Commit(ctx context.Context, adminUser, adminKey string) (CommitResult, error) {
	unlock, err := g.Lock()
	if err != nil {
		return "", err
	}
	defer unlock()
	if !fsx.Exists(g.Active()) {
		if err := g.requireMarker(g.Finalized()); err == nil && !fsx.Exists(g.RolledBack()) {
			_ = g.Systemd.Stop(ctx, g.Timer())
			return AlreadyFinalized, nil
		}
		return "", errors.New("host rollback already won; refusing to finalize")
	}
	if err := g.requireMarker(g.Active()); err != nil {
		return "", err
	}
	if fsx.Exists(g.Finalized()) || fsx.Exists(g.RolledBack()) {
		return "", errors.New("contradictory markers: finalized or rolled-back present with active")
	}
	if err := g.Systemd.RequireTimerWaiting(ctx, g.Timer()); err != nil {
		return "", err
	}
	if err := g.writeMarker(g.Finalized(), fmt.Sprintf("version=1\nadmin=%s\nadmin_key=%s\n", adminUser, adminKey)); err != nil {
		return "", err
	}
	if err := fsx.Remove(g.Active()); err != nil {
		return "", err
	}
	if err := g.Systemd.Stop(ctx, g.Timer()); err != nil {
		return "", err
	}
	return Committed, nil
}

// Disarm ends a transaction that leaves no durable finalized marker: the
// timer is stopped and the active marker removed, so the same transaction
// can be armed again (a proxy exposure is replayed by `up` and `mode`).
// It refuses once the rollback has won.
func (g *Guard) Disarm(ctx context.Context) error {
	unlock, err := g.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	if fsx.Exists(g.RolledBack()) {
		return errors.New("rollback already won; refusing to disarm")
	}
	if !fsx.Exists(g.Active()) {
		return nil
	}
	if err := g.requireMarker(g.Active()); err != nil {
		return err
	}
	if err := g.Systemd.Stop(ctx, g.Timer()); err != nil {
		return err
	}
	return fsx.Remove(g.Active())
}

// ClearSnapshots removes named state markers and backups once a transaction
// is over. It refuses while the transaction is still armed: those files are
// exactly what the rollback would need.
func (g *Guard) ClearSnapshots(names ...string) error {
	unlock, err := g.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	if fsx.Exists(g.Active()) {
		return errors.New("transaction still armed; refusing to clear its snapshots")
	}
	for _, n := range names {
		for _, p := range []string{g.StatePath(n), g.BackupPath(n)} {
			st, err := fsx.Lstat(p)
			if err != nil {
				return err
			}
			if !st.Exists {
				continue
			}
			if !st.Regular || st.Symlink || st.Owner.UID != g.Owner.UID {
				return fmt.Errorf("%s is not a regular file owned by the transaction; leaving it", p)
			}
			if err := fsx.Remove(p); err != nil {
				return err
			}
		}
	}
	return nil
}

// MarkRolledBack writes the rolled-back marker and removes active; called by
// the rollback after access was restored.
func (g *Guard) MarkRolledBack(features ...string) error {
	content := "version=1\nstate=rolled-back\n"
	if len(features) > 0 {
		content = fmt.Sprintf("version=2\nstate=rolled-back\nfeatures=%s\n", strings.Join(features, ","))
	}
	if err := g.writeMarker(g.RolledBack(), content); err != nil {
		return err
	}
	return fsx.Remove(g.Active())
}

// WriteRebootCheckpoint persists the selected access snapshots that may
// legitimately exist before any guarded mutation.
func (g *Guard) WriteRebootCheckpoint(features ...string) error {
	return g.writeMarker(g.RebootCheckpoint(), fmt.Sprintf("version=2\nstate=awaiting-reboot\nfeatures=%s\n", strings.Join(features, ",")))
}

// StateArtifacts are the snapshot files the prepare phase may leave in the
// state directory; ResetAfterRollback removes them only after a rollback.
var StateArtifacts = []string{
	"admin.created-by-bootstrap", "sudoers.created-by-bootstrap",
	"ufw.was-active", "ufw.was-inactive", "fail2ban.was-active", "fail2ban.was-inactive", "ssh-dropin.was-absent",
	"resolved-dropin.created-by-bootstrap", "pwquality-dropin.created-by-bootstrap", "fail2ban-dropin.created-by-bootstrap",
	"auto-upgrades.created-by-bootstrap", "unattended.created-by-bootstrap",
	"80-hermes-admin.created-by-bootstrap", "81-hermes-logging.created-by-bootstrap", "sudo-logrotate.created-by-bootstrap",
	"80-hermes-admin", "81-hermes-logging",
	"resolved.candidate", "pwquality.candidate", "fail2ban-sshd.candidate", "sshd-hardening.candidate", "ufw.default.candidate",
}

// BackupArtifacts are the files the rollback restores from.
var BackupArtifacts = []string{
	"ssh-dropin.original", "ufw.default", "ufw.conf", "ufw.user.rules", "ufw.user6.rules",
	"debian.authorized_keys", "debian.sudoers", "debian.manifest", "auto-upgrades.original",
}

// preArmSnapshots are the artifacts allowed at a reboot checkpoint: the
// access snapshots, and the ownership records of the unattended-upgrades
// configuration, written before the upgrade that requires the reboot.
var preArmSnapshots = map[string]bool{
	"ufw.was-active": true, "ufw.was-inactive": true, "fail2ban.was-active": true, "fail2ban.was-inactive": true,
	"ssh-dropin.was-absent": true, "ssh-dropin.original": true,
	"auto-upgrades.created-by-bootstrap": true, "auto-upgrades.original": true, "unattended.created-by-bootstrap": true,
}

// ResetOutcome describes what ResetAfterRollback found.
type ResetOutcome string

// Reset outcomes.
const (
	Clean             ResetOutcome = "clean"
	Reset             ResetOutcome = "reset"
	ResumeAfterReboot ResetOutcome = "resume-after-reboot"
)

// ResetAfterRollback prepares the state directory for a new attempt. Only a
// completed rollback authorises removing previous artifacts; an incomplete
// state without a rolled-back marker is refused, and a reboot checkpoint
// is accepted only when exactly the pre-arm snapshots exist.
func (g *Guard) ResetAfterRollback() (ResetOutcome, error) {
	unlock, err := g.Lock()
	if err != nil {
		return "", err
	}
	defer unlock()
	if fsx.Exists(g.Active()) || fsx.Exists(g.Finalized()) {
		return "", errors.New("active or finalized marker present; nothing to reset")
	}
	artifacts := g.artifactPaths()
	if !fsx.Exists(g.RolledBack()) {
		if fsx.Exists(g.RebootCheckpoint()) {
			kv, err := g.ReadMarker(g.RebootCheckpoint())
			if err != nil {
				return "", err
			}
			if (kv["version"] != "1" && kv["version"] != "2") || kv["state"] != "awaiting-reboot" {
				return "", fmt.Errorf("%s: unexpected content", g.RebootCheckpoint())
			}
			selected := map[string]bool{}
			for _, feature := range strings.Split(kv["features"], ",") {
				if feature != "" {
					selected[feature] = true
				}
			}
			legacy := kv["version"] == "1"
			ufw := 0
			for _, m := range []string{"ufw.was-active", "ufw.was-inactive"} {
				if fsx.Exists(filepath.Join(g.StateDir, m)) {
					ufw++
				}
			}
			f2b := 0
			for _, m := range []string{"fail2ban.was-active", "fail2ban.was-inactive"} {
				if fsx.Exists(filepath.Join(g.StateDir, m)) {
					f2b++
				}
			}
			ssh := 0
			for _, m := range []string{filepath.Join(g.StateDir, "ssh-dropin.was-absent"), filepath.Join(g.BackupDir, "ssh-dropin.original")} {
				if fsx.Exists(m) {
					ssh++
				}
			}
			wantUFW, wantF2B, wantSSH := selected["firewall"], selected["fail2ban"], selected["ssh"]
			if legacy {
				wantUFW, wantF2B, wantSSH = true, true, true
			}
			if ufw != boolCount(wantUFW) || f2b != boolCount(wantF2B) || ssh != boolCount(wantSSH) {
				return "", errors.New("reboot checkpoint does not match the selected UFW, fail2ban or sshd snapshots; manual recovery is required")
			}
			if fsx.Exists(filepath.Join(g.StateDir, "auto-upgrades.created-by-bootstrap")) && fsx.Exists(filepath.Join(g.BackupDir, "auto-upgrades.original")) {
				return "", errors.New("reboot checkpoint records 20auto-upgrades as both created and pre-existing; manual recovery is required")
			}
			for _, p := range artifacts {
				if !fsx.Exists(p) {
					continue
				}
				if !preArmSnapshots[filepath.Base(p)] {
					return "", fmt.Errorf("unexpected artifact at reboot checkpoint: %s", p)
				}
				if _, err := fsx.RequireRegular(p, 0o600, g.Owner); err != nil {
					return "", err
				}
			}
			return ResumeAfterReboot, nil
		}
		for _, p := range artifacts {
			if fsx.Exists(p) {
				return "", fmt.Errorf("incomplete pre-arm hardening state at %s; manual recovery is required", p)
			}
		}
		return Clean, nil
	}
	kv, err := g.ReadMarker(g.RolledBack())
	if err != nil {
		return "", err
	}
	if (kv["version"] != "1" && kv["version"] != "2") || kv["state"] != "rolled-back" {
		return "", fmt.Errorf("%s: unexpected content", g.RolledBack())
	}
	for _, p := range artifacts {
		if !fsx.Exists(p) {
			continue
		}
		st, err := fsx.Lstat(p)
		if err != nil {
			return "", err
		}
		if !st.Regular || st.Symlink || st.Owner != g.Owner {
			return "", fmt.Errorf("%s: refusing to remove a non-regular or foreign artifact", p)
		}
		if err := fsx.Remove(p); err != nil {
			return "", err
		}
	}
	if err := fsx.Remove(g.RolledBack()); err != nil {
		return "", err
	}
	return Reset, nil
}

func boolCount(v bool) int {
	if v {
		return 1
	}
	return 0
}

func (g *Guard) artifactPaths() []string {
	out := make([]string, 0, len(StateArtifacts)+len(BackupArtifacts))
	for _, a := range StateArtifacts {
		out = append(out, filepath.Join(g.StateDir, a))
	}
	for _, a := range BackupArtifacts {
		out = append(out, filepath.Join(g.BackupDir, a))
	}
	return out
}

// Artifacts returns the names of the artifacts present now: the state markers
// and the backups the prepare phase may leave, which ResetAfterRollback
// refuses to start over from. A name is also what ClearSnapshots takes.
func (g *Guard) Artifacts() map[string]bool {
	present := map[string]bool{}
	for _, a := range StateArtifacts {
		if fsx.Exists(filepath.Join(g.StateDir, a)) {
			present[a] = true
		}
	}
	for _, a := range BackupArtifacts {
		if fsx.Exists(filepath.Join(g.BackupDir, a)) {
			present[a] = true
		}
	}
	return present
}

// Snapshot writes an empty 0600 marker in the state dir if absent (the
// "was-*" and "created-by-bootstrap" family). Existing markers are kept.
func (g *Guard) Snapshot(name string) error {
	p := filepath.Join(g.StateDir, name)
	if fsx.Exists(p) {
		_, err := fsx.RequireRegular(p, 0o600, g.Owner)
		return err
	}
	return g.writeMarker(p, "\n")
}

// HasSnapshot reports whether a state marker exists.
func (g *Guard) HasSnapshot(name string) bool {
	return fsx.Exists(filepath.Join(g.StateDir, name))
}

// Backup copies src into the backup dir under name, 0600, unless a backup
// already exists (the first snapshot is the one the rollback trusts).
func (g *Guard) Backup(src, name string) error {
	dst := filepath.Join(g.BackupDir, name)
	if fsx.Exists(dst) {
		_, err := fsx.RequireRegular(dst, 0o600, g.Owner)
		return err
	}
	return fsx.CopyFile(src, dst, 0o600, g.Owner)
}

// BackupPath returns the path of a backup artifact.
func (g *Guard) BackupPath(name string) string { return filepath.Join(g.BackupDir, name) }

// StatePath returns the path of a state artifact.
func (g *Guard) StatePath(name string) string { return filepath.Join(g.StateDir, name) }
