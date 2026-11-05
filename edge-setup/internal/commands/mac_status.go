package commands

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/devicekeys"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

type macInstanceStatus struct {
	instanceStatus
	Registered          bool   `json:"service_registered"`
	DeviceKeyStorage    string `json:"device_key_storage"`
	DeviceKeyAccessible *bool  `json:"device_key_accessible,omitempty"`
	DeviceKeyError      string `json:"device_key_error,omitempty"`
}

func runMacStatus(env cli.Env, asJSON bool) int {
	if code := prepareConnectorHost(env); code != 0 {
		return code
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS user home could not be resolved")
	}
	p, err := layout.MacRuntime(home)
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS runtime paths could not be resolved")
	}
	store, err := devicekeys.New()
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS device key storage could not be inspected")
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	summary, err := collectMacStatus(ctx, home, p, store)
	if err != nil {
		return fail(env, cli.ExitFailure, "%v", err)
	}
	if asJSON {
		data, err := json.MarshalIndent(summary, "", "  ")
		if err != nil {
			return fail(env, cli.ExitFailure, "macOS runtime status could not be encoded")
		}
		printf(env.Stdout, "%s", data)
		return cli.ExitOK
	}
	printf(env.Stdout, "state       configured=%s service_manager=launchd", boolLabel(env.Color, summary["configured"].(bool)))
	printf(env.Stdout, "hardening   Linux host-policy controls unavailable on macOS")
	printf(env.Stdout, "auto-upgrade unavailable on macOS")
	printf(env.Stdout, "gateway     active=%s", boolLabel(env.Color, summary["gateway_active"].(bool)))
	printf(env.Stdout, "operator    active=%s", boolLabel(env.Color, summary["operator_active"].(bool)))
	for _, entry := range summary["connectors"].([]macInstanceStatus) {
		printf(env.Stdout, "connector   %-8s registered=%s active=%s link=%s key_storage=keychain refused=%s", entry.Name,
			boolLabel(env.Color, entry.Registered), boolLabel(env.Color, entry.Active), boolLabel(env.Color, entry.Link), boolLabel(env.Color, entry.Refused))
		if entry.DeviceKeyAccessible != nil {
			printf(env.Stdout, "device-key  %-8s accessible=%s", entry.Name, boolLabel(env.Color, *entry.DeviceKeyAccessible))
		}
	}
	return cli.ExitOK
}

func collectMacStatus(ctx context.Context, home string, p layout.MacRuntimePaths, store devicekeys.Store) (map[string]any, error) {
	want, err := layout.MacRuntime(home)
	if err != nil || p != want {
		return nil, errors.New("macOS status paths do not belong to this user's managed runtime")
	}
	if connectorRoot != p.ConnectorRoot || connectorStateRoot != p.StateRoot {
		return nil, errors.New("macOS connector status paths were not initialized for this runtime")
	}
	st, err := state.LoadFrom(p.ToolConfig, fsx.Current())
	if err != nil {
		return nil, errors.New("macOS setup state could not be read")
	}
	gw, err := macService(p, home, launchd.Gateway)
	if err != nil {
		return nil, err
	}
	op, err := macService(p, home, launchd.Operator)
	if err != nil {
		return nil, err
	}
	gwStatus, err := gw.Status(ctx)
	if err != nil {
		return nil, errors.New("gateway LaunchAgent status is unknown")
	}
	opStatus, err := op.Status(ctx)
	if err != nil {
		return nil, errors.New("operator LaunchAgent status is unknown")
	}
	instances, err := macStatusInstances(p.ConnectorRoot)
	if err != nil {
		return nil, err
	}
	var connectors []macInstanceStatus
	for _, inst := range instances {
		c, err := launchd.New(launchd.Config{Runner: runner, LaunchctlPath: "/bin/launchctl", UID: os.Geteuid(), HomeDir: home,
			ExecutablePath: p.ExecutablePath, CredentialsDirectory: inst.DirUnder(p.ConnectorRoot), StateDirectory: inst.DirUnder(p.StateRoot), Instance: inst})
		if err != nil {
			return nil, err
		}
		status, err := c.Status(ctx)
		if err != nil {
			return nil, errors.New("connector LaunchAgent status is unknown")
		}
		entry := macInstanceStatus{instanceStatus: instanceStatus{Name: inst.Label(), Unit: c.Label(), Active: status.Running}, Registered: status.Registered, DeviceKeyStorage: "keychain"}
		present, err := fsx.RequireRegular(linkPathOf(inst), 0o600, fsx.Current())
		if err != nil {
			return nil, errors.New("connector link metadata is not private and user-owned")
		}
		if present {
			lf, err := readLinkFile(inst)
			if err != nil || lf == nil {
				return nil, errors.New("connector link metadata could not be read")
			}
			entry.Link, entry.Openedbot, entry.RuntimeID = true, lf.Openedbot, lf.RuntimeID
			lc := lf.linkContext()
			if stored, ok := loadLinkContext(filepath.Join(inst.DirUnder(p.StateRoot), "link-context.json"), lf.RuntimeID); ok {
				lc = stored
			}
			entry.Environment, entry.Organization, entry.Owner = lc.Environment, lc.Organization.Name, lc.Owner.Email
			if store == nil {
				return nil, errors.New("macOS device key store is unavailable")
			}
			seed, readErr := store.Read(ctx, inst)
			accessible := readErr == nil && len(seed) == ed25519.SeedSize
			clear(seed)
			entry.DeviceKeyAccessible = &accessible
			if readErr != nil && !errors.Is(readErr, devicekeys.ErrNotFound) || readErr == nil && !accessible {
				entry.DeviceKeyError = "Keychain entry could not be read"
			}
		}
		refusal := filepath.Join(inst.DirUnder(p.StateRoot), linkRefusedMarker)
		entry.Refused, err = fsx.RequireRegular(refusal, 0o600, fsx.Current())
		if err != nil {
			return nil, errors.New("connector refusal state could not be read")
		}
		connectors = append(connectors, entry)
	}
	summary := map[string]any{
		"configured": st != nil, "service_manager": "launchd",
		"gateway_active": gwStatus.Running, "gateway_registered": gwStatus.Registered,
		"operator_active": opStatus.Running, "operator_registered": opStatus.Registered,
		"connector_active": connectors[0].Active, "link_present": connectors[0].Link, "connectors": connectors,
		"hardening": map[string]any{"supported": false}, "rollback_timer": nil,
		"auto_upgrade": map[string]any{"supported": false},
	}
	if st != nil {
		summary["state"] = st
	}
	return summary, nil
}

func macStatusInstances(root string) ([]layout.ConnectorInstance, error) {
	out := []layout.ConnectorInstance{layout.DefaultConnectorInstance}
	info, err := fsx.Lstat(root)
	if err != nil {
		return nil, errors.New("connector instances could not be inspected")
	}
	if !info.Exists {
		return out, nil
	}
	if !info.Dir || info.Symlink || info.Mode != 0o700 || info.Owner != fsx.Current() {
		return nil, errors.New("connector instances directory is not private and user-owned")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, errors.New("connector instances could not be listed")
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		inst, err := layout.ParseConnectorInstance(entry.Name())
		if err != nil || inst.IsDefault() {
			continue
		}
		present, err := fsx.RequireRegular(filepath.Join(inst.DirUnder(root), "link.json"), 0o600, fsx.Current())
		if err != nil {
			return nil, errors.New("named connector metadata is not private and user-owned")
		}
		if present {
			out = append(out, inst)
		}
	}
	return out, nil
}
