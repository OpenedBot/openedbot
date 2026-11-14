package operator

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

// MacHostConfig is installed local configuration, never relay input. The
// restart callback controls the one fixed openedbot gateway LaunchAgent only.
type MacHostConfig struct {
	Paths          layout.MacRuntimePaths
	Home           string
	Token          func() (string, error)
	RestartGateway func(context.Context) error
}

// MacCommand builds one direct user invocation with a private runtime home.
// Credentials are read from that home's files; they never enter its Env.
func MacCommand(paths layout.MacRuntimePaths, home, program string, args ...string) exec.Cmd {
	return exec.Cmd{Path: filepath.Join(paths.VenvBin, program), Args: append([]string(nil), args...), Dir: paths.RuntimeRoot,
		Env: []string{"HERMES_HOME=" + paths.RuntimeRoot, "HOME=" + home,
			"PATH=" + paths.VenvBin + ":" + paths.NodeBin + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
			"VIRTUAL_ENV=" + filepath.Dir(paths.VenvBin), "PYTHONUNBUFFERED=1", "TERM=dumb", "NO_COLOR=1"}}
}

func InstallMacProbe(paths layout.MacRuntimePaths) error {
	if err := fsx.EnsureDir(filepath.Dir(paths.Probe), 0o700, fsx.Current()); err != nil {
		return err
	}
	if err := fsx.WriteAtomic(paths.Probe, inventoryProbeScript, 0o600, fsx.Current()); err != nil {
		return err
	}
	if err := fsx.WriteAtomic(paths.OAuthProbe, mcpOAuthProbeScript, 0o600, fsx.Current()); err != nil {
		return err
	}
	return installA2APolicyFilesIfPresent(paths.RuntimeRoot, fsx.Current())
}

func macProbeInstalled(path string, content []byte) bool {
	valid, err := fsx.RequireRegular(path, 0o600, fsx.Current())
	if err != nil || !valid {
		return false
	}
	data, err := os.ReadFile(path)
	return err == nil && string(data) == string(content)
}

func MacHost(runner exec.Runner, token string, cfg MacHostConfig, logf func(string, ...any)) (*Server, error) {
	if runner == nil || cfg.Token == nil {
		return nil, errors.New("macOS operator dependencies are missing")
	}
	want, err := layout.MacRuntime(cfg.Home)
	if err != nil || cfg.Paths != want {
		return nil, errors.New("macOS operator paths do not belong to this user's managed runtime")
	}
	if !gateway.ValidToken(token) {
		return nil, errors.New("macOS operator gateway credential is invalid")
	}
	p := cfg.Paths
	connectorPaths, err := layout.ConnectorPaths("darwin", cfg.Home)
	if err != nil {
		return nil, err
	}
	cliPath := filepath.Join(p.VenvBin, "hermes")
	present, err := fsx.RequireRegular(cliPath, 0, fsx.Current())
	if err != nil || !present {
		return nil, errors.New("macOS operator Hermes CLI is not installed for this user")
	}
	info, err := os.Stat(cliPath)
	if err != nil || info.Mode().Perm()&0o111 == 0 {
		return nil, errors.New("macOS operator Hermes CLI is not executable")
	}
	cli := func(args ...string) exec.Cmd { return MacCommand(p, cfg.Home, "hermes", args...) }
	server := &Server{Runner: runner, HermesCommand: cli, CredentialEnv: hermes.EnvStore{Root: p.RuntimeRoot, Owner: fsx.Current()},
		DevelopmentCallbackOrigin: func(runtimeID string) (string, error) {
			return developmentCallbackOrigin(connectorPaths.ConnectorRoot, fsx.Current(), runtimeID)
		},
		Catalogue: func(ctx context.Context) ([]byte, error) { return gateway.Loopback(token).ModelOptions(ctx) },
		Inventory: func(ctx context.Context) ([]byte, error) { return gateway.Loopback(token).ToolsetInventory(ctx) },
		ProfileInventory: func(ctx context.Context, profile string) ([]byte, error) {
			return gateway.Loopback(token).ProfileToolsetInventory(ctx, profile)
		},
		ProfileCatalogue: func(ctx context.Context, profile string) ([]byte, error) {
			return gateway.Loopback(token).ProfileModelOptions(ctx, profile)
		},
		GatewayToken: cfg.Token, Logf: logf, RestartGateway: cfg.RestartGateway, InventoryRoots: InventoryRoots{RuntimeRoot: p.RuntimeRoot},
		GatewayHealthy:     func(ctx context.Context) error { return gateway.Loopback(token).WaitHealthy(ctx, HealthTimeout) },
		RestartMarker:      p.RestartMarker,
		SkillsOperationDir: filepath.Join(p.StateRoot, "skills-hub-operations"),
		Sessions: func(ctx context.Context, profile string, offset int) ([]byte, error) {
			return gateway.Loopback(token).Sessions(ctx, profile, offset)
		},
		A2ACard: func(ctx context.Context) (A2AAgentCard, error) {
			return readLoopbackA2ACard(ctx, runner)
		},
		A2AAudit: func(ctx context.Context, limit int) (a2aAuditSnapshot, error) {
			return readA2AAuditWithPolicyDenials(ctx, p.RuntimeRoot, limit)
		},
		StartLogin: func(ctx context.Context, provider string) (Login, error) {
			return startLoginWithSpec(ctx, cli("auth", "add", provider, "--no-browser"))
		},
		UsageProbe: hostUsageProbeWithCommand(runner, func(providers []string) exec.Cmd {
			legacy := usageProbeSpec(providers)
			// Only the fixed provider list is taken from the legacy selector.
			args := []string{"-"}
			for _, name := range usageProbeProviders {
				for _, requested := range providers {
					if name == requested {
						args = append(args, name)
						break
					}
				}
			}
			cmd := MacCommand(p, cfg.Home, "python", args...)
			cmd.Stdin = legacy.Stdin
			cmd.Timeout = legacy.Timeout
			return cmd
		}),
		ProviderSDKs: func(ctx context.Context) ([]hermes.ProviderSDKStatus, error) {
			return hermes.ProbeProviderSDKs(ctx, runner, filepath.Join(p.VenvBin, "python"))
		},
		// launchd does not expose systemd's activation timestamp. Unknown
		// remains unknown rather than inferring one from plist modification.
		GatewayActiveSince: func(context.Context) (time.Time, error) { return time.Time{}, nil },
	}
	policyCfg := a2aPolicyHostConfig{
		RuntimeRoot: p.RuntimeRoot, Owner: fsx.Current(), Runner: runner,
		Command:        func(string) exec.Cmd { return MacCommand(p, cfg.Home, "python") },
		ObserveProcess: observeA2APolicyProcess(p.RuntimeRoot, fsx.Current()),
	}
	policyCfg.ProbePeer = hostA2APolicyProver(policyCfg)
	wireA2APolicyServer(server, policyCfg)
	approvalPolicy := approvalPolicyService{
		runtimeRoot: p.RuntimeRoot, owner: fsx.Current(), runner: runner,
		command:        cli,
		python:         func(args ...string) exec.Cmd { return MacCommand(p, cfg.Home, "python", args...) },
		markPending:    server.markGatewayRestartPending,
		restartPending: func() bool { return restartMarkerPending(server.RestartMarker) },
	}
	server.ProfileToolsets = profileToolsetsApplier(runner, p.RuntimeRoot, approvalPolicy.python)
	server.ApprovalPolicyRead = approvalPolicy.state
	server.ApprovalPolicyWrite = approvalPolicy.write
	server.GatewayRestarted = approvalPolicy.gatewayRestarted
	if !macProbeInstalled(p.Probe, inventoryProbeScript) {
		return server, nil
	}
	server.Probe = hostProbeWithCommand(runner, func(verb string) exec.Cmd { return MacCommand(p, cfg.Home, "python", p.Probe, verb) })
	server.refreshMultiplex(context.Background())
	if macProbeInstalled(p.OAuthProbe, mcpOAuthProbeScript) {
		server.StartMCPOAuth = func(ctx context.Context, name, profile, redirect string) (OAuthFlow, error) {
			return startMCPOAuthWithSpec(ctx, name, profile, redirect, MacCommand(p, cfg.Home, "python", p.OAuthProbe), io.Discard)
		}
	}
	return server, nil
}
