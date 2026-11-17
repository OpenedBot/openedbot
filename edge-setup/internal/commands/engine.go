package commands

import (
	"context"
	"errors"
	"fmt"
	"runtime"

	"github.com/OpenedBot/openedbot/edge-setup/internal/acpbridge"
	"github.com/OpenedBot/openedbot/edge-setup/internal/acphost"
	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connector"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/pins"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
	"os"
)

func validateEngine(name, goos string, previous *state.File, sandbox bool) error {
	if name == "" {
		name = state.EngineHermes
	}
	if name != state.EngineHermes && name != state.EngineOpenCode {
		return errors.New("--engine must be hermes or acp:opencode (experimental)")
	}
	if name != state.EngineHermes && goos != "linux" {
		return errors.New("--engine acp:opencode is experimental and requires Linux with systemd only")
	}
	if previous != nil && previous.EngineName() != name {
		return fmt.Errorf("cannot change the installed engine from %s to %s; uninstall first", previous.EngineName(), name)
	}
	if name == state.EngineOpenCode && sandbox {
		return errors.New("--sandbox is only supported by the Hermes engine")
	}
	return nil
}

func configureConnectorEngine(c *connector.Client, engine string) {
	if engine == state.EngineOpenCode {
		c.Engine = state.EngineOpenCode
		c.EngineVersion = pins.OpenCodeVersion
		c.HermesVersion = ""
		return
	}
	c.HermesVersion = installedHermesVersion()
}

// loadHostState allows command tests to supply state without owning root files.
var loadHostState = state.Load

// installACPRuntime is shared by up and the new binary's upgrade finish step.

func installACPRuntime(ctx context.Context, arch string, force bool, st *state.File, log func(string, ...any)) error {
	if err := acphost.New(runner, arch, log).Run(ctx, force); err != nil {
		return err
	}
	st.PinsApplied["opencode"] = pins.OpenCodeVersion
	st.MarkPhase("runtime", "")
	return st.Save()
}

func runACPBridge(env cli.Env, ctx context.Context) int {
	if runtime.GOOS != "linux" {
		return fail(env, cli.ExitRefused, "acp-bridge requires Linux with systemd only")
	}
	st, err := loadHostState()
	if err != nil {
		return fail(env, cli.ExitFailure, "state: %v", err)
	}
	opts, err := acphost.Options(acphost.HostPaths(), st, os.Getenv("ACP_BRIDGE_CREDENTIALS_DIRECTORY"), fsx.Root)
	if err != nil {
		return fail(env, cli.ExitFailure, "acp-bridge: %v", err)
	}
	bridge, err := acpbridge.New(opts)
	if err != nil {
		return fail(env, cli.ExitFailure, "acp-bridge: %v", err)
	}
	defer bridge.Close()
	if err := bridge.Serve(ctx); err != nil {
		return fail(env, cli.ExitFailure, "acp-bridge: %v", err)
	}
	return cli.ExitOK
}

// proveEngineRuntime preserves the Hermes optional-running check. An ACP
// installation always requires its bridge unit as well as the loopback proof.
func proveEngineRuntime(ctx context.Context, sd systemd.Client, st *state.File, healthy func(context.Context) error) error {
	unit := layout.GatewayUnit
	isACP := st.EngineName() == state.EngineOpenCode
	if isACP {
		unit = layout.ACPBridgeUnit
	}
	active, err := sd.IsActive(ctx, unit)
	if isACP && (err != nil || !active) {
		return fmt.Errorf("%s.service is not active", unit)
	}
	if active {
		if err := healthy(ctx); err != nil {
			return fmt.Errorf("%s does not answer /health: %w", unit, err)
		}
	}
	return nil
}
