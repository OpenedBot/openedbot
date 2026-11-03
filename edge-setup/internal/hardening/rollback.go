package hardening

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// Rollback restores the audited access path. It is executed by the systemd
// timer (`internal rollback-access`) and never reads the tool's JSON state:
// only markers and backups, so a corrupted state cannot prevent recovery.
// Ported verbatim from rollback-access.sh of the previous tool.
func (h *Hardener) Rollback(ctx context.Context) (string, error) {
	g := h.Guard
	unlock, err := g.Lock()
	if err != nil {
		return "", err
	}
	defer unlock()
	// A durable finalized marker means commit won before a queued service started.
	if _, err := fsx.RequireRegular(g.Finalized(), 0o600, fsx.Root); err == nil && fsx.Exists(g.Finalized()) {
		_ = fsx.Remove(g.Active())
		return "already-finalized", nil
	}
	if !fsx.Exists(g.Active()) {
		return "not-armed", nil
	}
	if _, err := fsx.RequireRegular(g.Active(), 0o600, fsx.Root); err != nil {
		return "", err
	}
	marker, err := g.ReadMarker(g.Active())
	if err != nil {
		return "", err
	}
	selected := map[string]bool{}
	for _, feature := range strings.Split(marker["features"], ",") {
		if feature != "" {
			selected[feature] = true
		}
	}
	// Version 1 markers came from the all-or-nothing hardening release.
	if marker["version"] == "1" || marker["features"] == "" {
		for _, feature := range []string{"firewall", "fail2ban", "ssh", "quarantine"} {
			selected[feature] = true
		}
	}
	quarantine := selected["quarantine"] && fsx.Exists(g.BackupPath("debian.manifest"))
	var required []string
	if selected["firewall"] {
		required = append(required, "ufw.default", "ufw.conf", "ufw.user.rules", "ufw.user6.rules")
	}
	if quarantine {
		required = append(required, "debian.authorized_keys", "debian.sudoers")
	}
	for _, name := range required {
		if _, err := fsx.RequireRegular(g.BackupPath(name), 0o600, fsx.Root); err != nil || !fsx.Exists(g.BackupPath(name)) {
			return "", fmt.Errorf("backup %s is missing or invalid; refusing an unproven rollback", name)
		}
	}
	// 1. Restore sshd only when this transaction selected it.
	if selected["ssh"] {
		if g.HasSnapshot("ssh-dropin.was-absent") {
			if err := fsx.Remove(h.SSHDropin); err != nil {
				return "", err
			}
		} else {
			if _, err := fsx.RequireRegular(g.BackupPath("ssh-dropin.original"), 0o600, fsx.Root); err != nil {
				return "", fmt.Errorf("SSH backup is missing or invalid; refusing an unproven rollback: %w", err)
			}
			if err := fsx.CopyFile(g.BackupPath("ssh-dropin.original"), h.SSHDropin, 0o644, fsx.Root); err != nil {
				return "", err
			}
		}
	}
	// 2. Restore a usable audited access path before any secondary cleanup.
	if quarantine {
		if err := h.restoreQuarantine(ctx); err != nil {
			return "", err
		}
	}
	// 3. Restore UFW only when this transaction selected it. `ufw reset` is
	// forbidden because it destroys unrelated rules. The deny out rules and the
	// DNS exception of a resolver above them (resolver.go) live in the four
	// files restored here, so both go with them.
	if selected["firewall"] {
		if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/ufw", Args: []string{"--force", "disable"}, Env: []string{"LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}}); err != nil {
			return "", err
		}
		for _, f := range ufwFiles {
			mode := os.FileMode(0o644)
			if strings.HasSuffix(f.Path, ".rules") {
				mode = 0o640
			}
			if err := fsx.CopyFile(g.BackupPath(f.Backup), f.Path, mode, fsx.Root); err != nil {
				return "", err
			}
		}
		if g.HasSnapshot("ufw.was-active") {
			if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/ufw", Args: []string{"--force", "enable"}, Env: []string{"LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}}); err != nil {
				return "", err
			}
		}
	}
	if selected["ssh"] || quarantine {
		if err := h.validateAndReloadSSH(ctx); err != nil {
			return "", err
		}
	}
	// 4. Secondary access policy, only when selected by this transaction.
	if selected["fail2ban"] && g.HasSnapshot("fail2ban-dropin.created-by-bootstrap") {
		_ = fsx.Remove(h.Fail2banJail)
	}
	if selected["fail2ban"] {
		if g.HasSnapshot("fail2ban.was-active") {
			_ = h.Systemd.EnableNow(ctx, "fail2ban")
		} else {
			if active, _ := h.Systemd.IsActive(ctx, "fail2ban"); active {
				_ = h.Systemd.Stop(ctx, "fail2ban")
			}
			if enabled, _ := h.Systemd.IsEnabled(ctx, "fail2ban"); enabled {
				_ = h.Systemd.Disable(ctx, "fail2ban")
			}
		}
	}
	if selected["ssh"] && g.HasSnapshot("admin.created-by-bootstrap") {
		_ = fsx.Remove(h.SudoersAdmin)
		if info, _ := h.Accounts.Get(ctx, layout.AdminUser); info != nil {
			_ = h.Accounts.Delete(ctx, layout.AdminUser)
		}
	}
	// 5. End-of-transaction validation as a second gate after cleanup.
	if selected["ssh"] || quarantine {
		if err := h.validateAndReloadSSH(ctx); err != nil {
			return "", err
		}
	}
	rolledBackFeatures := make([]string, 0, len(selected))
	for feature := range selected {
		rolledBackFeatures = append(rolledBackFeatures, feature)
	}
	sort.Strings(rolledBackFeatures)
	if err := g.MarkRolledBack(rolledBackFeatures...); err != nil {
		return "", err
	}
	_, _ = h.Runner.Run(ctx, exec.Cmd{Path: "/usr/bin/logger", Args: []string{"-p", "authpriv.alert", "-t", "edge-setup", "Automatic access rollback executed; hardening was not finalized."}})
	return "rolled-back", nil
}

func (h *Hardener) restoreQuarantine(ctx context.Context) error {
	g := h.Guard
	q := layout.QuarantineUser
	kv, err := g.ReadMarker(g.BackupPath("debian.manifest"))
	if err != nil {
		return err
	}
	info, err := h.Accounts.Get(ctx, q)
	if err != nil {
		return err
	}
	if info == nil {
		return errors.New("the quarantined account no longer exists; manual recovery is required")
	}
	owner := fsx.Owner{UID: info.UID, GID: info.GID}
	if err := fsx.EnsureDir("/home/"+q+"/.ssh", 0o700, owner); err != nil {
		return err
	}
	if err := fsx.CopyFile(g.BackupPath("debian.authorized_keys"), "/home/"+q+"/.ssh/authorized_keys", 0o600, owner); err != nil {
		return err
	}
	if err := fsx.CopyFile(g.BackupPath("debian.sudoers"), layout.QuarantineSudoers, 0o440, fsx.Root); err != nil {
		return err
	}
	shell := kv["shell"]
	if shell == "" {
		shell = "/bin/bash"
	}
	if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/usermod", Args: []string{"--lock", "--shell", shell, q}}); err != nil {
		return err
	}
	wasSudo := HasGroup(strings.Fields(kv["groups"]), "sudo")
	groups, err := h.Accounts.Groups(ctx, q)
	if err != nil {
		return err
	}
	if wasSudo && !HasGroup(groups, "sudo") {
		if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/usermod", Args: []string{"-aG", "sudo", q}}); err != nil {
			return err
		}
	} else if !wasSudo && HasGroup(groups, "sudo") {
		if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/bin/gpasswd", Args: []string{"-d", q, "sudo"}}); err != nil {
			return err
		}
	}
	return nil
}

func (h *Hardener) validateAndReloadSSH(ctx context.Context) error {
	if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/visudo", Args: []string{"-cf", "/etc/sudoers"}}); err != nil {
		return err
	}
	if _, err := exec.Must(ctx, h.Runner, exec.Cmd{Path: "/usr/sbin/sshd", Args: []string{"-t"}}); err != nil {
		return err
	}
	return h.Systemd.Reload(ctx, "ssh")
}
