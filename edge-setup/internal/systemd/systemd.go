// Package systemd wraps the few systemctl operations the tool needs, all
// through the exec.Runner so they are scriptable in tests.
package systemd

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
)

const systemctl = "/usr/bin/systemctl"

// Client runs systemctl.
type Client struct{ Runner exec.Runner }

// Show returns one property value of a unit.
func (c Client) Show(ctx context.Context, unit, property string) (string, error) {
	return exec.Output(ctx, c.Runner, systemctl, "show", unit, "--property="+property, "--value")
}

// TimerIsWaiting reports whether unit.timer is active, waiting and has a
// real next elapse. This is the exact predicate the previous tool used
// before every guarded mutation.
func (c Client) TimerIsWaiting(ctx context.Context, timer string) (bool, error) {
	active, err := c.Show(ctx, timer, "ActiveState")
	if err != nil {
		return false, err
	}
	sub, err := c.Show(ctx, timer, "SubState")
	if err != nil {
		return false, err
	}
	next, err := c.Show(ctx, timer, "NextElapseUSecMonotonic")
	if err != nil {
		return false, err
	}
	if active != "active" || sub != "waiting" {
		return false, nil
	}
	switch next {
	case "", "0", "n/a", "infinity":
		return false, nil
	}
	return true, nil
}

// IsActive reports whether a unit is active.
func (c Client) IsActive(ctx context.Context, unit string) (bool, error) {
	res, err := c.Runner.Run(ctx, exec.Cmd{Path: systemctl, Args: []string{"is-active", "--quiet", unit}})
	if err != nil {
		return false, err
	}
	return res.ExitCode == 0, nil
}

// IsEnabled reports whether a unit is enabled.
func (c Client) IsEnabled(ctx context.Context, unit string) (bool, error) {
	res, err := c.Runner.Run(ctx, exec.Cmd{Path: systemctl, Args: []string{"is-enabled", "--quiet", unit}})
	if err != nil {
		return false, err
	}
	return res.ExitCode == 0, nil
}

// Query runs one read-only state verb (is-active, is-enabled, ...) on a unit
// and returns the raw result. A non-zero exit is not an error: callers that
// must tell "inactive" from a bus or permission failure read the exit code,
// stdout and stderr themselves. A zero timeout means exec.DefaultTimeout.
func (c Client) Query(ctx context.Context, verb, unit string, timeout time.Duration) (exec.Result, error) {
	return c.Runner.Run(ctx, exec.Cmd{Path: systemctl, Args: []string{verb, unit}, Timeout: timeout})
}

func (c Client) verb(ctx context.Context, verb string, units ...string) error {
	_, err := exec.Must(ctx, c.Runner, exec.Cmd{Path: systemctl, Args: append([]string{verb}, units...)})
	return err
}

// DaemonReload reloads unit files.
func (c Client) DaemonReload(ctx context.Context) error { return c.verb(ctx, "daemon-reload") }

// Enable enables units.
func (c Client) Enable(ctx context.Context, units ...string) error {
	return c.verb(ctx, "enable", units...)
}

// EnableNow enables and starts units.
func (c Client) EnableNow(ctx context.Context, units ...string) error {
	return c.verb(ctx, "enable", append([]string{"--now"}, units...)...)
}

// Disable disables units.
func (c Client) Disable(ctx context.Context, units ...string) error {
	return c.verb(ctx, "disable", units...)
}

// Start starts units.
func (c Client) Start(ctx context.Context, units ...string) error {
	return c.verb(ctx, "start", units...)
}

// Stop stops units.
func (c Client) Stop(ctx context.Context, units ...string) error {
	return c.verb(ctx, "stop", units...)
}

// Restart restarts units.
func (c Client) Restart(ctx context.Context, units ...string) error {
	return c.verb(ctx, "restart", units...)
}

// Signal sends one signal to a unit's main process only, never to its
// children (`systemctl kill --kill-whom=main`).
func (c Client) Signal(ctx context.Context, unit, signal string) error {
	return c.verb(ctx, "kill", "--kill-whom=main", "--signal="+signal, unit)
}

// Reload reloads units.
func (c Client) Reload(ctx context.Context, units ...string) error {
	return c.verb(ctx, "reload", units...)
}

// TryRestart restarts units only if active.
func (c Client) TryRestart(ctx context.Context, units ...string) error {
	return c.verb(ctx, "try-restart", units...)
}

// Mask masks units.
func (c Client) Mask(ctx context.Context, units ...string) error {
	return c.verb(ctx, "mask", units...)
}

// Unmask unmasks units.
func (c Client) Unmask(ctx context.Context, units ...string) error {
	return c.verb(ctx, "unmask", units...)
}

// ListUnitFiles returns unit file names matching the patterns.
func (c Client) ListUnitFiles(ctx context.Context, patterns ...string) ([]string, error) {
	args := append([]string{"list-unit-files", "--no-legend", "--plain", "--no-pager"}, patterns...)
	res, err := c.Runner.Run(ctx, exec.Cmd{Path: systemctl, Args: args})
	if err != nil {
		return nil, err
	}
	// systemd exits 1 with an empty listing when no unit file matches.
	if res.ExitCode != 0 && strings.TrimSpace(res.Stdout) != "" {
		return nil, fmt.Errorf("systemctl list-unit-files: exit %d", res.ExitCode)
	}
	var names []string
	for _, line := range strings.Split(strings.TrimSpace(res.Stdout), "\n") {
		f := strings.Fields(line)
		if len(f) > 0 {
			names = append(names, f[0])
		}
	}
	return names, nil
}

// RequireTimerWaiting fails unless the timer is armed and will fire.
func (c Client) RequireTimerWaiting(ctx context.Context, timer string) error {
	ok, err := c.TimerIsWaiting(ctx, timer)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%s is not armed (active/waiting with a next elapse); refusing to continue", timer)
	}
	return nil
}
