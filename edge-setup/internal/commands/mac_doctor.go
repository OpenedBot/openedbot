package commands

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/devicekeys"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/operator"
)

type macDoctorGateway interface {
	Health(context.Context) (int, error)
	RequireUnauthorizedWithoutBearer(context.Context) error
	Toolsets(context.Context) ([]string, error)
}

type macDoctorDeps struct {
	Store         devicekeys.Store
	Gateway       macDoctorGateway
	OperatorReady func(context.Context, string) error
}

func runMacDoctor(env cli.Env, args []string) int {
	fs := newFlagSet("doctor", env)
	if err := fs.Parse(args); err != nil {
		return cli.ExitUsage
	}
	if fs.NArg() != 0 {
		return fail(env, cli.ExitUsage, "doctor takes no positional argument")
	}
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
	token, err := connectorGatewayToken()
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS gateway credential could not be read; run edge-setup up first")
	}
	store, err := devicekeys.New()
	if err != nil {
		return fail(env, cli.ExitFailure, "macOS device key storage could not be inspected")
	}
	ctx, cancel := ctxWithSignals()
	defer cancel()
	ctx, stop := context.WithTimeout(ctx, 90*time.Second)
	defer stop()
	problems, warnings := collectMacDoctor(ctx, home, p, macDoctorDeps{Store: store, Gateway: gateway.Loopback(token), OperatorReady: proveMacOperator})
	for _, warning := range warnings {
		printf(env.Stdout, "doctor %s %s", env.Color.Yellow("!"), warning)
	}
	for _, problem := range problems {
		printf(env.Stdout, "doctor %s %s", env.Color.Red("✗"), problem)
	}
	if len(problems) > 0 {
		return cli.ExitFailure
	}
	printf(env.Stdout, "doctor %s user LaunchAgents active, gateway loopback-only, anonymous calls refused, multiplex and toolset policy confirmed, operator capabilities confirmed", env.Color.Green("✓"))
	return cli.ExitOK
}

func collectMacDoctor(ctx context.Context, home string, p layout.MacRuntimePaths, deps macDoctorDeps) ([]string, []string) {
	warnings := []string{"Linux host-policy and rootless-Docker checks are unavailable on macOS"}
	if deps.Gateway == nil || deps.OperatorReady == nil {
		return []string{"macOS runtime diagnostic dependencies are unavailable"}, warnings
	}
	summary, err := collectMacStatus(ctx, home, p, deps.Store)
	if err != nil {
		return []string{err.Error()}, warnings
	}
	var problems []string
	if !summary["configured"].(bool) {
		problems = append(problems, "runtime setup state is absent: run edge-setup up")
	}
	if !summary["gateway_active"].(bool) {
		problems = append(problems, "openedbot gateway LaunchAgent is not active")
	}
	if !summary["operator_active"].(bool) {
		problems = append(problems, "openedbot operator LaunchAgent is not active")
	}
	for _, entry := range summary["connectors"].([]macInstanceStatus) {
		if !entry.Link {
			if entry.Name == layout.DefaultConnectorInstance.Label() {
				warnings = append(warnings, "no connector link yet: run edge-setup link and enter its ticket at the hidden prompt")
			}
			continue
		}
		if entry.Refused {
			problems = append(problems, fmt.Sprintf("connector %s was refused by openedbot; pair it again", entry.Name))
		}
		if !entry.Active {
			problems = append(problems, fmt.Sprintf("connector %s LaunchAgent is not active although a link exists", entry.Name))
		}
		if entry.DeviceKeyAccessible == nil || !*entry.DeviceKeyAccessible {
			problems = append(problems, fmt.Sprintf("connector %s device key is inaccessible", entry.Name))
		}
	}
	listeners, err := runner.Run(ctx, exec.Cmd{Path: "/usr/sbin/lsof", Args: []string{"-nP", "-a", "-iTCP:8642", "-sTCP:LISTEN", "-Ffn"}, Timeout: 10 * time.Second})
	if err != nil || listeners.ExitCode != 0 || strings.TrimSpace(listeners.Stderr) != "" {
		problems = append(problems, "gateway listener inspection did not prove a loopback listener")
	} else if err := requireMacLoopbackListeners(listeners.Stdout); err != nil {
		problems = append(problems, err.Error())
	}
	command := operator.MacCommand(p, home, "hermes", "config", "get", "gateway.multiplex_profiles")
	command.Timeout = 15 * time.Second
	config, err := runner.Run(ctx, command)
	if err != nil || config.ExitCode != 0 || !strings.EqualFold(strings.TrimSpace(config.Stdout), "true") {
		problems = append(problems, "gateway.multiplex_profiles = true could not be confirmed")
	}
	status, err := deps.Gateway.Health(ctx)
	if err != nil || (status != 200 && status != 401 && status != 403) {
		problems = append(problems, "loopback gateway health could not be confirmed")
	}
	if err := deps.Gateway.RequireUnauthorizedWithoutBearer(ctx); err != nil {
		problems = append(problems, "loopback gateway did not prove refusal of anonymous calls")
	}
	names, err := deps.Gateway.Toolsets(ctx)
	if err != nil {
		problems = append(problems, "loopback gateway toolsets could not be read back")
	} else if err := gateway.RequireToolsetPolicy(names); err != nil {
		problems = append(problems, "loopback gateway toolset policy did not read back as requested")
	}
	if err := deps.OperatorReady(ctx, p.OperatorSocket); err != nil {
		problems = append(problems, "operator did not prove the required runtime capabilities")
	}
	return problems, warnings
}

func requireMacLoopbackListeners(output string) error {
	found := false
	processOpen, fileOpen, named := false, false, false
	for _, line := range strings.Split(output, "\n") {
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			pid, err := strconv.ParseUint(line[1:], 10, 31)
			if err != nil || pid == 0 || processOpen && (!fileOpen || !named) {
				return errors.New("gateway listener process could not be verified")
			}
			processOpen, fileOpen, named = true, false, false
			continue
		case 'f':
			_, err := strconv.ParseUint(line[1:], 10, 31)
			if err != nil || !processOpen || fileOpen && !named {
				return errors.New("gateway listener descriptor could not be verified")
			}
			fileOpen, named = true, false
			continue
		case 'n':
			if !processOpen || !fileOpen || named {
				return errors.New("gateway listener field order is unrecognized")
			}
		default:
			return errors.New("gateway listener output is unrecognized")
		}
		host, port, err := net.SplitHostPort(line[1:])
		if err != nil || port != "8642" {
			return errors.New("gateway listener address could not be verified")
		}
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return errors.New("gateway has a listener outside loopback")
		}
		found = true
		named = true
	}
	if !found || !fileOpen || !named {
		return errors.New("gateway has no verified loopback listener")
	}
	return nil
}
