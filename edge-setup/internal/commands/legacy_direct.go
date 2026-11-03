package commands

// Kept on 2026-10-10: hosts still running the pre connector-only releases may
// exist; remove once the host inventory shows no `state.Mode == "direct"`.

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
	"github.com/OpenedBot/openedbot/edge-setup/internal/proxy"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

const legacyDirectMode state.Mode = "direct"

type unitController interface {
	IsActive(context.Context, string) (bool, error)
	IsEnabled(context.Context, string) (bool, error)
	Stop(context.Context, ...string) error
	Disable(context.Context, ...string) error
}

type legacyProxyTransaction interface {
	State() guard.State
	Commit(context.Context) error
	Rollback(context.Context) (string, error)
}

// migrateLegacyDirect is the one-way bridge from releases that exposed
// Caddy on 80/443. It completes before callers record connector state.
func migrateLegacyDirect(ctx context.Context, r exec.Runner, st *state.File) error {
	if st == nil || st.Mode != legacyDirectMode {
		return nil
	}

	return migrateLegacyDirectWith(ctx, r, st, systemd.Client{Runner: r}, proxy.NewTransaction(r, nil), layout.Caddyfile, "/usr/sbin/ufw", fsx.Exists("/usr/sbin/ufw"))
}

func migrateLegacyDirectWith(ctx context.Context, r exec.Runner, st *state.File, units unitController, tx legacyProxyTransaction, caddyfile, ufw string, ufwExists bool) error {
	if st == nil || st.Mode != legacyDirectMode {
		return nil
	}

	managed, err := managedCaddyfile(caddyfile)
	if err != nil {
		return err
	}
	if !managed {
		if err := refuseForeignLegacyExposure(ctx, r, units, ufw, ufwExists); err != nil {
			return err
		}
	}
	if tx.State().Active {
		if managed {
			if _, err := tx.Rollback(ctx); err != nil {
				return fmt.Errorf("rollback armed proxy transaction: %w", err)
			}
		} else {
			// A third party replaced (or removed) our Caddyfile while the old
			// timer was armed. Disarm it so it cannot later stop their service.
			if err := tx.Commit(ctx); err != nil {
				return fmt.Errorf("disarm stale proxy transaction: %w", err)
			}
		}
	}

	// Rollback may have restored a pre-existing foreign Caddyfile. Recheck
	// before touching either its service or its firewall policy.
	managed, err = managedCaddyfile(caddyfile)
	if err != nil {
		return err
	}
	if !managed {
		return refuseForeignLegacyExposure(ctx, r, units, ufw, ufwExists)
	}
	if err := retireManagedCaddy(ctx, units, caddyfile); err != nil {
		return err
	}
	return closeLegacyDirectPorts(ctx, r, ufw, ufwExists)
}

func refuseForeignLegacyExposure(ctx context.Context, r exec.Runner, units unitController, ufw string, ufwExists bool) error {
	active, err := units.IsActive(ctx, "caddy")
	if err != nil {
		return err
	}
	enabled, err := units.IsEnabled(ctx, "caddy")
	if err != nil {
		return err
	}
	ports, err := legacyAllowedPorts(ctx, r, ufw, ufwExists)
	if err != nil {
		return err
	}
	if active || enabled || len(ports) > 0 {
		return fmt.Errorf("unmanaged Caddy or public firewall policy is present (caddy active=%v enabled=%v, ports=%v); refusing connector migration without mutation", active, enabled, ports)
	}
	return nil
}

// managedCaddyfile recognizes only a regular, non-symlink file carrying the
// exact marker used by old hermes-setup releases.
func managedCaddyfile(path string) (bool, error) {
	info, err := fsx.Lstat(path)
	if err != nil {
		return false, err
	}
	if !info.Exists || !info.Regular || info.Symlink {
		return false, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	return strings.HasPrefix(string(data), proxy.ManagedMarker), nil
}

// retireManagedCaddy never operates on an unmarked Caddyfile. The file is
// removed only after caddy.service is proven stopped and disabled.
func retireManagedCaddy(ctx context.Context, units unitController, path string) error {
	managed, err := managedCaddyfile(path)
	if err != nil || !managed {
		return err
	}
	if active, err := units.IsActive(ctx, "caddy"); err != nil {
		return err
	} else if active {
		if err := units.Stop(ctx, "caddy"); err != nil {
			return err
		}
	}
	if enabled, err := units.IsEnabled(ctx, "caddy"); err != nil {
		return err
	} else if enabled {
		if err := units.Disable(ctx, "caddy"); err != nil {
			return err
		}
	}
	if active, err := units.IsActive(ctx, "caddy"); err != nil {
		return err
	} else if active {
		return fmt.Errorf("caddy.service is still active after legacy cleanup")
	}
	if enabled, err := units.IsEnabled(ctx, "caddy"); err != nil {
		return err
	} else if enabled {
		return fmt.Errorf("caddy.service is still enabled after legacy cleanup")
	}
	return fsx.Remove(path)
}

func closeLegacyDirectPorts(ctx context.Context, r exec.Runner, ufw string, exists bool) error {
	if !exists {
		return nil
	}
	status, err := exec.Output(ctx, r, ufw, "status", "numbered")
	if err != nil {
		return fmt.Errorf("inspect ufw before closing legacy ports: %w", err)
	}
	for _, number := range managedLegacyRuleNumbers(status) {
		if _, err := exec.Must(ctx, r, exec.Cmd{Path: ufw, Args: []string{"--force", "delete", number}, Env: []string{"LC_ALL=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}}); err != nil {
			return err
		}
	}
	ports, err := legacyAllowedPorts(ctx, r, ufw, exists)
	if err != nil {
		return fmt.Errorf("verify ufw after closing legacy ports: %w", err)
	}
	if len(ports) > 0 {
		return fmt.Errorf("ufw still allows %v after removing Hermes-managed legacy rules", ports)
	}
	return nil
}

func legacyAllowedPorts(ctx context.Context, r exec.Runner, ufw string, exists bool) ([]string, error) {
	if !exists {
		return nil, nil
	}
	status, err := exec.Output(ctx, r, ufw, "status")
	if err != nil {
		return nil, err
	}
	var ports []string
	for _, port := range hardening.UFWAllowedInPorts(status) {
		if port == "80/tcp" || port == "443/tcp" {
			ports = append(ports, port)
		}
	}
	return ports, nil
}

func managedLegacyRuleNumbers(numbered string) []string {
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
		n, err := strconv.Atoi(strings.TrimSpace(line[left+1 : right]))
		if err == nil {
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
