// Package reset removes everything edge-setup installed, in an order
// that never closes access, and optionally purges the namespace of the
// previous tool (`--legacy`). A plan is printed before anything moves.
package reset

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/apt"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hardening"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/proxy"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// Options select the depth of the reset.
type Options struct {
	PurgeData        bool
	DataLossAccepted bool
	PurgePackages    bool
	Legacy           bool
	// PurgeTailscale removes the tailscale package and its firewall rules.
	// It is separate from Legacy: on a homelab, tailscale is often the
	// operator's own way in, and reset must never close the door behind it.
	PurgeTailscale   bool
	RemoveAdmin      bool
	RestoreCloudUser bool
	Plan             bool
}

// Units removed (stop, disable, unit file deleted).
var Units = []string{
	layout.ConnectorUnit + ".service",
	layout.ConnectorTemplateUnit + ".service",
	layout.OperatorUnit + ".service",
	layout.GatewayUnit + ".service",
	layout.LoopbackGuardUnit + ".service",
	layout.ProxyRollbackUnit + ".timer", layout.ProxyRollbackUnit + ".service",
	layout.HardeningRollbackUnit + ".timer", layout.HardeningRollbackUnit + ".service",
	layout.AutoUpgradeUnit + ".timer", layout.AutoUpgradeUnit + ".service",
}

// RuntimePaths are removed unconditionally (no data inside).
var RuntimePaths = []string{
	layout.InstallDir, layout.UVRoot, layout.BootstrapHome, layout.PythonInstall, "/var/cache/hermes",
	layout.InstallerPath, layout.UVArchivePath(), layout.LegacyDownloadPaths[0], layout.LegacyDownloadPaths[1],
	"/etc/systemd/system/user@.service.d/delegate.conf", layout.DockerModulesLoad,
	// The operator unit keeps its RuntimeDirectory across restarts
	// (RuntimeDirectoryPreserve=yes), so stopping it no longer empties the
	// directory: the socket and the gateway restart marker would outlive a
	// reset or an uninstall until the next boot.
	layout.OperatorRunDir,
}

// StatePaths are the tool's own state.
var StatePaths = []string{
	layout.HardeningStateDir, layout.HardeningBackupDir, layout.ProxyStateDir, "/var/lib/hermes-runtime",
	layout.AuditDir, "/var/lib/hermes", layout.ConnectorStateDir, layout.ToolStateDir, "/etc/hermes",
	filepath.Join(layout.OperatorStateDir, "skills-hub-operations"),
}

// DataPaths hold the bearer and the workspaces: only with --purge-data.
var DataPaths = []string{layout.RuntimeRoot, "/srv/hermes", "/home/" + layout.ServiceUser}

// ToolPathEntries are the tool's names on the PATH, outside ToolInstallDir:
// the links `up` and `upgrade` keep there, and the copies the install script
// or an operator put there (`upgrade` refreshes those as its own). Run
// removes each one, except a file the edge-setup package owns: apt removes
// those, and deleting them behind dpkg's back would break its record.
var ToolPathEntries = append(append([]string{}, layout.ToolPathCopies...), layout.ToolLegacyPathCopies...)

// PackageFileList is dpkg's list of the files the edge-setup package owns.
var PackageFileList = "/var/lib/dpkg/info/edge-setup.list"

// Packages purged with --purge-packages.
var Packages = pins.DockerPackageNames()

// PackageFiles removed with --purge-packages.
var PackageFiles = []string{"/etc/apt/sources.list.d/docker.sources", "/etc/apt/keyrings/docker.asc"}

// LegacyPaths are the previous tool's namespace.
var LegacyPaths = []string{
	"/etc/ssh/sshd_config.d/00-openhermesbot-hardening.conf",
	"/etc/security/pwquality.conf.d/90-openhermesbot-hardening.conf",
	"/etc/systemd/resolved.conf.d/90-openhermesbot-hardening.conf",
	"/etc/apt/apt.conf.d/52-openhermesbot-unattended",
	"/etc/sudoers.d/81-openhermesbot-logging",
	"/etc/logrotate.d/openhermesbot-sudo",
	"/var/lib/openhermesbot-host-hardening", "/var/lib/openhermesbot", "/var/lib/openhermesbot-runtime",
	"/var/backups/openhermesbot-access", "/var/cache/openhermesbot",
	"/usr/local/lib/openhermesbot-uv", "/usr/local/lib/openhermesbot-bootstrap", "/usr/local/share/openhermesbot-python",
	"/etc/openhermesbot", "/run/hermes-tailnet", "/etc/hermes/hermes-mtls",
}

// LegacyUnits are the previous tool's units and the abandoned tailnet.
var LegacyUnits = []string{
	"openhermesbot-hardening-rollback.timer", "openhermesbot-hardening-rollback.service",
	"openhermesbot-hermes-proxy-rollback.timer", "openhermesbot-hermes-proxy-rollback.service",
	"tailscaled.service",
}

// removeFile deletes one restored access file; tests record the paths.
var removeFile = fsx.Remove

// ufwInstalled reports whether the ufw binary is on the host; tests replace it.
var ufwInstalled = func() bool { return fsx.Exists("/usr/sbin/ufw") }

// Resetter carries dependencies.
type Resetter struct {
	Runner   exec.Runner
	Systemd  systemd.Client
	Apt      apt.Client
	Accounts account.Client
	Guard    *guard.Guard
	Out      func(string, ...any)
	SudoUser string
}

// New wires a resetter.
func New(r exec.Runner, out func(string, ...any)) *Resetter {
	return &Resetter{Runner: r, Systemd: systemd.Client{Runner: r}, Apt: apt.New(r), Accounts: account.New(r), Guard: guard.Default(r), Out: out, SudoUser: os.Getenv("SUDO_USER")}
}

// Plan lists what Run would do.
func (r *Resetter) Plan(o Options) []string {
	var steps []string
	steps = append(steps, "stop, disable and remove units: "+strings.Join(Units, ", "))
	steps = append(steps, "delete the iptables OUTPUT rules of "+layout.LoopbackGuardUnit+".service (loopback ports "+loopbackGuardPortList()+"): reopens them to local users, never closes SSH")
	steps = append(steps, "remove old hermes-managed caddy only when its Caddyfile carries the hermes-setup marker; keep third-party Caddy")
	steps = append(steps, "disable the rootless docker of "+layout.ServiceUser+" (systemctl --user, linger, subuid/subgid, delegate.conf, nf_tables modules-load entry)")
	steps = append(steps, "restore access files from backups: sshd drop-in, UFW (4 files) or disable UFW, fail2ban jail, resolved/pwquality drop-ins, sudoers logging drop-in, logrotate, apt drop-ins; then visudo -cf")
	if o.RemoveAdmin {
		steps = append(steps, "remove the "+layout.AdminUser+" account and its sudoers file "+layout.SudoersAdmin+", then visudo -cf (refused from the "+layout.AdminUser+" session)")
	} else {
		steps = append(steps, "keep the "+layout.AdminUser+" account and its sudoers file "+layout.SudoersAdmin+" (removed only with --remove-admin, or if the account no longer exists)")
	}
	if o.RestoreCloudUser {
		steps = append(steps, "restore the quarantined "+layout.QuarantineUser+" account from backups")
	}
	steps = append(steps, "remove runtime files: "+strings.Join(RuntimePaths, ", "))
	steps = append(steps, "remove state: "+strings.Join(StatePaths, ", "))
	if o.PurgeData {
		steps = append(steps, "PURGE DATA (bearer, workspaces): "+strings.Join(DataPaths, ", "))
	}
	if o.PurgePackages {
		steps = append(steps, "purge packages: "+strings.Join(Packages, ", ")+" and "+strings.Join(PackageFiles, ", "))
	}
	steps = append(steps, "remove obsolete connector account "+layout.LegacyConnectorUser+(map[bool]string{true: " and service account " + layout.ServiceUser, false: "; keep service account " + layout.ServiceUser}[o.PurgeData]))
	if o.Legacy {
		legacy := "purge the legacy namespace: units " + strings.Join(LegacyUnits, ", ") + "; paths " + strings.Join(LegacyPaths, ", ") + "; group hermes_runtime; /root/hermes-rename-*"
		if o.PurgeTailscale {
			legacy += "; package tailscale; UFW rules 41641/udp and tailscale0"
		} else {
			legacy += " (tailscale is kept; --purge-tailscale to remove it)"
		}
		steps = append(steps, legacy)
	}
	steps = append(steps, "remove the installed copy "+layout.ToolInstalledPath)
	steps = append(steps, "remove the tool's PATH names (link or copy): "+strings.Join(ToolPathEntries, ", ")+"; keep those the edge-setup package owns (apt remove edge-setup)")
	return steps
}

// Run performs the reset.
func (r *Resetter) Run(ctx context.Context, o Options) error {
	if o.PurgeData && !o.DataLossAccepted {
		return errors.New("--purge-data destroys the bearer and every workspace; add --i-understand-data-loss")
	}
	g := r.Guard
	if fsx.Exists(g.Active()) || fsx.Exists(layout.ProxyActive) {
		return errors.New("a hardening or proxy transaction is active; wait for its commit or rollback before resetting")
	}
	if o.Plan {
		for _, s := range r.Plan(o) {
			r.Out("  - %s", s)
		}
		return nil
	}
	// Refused before anything moves: once the sudoers file is gone, the
	// session asking for the reset has no way back to root.
	if o.RemoveAdmin && r.SudoUser == layout.AdminUser {
		return errors.New("refusing to remove " + layout.AdminUser + " from its own session")
	}
	// 1. Units. Named connector instances are stopped through their glob:
	// only loaded units match it, which is exactly the running ones.
	_ = r.Systemd.Stop(ctx, layout.ConnectorTemplateUnit+"*")
	for _, u := range Units {
		_ = r.Systemd.Stop(ctx, u)
		_ = r.Systemd.Disable(ctx, u)
		_ = fsx.Remove("/etc/systemd/system/" + u)
	}
	// The guard rules outlive the stopped unit: delete them while the service
	// account still exists, its uid is part of the rule specs.
	r.removeLoopbackGuardRules(ctx)
	// 2. Rootless docker.
	if info, _ := r.Accounts.Get(ctx, layout.ServiceUser); info != nil {
		_, _ = r.Runner.Run(ctx, account.AsUser(layout.ServiceUser, []string{"XDG_RUNTIME_DIR=" + fmt.Sprintf("/run/user/%d", info.UID), "DBUS_SESSION_BUS_ADDRESS=" + fmt.Sprintf("unix:path=/run/user/%d/bus", info.UID), "PATH=/usr/bin:/bin"}, "systemctl", "--user", "disable", "--now", "docker.service"))
		_ = os.RemoveAll("/home/" + layout.ServiceUser + "/.config/docker")
		_ = os.RemoveAll("/home/" + layout.ServiceUser + "/.config/systemd")
		_, _ = r.Runner.Run(ctx, exec.Cmd{Path: "/usr/bin/loginctl", Args: []string{"disable-linger", layout.ServiceUser}})
		_ = r.Systemd.Stop(ctx, fmt.Sprintf("user@%d.service", info.UID))
	}
	for _, p := range []string{"/etc/subuid", "/etc/subgid"} {
		if data, err := os.ReadFile(p); err == nil {
			var keep []string
			for _, l := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
				if l != "" && !strings.HasPrefix(l, layout.ServiceUser+":") {
					keep = append(keep, l)
				}
			}
			_ = fsx.WriteAtomic(p, []byte(strings.Join(keep, "\n")+"\n"), 0o644, fsx.Root)
		}
	}
	// 3. Access: restore, never close.
	h := hardening.New(r.Runner, nil)
	h.Guard, h.Accounts = g, r.Accounts
	if err := r.restoreAccess(ctx, h, o); err != nil {
		return err
	}
	// 4–5. Files and state.
	r.removeManagedCaddyfile(ctx)
	for _, p := range RuntimePaths {
		_ = os.RemoveAll(p)
	}
	for _, u := range []string{"docker.socket", "docker.service", "containerd.service"} {
		_ = r.Systemd.Unmask(ctx, u)
	}
	if o.PurgeData {
		for _, p := range DataPaths {
			_ = os.RemoveAll(p)
		}
	}
	if o.PurgePackages {
		_ = r.Apt.Unhold(ctx, Packages...)
		_ = r.Apt.Purge(ctx, Packages...)
		for _, p := range PackageFiles {
			_ = fsx.Remove(p)
		}
	}
	if o.Legacy {
		r.purgeLegacy(ctx, o.PurgeTailscale)
	}
	for _, p := range StatePaths {
		_ = os.RemoveAll(p)
	}
	// 8. Accounts.
	if info, _ := r.Accounts.Get(ctx, layout.LegacyConnectorUser); info != nil {
		_ = r.Accounts.Delete(ctx, layout.LegacyConnectorUser)
	}
	if o.PurgeData {
		if info, _ := r.Accounts.Get(ctx, layout.ServiceUser); info != nil {
			_ = r.Accounts.Delete(ctx, layout.ServiceUser)
		}
	}
	_ = r.Systemd.DaemonReload(ctx)
	_ = os.RemoveAll(layout.ToolInstallDir)
	for _, p := range RemoveToolPathEntries(ToolPathEntries, PackageFileList) {
		r.Out("kept %s: owned by the edge-setup package; remove it with apt remove edge-setup", p)
	}
	return nil
}

// RemoveToolPathEntries deletes each path that is a link or a regular file,
// and returns the ones it kept because the package file list names them.
func RemoveToolPathEntries(paths []string, packageList string) []string {
	owned := packageOwned(packageList)
	var kept []string
	for _, p := range paths {
		st, err := fsx.Lstat(p)
		if err != nil || !st.Exists || !(st.Symlink || st.Regular) {
			continue
		}
		if owned[p] {
			kept = append(kept, p)
			continue
		}
		_ = removeFile(p)
	}
	return kept
}

// packageOwned reads a dpkg file list; a missing list means no package.
func packageOwned(list string) map[string]bool {
	owned := map[string]bool{}
	data, err := os.ReadFile(list)
	if err != nil {
		return owned
	}
	for _, l := range strings.Split(string(data), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			owned[filepath.Clean(l)] = true
		}
	}
	return owned
}

func (r *Resetter) restoreAccess(ctx context.Context, h *hardening.Hardener, o Options) error {
	g := r.Guard
	sshManaged := g.HasSnapshot("ssh-dropin.was-absent") || fsx.Exists(g.BackupPath("ssh-dropin.original"))
	if sshManaged && fsx.Exists(layout.SSHDropin) {
		if fsx.Exists(g.BackupPath("ssh-dropin.original")) {
			_ = fsx.CopyFile(g.BackupPath("ssh-dropin.original"), layout.SSHDropin, 0o644, fsx.Root)
		} else {
			_ = fsx.Remove(layout.SSHDropin)
		}
		if _, err := exec.Must(ctx, r.Runner, exec.Cmd{Path: "/usr/sbin/sshd", Args: []string{"-t"}}); err != nil {
			return fmt.Errorf("sshd configuration invalid after removing the drop-in; not reloading: %w", err)
		}
		_ = r.Systemd.Reload(ctx, "ssh")
	}
	if g.HasSnapshot("fail2ban-dropin.created-by-bootstrap") {
		_ = fsx.Remove(layout.Fail2banJail)
	}
	if g.HasSnapshot("fail2ban.was-inactive") {
		_ = r.Systemd.Stop(ctx, "fail2ban")
		_ = r.Systemd.Disable(ctx, "fail2ban")
	} else if g.HasSnapshot("fail2ban.was-active") {
		_ = r.Systemd.EnableNow(ctx, "fail2ban")
	}
	backupsOK := true
	for _, name := range []string{"ufw.default", "ufw.conf", "ufw.user.rules", "ufw.user6.rules"} {
		if !fsx.Exists(g.BackupPath(name)) {
			backupsOK = false
		}
	}
	ufw := func(args ...string) {
		_, _ = r.Runner.Run(ctx, exec.Cmd{Path: "/usr/sbin/ufw", Args: args, Env: []string{"LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}})
	}
	ufwManaged := g.HasSnapshot("ufw.was-active") || g.HasSnapshot("ufw.was-inactive") || backupsOK
	if ufwInstalled() && ufwManaged {
		if !backupsOK {
			// No backup: delete only the rules we tagged. While UFW is active:
			// a disabled firewall lists no rule, and nothing would be found.
			if out, err := exec.Output(ctx, r.Runner, "/usr/sbin/ufw", "status", "numbered"); err == nil {
				for _, n := range managedRuleNumbers(out) {
					ufw("--force", "delete", n)
				}
			}
		}
		ufw("--force", "disable")
		if backupsOK {
			_ = fsx.CopyFile(g.BackupPath("ufw.default"), "/etc/default/ufw", 0o644, fsx.Root)
			_ = fsx.CopyFile(g.BackupPath("ufw.conf"), "/etc/ufw/ufw.conf", 0o644, fsx.Root)
			_ = fsx.CopyFile(g.BackupPath("ufw.user.rules"), "/etc/ufw/user.rules", 0o640, fsx.Root)
			_ = fsx.CopyFile(g.BackupPath("ufw.user6.rules"), "/etc/ufw/user6.rules", 0o640, fsx.Root)
		}
		if g.HasSnapshot("ufw.was-active") {
			ufw("--force", "enable")
		}
	}
	admin, _ := r.Accounts.Get(ctx, layout.AdminUser)
	resolvedRemoved := false
	for _, p := range accessFilesToRemove(g, o, admin != nil) {
		_ = removeFile(p)
		if p == layout.ResolvedDropin {
			resolvedRemoved = true
		}
	}
	r.removeCreatedAutoUpgrades(g)
	if resolvedRemoved {
		if active, _ := r.Systemd.IsActive(ctx, "systemd-resolved"); active {
			_ = r.Systemd.Restart(ctx, "systemd-resolved")
		}
	}
	r.checkSudoers(ctx)
	// Run refuses an active transaction, so Rollback would only answer
	// "not-armed" or "already-finalized" here: the account is restored
	// directly. A failure stops the reset before --remove-admin and before the
	// backups are deleted, so neither the last way in nor the means to rebuild
	// it is lost.
	if o.RestoreCloudUser {
		if !fsx.Exists(g.BackupPath("debian.manifest")) {
			r.Out("no backup of the %s account in %s: nothing to restore", layout.QuarantineUser, g.BackupDir)
		} else if err := h.RestoreCloudUser(ctx); err != nil {
			return fmt.Errorf("restoring the %s account failed, backups in %s are kept: %w", layout.QuarantineUser, g.BackupDir, err)
		} else {
			r.Out("restored the %s account from %s", layout.QuarantineUser, g.BackupDir)
		}
	}
	if o.RemoveAdmin && admin != nil {
		// The account goes first: a sudoers entry naming a missing user is
		// harmless, an existing admin without sudo is a lockout.
		_ = r.Accounts.Delete(ctx, layout.AdminUser)
		_ = removeFile(layout.SudoersAdmin)
		r.checkSudoers(ctx)
	}
	return nil
}

// accessFilesToRemove lists the drop-ins reset deletes. The admin sudoers
// file follows the admin account: reset restores access and never closes
// it, so hermes-admin keeps sudo unless --remove-admin deletes the account
// itself (the file is then removed with it, see restoreAccess). An orphan
// file, whose account no longer exists, is removed like any other drop-in.
func accessFilesToRemove(g *guard.Guard, o Options, adminExists bool) []string {
	var paths []string
	if g.HasSnapshot("resolved-dropin.created-by-bootstrap") {
		paths = append(paths, layout.ResolvedDropin)
	}
	if g.HasSnapshot("pwquality-dropin.created-by-bootstrap") {
		paths = append(paths, layout.PwqualityDropin)
	}
	legacySudo := g.HasSnapshot("sudoers.created-by-bootstrap") &&
		!g.HasSnapshot("80-hermes-admin.created-by-bootstrap") &&
		!g.HasSnapshot("81-hermes-logging.created-by-bootstrap")
	if g.HasSnapshot("81-hermes-logging.created-by-bootstrap") || legacySudo {
		paths = append(paths, layout.SudoersLogging)
	}
	if g.HasSnapshot("sudo-logrotate.created-by-bootstrap") || legacySudo {
		paths = append(paths, layout.SudoLogrotate)
	}
	if g.HasSnapshot(hardening.SnapUnattendedCreated) {
		paths = append(paths, layout.AptUnattended)
	}
	adminOwned := g.HasSnapshot("admin.created-by-bootstrap") ||
		g.HasSnapshot("80-hermes-admin.created-by-bootstrap") || legacySudo
	if !adminExists && adminOwned {
		paths = append(paths, layout.SudoersAdmin)
	}
	return paths
}

// loopbackGuardPortList renders the guarded ports for the plan.
func loopbackGuardPortList() string {
	var ports []string
	for _, p := range hardening.LoopbackGuardPorts {
		ports = append(ports, strconv.Itoa(p))
	}
	return strings.Join(ports, ", ")
}

// removeLoopbackGuardRules deletes the owner-match rules the guard unit
// inserted into OUTPUT. Failures are ignored: a rule already gone is fine,
// and removing them only reopens loopback ports to local users.
func (r *Resetter) removeLoopbackGuardRules(ctx context.Context) {
	uids := []int{0}
	if info, _ := r.Accounts.Get(ctx, layout.ServiceUser); info != nil {
		uids = append(uids, info.UID)
	}
	for _, rule := range hardening.LoopbackGuardRules(uids, hardening.LoopbackGuardPorts) {
		args := append([]string{"-w", "-D", "OUTPUT"}, rule...)
		_, _ = r.Runner.Run(ctx, exec.Cmd{Path: "/usr/sbin/iptables", Args: args})
	}
}

// removeManagedCaddyfile deletes /etc/caddy/Caddyfile only when this tool
// wrote it. `up` refuses to replace a customer's reverse proxy; reset must
// not delete one either.
func (r *Resetter) removeManagedCaddyfile(ctx context.Context) {
	info, err := fsx.Lstat(layout.Caddyfile)
	if err != nil || !info.Exists || !info.Regular || info.Symlink {
		return
	}
	data, err := os.ReadFile(layout.Caddyfile)
	if err != nil {
		return
	}
	if !strings.HasPrefix(string(data), proxy.ManagedMarker) {
		r.Out("kept %s: not written by hermes-setup", layout.Caddyfile)
		return
	}
	_ = r.Systemd.Stop(ctx, "caddy.service")
	_ = r.Systemd.Disable(ctx, "caddy.service")
	_ = os.Remove(layout.Caddyfile)
}

// removeCreatedAutoUpgrades deletes 20auto-upgrades only if the hardening
// phase created it. Debian's own copy stays: removing it would disable
// unattended security upgrades on a host we are merely leaving.
func (r *Resetter) removeCreatedAutoUpgrades(g *guard.Guard) {
	if fsx.Exists(g.BackupPath("auto-upgrades.original")) {
		_ = fsx.CopyFile(g.BackupPath("auto-upgrades.original"), layout.AptAutoUpgrades, 0o644, fsx.Root)
		return
	}
	if !g.HasSnapshot(hardening.SnapAutoUpgradesCreated) {
		r.Out("kept %s: it predates edge-setup", layout.AptAutoUpgrades)
		return
	}
	_ = removeFile(layout.AptAutoUpgrades)
}

// checkSudoers validates /etc/sudoers after every change under sudoers.d.
func (r *Resetter) checkSudoers(ctx context.Context) {
	_, _ = r.Runner.Run(ctx, exec.Cmd{Path: "/usr/sbin/visudo", Args: []string{"-cf", "/etc/sudoers"}})
}

// managedRuleNumbers returns rule numbers tagged Hermes-managed in
// `ufw status numbered`, highest first so deletions do not shift.
func managedRuleNumbers(numbered string) []string {
	var nums []string
	for _, line := range strings.Split(numbered, "\n") {
		if !strings.Contains(line, "Hermes-managed") {
			continue
		}
		if i, j := strings.Index(line, "["), strings.Index(line, "]"); i >= 0 && j > i {
			nums = append(nums, strings.TrimSpace(line[i+1:j]))
		}
	}
	for i, j := 0, len(nums)-1; i < j; i, j = i+1, j-1 {
		nums[i], nums[j] = nums[j], nums[i]
	}
	return nums
}

func (r *Resetter) purgeLegacy(ctx context.Context, purgeTailscale bool) {
	for _, u := range LegacyUnits {
		if isTailscaleUnit(u) && !purgeTailscale {
			continue
		}
		_ = r.Systemd.Stop(ctx, u)
		_ = r.Systemd.Disable(ctx, u)
		_ = fsx.Remove("/etc/systemd/system/" + u)
	}
	if purgeTailscale {
		_ = r.Apt.Purge(ctx, "tailscale")
		ufw := func(args ...string) {
			_, _ = r.Runner.Run(ctx, exec.Cmd{Path: "/usr/sbin/ufw", Args: args, Env: []string{"LC_ALL=C"}})
		}
		ufw("--force", "delete", "allow", "41641/udp")
		ufw("--force", "delete", "allow", "in", "on", "tailscale0", "to", "any", "port", "22", "proto", "tcp")
	} else {
		r.Out("kept tailscale: it may be your way into this host (--purge-tailscale to remove it)")
	}
	for _, p := range LegacyPaths {
		_ = os.RemoveAll(p)
	}
	if m, _ := filepath.Glob("/root/hermes-rename-*"); m != nil {
		for _, p := range m {
			_ = os.RemoveAll(p)
		}
	}
	_, _ = r.Runner.Run(ctx, exec.Cmd{Path: "/usr/sbin/groupdel", Args: []string{"hermes_runtime"}})
	_, _ = r.Runner.Run(ctx, exec.Cmd{Path: "/usr/bin/docker", Args: []string{"rm", "-f", "openhermesbot-hermes"}})
}

// Residue lists what still mentions the namespaces after a reset.
func (r *Resetter) Residue(ctx context.Context, legacy bool) ([]string, error) {
	patterns := []string{"hermes-*"}
	if legacy {
		patterns = append(patterns, "openhermesbot-*")
	}
	units, err := r.Systemd.ListUnitFiles(ctx, patterns...)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, u := range units {
		out = append(out, "unit "+u)
	}
	for _, p := range append(append([]string{}, StatePaths...), RuntimePaths...) {
		if fsx.Exists(p) {
			out = append(out, p)
		}
	}
	owned := packageOwned(PackageFileList)
	for _, p := range ToolPathEntries {
		if st, _ := fsx.Lstat(p); st.Exists && !owned[p] {
			out = append(out, p)
		}
	}
	if legacy {
		for _, p := range LegacyPaths {
			if fsx.Exists(p) {
				out = append(out, p)
			}
		}
	}
	return out, nil
}

// isTailscaleUnit reports whether a legacy unit belongs to tailscale rather
// than to the previous tool's own namespace.
func isTailscaleUnit(unit string) bool { return strings.HasPrefix(unit, "tailscale") }
