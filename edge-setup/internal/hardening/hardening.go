// Package hardening closes the host's access surface inside the guarded
// transaction: an audited admin account, key-only sshd, UFW with an exact
// public port list, Fail2ban, LLMNR off, pwquality, sudo logging, and the
// quarantine of the cloud-init account. Every live mutation goes through
// guard.Exec; the rollback restores the four UFW files, the sshd drop-in
// and the quarantined account from backups only.
package hardening

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/apt"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/render"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// Options select what the harden phase does.
type Options struct {
	Features state.Features
	// Guarded is true only when this invocation newly enables a policy that
	// can affect remote access. Replaying an already committed policy does not
	// arm another one-shot rollback transaction.
	Guarded bool
	// AdminPublicKey is the single ed25519 public key of the administrator.
	AdminPublicKey string
	// AdminSudo is layout.AdminSudoPassword (empty means the same) or
	// layout.AdminSudoNoPasswd.
	AdminSudo string
	// AdminPassword is hermes-admin's sudo password in password mode. It is
	// set only once sshd refuses passwords, through chpasswd's stdin, and
	// never appears in an argument, a log line or an error.
	AdminPassword string
	// QuarantineExpectedKey, when set, is the fingerprint the cloud-init
	// account must still carry (drift refusal on replay).
	QuarantineExpectedKey string
}

// Hardener carries the dependencies.
type Hardener struct {
	Runner   exec.Runner
	Apt      apt.Client
	Accounts account.Client
	Systemd  systemd.Client
	Guard    *guard.Guard
	// Paths, overridable for tests that render candidates on tmpfs.
	SSHDropin, ResolvedDropin, PwqualityDropin, Fail2banJail string
	SudoersAdmin, SudoersLogging, SudoLog, SudoLogrotate     string
	LoopbackGuardPath                                        string
	// ResolverFiles are the resolv.conf files the host's nameservers are read
	// from (layout.ResolverFiles).
	ResolverFiles []string
	Log           func(string, ...any)
	// OperatorIP overrides the process-tree detection of the address to
	// exempt from the fail2ban jail. Tests set it; production leaves it nil.
	OperatorIP func() string
	// UFWInstalled overrides the lookup of the ufw binary. Tests set it;
	// production leaves it nil.
	UFWInstalled func() bool
}

// New wires a hardener at the canonical paths.
func New(r exec.Runner, log func(string, ...any)) *Hardener {
	if log == nil {
		log = func(string, ...any) {}
	}
	return &Hardener{
		Runner: r, Apt: apt.New(r), Accounts: account.New(r), Systemd: systemd.Client{Runner: r}, Guard: guard.Default(r),
		SSHDropin: layout.SSHDropin, ResolvedDropin: layout.ResolvedDropin, PwqualityDropin: layout.PwqualityDropin, Fail2banJail: layout.Fail2banJail,
		SudoersAdmin: layout.SudoersAdmin, SudoersLogging: layout.SudoersLogging, SudoLog: layout.SudoLog, SudoLogrotate: layout.SudoLogrotate,
		LoopbackGuardPath: "/etc/systemd/system/" + layout.LoopbackGuardUnit + ".service",
		ResolverFiles:     layout.ResolverFiles,
		Log:               log,
	}
}

// renderFail2banJail renders the jail with the operator's address exempted.
// The address is read from the process tree rather than taken as an option:
// `up` is the only caller, and the peer it must never ban is the peer it is
// talking to right now. A jail already written by a previous run keeps its
// addresses, so converging from a second workstation does not evict the first.
// It reads the WHOLE jail.d directory, not just the file it owns: fail2ban
// merges jail.d in lexical order and the last value of a key wins, so
// "sshd.local" overrides anything an earlier "10-*.conf" set. Rendering only
// from its own file would let a console-run `up` silently drop an exemption
// an operator added by hand, the exact lockout this guards against.
func (h *Hardener) renderFail2banJail() (string, error) {
	return render.Fail2banJail(MergeIgnoreIP(readJailDir(h.Fail2banJail), h.operatorIP()))
}

// readJailDir concatenates every jail fragment beside jailPath. Unreadable
// entries are skipped: an exemption that cannot be read is one this run will
// re-add if it still applies, never a reason to refuse to converge.
func readJailDir(jailPath string) string {
	entries, err := os.ReadDir(filepath.Dir(jailPath))
	if err != nil {
		return ""
	}
	var b strings.Builder
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if content, err := os.ReadFile(filepath.Join(filepath.Dir(jailPath), e.Name())); err == nil {
			b.Write(content)
			b.WriteString("\n")
		}
	}
	return b.String()
}

// ufwInstalled reports whether the ufw binary is on the host, overridable in tests.
func (h *Hardener) ufwInstalled() bool {
	if h.UFWInstalled != nil {
		return h.UFWInstalled()
	}
	return fsx.Exists("/usr/sbin/ufw")
}

// operatorIP is the detected address, overridable in tests.
func (h *Hardener) operatorIP() string {
	if h.OperatorIP != nil {
		return h.OperatorIP()
	}
	return DetectOperatorIP(HostProcTable())
}

// PrepareResult tells what prepare established.
type PrepareResult struct {
	AdminKeyFingerprint      string
	QuarantineApplies        bool
	QuarantineKeyFingerprint string
	RebootRequired           bool
}

func guardedFeatureNames(f state.Features) []string {
	var names []string
	if f.Firewall {
		names = append(names, "firewall")
	}
	if f.Fail2Ban {
		names = append(names, "fail2ban")
	}
	if f.SSHHardening {
		names = append(names, "ssh")
	}
	if f.QuarantineCloudUser {
		names = append(names, "quarantine")
	}
	return names
}

var ufwFiles = []struct{ Path, Backup string }{
	{"/etc/default/ufw", "ufw.default"},
	{"/etc/ufw/ufw.conf", "ufw.conf"},
	{"/etc/ufw/user.rules", "ufw.user.rules"},
	{"/etc/ufw/user6.rules", "ufw.user6.rules"},
}

// Prepare snapshots the pre-hardening state, installs packages and the
// admin account, and arms the rollback. It stops before any access change
// when a reboot is required. A refusal before the rollback is armed leaves no
// snapshot behind that only records what it found (discardNewSnapshots), so
// the next guarded run is not met by ResetAfterRollback's "incomplete pre-arm
// hardening state".
func (h *Hardener) Prepare(ctx context.Context, o Options) (res PrepareResult, err error) {
	g := h.Guard
	if o.Features.SSHHardening {
		// Before any change: a password mode without a usable password is
		// refused here, not after the account exists.
		if _, err := adminNoPasswd(o); err != nil {
			return res, err
		}
	}
	if err := g.EnsureDirs(); err != nil {
		return res, err
	}
	if o.Guarded {
		// Only the guarded path leaves a rolled-back marker to reset from;
		// without SSH hardening the snapshots are plain idempotency markers.
		if !fsx.Exists(g.Finalized()) {
			outcome, err := g.ResetAfterRollback()
			if err != nil {
				return res, err
			}
			h.Log("hardening state: %s", outcome)
		} else if _, err := fsx.RequireRegular(g.Finalized(), 0o600, fsx.Root); err != nil {
			return res, fmt.Errorf("previous finalized transaction: %w", err)
		}
	}
	before := g.Artifacts()
	defer func() {
		if err != nil {
			h.discardNewSnapshots(before)
		}
	}()
	if err := h.refusePreexistingPolicies(o); err != nil {
		return res, err
	}
	if o.Features.Firewall {
		// Before any snapshot: a refusal here leaves nothing behind.
		if err := h.requireResolverException(ctx); err != nil {
			return res, err
		}
		if err := h.snapshotUFW(ctx); err != nil {
			return res, err
		}
	}
	if o.Features.Fail2Ban {
		if err := h.snapshotFail2ban(ctx); err != nil {
			return res, err
		}
	}
	if o.Features.SSHHardening {
		if err := h.snapshotSSHDropin(ctx); err != nil {
			return res, err
		}
	}
	var packages []string
	if o.Features.Fail2Ban {
		packages = append(packages, "fail2ban")
	}
	if o.Features.PasswordPolicy {
		// cracklib-runtime carries the dictionary pam_pwquality checks against:
		// apt runs without recommends, and without it every password change
		// (chpasswd included) fails with "error loading dictionary".
		packages = append(packages, "libpam-pwquality", "cracklib-runtime")
	}
	if o.Features.SudoLogging {
		packages = append(packages, "logrotate")
	}
	if o.Features.Firewall {
		packages = append(packages, "ufw")
	}
	if o.Features.UnattendedUpgrades {
		packages = append(packages, "unattended-upgrades")
	}
	if len(packages) > 0 {
		if err := h.Apt.Install(ctx, packages...); err != nil {
			return res, err
		}
	}
	if o.Features.Firewall {
		if err := h.requireUFWPristine(ctx, o.Features.AllowedInbound); err != nil {
			return res, err
		}
		// Again, for a ufw this run has just installed (the first check had no
		// ufw to ask): still before any access change.
		if err := h.requireResolverException(ctx); err != nil {
			return res, err
		}
	}
	if o.Features.Fail2Ban && fsx.Exists(h.Fail2banJail) && !g.HasSnapshot("fail2ban-dropin.created-by-bootstrap") {
		return res, fmt.Errorf("%s pre-exists; reconcile that policy manually, no third-party jail is overwritten", h.Fail2banJail)
	}
	if o.Features.PasswordPolicy {
		if err := h.refusePwqualityOverrides(); err != nil {
			return res, err
		}
	}
	if o.Features.UnattendedUpgrades {
		if err := h.configureUnattendedUpgrades(ctx); err != nil {
			return res, err
		}
	}
	if o.Features.UnattendedUpgrades && fsx.Exists("/var/run/reboot-required") {
		if err := g.WriteRebootCheckpoint(guardedFeatureNames(o.Features)...); err != nil {
			return res, err
		}
		res.RebootRequired = true
		return res, nil
	}
	_ = fsx.Remove(g.RebootCheckpoint())
	if o.Features.QuarantineCloudUser {
		applies, qfp, err := h.captureQuarantine(ctx, o.QuarantineExpectedKey)
		if err != nil {
			return res, err
		}
		res.QuarantineApplies, res.QuarantineKeyFingerprint = applies, qfp
	}
	if o.Features.SudoLogging {
		if err := h.installSudoLogging(ctx); err != nil {
			return res, err
		}
	}
	if o.Guarded {
		if err := h.installRollbackUnits(ctx); err != nil {
			return res, err
		}
		if o.Features.Firewall {
			for _, f := range ufwFiles {
				if _, err := fsx.RequireRegular(f.Path, 0, fsx.Root); err != nil {
					return res, fmt.Errorf("UFW file to back up: %w", err)
				}
				if !fsx.Exists(f.Path) {
					return res, fmt.Errorf("%s is missing after installing ufw", f.Path)
				}
				if err := g.Backup(f.Path, f.Backup); err != nil {
					return res, err
				}
			}
		}
	}
	if !o.Features.SSHHardening {
		if o.Guarded {
			if err := g.Arm(ctx, guard.ArmParams{EnforcedAt: time.Now(), Features: guardedFeatureNames(o.Features)}); err != nil {
				return res, err
			}
		}
		return res, nil
	}
	fp, err := h.installAdmin(ctx, o.AdminPublicKey)
	if err != nil {
		return res, err
	}
	res.AdminKeyFingerprint = fp
	noPasswd, err := adminNoPasswd(o)
	if err != nil {
		return res, err
	}
	if err := h.installAdminSudoers(ctx, noPasswd); err != nil {
		return res, err
	}
	if !o.Guarded {
		return res, nil
	}
	if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/sshd", Args: []string{"-t"}}); err != nil {
		return res, fmt.Errorf("current sshd configuration does not validate: %w", err)
	}
	if err := g.Arm(ctx, guard.ArmParams{AdminUser: layout.AdminUser, AdminKeyFingerprint: fp, EnforcedAt: time.Now(), Features: guardedFeatureNames(o.Features)}); err != nil {
		return res, err
	}
	return res, nil
}

// snapshotRecords are the artifacts Prepare writes only to remember what it
// found (the state before it, or a copy of a file it has not touched): nothing
// it applies rests on them. Every other artifact records a change already made
// (an account, a drop-in, a timer) and must outlive a refusal.
var snapshotRecords = map[string]bool{
	"ufw.was-active": true, "ufw.was-inactive": true,
	"fail2ban.was-active": true, "fail2ban.was-inactive": true,
	"ssh-dropin.was-absent": true, "ssh-dropin.original": true,
	"ufw.default": true, "ufw.conf": true, "ufw.user.rules": true, "ufw.user6.rules": true,
	"debian.authorized_keys": true, "debian.sudoers": true, "debian.manifest": true,
}

// discardNewSnapshots undoes what a refused Prepare took: the snapshots that
// were not there when it started (before, from guard.Artifacts) go, and the
// next guarded run starts clean instead of being met by "incomplete pre-arm
// hardening state; manual recovery is required". If the refused run also left
// an artifact that records a change it made, the state is no longer a mere
// snapshot: everything stays, as that manual recovery expects.
//
// The packages the refused run installed stay, which the next snapshot reads
// the same: apt.Client.Install keeps every postinst from starting a service.
func (h *Hardener) discardNewSnapshots(before map[string]bool) {
	var created []string
	for name := range h.Guard.Artifacts() {
		switch {
		case before[name]:
		case snapshotRecords[name]:
			created = append(created, name)
		default:
			return
		}
	}
	_ = h.Guard.ClearSnapshots(created...)
}

func (h *Hardener) refusePreexistingPolicies(o Options) error {
	var paths []string
	if o.Features.DisableLLMNR {
		paths = append(paths, h.ResolvedDropin)
	}
	if o.Features.PasswordPolicy {
		paths = append(paths, h.PwqualityDropin)
	}
	for _, p := range paths {
		if fsx.Exists(p) && !h.Guard.HasSnapshot(filepath.Base(strings.TrimSuffix(p, ".conf"))+"-dropin.created-by-bootstrap") && !h.createdByUs(p) {
			return fmt.Errorf("%s pre-exists; no local security policy is overwritten automatically", p)
		}
	}
	return nil
}

func (h *Hardener) createdByUs(p string) bool {
	switch p {
	case h.ResolvedDropin:
		return h.Guard.HasSnapshot("resolved-dropin.created-by-bootstrap")
	case h.PwqualityDropin:
		return h.Guard.HasSnapshot("pwquality-dropin.created-by-bootstrap")
	}
	return false
}

func (h *Hardener) ufw(ctx context.Context, args ...string) (exec.Result, error) {
	return h.Runner.Run(ctx, ufwCmd(args...))
}

// snapshotUFW records whether UFW was active. Existing rules are audited in
// requireUFWCompatible after the package is present; they are never reset.
func (h *Hardener) snapshotUFW(ctx context.Context) error {
	if h.Guard.HasSnapshot("ufw.was-active") || h.Guard.HasSnapshot("ufw.was-inactive") {
		if h.Guard.HasSnapshot("ufw.was-active") && h.Guard.HasSnapshot("ufw.was-inactive") {
			return errors.New("contradictory UFW snapshots; no firewall mutation is allowed")
		}
		return nil
	}
	wasActive := false
	if h.ufwInstalled() {
		status, err := h.ufw(ctx, "status")
		if err != nil {
			return err
		}
		if status.ExitCode != 0 {
			return errors.New("UFW status is unreadable; refusing an unproven firewall change")
		}
		wasActive = UFWStatusActive(status.Stdout)
		if !wasActive {
			added, err := h.ufw(ctx, "show", "added")
			if err != nil {
				return err
			}
			if added.ExitCode != 0 || UFWHasHistoricalRules(added.Stdout) {
				return errors.New("UFW carries historical inactive rules; audit or purge them before enabling it")
			}
		}
	}
	for _, f := range []string{"/etc/ufw/user.rules", "/etc/ufw/user6.rules", "/etc/ufw/ufw.conf"} {
		st, err := fsx.Lstat(f)
		if err != nil {
			return err
		}
		if st.Exists && (!st.Regular || st.Symlink) {
			return fmt.Errorf("%s is not a regular file", f)
		}
	}
	if !wasActive {
		if data, err := os.ReadFile("/etc/ufw/ufw.conf"); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				t := strings.TrimSpace(strings.SplitN(line, "#", 2)[0])
				if strings.HasPrefix(t, "ENABLED") && strings.HasSuffix(strings.ReplaceAll(t, " ", ""), "=yes") {
					return errors.New("/etc/ufw/ufw.conf enables UFW although the firewall is inactive; reconcile before hardening")
				}
			}
		}
		for _, f := range []string{"/etc/ufw/user.rules", "/etc/ufw/user6.rules"} {
			if data, err := os.ReadFile(f); err == nil && strings.Contains(string(data), "### tuple ###") {
				return fmt.Errorf("%s carries residual rules; audit or purge them before hardening", f)
			}
		}
	}
	if wasActive {
		return h.Guard.Snapshot("ufw.was-active")
	}
	return h.Guard.Snapshot("ufw.was-inactive")
}

func (h *Hardener) snapshotFail2ban(ctx context.Context) error {
	if h.Guard.HasSnapshot("fail2ban.was-active") || h.Guard.HasSnapshot("fail2ban.was-inactive") {
		if h.Guard.HasSnapshot("fail2ban.was-active") && h.Guard.HasSnapshot("fail2ban.was-inactive") {
			return errors.New("contradictory fail2ban snapshots; no further access mutation is allowed")
		}
		return nil
	}
	active, err := h.Systemd.IsActive(ctx, "fail2ban")
	if err != nil {
		return err
	}
	if active {
		return h.Guard.Snapshot("fail2ban.was-active")
	}
	return h.Guard.Snapshot("fail2ban.was-inactive")
}

func (h *Hardener) snapshotSSHDropin(ctx context.Context) error {
	if h.Guard.HasSnapshot("ssh-dropin.was-absent") || fsx.Exists(h.Guard.BackupPath("ssh-dropin.original")) {
		return nil
	}
	exists, err := fsx.RequireRegular(h.SSHDropin, 0, fsx.Root)
	if err != nil {
		return fmt.Errorf("pre-existing sshd drop-in: %w", err)
	}
	if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/sshd", Args: []string{"-t"}}); err != nil {
		return fmt.Errorf("current sshd configuration does not validate: %w", err)
	}
	if exists {
		return h.Guard.Backup(h.SSHDropin, "ssh-dropin.original")
	}
	return h.Guard.Snapshot("ssh-dropin.was-absent")
}

// requireUFWPristine compares hooks and rules with the package defaults:
// the tool cannot prove an exposure limited to its port list otherwise.
func (h *Hardener) requireUFWPristine(ctx context.Context, declared []string) error {
	status, err := h.ufw(ctx, "status")
	if err != nil {
		return err
	}
	if UFWStatusActive(status.Stdout) {
		if h.Guard.HasSnapshot("ufw.was-active") {
			if err := RequireAllowedSubset(UFWAllowedInPorts(status.Stdout), declared); err != nil {
				return err
			}
			for _, bin := range []string{"/usr/sbin/iptables", "/usr/sbin/ip6tables"} {
				out, err := exec.Output(ctx, h.Runner, bin, "-S")
				if err != nil || !IptablesInputDrop(out) {
					return fmt.Errorf("existing UFW policy is not default-deny for inbound traffic (%s); reconcile it manually", bin)
				}
			}
			return nil
		}
		if h.Guard.HasSnapshot("ufw.was-inactive") && UFWOnlyManagedRules(status.Stdout) {
			// Replay: the active policy is the one this tool wrote.
			return nil
		}
		return errors.New("UFW became active after installation; stopping before any access change")
	}
	added, err := h.ufw(ctx, "show", "added")
	if err != nil {
		return err
	}
	if UFWHasHistoricalRules(added.Stdout) {
		return errors.New("UFW shows historical rules after installation")
	}
	var drift []string
	for _, name := range []string{"before.rules", "before6.rules", "after.rules", "after6.rules", "before.init", "after.init", "user.rules", "user6.rules", "ufw.conf"} {
		live, vendor := "/etc/ufw/"+name, "/usr/share/ufw/"+name
		lst, err := fsx.Lstat(live)
		if err != nil || !lst.Exists || !lst.Regular || lst.Symlink || !fsx.Exists(vendor) {
			drift = append(drift, live)
			continue
		}
		a, _ := os.ReadFile(live)
		b, _ := os.ReadFile(vendor)
		if string(a) != string(b) {
			drift = append(drift, live)
		}
	}
	md5, err := h.Apt.ConffileMD5(ctx, "ufw", "/etc/default/ufw")
	if err != nil {
		return err
	}
	sum, err := exec.Output(ctx, h.Runner, "/usr/bin/md5sum", "/etc/default/ufw")
	if err != nil {
		return err
	}
	if md5 == "" || !strings.HasPrefix(sum, md5) {
		drift = append(drift, "/etc/default/ufw")
	}
	if len(drift) > 0 {
		return fmt.Errorf("UFW hooks, rules or defaults differ from the Debian package (%s); refusing to enable this firewall without manual reconciliation", strings.Join(drift, ", "))
	}
	return nil
}

func (h *Hardener) refusePwqualityOverrides() error {
	files := map[string]string{}
	for _, p := range append([]string{"/etc/security/pwquality.conf"}, globConf("/etc/security/pwquality.conf.d")...) {
		if p == h.PwqualityDropin && h.createdByUs(p) {
			continue
		}
		st, err := fsx.Lstat(p)
		if err != nil || !st.Exists {
			continue
		}
		if !st.Regular || st.Symlink {
			return fmt.Errorf("%s is not a regular file", p)
		}
		data, _ := os.ReadFile(p)
		files[p] = string(data)
	}
	if over := PwqualityOverridesPresent(files); len(over) > 0 {
		return fmt.Errorf("a pre-existing pwquality policy would have the last word over the managed drop-in (%s); reconcile it manually", strings.Join(over, ", "))
	}
	return nil
}

func globConf(dir string) []string {
	m, _ := filepath.Glob(filepath.Join(dir, "*.conf"))
	return m
}

// SnapAutoUpgradesCreated records that this tool, not Debian, created
// /etc/apt/apt.conf.d/20auto-upgrades. reset consults it before removing it.
const SnapAutoUpgradesCreated = "auto-upgrades.created-by-bootstrap"
const SnapUnattendedCreated = "unattended.created-by-bootstrap"

func (h *Hardener) configureUnattendedUpgrades(ctx context.Context) error {
	auto, err := render.AptAutoUpgrades()
	if err != nil {
		return err
	}
	unattended, err := render.AptUnattended()
	if err != nil {
		return err
	}
	// Debian ships 20auto-upgrades with unattended-upgrades. Record whether
	// we are the ones creating it, so reset removes it only in that case:
	// deleting a distribution file would silently disable security updates.
	if !fsx.Exists(layout.AptAutoUpgrades) {
		if err := h.Guard.Snapshot(SnapAutoUpgradesCreated); err != nil {
			return err
		}
	} else if !h.Guard.HasSnapshot(SnapAutoUpgradesCreated) && !fsx.Exists(h.Guard.BackupPath("auto-upgrades.original")) {
		if _, err := fsx.RequireRegular(layout.AptAutoUpgrades, 0, fsx.Root); err != nil {
			return fmt.Errorf("pre-existing auto-upgrades policy: %w", err)
		}
		if err := h.Guard.Backup(layout.AptAutoUpgrades, "auto-upgrades.original"); err != nil {
			return err
		}
	}
	if !fsx.Exists(layout.AptUnattended) {
		if err := h.Guard.Snapshot(SnapUnattendedCreated); err != nil {
			return err
		}
	} else if !h.Guard.HasSnapshot(SnapUnattendedCreated) {
		info, err := fsx.RequireRegular(layout.AptUnattended, 0, fsx.Root)
		if err != nil || !info {
			return fmt.Errorf("pre-existing unattended-upgrades policy is not a regular root-owned file")
		}
		current, err := os.ReadFile(layout.AptUnattended)
		if err != nil {
			return err
		}
		if string(current) != unattended {
			return fmt.Errorf("%s pre-exists with another policy; refusing to overwrite it", layout.AptUnattended)
		}
	}
	if err := writeIfChanged(layout.AptAutoUpgrades, auto, 0o644); err != nil {
		return err
	}
	if err := writeIfChanged(layout.AptUnattended, unattended, 0o644); err != nil {
		return err
	}
	if err := h.Apt.UpgradeSafe(ctx, pins.DockerPackageNames()...); err != nil {
		return err
	}
	return h.Systemd.EnableNow(ctx, "apt-daily.timer", "apt-daily-upgrade.timer")
}

func writeIfChanged(path, content string, mode os.FileMode) error {
	if cur, err := os.ReadFile(path); err == nil && string(cur) == content {
		return nil
	}
	return fsx.WriteAtomic(path, []byte(content), mode, fsx.Root)
}

// FingerprintOf returns the SHA256 fingerprint of a public key line.
func (h *Hardener) FingerprintOf(ctx context.Context, publicKey string) (string, error) {
	tmp, err := os.CreateTemp("", "edge-setup-key-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(strings.TrimSpace(publicKey) + "\n"); err != nil {
		return "", err
	}
	_ = tmp.Close()
	out, err := exec.Output(ctx, h.Runner, "/usr/bin/ssh-keygen", "-lf", tmp.Name(), "-E", "sha256")
	if err != nil {
		return "", fmt.Errorf("the admin public key is not a valid OpenSSH key: %w", err)
	}
	fps := Fingerprints(out)
	if len(fps) != 1 {
		return "", errors.New("exactly one admin public key is expected")
	}
	return fps[0], nil
}

// installAdmin creates the admin account with the verified key,
// refusing any pre-existing account this tool did not create.
// Extra operator keys already in authorized_keys are kept when the
// declared key is present; the file is not rewritten in that case.
func (h *Hardener) installAdmin(ctx context.Context, publicKey string) (string, error) {
	key := strings.TrimSpace(publicKey)
	if !strings.HasPrefix(key, "ssh-ed25519 ") && !strings.HasPrefix(key, "sk-ssh-ed25519@openssh.com ") {
		return "", errors.New("--admin-key must be a single ssh-ed25519 public key")
	}
	fp, err := h.FingerprintOf(ctx, key)
	if err != nil {
		return "", err
	}
	authorized := "/home/" + layout.AdminUser + "/.ssh/authorized_keys"
	existing, err := h.Accounts.Get(ctx, layout.AdminUser)
	if err != nil {
		return "", err
	}
	keepExtraKeys := false
	if existing != nil {
		if !h.Guard.HasSnapshot("admin.created-by-bootstrap") || !fsx.Exists(authorized) {
			return "", errors.New("the admin account pre-exists and was not created by this tool; no existing identity is overwritten")
		}
		out, err := exec.Output(ctx, h.Runner, "/usr/bin/ssh-keygen", "-lf", authorized, "-E", "sha256")
		if err != nil {
			return "", err
		}
		fps := Fingerprints(out)
		if !ContainsFingerprint(fps, fp) {
			return "", errors.New("the existing admin account carries another identity; refusing to overwrite it")
		}
		keepExtraKeys = len(fps) > 1
	} else if err := h.Guard.Snapshot("admin.created-by-bootstrap"); err != nil {
		return "", err
	}
	info, err := h.Accounts.EnsureLoginUser(ctx, layout.AdminUser)
	if err != nil {
		return "", err
	}
	owner := fsx.Owner{UID: info.UID, GID: info.GID}
	if err := fsx.EnsureDir("/home/"+layout.AdminUser, 0o750, owner); err != nil {
		return "", err
	}
	if err := fsx.EnsureDir("/home/"+layout.AdminUser+"/.ssh", 0o700, owner); err != nil {
		return "", err
	}
	if !keepExtraKeys {
		if err := fsx.WriteAtomic(authorized, []byte(key+"\n"), 0o600, owner); err != nil {
			return "", err
		}
	}
	out, err := exec.Output(ctx, h.Runner, "/usr/bin/ssh-keygen", "-lf", authorized, "-E", "sha256")
	if err != nil {
		return "", err
	}
	if !ContainsFingerprint(Fingerprints(out), fp) {
		return "", errors.New("unexpected admin key on the host after installation")
	}
	return fp, nil
}

// installSudoLogging applies on every host: sudo writes a root-only log
// with host and year, rotated weekly.
func (h *Hardener) installSudoLogging(ctx context.Context) error {
	logging, err := render.SudoersLogging()
	if err != nil {
		return err
	}
	if err := h.installSudoersDropin(ctx, "81-hermes-logging", logging); err != nil {
		return err
	}
	if !fsx.Exists(h.SudoLog) {
		if err := fsx.WriteAtomic(h.SudoLog, nil, 0o600, fsx.Root); err != nil {
			return err
		}
	}
	rot, err := render.SudoLogrotate()
	if err != nil {
		return err
	}
	legacyOwned := h.Guard.HasSnapshot("sudoers.created-by-bootstrap") &&
		!h.Guard.HasSnapshot("80-hermes-admin.created-by-bootstrap") &&
		!h.Guard.HasSnapshot("81-hermes-logging.created-by-bootstrap")
	logrotateOwned := h.Guard.HasSnapshot("sudo-logrotate.created-by-bootstrap") || legacyOwned
	if current, err := os.ReadFile(h.SudoLogrotate); err == nil {
		if !logrotateOwned && string(current) != rot {
			return fmt.Errorf("%s pre-exists with another policy; refusing to overwrite it", h.SudoLogrotate)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := h.Guard.Snapshot("sudo-logrotate.created-by-bootstrap"); err != nil {
			return err
		}
	} else {
		return err
	}
	if err := writeIfChanged(h.SudoLogrotate, rot, 0o644); err != nil {
		return err
	}
	_, err = exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/visudo", Args: []string{"-cf", "/etc/sudoers"}})
	return err
}

// adminNoPasswd reads the sudo mode of the options and refuses a password
// mode without a password: hermes-admin would then hold a rule nobody can use.
func adminNoPasswd(o Options) (bool, error) {
	switch o.AdminSudo {
	case "", layout.AdminSudoPassword:
		if err := ValidAdminPassword(o.AdminPassword); err != nil {
			return false, err
		}
		return false, nil
	case layout.AdminSudoNoPasswd:
		return true, nil
	}
	return false, fmt.Errorf("--admin-sudo must be %s or %s", layout.AdminSudoPassword, layout.AdminSudoNoPasswd)
}

// installAdminSudoers grants the admin account sudo: with its own password
// (the default), or without one for --admin-sudo=nopasswd. The candidate goes
// through visudo -cf before it is published, then the whole policy does.
func (h *Hardener) installAdminSudoers(ctx context.Context, noPasswd bool) error {
	admin, err := render.SudoersAdmin(layout.AdminUser, noPasswd)
	if err != nil {
		return err
	}
	if err := h.installSudoersDropin(ctx, "80-hermes-admin", admin); err != nil {
		return err
	}
	_, err = exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/visudo", Args: []string{"-cf", "/etc/sudoers"}})
	return err
}

// installSudoersDropin validates a candidate with visudo before publishing
// it, refusing to overwrite a drop-in this tool did not create.
func (h *Hardener) installSudoersDropin(ctx context.Context, name, content string) error {
	g := h.Guard
	dst := "/etc/sudoers.d/" + name
	specific := name + ".created-by-bootstrap"
	legacyOwned := g.HasSnapshot("sudoers.created-by-bootstrap") &&
		!g.HasSnapshot("80-hermes-admin.created-by-bootstrap") &&
		!g.HasSnapshot("81-hermes-logging.created-by-bootstrap")
	owned := g.HasSnapshot(specific) || legacyOwned
	if fsx.Exists(dst) && !owned {
		if _, err := fsx.RequireRegular(dst, 0o440, fsx.Root); err != nil {
			return fmt.Errorf("pre-existing sudoers drop-in: %w", err)
		}
		current, err := os.ReadFile(dst)
		if err != nil {
			return err
		}
		if string(current) != content {
			return fmt.Errorf("%s pre-exists; no existing authorisation is overwritten", dst)
		}
	} else if !fsx.Exists(dst) {
		if err := g.Snapshot(specific); err != nil {
			return err
		}
		if err := g.Snapshot("sudoers.created-by-bootstrap"); err != nil {
			return err
		}
	}
	candidate := g.StatePath(name)
	if err := fsx.WriteAtomic(candidate, []byte(content), 0o440, fsx.Root); err != nil {
		return err
	}
	if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/visudo", Args: []string{"-cf", candidate}}); err != nil {
		return fmt.Errorf("sudoers candidate %s: %w", name, err)
	}
	if cur, err := os.ReadFile(dst); err == nil && string(cur) == content {
		return nil
	}
	return fsx.CopyFile(candidate, dst, 0o440, fsx.Root)
}

// captureQuarantine records the cloud-init account exactly as audited and
// refuses a state that drifted. Returns false when the account is absent
// (a homelab image without cloud-init).
func (h *Hardener) captureQuarantine(ctx context.Context, expectedKey string) (bool, string, error) {
	g := h.Guard
	q := layout.QuarantineUser
	info, err := h.Accounts.Get(ctx, q)
	if err != nil {
		return false, "", err
	}
	if info == nil {
		h.Log("no %s account: quarantine does not apply", q)
		return false, "", nil
	}
	authorized := "/home/" + q + "/.ssh/authorized_keys"
	if fsx.Exists(g.BackupPath("debian.manifest")) {
		kv, err := g.ReadMarker(g.BackupPath("debian.manifest"))
		if err != nil {
			return false, "", err
		}
		return true, kv["key_fingerprint"], nil
	}
	if !fsx.Exists(authorized) {
		return false, "", fmt.Errorf("%s exists without authorized_keys; refusing to quarantine an unaudited state", q)
	}
	out, err := exec.Output(ctx, h.Runner, "/usr/bin/ssh-keygen", "-lf", authorized, "-E", "sha256")
	if err != nil {
		return false, "", err
	}
	fps := Fingerprints(out)
	if len(fps) != 1 {
		return false, "", fmt.Errorf("%s carries %d keys, want exactly one", q, len(fps))
	}
	if expectedKey != "" && fps[0] != expectedKey {
		return false, "", fmt.Errorf("%s no longer matches the audited key; no automatic removal", q)
	}
	st, err := fsx.Lstat(layout.QuarantineSudoers)
	if err != nil {
		return false, "", err
	}
	if !st.Exists || !st.Regular || st.Symlink || st.Owner != fsx.Root || st.Mode != 0o440 {
		return false, "", fmt.Errorf("%s is not a root:root 0440 regular file", layout.QuarantineSudoers)
	}
	sudoers, _ := os.ReadFile(layout.QuarantineSudoers)
	if lines := SudoersActiveLines(string(sudoers)); len(lines) != 1 || lines[0] != layout.QuarantineSudoersLine {
		return false, "", fmt.Errorf("%s does not carry exactly %q", layout.QuarantineSudoers, layout.QuarantineSudoersLine)
	}
	pw, err := exec.Output(ctx, h.Runner, "/usr/bin/passwd", "-S", q)
	if err != nil {
		return false, "", err
	}
	if !PasswordLocked(pw) {
		return false, "", fmt.Errorf("%s has a usable password; the audited state expects a locked one", q)
	}
	groups, err := h.Accounts.Groups(ctx, q)
	if err != nil {
		return false, "", err
	}
	if err := g.Backup(authorized, "debian.authorized_keys"); err != nil {
		return false, "", err
	}
	if err := g.Backup(layout.QuarantineSudoers, "debian.sudoers"); err != nil {
		return false, "", err
	}
	manifest := fmt.Sprintf("user=%s\nshell=%s\ngroups=%s\npassword_status=%s\nkey_fingerprint=%s\n", q, info.Shell, strings.Join(groups, " "), pw, fps[0])
	if err := fsx.WriteAtomic(g.BackupPath("debian.manifest"), []byte(manifest), 0o600, fsx.Root); err != nil {
		return false, "", err
	}
	return true, fps[0], nil
}

// loopbackGuardUIDs is the closed set allowed to open the private loopback
// ports: root (the operator daemon, doctor) and the service user (gateway,
// connector). Any other uid is rejected by the guard.
func (h *Hardener) loopbackGuardUIDs(ctx context.Context) ([]int, error) {
	info, err := h.Accounts.Get(ctx, layout.ServiceUser)
	if err != nil {
		return nil, err
	}
	if info == nil {
		return nil, fmt.Errorf("service user %s does not exist", layout.ServiceUser)
	}
	return []int{0, info.UID}, nil
}

// mutationRunner adapts a mutation func (guarded or plain, already failing on
// a non-zero exit) to exec.Runner, so systemd.Client verbs keep running under
// the same guard as every other live mutation of the harden phase.
type mutationRunner func(exec.Cmd) error

// Run implements exec.Runner.
func (f mutationRunner) Run(_ context.Context, c exec.Cmd) (exec.Result, error) {
	return exec.Result{}, f(c)
}

// installLoopbackGuard renders and enables the oneshot unit that pins the
// owner-match rules at the head of OUTPUT. Idempotent: an unchanged unit is
// not rewritten, and the unit itself deletes before inserting.
func (h *Hardener) installLoopbackGuard(ctx context.Context, run func(exec.Cmd) error) error {
	uids, err := h.loopbackGuardUIDs(ctx)
	if err != nil {
		return err
	}
	unit, err := loopbackGuardUnit(uids)
	if err != nil {
		return err
	}
	path := h.LoopbackGuardPath
	if cur, err := os.ReadFile(path); err != nil || string(cur) != unit {
		if err := fsx.WriteAtomic(path, []byte(unit), 0o644, fsx.Root); err != nil {
			return err
		}
	}
	sd := systemd.Client{Runner: mutationRunner(run)}
	if err := sd.DaemonReload(ctx); err != nil {
		return err
	}
	// `restart` rather than `enable --now`: an already active oneshot with
	// RemainAfterExit is not re-run by start, and the rule set may have changed.
	if err := sd.Enable(ctx, layout.LoopbackGuardUnit+".service"); err != nil {
		return err
	}
	return sd.Restart(ctx, layout.LoopbackGuardUnit+".service")
}

// loopbackGuardUnit renders the unit for the uids allowed on the ports.
func loopbackGuardUnit(uids []int) (string, error) {
	var rules []string
	for _, rule := range LoopbackGuardRules(uids, LoopbackGuardPorts) {
		rules = append(rules, strings.Join(rule, " "))
	}
	return render.LoopbackGuardUnit(rules)
}

// EnsureLoopbackGuard installs the loopback guard on a host whose firewall is
// selected but whose OUTPUT chain does not carry the rules, or whose unit is
// not the one this build renders (a confinement added since). A host
// hardened by a build that predates the guard never received it, and a
// replayed `up` only enforces newly selected features. It reports whether it
// had to install.
func (h *Hardener) EnsureLoopbackGuard(ctx context.Context) (bool, error) {
	uids, err := h.loopbackGuardUIDs(ctx)
	if err != nil {
		return false, err
	}
	unit, err := loopbackGuardUnit(uids)
	if err != nil {
		return false, err
	}
	current, _ := os.ReadFile(h.LoopbackGuardPath)
	if out, err := exec.Output(ctx, h.Runner, "/usr/sbin/iptables", "-w", "-S", "OUTPUT"); err == nil && IptablesLoopbackGuarded(out, uids, LoopbackGuardPorts) && string(current) == unit {
		return false, nil
	}
	return true, h.installLoopbackGuard(ctx, func(c exec.Cmd) error {
		_, err := exec.Must(ctx, h.Runner, c)
		return err
	})
}

func (h *Hardener) installRollbackUnits(ctx context.Context) error {
	svc, err := render.HardeningRollbackService()
	if err != nil {
		return err
	}
	timer, err := render.HardeningRollbackTimer()
	if err != nil {
		return err
	}
	changed := false
	for path, content := range map[string]string{
		"/etc/systemd/system/" + layout.HardeningRollbackUnit + ".service": svc,
		"/etc/systemd/system/" + layout.HardeningRollbackUnit + ".timer":   timer,
	} {
		if cur, err := os.ReadFile(path); err == nil && string(cur) == content {
			continue
		}
		if err := fsx.WriteAtomic(path, []byte(content), 0o644, fsx.Root); err != nil {
			return err
		}
		changed = true
	}
	if changed {
		return h.Systemd.DaemonReload(ctx)
	}
	return nil
}

// Enforce applies the closing mutations under the guard. The last one is
// the sshd reload; if rollback won earlier, guard.Exec refuses it.
func (h *Hardener) Enforce(ctx context.Context, o Options) error {
	g := h.Guard
	if o.Guarded {
		if err := h.Systemd.RequireTimerWaiting(ctx, g.Timer()); err != nil {
			return err
		}
	}
	resolvedActive := false
	if o.Features.DisableLLMNR {
		var err error
		resolvedActive, err = h.Systemd.IsActive(ctx, "systemd-resolved")
		if err != nil {
			return err
		}
	}
	candidates := map[string]func() (string, error){}
	if o.Features.DisableLLMNR {
		candidates["resolved.candidate"] = render.ResolvedDropin
	}
	if o.Features.PasswordPolicy {
		candidates["pwquality.candidate"] = render.PwqualityDropin
	}
	if o.Features.Fail2Ban {
		candidates["fail2ban-sshd.candidate"] = h.renderFail2banJail
	}
	if o.Features.SSHHardening {
		candidates["sshd-hardening.candidate"] = func() (string, error) { return render.SSHDropin(layout.AdminUser) }
	}
	for name, fn := range candidates {
		content, err := fn()
		if err != nil {
			return err
		}
		if err := fsx.WriteAtomic(g.StatePath(name), []byte(content), 0o600, fsx.Root); err != nil {
			return err
		}
	}
	if o.Features.Firewall {
		def, err := os.ReadFile("/etc/default/ufw")
		if err != nil {
			return err
		}
		if err := fsx.WriteAtomic(g.StatePath("ufw.default.candidate"), []byte(SetIPv6Yes(string(def))), 0o600, fsx.Root); err != nil {
			return err
		}
	}
	var markers []string
	if o.Features.DisableLLMNR {
		markers = append(markers, "resolved-dropin")
	}
	if o.Features.PasswordPolicy {
		markers = append(markers, "pwquality-dropin")
	}
	if o.Features.Fail2Ban {
		markers = append(markers, "fail2ban-dropin")
	}
	for _, m := range markers {
		if err := g.Snapshot(m + ".created-by-bootstrap"); err != nil {
			return err
		}
	}
	if o.Features.SSHHardening {
		if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/sshd", Args: []string{"-T", "-f", g.StatePath("sshd-hardening.candidate")}}); err != nil {
			return fmt.Errorf("sshd candidate does not validate: %w", err)
		}
	}
	// From here every mutation is guarded. Without SSH hardening there is no
	// timer: the mutations below cannot lock anyone out, so run them plainly.
	run := func(c exec.Cmd) error {
		if o.Guarded {
			_, err := g.Exec(ctx, c)
			return err
		}
		_, err := exec.Must(ctx, h.Runner, c)
		return err
	}
	// Systemctl verbs go through the same (possibly guarded) mutation path.
	sd := systemd.Client{Runner: mutationRunner(run)}
	install := func(src, dst string, mode string) error {
		return run(exec.Cmd{Path: "/usr/bin/install", Args: []string{"-o", "root", "-g", "root", "-m", mode, src, dst}})
	}
	var dirs []string
	if o.Features.DisableLLMNR {
		dirs = append(dirs, filepath.Dir(h.ResolvedDropin))
	}
	if o.Features.PasswordPolicy {
		dirs = append(dirs, filepath.Dir(h.PwqualityDropin))
	}
	for _, d := range dirs {
		if err := run(exec.Cmd{Path: "/usr/bin/install", Args: []string{"-d", "-o", "root", "-g", "root", "-m", "0755", d}}); err != nil {
			return err
		}
	}
	if o.Features.DisableLLMNR {
		if err := install(g.StatePath("resolved.candidate"), h.ResolvedDropin, "0644"); err != nil {
			return err
		}
	}
	if o.Features.PasswordPolicy {
		if err := install(g.StatePath("pwquality.candidate"), h.PwqualityDropin, "0644"); err != nil {
			return err
		}
	}
	if o.Features.DisableLLMNR && resolvedActive {
		if err := sd.TryRestart(ctx, "systemd-resolved"); err != nil {
			return err
		}
	}
	ufw := func(args ...string) error {
		c := exec.Cmd{Path: "/usr/sbin/ufw", Args: args, Env: []string{"LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}}
		return run(c)
	}
	if o.Features.Firewall {
		wasActive := g.HasSnapshot("ufw.was-active")
		existing := map[string]bool{}
		status, err := h.ufw(ctx, "status", "verbose")
		if err != nil || status.ExitCode != 0 {
			return errors.New("cannot read UFW immediately before applying the declared policy")
		}
		for _, rule := range UFWAllowedInPorts(status.Stdout) {
			existing[rule] = true
		}
		resolvers, err := h.metadataResolvers()
		if err != nil {
			return err
		}
		if !wasActive {
			if err := install(g.StatePath("ufw.default.candidate"), "/etc/default/ufw", "0644"); err != nil {
				return err
			}
			for _, p := range [][]string{{"deny", "incoming"}, {"deny", "routed"}, {"allow", "outgoing"}} {
				if err := ufw("default", p[0], p[1]); err != nil {
					return err
				}
			}
		}
		// Explicit denies are matched before the default policy. A resolver
		// inside a denied range keeps DNS through an allow above its deny.
		if err := h.denyMetadataEgress(status.Stdout, resolvers, ufw); err != nil {
			return err
		}
		for _, rule := range o.Features.AllowedInbound {
			if existing[rule] {
				continue
			}
			if err := ufw("allow", rule, "comment", "Hermes-managed"); err != nil {
				return err
			}
		}
		if !wasActive {
			if err := ufw("logging", "low"); err != nil {
				return err
			}
			if err := ufw("--force", "enable"); err != nil {
				return err
			}
		}
		if err := h.installLoopbackGuard(ctx, run); err != nil {
			return err
		}
	}
	if o.Features.Fail2Ban {
		if err := install(g.StatePath("fail2ban-sshd.candidate"), h.Fail2banJail, "0644"); err != nil {
			return err
		}
		if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/bin/fail2ban-client", Args: []string{"-t"}}); err != nil {
			return err
		}
		if err := sd.Enable(ctx, "fail2ban"); err != nil {
			return err
		}
		if err := sd.Restart(ctx, "fail2ban"); err != nil {
			return err
		}
	}
	if o.Features.PasswordPolicy {
		pam, err := os.ReadFile("/etc/pam.d/common-password")
		if err != nil {
			return err
		}
		if err := PAMGate(string(pam)); err != nil {
			return err
		}
	}
	if o.Features.DisableLLMNR {
		ss, err := exec.Output(ctx, h.Runner, "/usr/bin/ss", "-H", "-ltnup")
		if err != nil {
			return err
		}
		if ListenerOnPort(ss, 5355) {
			return errors.New("an LLMNR listener on :5355 remains after hardening")
		}
	}
	if o.Features.QuarantineCloudUser && fsx.Exists(g.BackupPath("debian.manifest")) {
		q := layout.QuarantineUser
		groups, err := h.Accounts.Groups(ctx, q)
		if err != nil {
			return err
		}
		if HasGroup(groups, "sudo") {
			if err := run(exec.Cmd{Path: "/usr/bin/gpasswd", Args: []string{"-d", q, "sudo"}}); err != nil {
				return err
			}
		}
		if err := run(exec.Cmd{Path: "/usr/sbin/usermod", Args: []string{"--lock", "--shell", "/usr/sbin/nologin", q}}); err != nil {
			return err
		}
		for _, p := range []string{"/home/" + q + "/.ssh/authorized_keys", layout.QuarantineSudoers} {
			if err := run(exec.Cmd{Path: "/bin/rm", Args: []string{"-f", "--", p}}); err != nil {
				return err
			}
		}
		if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/visudo", Args: []string{"-cf", "/etc/sudoers"}}); err != nil {
			return err
		}
	}
	if o.Features.SSHHardening {
		if err := install(g.StatePath("sshd-hardening.candidate"), h.SSHDropin, "0644"); err != nil {
			return err
		}
		if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/sshd", Args: []string{"-t"}}); err != nil {
			return err
		}
		if err := sd.Reload(ctx, "ssh"); err != nil {
			return err
		}
		if noPasswd, err := adminNoPasswd(o); err != nil || noPasswd {
			return err
		}
		return h.setAdminPassword(ctx, run, o.AdminPassword)
	}
	return nil
}

// setAdminPassword gives hermes-admin its sudo password, last, once the
// reloaded sshd refuses passwords: the account never holds a password while
// SSH could still accept one. If anything here fails, sudo stays unusable for
// hermes-admin, verify-access cannot run and the rollback timer restores the
// previous access: a missing password cannot lock the host.
func (h *Hardener) setAdminPassword(ctx context.Context, run func(exec.Cmd) error, password string) error {
	if err := ValidAdminPassword(password); err != nil {
		return err
	}
	out, err := exec.Output(ctx, h.Runner, "/usr/sbin/sshd", "-T", "-C", "user="+layout.AdminUser+",host=localhost,addr=127.0.0.1")
	if err != nil {
		return err
	}
	if err := RequireSSHDHardened(SSHDEffective(out), layout.AdminUser); err != nil {
		return fmt.Errorf("refusing to give %s a password while sshd may accept it: %w", layout.AdminUser, err)
	}
	err = run(exec.Cmd{Path: "/usr/sbin/chpasswd", Stdin: []byte(layout.AdminUser + ":" + password + "\n")})
	if err != nil {
		// chpasswd does not echo its input, but an error must never carry it.
		return fmt.Errorf("set the sudo password of %s: %s", layout.AdminUser, strings.ReplaceAll(err.Error(), password, "[redacted]"))
	}
	return nil
}

// ValidAdminPassword is the floor this tool enforces before chpasswd (and,
// with --password-policy, pam_pwquality) sees it: one line of
// layout.PasswordMinLength to 256 characters without control characters. The
// floor is the password policy's minlen, so a password accepted here is not
// refused by pam_pwquality halfway through the transaction for its length.
func ValidAdminPassword(p string) error {
	n := utf8.RuneCountInString(p)
	if n < layout.PasswordMinLength || len(p) > 256 || !utf8.ValidString(p) {
		return fmt.Errorf("the sudo password of %s must be %d to 256 characters", layout.AdminUser, layout.PasswordMinLength)
	}
	for _, r := range p {
		if unicode.IsControl(r) {
			return fmt.Errorf("the sudo password of %s must not contain control characters", layout.AdminUser)
		}
	}
	return nil
}

// SetIPv6Yes rewrites IPV6= in /etc/default/ufw content.
func SetIPv6Yes(content string) string {
	lines := strings.Split(content, "\n")
	found := false
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "IPV6=") {
			lines[i] = "IPV6=yes"
			found = true
		}
	}
	out := strings.Join(lines, "\n")
	if !found {
		if !strings.HasSuffix(out, "\n") {
			out += "\n"
		}
		out += "IPV6=yes\n"
	}
	return out
}

// Finalize proves the closed state. It does not commit: verify-access does,
// from the fresh session, before calling this.
func (h *Hardener) Finalize(ctx context.Context, o Options, adminKeyFingerprint string) error {
	if o.Features.SSHHardening {
		out, err := exec.Output(ctx, h.Runner, "/usr/sbin/sshd", "-T")
		if err != nil {
			return err
		}
		if err := RequireSSHDHardened(SSHDEffective(out), layout.AdminUser); err != nil {
			return err
		}
		keys, err := exec.Output(ctx, h.Runner, "/usr/bin/ssh-keygen", "-lf", "/home/"+layout.AdminUser+"/.ssh/authorized_keys", "-E", "sha256")
		if err != nil {
			return err
		}
		if !ContainsFingerprint(Fingerprints(keys), adminKeyFingerprint) {
			return errors.New("the admin account does not carry the verified key")
		}
	}
	if o.Features.QuarantineCloudUser && fsx.Exists(h.Guard.BackupPath("debian.manifest")) {
		q := layout.QuarantineUser
		info, err := h.Accounts.Get(ctx, q)
		if err != nil {
			return err
		}
		groups, err := h.Accounts.Groups(ctx, q)
		if err != nil {
			return err
		}
		if info == nil || info.Shell != "/usr/sbin/nologin" || HasGroup(groups, "sudo") || fsx.Exists("/home/"+q+"/.ssh/authorized_keys") || fsx.Exists(layout.QuarantineSudoers) {
			return fmt.Errorf("%s is not quarantined (shell, sudo group, key or sudoers still present)", q)
		}
	}
	if o.Features.Firewall {
		status, err := h.ufw(ctx, "status", "verbose")
		if err != nil {
			return err
		}
		if !UFWStatusActive(status.Stdout) {
			return errors.New("UFW is not active")
		}
		plain, err := h.ufw(ctx, "status")
		if err != nil {
			return err
		}
		if err := RequireExactRules(UFWAllowedInPorts(plain.Stdout), o.Features.AllowedInbound); err != nil {
			return err
		}
		for _, p := range []string{"8642", "9119"} {
			if strings.Contains(status.Stdout, p) {
				return fmt.Errorf("UFW mentions private port %s", p)
			}
		}
		for _, n := range layout.EgressDenyNetworks {
			if !UFWDeniesOut(status.Stdout, n) {
				return fmt.Errorf("egress to %s (cloud metadata) is not denied in the final UFW policy", n)
			}
		}
		resolvers, err := h.metadataResolvers()
		if err != nil {
			return err
		}
		// A policy enforced by a build that predates the exception gets it
		// here, above its deny; Finalize fails only if that repair does.
		if _, err := h.restoreResolverException(ctx, status.Stdout, resolvers); err != nil {
			return err
		}
		for _, bin := range []string{"/usr/sbin/iptables", "/usr/sbin/ip6tables"} {
			out, err := exec.Output(ctx, h.Runner, bin, "-S")
			if err != nil {
				return err
			}
			if !IptablesInputDrop(out) {
				return fmt.Errorf("%s: INPUT policy is not DROP", bin)
			}
		}
		uids, err := h.loopbackGuardUIDs(ctx)
		if err != nil {
			return err
		}
		out, err := exec.Output(ctx, h.Runner, "/usr/sbin/iptables", "-w", "-S", "OUTPUT")
		if err != nil {
			return err
		}
		if !IptablesLoopbackGuarded(out, uids, LoopbackGuardPorts) {
			return fmt.Errorf("the loopback guard (%s) does not reserve ports %v for the service user and root", layout.LoopbackGuardUnit, LoopbackGuardPorts)
		}
	}
	if o.Features.Fail2Ban {
		f2b, err := exec.Output(ctx, h.Runner, "/usr/bin/fail2ban-client", "status", "sshd")
		if err != nil {
			return err
		}
		if !strings.Contains(f2b, "Currently banned") && !strings.Contains(f2b, "File list") && !strings.Contains(f2b, "Journal matches") {
			return errors.New("the fail2ban sshd jail is not active")
		}
	}
	if o.Features.DisableLLMNR {
		ss, err := exec.Output(ctx, h.Runner, "/usr/bin/ss", "-H", "-ltnup")
		if err != nil {
			return err
		}
		if ListenerOnPort(ss, 5355) {
			return errors.New("an LLMNR listener on :5355 is still exposed")
		}
	}
	if o.Features.PasswordPolicy {
		pam, err := os.ReadFile("/etc/pam.d/common-password")
		if err != nil {
			return err
		}
		if err := PAMGate(string(pam)); err != nil {
			return err
		}
		dropins := map[string]string{}
		for _, dir := range []string{"/usr/lib/security/pwquality.conf.d", "/etc/security/pwquality.conf.d"} {
			for _, p := range globConf(dir) {
				data, err := os.ReadFile(p)
				if err == nil {
					dropins[filepath.Base(p)] = string(data)
				}
			}
		}
		main := ""
		for _, p := range []string{"/etc/security/pwquality.conf", "/usr/lib/security/pwquality.conf"} {
			if data, err := os.ReadFile(p); err == nil {
				main = string(data)
				break
			}
		}
		managed, err := os.ReadFile(h.PwqualityDropin)
		if err != nil {
			return err
		}
		if err := RequirePwquality(EffectivePwquality(dropins, main), string(managed), layout.PasswordMinLength); err != nil {
			return err
		}
	}
	if o.Features.UnattendedUpgrades {
		for _, t := range []string{"apt-daily.timer", "apt-daily-upgrade.timer"} {
			enabled, err := h.Systemd.IsEnabled(ctx, t)
			if err != nil {
				return err
			}
			if !enabled {
				return fmt.Errorf("%s is not enabled", t)
			}
		}
	}
	if o.Features.SudoLogging {
		if _, err := fsx.RequireRegular(h.SudoLog, 0o600, fsx.Root); err != nil {
			return fmt.Errorf("sudo log: %w", err)
		}
		if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/visudo", Args: []string{"-cf", "/etc/sudoers"}}); err != nil {
			return err
		}
		if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/logrotate", Args: []string{"-d", h.SudoLogrotate}}); err != nil {
			return err
		}
	}
	return nil
}
