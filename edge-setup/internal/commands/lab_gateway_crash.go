package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"runtime"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/gateway"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
	"github.com/OpenedBot/openedbot/edge-setup/internal/systemd"
)

var labUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type labCrashOptions struct {
	Instance  layout.ConnectorInstance
	RuntimeID string
	Nonce     string
}

type labCrashDependencies struct {
	Runner      exec.Runner
	ReadLink    func(layout.ConnectorInstance) (*LinkFile, error)
	Environment func(layout.ConnectorInstance, string) (string, error)
	Healthy     func(context.Context) error
	StateDir    string
	Owner       fsx.Owner
	Poll        time.Duration
}

func parseLabCrash(env cli.Env, args []string) (labCrashOptions, error) {
	var options labCrashOptions
	if len(args) == 0 || args[0] != "gateway-crash" {
		return options, errors.New("lab gateway-crash --yes --allow-lab-fault --runtime-id <UUID> --nonce <UUID> [--name <instance>] --json")
	}
	fs := newFlagSet("lab gateway-crash", env)
	yes := fs.Bool("yes", false, "confirm interruption of the dedicated development gateway")
	allow := fs.Bool("allow-lab-fault", false, "explicitly allow this single development fault")
	name := fs.String("name", "", "the only active connector instance (omit for default)")
	runtimeID := fs.String("runtime-id", "", "exact runtime UUID of that instance")
	nonce := fs.String("nonce", "", "unique UUID; a reserved nonce is never signalled twice")
	jsonOutput := fs.Bool("json", false, "write one process/restart evidence document")
	if err := fs.Parse(args[1:]); err != nil {
		return options, err
	}
	if fs.NArg() != 0 || !*yes || !*allow || !*jsonOutput {
		return options, errors.New("the lab fault requires --yes, --allow-lab-fault and --json, with no positional arguments")
	}
	if !labUUID.MatchString(*runtimeID) || !labUUID.MatchString(*nonce) {
		return options, errors.New("--runtime-id and --nonce must be canonical UUIDs")
	}
	instance, err := layout.ParseConnectorInstance(*name)
	if err != nil {
		return options, err
	}
	return labCrashOptions{Instance: instance, RuntimeID: *runtimeID, Nonce: *nonce}, nil
}

func runLab(env cli.Env, args []string) int {
	if len(args) > 0 && args[0] == "browser-fixture" {
		return runLabBrowserFixture(env, args[1:])
	}
	if len(args) > 0 && args[0] == "mcp-fixture" {
		return runLabMCPFixture(env, args[1:])
	}
	options, err := parseLabCrash(env, args)
	if err != nil {
		return fail(env, cli.ExitUsage, "%v (nothing was signalled)", err)
	}
	if runtime.GOOS != "linux" {
		return fail(env, cli.ExitNotImpl, "lab gateway-crash requires the managed Linux systemd gateway")
	}
	if code := requireRoot(env); code != 0 {
		return code
	}
	if fsx.Exists(guard.Default(runner).Active()) || fsx.Exists(layout.ProxyActive) {
		return fail(env, cli.ExitRefused, "a host transaction is active; no lab fault was injected")
	}
	unlock, err := lockUpgrade(layout.UpgradeLock)
	if err != nil {
		return fail(env, cli.ExitRefused, "host upgrade lock: %v", err)
	}
	defer unlock()
	ctx, cancel := ctxWithSignals()
	defer cancel()
	ctx, deadline := context.WithTimeout(ctx, 110*time.Second)
	defer deadline()
	evidence, err := executeLabGatewayCrash(ctx, options, labCrashDependencies{
		Runner: runner, ReadLink: readLabCrashLink, Environment: labCrashEnvironment,
		StateDir: filepath.Join(layout.ToolStateDir, "lab-gateway-crash"), Owner: fsx.Root, Poll: 100 * time.Millisecond,
		Healthy: func(ctx context.Context) error {
			token, err := hermes.Token()
			if err != nil {
				return errors.New("the gateway health credential could not be read")
			}
			return gateway.Loopback(token).WaitHealthy(ctx, 90*time.Second)
		},
	})
	if err != nil {
		// This includes post-signal failures. Do not use ExitRefused, whose
		// contract would claim that nothing was mutated.
		return fail(env, cli.ExitFailure, "lab gateway crash: %v; inspect edge-setup status before a new fault", err)
	}
	if err := json.NewEncoder(env.Stdout).Encode(evidence); err != nil {
		return fail(env, cli.ExitFailure, "write crash evidence: %v", err)
	}
	return cli.ExitOK
}

func readLabCrashLink(instance layout.ConnectorInstance) (*LinkFile, error) {
	data, err := fsx.ReadRegular(linkPathOf(instance), 0o600, connectorOwner)
	if err != nil {
		return nil, errors.New("the selected instance has no private owned link receipt")
	}
	var link LinkFile
	if json.Unmarshal(data, &link) != nil || link.Schema != 1 || link.RuntimeID == "" || link.LinkToken == "" || link.WSURL == "" {
		return nil, errors.New("the selected instance link receipt is invalid")
	}
	return &link, nil
}

func labCrashEnvironment(instance layout.ConnectorInstance, runtimeID string) (string, error) {
	// The overlay is the broker's latest context. Neither a missing nor a
	// corrupt overlay permits falling back to an older dev enrollment.
	path := filepath.Join(stateDirOf(instance), "link-context.json")
	data, err := fsx.ReadFile(path)
	if err == nil {
		var context linkContextFile
		if json.Unmarshal(data, &context) != nil || context.Schema != 1 || context.RuntimeID != runtimeID || context.Environment == "" {
			return "", errors.New("the latest connector environment receipt is invalid")
		}
		return context.Environment, nil
	}
	return "", fmt.Errorf("read latest connector environment receipt: %w", err)
}

func init() {
	cli.Register(cli.Command{Name: "lab", Summary: "Inject an explicitly confirmed fault into one development-only gateway", Run: runLab})
}

// Keep all mutation gates in the core too: callers and tests never bypass
// target/environment verification by invoking the executor directly.
func executeLabGatewayCrash(ctx context.Context, options labCrashOptions, deps labCrashDependencies) (*labCrashEvidence, error) {
	link, err := requireLabTarget(ctx, options, deps)
	if err != nil {
		return nil, err
	}
	sd := systemd.Client{Runner: deps.Runner}
	before, err := readLabGatewayProcess(ctx, sd)
	if err != nil {
		return nil, err
	}
	if deps.Healthy == nil || deps.Poll <= 0 {
		return nil, errors.New("bounded process and health probes are required")
	}
	if err := deps.Healthy(ctx); err != nil {
		return nil, errors.New("the gateway is not healthy before the fault")
	}
	reservation, err := reserveLabCrash(deps.StateDir, deps.Owner, options)
	if err != nil {
		return nil, err
	}
	defer reservation.Close()
	// Refresh both process and connector state immediately before signalling.
	if err := requireOnlyLabConnector(ctx, deps.Runner, options.Instance); err != nil {
		return nil, err
	}
	current, err := readLabGatewayProcess(ctx, sd)
	if err != nil || current != before {
		return nil, errors.New("the gateway changed during fault preflight; nothing was signalled")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := sd.Signal(ctx, layout.GatewayUnit, "SIGKILL"); err != nil {
		return nil, errors.New("the fixed gateway SIGKILL could not be confirmed; the nonce remains reserved")
	}
	after, err := waitLabGatewayRelaunch(ctx, sd, before, deps.Poll)
	if err != nil {
		return nil, err
	}
	if err := deps.Healthy(ctx); err != nil {
		return nil, errors.New("the new gateway process did not become healthy after the fault")
	}
	evidence := &labCrashEvidence{SchemaVersion: 1, Kind: "gateway-crash-restart", Nonce: options.Nonce,
		RuntimeID: link.RuntimeID, Signal: "SIGKILL", StoppedObserved: true, Healthy: true, Before: before, After: after}
	if err := reservation.Complete(evidence); err != nil {
		return nil, err
	}
	return evidence, nil
}

// Shared by the fixed local lab operations; no public operator verb is added.
func requireLabTarget(ctx context.Context, options labCrashOptions, deps labCrashDependencies) (*LinkFile, error) {
	if !labUUID.MatchString(options.RuntimeID) || !labUUID.MatchString(options.Nonce) {
		return nil, errors.New("runtime and nonce must be canonical UUIDs")
	}
	if _, err := layout.ParseConnectorInstance(string(options.Instance)); err != nil {
		return nil, err
	}
	link, err := deps.ReadLink(options.Instance)
	if err != nil || link == nil || link.RuntimeID != options.RuntimeID {
		return nil, errors.New("the selected connector does not own the requested runtime")
	}
	if link.Environment != "dev" {
		return nil, errors.New("the private enrollment receipt must attest the dev environment")
	}
	environment, err := deps.Environment(options.Instance, options.RuntimeID)
	if err != nil || environment != "dev" {
		return nil, errors.New("the latest connector context must attest the dev environment")
	}
	if err := requireOnlyLabConnector(ctx, deps.Runner, options.Instance); err != nil {
		return nil, err
	}
	return link, nil
}
