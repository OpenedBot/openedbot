package commands

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/operator"
)

type runtimeCLI struct {
	Command       func(...string) exec.Cmd
	Python        func(...string) exec.Cmd
	Env           operator.CredentialEnv
	Token         func() (string, error)
	Login         func(context.Context, string) (operator.Login, error)
	Probe         func() (operator.Probe, error)
	RestartMarker string
}

type legacyCredentialEnv struct{}

func (legacyCredentialEnv) SnapshotRootEnv() (map[string]string, error) {
	return hermes.SnapshotRuntimeEnv()
}
func (legacyCredentialEnv) SnapshotProfileEnv(profile string) (map[string]string, error) {
	return hermes.SnapshotNamedProfileEnv(profile)
}
func (legacyCredentialEnv) MirrorRuntimeEnvDelta(before, after map[string]string) error {
	return hermes.MirrorRuntimeEnvDelta(before, after)
}
func (legacyCredentialEnv) PreserveOwnProfileKeys(profile string, before, after map[string]string) error {
	return hermes.MarkNamedProfileOwnEnvDelta(profile, before, after)
}

func prepareRuntimeCLI(env cli.Env) int {
	if runtime.GOOS == "darwin" {
		return prepareConnectorHost(env)
	}
	return requireRoot(env)
}

func currentRuntimeCLI() (runtimeCLI, error) {
	home := ""
	if runtime.GOOS == "darwin" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return runtimeCLI{}, errors.New("macOS user home could not be resolved")
		}
	}
	return runtimeCLIFor(runtime.GOOS, home, runner)
}

// runtimeCLIFor selects one local host context. It does not install anything
// or run a process. Credential files and processes are read only when the
// selected operation calls their corresponding function.
func runtimeCLIFor(goos, home string, r exec.Runner) (runtimeCLI, error) {
	switch goos {
	case "linux":
		return runtimeCLI{Command: hermes.CLI, Python: func(args ...string) exec.Cmd { return hermes.CLIWith(filepath.Join(layout.VenvBin, "python"), args...) },
			Env: legacyCredentialEnv{}, Token: hermes.Token, Login: operator.StartHostLogin, RestartMarker: layout.GatewayRestartMarker,
			Probe: func() (operator.Probe, error) {
				if err := operator.InstallProbe(); err != nil {
					return nil, err
				}
				return operator.HostProbe(r), nil
			}}, nil
	case "darwin":
		p, err := layout.MacRuntime(home)
		if err != nil {
			return runtimeCLI{}, err
		}
		token := func() (string, error) { return readUserGatewayToken(p.RuntimeEnv) }
		host := func() (*operator.Server, error) {
			key, err := token()
			if err != nil {
				return nil, err
			}
			return operator.MacHost(r, key, operator.MacHostConfig{Home: home, Paths: p, Token: token}, nil)
		}
		return runtimeCLI{Command: func(args ...string) exec.Cmd { return operator.MacCommand(p, home, "hermes", args...) },
			Python: func(args ...string) exec.Cmd { return operator.MacCommand(p, home, "python", args...) }, RestartMarker: p.RestartMarker,
			Env: hermes.EnvStore{Root: p.RuntimeRoot, Owner: fsx.Current()}, Token: token,
			Login: func(ctx context.Context, provider string) (operator.Login, error) {
				srv, err := host()
				if err != nil {
					return nil, err
				}
				return srv.StartLogin(ctx, provider)
			},
			Probe: func() (operator.Probe, error) {
				srv, err := host()
				if err != nil {
					return nil, err
				}
				if srv.Probe == nil {
					return nil, errors.New("private macOS inventory program is missing or changed; run edge-setup up")
				}
				return srv.Probe, nil
			}}, nil
	default:
		return runtimeCLI{}, errors.New("runtime management supports Linux and macOS only")
	}
}

func mirrorRuntimeCLI(h runtimeCLI, before map[string]string) error {
	after, err := h.Env.SnapshotRootEnv()
	if err != nil {
		return err
	}
	return h.Env.MirrorRuntimeEnvDelta(before, after)
}
