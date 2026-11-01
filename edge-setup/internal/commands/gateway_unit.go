package commands

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"slices"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

// `up` is not the only way a gateway unit change reaches an installed host.
// `upgrade` (and so `upgrade --auto`) renders the unit with the very parameters
// `up` uses (hermes.DesiredGatewayUnit), rewrites it when it differs, and
// applies it with the same care as every other restart of the runtime: only on
// an idle host, proven on /health, rolled back when the proof fails. On a busy
// host the unit is written and reloaded but the gateway is left running; the
// « restart pending » marker, the same one the other writers set (the list is
// on operator.GatewayStatus.RestartPending), tells the owner.
//
// A difference made only of comments and blank lines (sameUnitDirectives) is
// not a change systemd can tell: the unit is still written and reloaded, so
// the file on disk is the rendered one and `systemctl` does not report it
// changed, but the gateway is neither restarted nor marked. Otherwise a release
// that only rewords a comment of the template would restart the gateway of
// every host that upgrades by itself.

// gatewayUnitOutcome is what the gateway-unit step of an upgrade did.
type gatewayUnitOutcome int

const (
	// gatewayUnitUnchanged: nothing was written. The installed unit already is
	// the rendered one, or there is nothing this step may touch (no unit
	// installed, not a regular file, a parameter `up` reads cannot be told).
	gatewayUnitUnchanged gatewayUnitOutcome = iota
	// gatewayUnitRestarted: the unit was rewritten, the gateway restarted on it
	// and proven on /health.
	gatewayUnitRestarted
	// gatewayUnitPending: the unit was rewritten and reloaded, the gateway keeps
	// the previous one until it restarts, and the marker says so.
	gatewayUnitPending
	// gatewayUnitCommentOnly: the unit was rewritten and reloaded but only its
	// comments or blank lines changed. The gateway was not restarted and no
	// marker was set: nothing in this change needs a restart.
	gatewayUnitCommentOnly
)

// gatewayUnitResult is the outcome of the step, with the reason the restart was
// left to the owner when it was.
type gatewayUnitResult struct {
	Outcome gatewayUnitOutcome
	Pending string
}

// gatewayUnitStep brings a changed gateway unit to an installed host. Every
// effect is a field so the decisions (nothing, restart, defer, roll back) are
// tested without a host, as autoUpgrader does for the automatic pass.
type gatewayUnitStep struct {
	path  string
	owner fsx.Owner
	sd    systemd.Client
	// want renders the unit this binary would install (hermes.DesiredGatewayUnit).
	want func() (string, error)
	// busy says why the gateway must not be restarted now, empty when the host
	// is idle (busyReason).
	busy func() string
	// healthy proves the gateway answers /health.
	healthy func(context.Context) error
	// markPending records « restart pending » in the same marker the other
	// writers set.
	markPending func() error
	log         func(string, ...any)
}

// gatewayUnitHealthTimeout bounds each /health proof, as the other gateway
// restarts of an upgrade are bounded.
const gatewayUnitHealthTimeout = 60 * time.Second

// waitGatewayHealthy is the proof every gateway restart of an upgrade asks, the
// one startGateway asks of `up`: the service can be active before the port
// listens, /health decides.
func waitGatewayHealthy(ctx context.Context) error {
	return gateway.Loopback("").WaitHealthy(ctx, gatewayUnitHealthTimeout)
}

// reconcileGatewayUnit is the step of `upgrade --finish` that brings the
// gateway unit this binary renders to the host. It never creates a unit (`up`
// installs the runtime) and never guesses a parameter: when the unit variant
// cannot be derived from the state and the service account, it says so and
// leaves the unit as it is.
func reconcileGatewayUnit(ctx context.Context, sd systemd.Client, st *state.File, log func(string, ...any)) (gatewayUnitResult, error) {
	return gatewayUnitStep{
		path:  layout.GatewayUnitPath,
		owner: fsx.Root,
		sd:    sd,
		want: func() (string, error) {
			return hermes.DesiredGatewayUnit(ctx, account.New(runner), st, layout.ResolvConf, log)
		},
		busy:        func() string { return busyReason(time.Now()) },
		healthy:     waitGatewayHealthy,
		markPending: func() error { return markCLIGatewayRestart(layout.GatewayRestartMarker) },
		log:         log,
	}.apply(ctx)
}

func (g gatewayUnitStep) apply(ctx context.Context) (gatewayUnitResult, error) {
	previous, err := fsx.ReadFile(g.path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return gatewayUnitResult{}, nil
	case errors.Is(err, fsx.ErrNotRegular):
		g.log("gateway unit left alone: %s is not a regular file, `up` would not rewrite it either", g.path)
		return gatewayUnitResult{}, nil
	case err != nil:
		return gatewayUnitResult{}, fmt.Errorf("read %s: %w", g.path, err)
	}
	want, err := g.want()
	if err != nil {
		g.log("gateway unit not reconciled: %v; `sudo edge-setup up --yes` renders it", err)
		return gatewayUnitResult{}, nil
	}
	if string(previous) == want {
		return gatewayUnitResult{}, nil
	}
	if err := fsx.WriteAtomic(g.path, []byte(want), 0o644, g.owner); err != nil {
		return gatewayUnitResult{}, err
	}
	if err := g.sd.DaemonReload(ctx); err != nil {
		return gatewayUnitResult{}, g.rolledBack(ctx, previous, false, err)
	}
	if sameUnitDirectives(string(previous), want) {
		g.log("gateway unit rewritten and reloaded; the change is comment-only, so %s is not restarted and no restart is pending", layout.GatewayUnit)
		return gatewayUnitResult{Outcome: gatewayUnitCommentOnly}, nil
	}
	if reason := g.busy(); reason != "" {
		if err := g.markPending(); err != nil {
			return gatewayUnitResult{}, g.rolledBack(ctx, previous, false, fmt.Errorf("the gateway cannot be restarted now (%s) and its pending restart could not be recorded: %w", reason, err))
		}
		g.log("gateway unit rewritten and reloaded; restart left to the owner (%s)", reason)
		return gatewayUnitResult{Outcome: gatewayUnitPending, Pending: reason}, nil
	}
	if err := g.restart(ctx); err != nil {
		return gatewayUnitResult{}, g.rolledBack(ctx, previous, true, fmt.Errorf("the gateway did not come back on the new unit: %w", err))
	}
	g.log("gateway unit rewritten; %s restarted and answering /health", layout.GatewayUnit)
	return gatewayUnitResult{Outcome: gatewayUnitRestarted}, nil
}

// restart restarts the gateway and proves /health, the proof `up` asks of it.
func (g gatewayUnitStep) restart(ctx context.Context) error {
	if err := g.sd.Restart(ctx, layout.GatewayUnit); err != nil {
		return err
	}
	healthCtx, cancel := context.WithTimeout(ctx, gatewayUnitHealthTimeout)
	defer cancel()
	return g.healthy(healthCtx)
}

// rolledBack puts the unit text captured before the write back, reloads
// systemd and, when the gateway had been restarted on the new unit, restarts it
// on the old one and proves /health. It reads no state: previous is the file as
// it was. The context may already be spent (the pass was cancelled), the host is
// not: a unit that did not prove itself never stays installed. The returned
// error says what was tried and what came of it.
func (g gatewayUnitStep) rolledBack(ctx context.Context, previous []byte, restarted bool, cause error) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Minute)
	defer cancel()
	if err := fsx.WriteAtomic(g.path, previous, 0o644, g.owner); err != nil {
		return fmt.Errorf("%w; the previous unit could not be put back (%v): run `sudo edge-setup up --yes`", cause, err)
	}
	if err := g.sd.DaemonReload(ctx); err != nil {
		return fmt.Errorf("%w; the previous unit is back on disk but systemd did not reload it (%v)", cause, err)
	}
	if !restarted {
		return fmt.Errorf("%w; the previous unit is back in place", cause)
	}
	if err := g.restart(ctx); err != nil {
		return fmt.Errorf("%w; the previous unit is back in place but the gateway does not answer /health on it either (%v)", cause, err)
	}
	return fmt.Errorf("%w; the previous unit is back in place and the gateway answers /health on it", cause)
}

// sameUnitDirectives reports whether two texts of a systemd unit carry the same
// directives: they may differ by full-line comments and by blank lines, and by
// nothing else. A comment is a line whose first non-blank character is `#` or
// `;` (systemd.syntax(7)); a `#` further along a line belongs to its value, so
// `Environment=A=#b` is a directive, and a directive commented out or removed
// is a difference. Every other line is compared byte for byte, in order.
func sameUnitDirectives(a, b string) bool {
	la, okA := unitDirectives(a)
	lb, okB := unitDirectives(b)
	return okA && okB && slices.Equal(la, lb)
}

// unitDirectives lists the lines of a unit text that systemd does not skip: the
// ones that are neither blank nor a full-line comment. ok is false when one of
// them ends with a backslash: systemd joins it with the next line, and a blank
// line there ends the join, so blank lines stop being neutral and the text is
// not compared line by line (the caller then sees a change, as it always did).
func unitDirectives(text string) (directives []string, ok bool) {
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || trimmed[0] == '#' || trimmed[0] == ';' {
			continue
		}
		if strings.HasSuffix(trimmed, `\`) {
			return nil, false
		}
		directives = append(directives, line)
	}
	return directives, true
}
