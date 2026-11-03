package operator

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// gatewayUnit is the part of systemd a graceful restart needs.
type gatewayUnit interface {
	Show(ctx context.Context, unit, property string) (string, error)
	Signal(ctx context.Context, unit, signal string) error
	Restart(ctx context.Context, units ...string) error
}

// gracefulGatewayRestart restarts the gateway WITHOUT cutting its runs.
//
// `systemctl restart` sends SIGTERM: Hermes then gives an api_server run 30 s
// (`cron_drain_timeout`) and interrupts it, a run waiting for an approval
// included. SIGUSR1 is Hermes' own drain-aware restart: it refuses new runs
// (503 `gateway_draining`, which the platform requeues), lets the running
// ones finish, exits 75, and systemd (`Restart=on-failure`) relaunches it.
//
// It returns once a NEW main process runs; the caller then proves /health.
// A gateway with no main process (stopped, failed) has nothing to drain: it
// gets a plain restart.
func gracefulGatewayRestart(ctx context.Context, sd gatewayUnit, poll time.Duration) error {
	before, err := gatewayMainPID(ctx, sd)
	if err != nil {
		return err
	}
	if before == "" {
		return sd.Restart(ctx, layout.GatewayUnit)
	}
	if err := sd.Signal(ctx, layout.GatewayUnit, "SIGUSR1"); err != nil {
		return fmt.Errorf("signal the gateway: %w", err)
	}
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("the gateway did not relaunch after draining its runs: %w", ctx.Err())
		case <-ticker.C:
		}
		now, err := gatewayMainPID(ctx, sd)
		if err != nil {
			// A read failing mid-relaunch is not the end of the restart.
			continue
		}
		if now != "" && now != before {
			return nil
		}
		if now == "" {
			// Between the old process's exit and its relaunch the unit is
			// "activating"; a "failed" unit will not come back on its own.
			if state, err := sd.Show(ctx, layout.GatewayUnit, "ActiveState"); err == nil && strings.TrimSpace(state) == "failed" {
				return fmt.Errorf("the gateway exited after draining and systemd did not relaunch it")
			}
		}
	}
}

// gatewayMainPID is the unit's main PID, "" when no process runs.
func gatewayMainPID(ctx context.Context, sd gatewayUnit) (string, error) {
	raw, err := sd.Show(ctx, layout.GatewayUnit, "MainPID")
	if err != nil {
		return "", fmt.Errorf("read the gateway main PID: %w", err)
	}
	pid := strings.TrimSpace(raw)
	if pid == "0" {
		return "", nil
	}
	return pid, nil
}
