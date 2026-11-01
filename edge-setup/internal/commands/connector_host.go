package commands

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/connectorsupervisor"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/launchd"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/state"
)

func connectorHostPaths() (layout.ConnectorHostPaths, string, error) {
	if runtime.GOOS == "linux" {
		paths, err := layout.ConnectorPaths("linux", "")
		return paths, "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return layout.ConnectorHostPaths{}, "", err
	}
	paths, err := layout.ConnectorPaths(runtime.GOOS, home)
	return paths, home, err
}

// prepareConnectorHost is called before connector-specific state is read.
// It does not create, move or remove files. Other Linux commands keep their
// established paths and privilege requirements.
func prepareConnectorHost(env cli.Env) int {
	if runtime.GOOS == "linux" {
		return requireRoot(env)
	}
	if runtime.GOOS != "darwin" {
		return fail(env, cli.ExitRefused, "connector service supports Linux and macOS only")
	}
	if os.Geteuid() == 0 {
		return fail(env, cli.ExitPrivilege, "the macOS connector runs as your logged-in user; run without sudo")
	}
	paths, _, err := connectorHostPaths()
	if err != nil {
		return fail(env, cli.ExitRefused, "%v", err)
	}
	connectorRoot, connectorStateRoot, connectorOwner = paths.ConnectorRoot, paths.StateRoot, fsx.Current()
	state.Path = paths.ToolConfig
	return 0
}

func connectorService(inst layout.ConnectorInstance) (connectorsupervisor.Service, error) {
	if runtime.GOOS == "linux" {
		return connectorsupervisor.Linux(runner, inst)
	}
	cfg, err := connectorLaunchAgentConfig(inst)
	if err != nil {
		return nil, err
	}
	return connectorsupervisor.Darwin(cfg)
}

func connectorLaunchAgentConfig(inst layout.ConnectorInstance) (launchd.Config, error) {
	paths, home, err := connectorHostPaths()
	if err != nil {
		return launchd.Config{}, err
	}
	present, err := fsx.RequireRegular(paths.ExecutablePath, 0o700, fsx.Current())
	if err != nil {
		return launchd.Config{}, err
	}
	if !present {
		return launchd.Config{}, errors.New("installed macOS connector binary is missing; run edge-setup up first")
	}
	return launchd.Config{Runner: runner, LaunchctlPath: "/bin/launchctl",
		UID: os.Geteuid(), HomeDir: home, ExecutablePath: paths.ExecutablePath,
		CredentialsDirectory: inst.DirUnder(paths.ConnectorRoot), StateDirectory: inst.DirUnder(paths.StateRoot), Instance: inst}, nil
}

func refreshConnectorDefinition(ctx context.Context, inst layout.ConnectorInstance, log func(string, ...any)) error {
	if runtime.GOOS == "linux" {
		return installConnectorUnit(ctx, log)
	}
	cfg, err := connectorLaunchAgentConfig(inst)
	if err != nil {
		return err
	}
	c, err := launchd.New(cfg)
	if err != nil {
		return err
	}
	for _, path := range []string{cfg.CredentialsDirectory, cfg.StateDirectory} {
		if err := fsx.EnsureDir(path, 0o700, fsx.Current()); err != nil {
			return err
		}
	}
	return c.Install()
}

// macOS reads this private credential directly; Linux uses the established
// systemd LoadCredential mapping from RuntimeEnv and needs no extra copy.
func persistConnectorRuntimeCredential(inst layout.ConnectorInstance, token string) error {
	if runtime.GOOS == "linux" {
		return nil
	}
	if !gateway.ValidToken(token) {
		return errors.New("invalid connector gateway credential")
	}
	return fsx.WriteAtomic(filepath.Join(inst.DirUnder(connectorRoot), "runtime.env"), []byte("API_SERVER_KEY="+token+"\n"), 0o600, connectorOwner)
}

func connectorOperatorSocket() (string, error) {
	paths, _, err := connectorHostPaths()
	return paths.OperatorSocket, err
}

func connectorGatewayToken() (string, error) {
	if runtime.GOOS == "linux" {
		return hermes.Token()
	}
	paths, _, err := connectorHostPaths()
	if err != nil {
		return "", err
	}
	return readUserGatewayToken(paths.RuntimeEnv)
}

func readUserGatewayToken(path string) (string, error) {
	present, err := fsx.RequireRegular(path, 0o600, fsx.Current())
	if err != nil {
		return "", err
	}
	if !present {
		return "", errors.New("connector gateway credentials are missing; run edge-setup up first")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	token := hermes.ReadToken(string(data))
	if !gateway.ValidToken(token) {
		return "", errors.New("connector gateway credentials contain no valid API_SERVER_KEY")
	}
	return token, nil
}

func loadConnectorState() (*state.File, error) {
	if runtime.GOOS == "darwin" {
		return state.LoadFrom(state.Path, connectorOwner)
	}
	return state.Load()
}
