package proxy

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hardening"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// Snapshot and backup names of the proxy transaction. They are a contract
// with hosts already exposed: renaming one breaks their rollback.
const (
	SnapCaddyfileAbsent = "caddyfile.was-absent"
	SnapCaddyWasActive  = "caddy.was-active"
	BackupCaddyfile     = "Caddyfile.original"
)

// legacyPublicPorts are the ports old direct mode opened; they are the only ones
// the rollback closes again.
var legacyPublicPorts = []string{"80/tcp", "443/tcp"}

const ufwBin = "/usr/sbin/ufw"

// Transaction retains the rollback half of the removed public-proxy mode so
// already-armed hosts can be migrated safely. It cannot arm a transaction or
// open a firewall port.
//
// Like the hardening rollback, it never reads the tool's JSON state: only
// markers and backups.
type Transaction struct {
	Guard   *guard.Guard
	Systemd systemd.Client
	Runner  exec.Runner
	// Caddyfile is the path guarded by the transaction (tests override it).
	Caddyfile string
	// Owner is the expected owner of a restored Caddyfile (tests override it).
	Owner fsx.Owner
	Log   func(string, ...any)
}

// NewTransaction wires the transaction at the canonical paths.
func NewTransaction(r exec.Runner, log func(string, ...any)) *Transaction {
	if log == nil {
		log = func(string, ...any) {}
	}
	return &Transaction{
		Guard:     guard.New(layout.ProxyStateDir, layout.ProxyBackupDir, layout.ProxyRollbackUnit, fsx.Root, r),
		Systemd:   systemd.Client{Runner: r},
		Runner:    r,
		Caddyfile: layout.Caddyfile,
		Owner:     caddyOwner(),
		Log:       log,
	}
}

// State reports the transaction markers, for `status` and `audit`.
func (t *Transaction) State() guard.State { return t.Guard.State() }

// Commit ends the transaction after the canary proved the endpoint: the
// timer is stopped, the marker removed, the snapshots cleared.
func (t *Transaction) Commit(ctx context.Context) error {
	if err := t.Guard.Disarm(ctx); err != nil {
		return err
	}
	return t.Guard.ClearSnapshots(SnapCaddyfileAbsent, SnapCaddyWasActive, BackupCaddyfile)
}

// Rollback restores the pre-exposure state. It is what the systemd timer
// runs (`internal proxy-rollback`) and it reads markers and backups only.
func (t *Transaction) Rollback(ctx context.Context) (string, error) {
	g := t.Guard
	unlock, err := g.Lock()
	if err != nil {
		return "", err
	}
	defer unlock()
	if !fsx.Exists(g.Active()) {
		return "not-armed", nil
	}
	if err := g.RequireActive(); err != nil {
		return "", err
	}
	// 1. Stop the proxy first: the ports must stop answering even if a
	// later step fails.
	if err := t.Systemd.Stop(ctx, "caddy"); err != nil {
		return "", err
	}
	if !g.HasSnapshot(SnapCaddyWasActive) {
		_ = t.Systemd.Disable(ctx, "caddy")
	}
	// 2. Caddyfile: remove only what this tool wrote, restore otherwise.
	if err := t.restoreCaddyfile(); err != nil {
		return "", err
	}
	_ = fsx.Remove(t.Caddyfile + ".candidate")
	// 3. Close the ports this transaction opened, and prove they are closed.
	status, _ := exec.Output(ctx, t.Runner, ufwBin, "status", "numbered")
	for _, number := range managedPublicRuleNumbers(status) {
		_, _ = t.Runner.Run(ctx, exec.Cmd{Path: ufwBin, Args: []string{"--force", "delete", number}, Env: []string{"LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}})
	}
	if err := t.requirePortsClosed(ctx); err != nil {
		return "", err
	}
	// If the transaction replaced a pre-existing active proxy, restore its
	// service only after the public firewall rules have been removed.
	if g.HasSnapshot(SnapCaddyWasActive) {
		if err := t.Systemd.Start(ctx, "caddy"); err != nil {
			return "", err
		}
	}
	if err := g.MarkRolledBack(); err != nil {
		return "", err
	}
	_, _ = t.Runner.Run(ctx, exec.Cmd{Path: "/usr/bin/logger", Args: []string{"-p", "authpriv.alert", "-t", "edge-setup", "Automatic proxy rollback executed; the public exposure was not committed."}})
	return "rolled-back", nil
}

func managedPublicRuleNumbers(numbered string) []string {
	var numbers []int
	for _, line := range strings.Split(numbered, "\n") {
		if !strings.Contains(line, "Hermes-managed") {
			continue
		}
		left, right := strings.Index(line, "["), strings.Index(line, "]")
		if left < 0 || right <= left {
			continue
		}
		fields := strings.Fields(line[right+1:])
		if len(fields) == 0 || (fields[0] != "80/tcp" && fields[0] != "443/tcp") {
			continue
		}
		if n, err := strconv.Atoi(strings.TrimSpace(line[left+1 : right])); err == nil {
			numbers = append(numbers, n)
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(numbers)))
	out := make([]string, 0, len(numbers))
	for _, n := range numbers {
		out = append(out, strconv.Itoa(n))
	}
	return out
}

// restoreCaddyfile puts back what Arm found: nothing, or the original file.
func (t *Transaction) restoreCaddyfile() error {
	g := t.Guard
	if g.HasSnapshot(SnapCaddyfileAbsent) {
		data, err := os.ReadFile(t.Caddyfile)
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if !strings.HasPrefix(string(data), ManagedMarker) {
			// Someone replaced it after the snapshot: leave it alone.
			return nil
		}
		return fsx.Remove(t.Caddyfile)
	}
	backup := g.BackupPath(BackupCaddyfile)
	if !fsx.Exists(backup) {
		return fmt.Errorf("backup %s is missing; refusing an unproven rollback", backup)
	}
	return fsx.CopyFile(backup, t.Caddyfile, 0o640, t.Owner)
}

// requirePortsClosed proves the public ports left the firewall.
func (t *Transaction) requirePortsClosed(ctx context.Context) error {
	out, err := exec.Output(ctx, t.Runner, ufwBin, "status")
	if err != nil {
		// UFW absent or inactive: nothing is exposed by it either.
		return nil
	}
	for _, allowed := range hardening.UFWAllowedInPorts(out) {
		for _, p := range legacyPublicPorts {
			if allowed == p {
				return fmt.Errorf("ufw still allows %s after the rollback; refusing to report success", p)
			}
		}
	}
	return nil
}
