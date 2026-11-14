package commands

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

type unlinkDeps struct {
	Stop, Inactive, Disable func(context.Context) error
	// Retire asks openedbot to revoke the runtime once the connector is
	// stopped, while the link still exists; it reports and never fails.
	Retire                func(context.Context)
	RuntimeCredentialPath string
	StateOwner            fsx.Owner
}

func runUnlink(env cli.Env, args []string) int {
	fs := newFlagSet("unlink", env)
	name := fs.String("name", "", "connector instance (default if omitted)")
	yes := fs.Bool("yes", false, "confirm removal of this local link")
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	inst, err := layout.ParseConnectorInstance(*name)
	if err != nil || fs.NArg() != 0 {
		return fail(env, cli.ExitUsage, "unlink takes only --name <instance> and --yes")
	}
	if !*yes {
		return fail(env, cli.ExitRefused, "unlink stops one connector and removes its local link; add --yes (nothing was changed)")
	}
	if code := prepareConnectorHost(env); code != 0 {
		return code
	}
	service, err := connectorService(inst)
	if err != nil {
		return fail(env, cli.ExitFailure, "connector service could not be inspected")
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	ctx, stop := context.WithTimeout(ctx, 60*time.Second)
	defer stop()
	deps := unlinkDeps{Stop: service.Stop, StateOwner: connectorOwner,
		Retire: func(ctx context.Context) { reportRetire(ctx, env, inst) }}
	if runtime.GOOS == "darwin" {
		cfg, err := connectorLaunchAgentConfig(inst)
		if err != nil {
			return fail(env, cli.ExitFailure, "connector LaunchAgent could not be inspected")
		}
		client, err := launchd.New(cfg)
		if err != nil {
			return fail(env, cli.ExitFailure, "connector LaunchAgent configuration is invalid")
		}
		deps.Inactive = func(ctx context.Context) error {
			status, err := client.Status(ctx)
			if err != nil || status.Registered || status.Running {
				return errors.New("connector LaunchAgent removal from the user domain was not proved")
			}
			return nil
		}
		deps.Disable = func(ctx context.Context) error {
			if err := removePrivateUnlinkFile(client.PlistPath(), fsx.Current()); err != nil {
				return errors.New("connector LaunchAgent plist could not be removed")
			}
			return deps.Inactive(ctx)
		}
		deps.RuntimeCredentialPath = filepath.Join(inst.DirUnder(connectorRoot), "runtime.env")
	} else {
		info, err := account.New(runner).Get(ctx, layout.ConnectorUser)
		if err != nil || info == nil || info.UID <= 0 || info.GID <= 0 {
			return fail(env, cli.ExitFailure, "connector state owner could not be verified")
		}
		deps.StateOwner = fsx.Owner{UID: info.UID, GID: info.GID}
		deps.Inactive = func(ctx context.Context) error { return proveSystemdUnlinkState(ctx, inst.Unit(), "is-active") }
		deps.Disable = func(ctx context.Context) error {
			if err := (systemd.Client{Runner: runner}).Disable(ctx, inst.Unit()); err != nil {
				return errors.New("connector unit could not be disabled")
			}
			return proveSystemdUnlinkState(ctx, inst.Unit(), "is-enabled")
		}
	}
	if err := unlinkInstance(ctx, inst, connectorOwner, deps); err != nil {
		return fail(env, cli.ExitFailure, "unlink: %v", err)
	}
	printf(env.Stdout, "local link %s removed; device key and Hermes data retained", inst.Label())
	return cli.ExitOK
}

func unlinkInstance(ctx context.Context, inst layout.ConnectorInstance, owner fsx.Owner, deps unlinkDeps) error {
	if _, err := layout.ParseConnectorInstance(string(inst)); err != nil || deps.Stop == nil || deps.Inactive == nil || deps.Disable == nil {
		return errors.New("unlink configuration is invalid")
	}
	for _, dir := range []struct {
		root, path string
		owner      fsx.Owner
	}{{connectorRoot, inst.DirUnder(connectorRoot), owner}, {connectorStateRoot, stateDirOf(inst), deps.StateOwner}} {
		if err := inspectUnlinkDirectory(dir.root, dir.path, dir.owner); err != nil {
			return errors.New("unlink instance directory is not private, regular and owned by this runtime")
		}
	}
	type unlinkFile struct {
		path  string
		owner fsx.Owner
	}
	files := []unlinkFile{{linkPathOf(inst), owner}}
	if deps.RuntimeCredentialPath != "" {
		if deps.RuntimeCredentialPath != filepath.Join(inst.DirUnder(connectorRoot), "runtime.env") {
			return errors.New("unlink runtime credential path is outside this instance")
		}
		files = append(files, unlinkFile{deps.RuntimeCredentialPath, owner})
	}
	for _, name := range []string{linkRefusedMarker, linkAdmittedMarker, "link-context.json", "link-token.json", "link-origin.json"} {
		files = append(files, unlinkFile{filepath.Join(stateDirOf(inst), name), deps.StateOwner})
	}
	for _, file := range files {
		if _, err := fsx.RequireRegular(file.path, 0o600, file.owner); err != nil {
			return errors.New("unlink metadata is not private, regular and owned by this runtime")
		}
	}
	if err := deps.Stop(ctx); err != nil {
		return errors.New("connector stop failed; stored link was preserved")
	}
	if err := deps.Inactive(ctx); err != nil {
		return errors.New("connector stop was not proved; stored link was preserved")
	}
	if deps.Retire != nil {
		deps.Retire(ctx)
	}
	if err := deps.Disable(ctx); err != nil {
		return errors.New("connector automatic start could not be disabled; stored link was preserved")
	}
	for _, file := range files {
		if err := removePrivateUnlinkFile(file.path, file.owner); err != nil {
			return errors.New("connector stopped but local unlink could not be completed")
		}
	}
	return nil
}

func inspectUnlinkDirectory(root, path string, owner fsx.Owner) error {
	if !filepath.IsAbs(root) || filepath.Clean(root) != root || filepath.Clean(path) != path {
		return errors.New("invalid unlink directory")
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("unlink directory is outside its namespace")
	}
	for current := root; ; {
		info, err := fsx.Lstat(current)
		if err != nil {
			return err
		}
		if info.Exists && (!info.Dir || info.Symlink || info.Mode&0o022 != 0 || (info.Owner != owner && info.Owner != fsx.Root)) {
			return errors.New("unlink directory is unsafe")
		}
		if current == path {
			if info.Exists && info.Owner != owner {
				return errors.New("unlink instance directory has another owner")
			}
			return nil
		}
		remainder, _ := filepath.Rel(current, path)
		current = filepath.Join(current, strings.Split(remainder, string(filepath.Separator))[0])
	}
}

func removePrivateUnlinkFile(path string, owner fsx.Owner) error {
	present, err := fsx.RequireRegular(path, 0o600, owner)
	if err != nil {
		return err
	}
	if !present {
		return nil
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	info, err := fsx.Lstat(path)
	if err != nil || info.Exists {
		return errors.New("unlink removal could not be read back")
	}
	return nil
}

// is-active/is-enabled nonzero can also mean a bus or permission error.
// Accept only the exact inactive/disabled states and their expected code.
func proveSystemdUnlinkState(ctx context.Context, unit, verb string) error {
	if verb != "is-active" && verb != "is-enabled" {
		return errors.New("invalid connector service proof")
	}
	res, err := (systemd.Client{Runner: runner}).Query(ctx, verb, unit, 10*time.Second)
	if err != nil || strings.TrimSpace(res.Stderr) != "" {
		return errors.New("connector service state is unknown")
	}
	value := strings.TrimSpace(res.Stdout)
	if verb == "is-active" && res.ExitCode == 3 && (value == "inactive" || value == "failed") {
		return nil
	}
	if verb == "is-enabled" && res.ExitCode == 1 && (value == "disabled" || value == "masked" || value == "masked-runtime") {
		return nil
	}
	return errors.New("connector service stop or disable was not proved")
}

func init() {
	cli.Register(cli.Command{Name: "unlink", Summary: "Stop and remove one local link, retaining its device key and Hermes data", Run: runUnlink})
}
