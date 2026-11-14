package commands

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/account"
	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

//go:embed lab_browser_fixture.py
var labBrowserProgram string

type labBrowserDirectoryIdentity struct {
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
}
type labBrowserBefore struct {
	DirectoryIdentity *labBrowserDirectoryIdentity `json:"directoryIdentity,omitempty"`
	BrowserPresent    bool                         `json:"browserPresent"`
	Fields            map[string]json.RawMessage   `json:"fields"`
}
type labBrowserReceipt struct {
	SidecarSpec          *labBrowserSidecarSpec     `json:"sidecarSpec,omitempty"`
	SidecarState         *labBrowserSidecarState    `json:"sidecarState,omitempty"`
	SidecarRequestedAtNS int64                      `json:"sidecarRequestedAtNs,omitempty"`
	SidecarURL           string                     `json:"sidecarUrl,omitempty"`
	ConfigRestored       bool                       `json:"configRestored"`
	SidecarFilesRemoved  bool                       `json:"sidecarFilesRemoved"`
	SchemaVersion        int                        `json:"schemaVersion"`
	RuntimeID            string                     `json:"runtimeId"`
	Nonce                string                     `json:"nonce"`
	Profile              string                     `json:"profile"`
	Phase                string                     `json:"phase"`
	LastProbeDiagnostic  *labBrowserProbeDiagnostic `json:"lastProbeDiagnostic,omitempty"`
	Before               *labBrowserBefore          `json:"before"`
	Owned                map[string]any             `json:"owned"`
	hermes.ChromiumAsset
}
type labBrowserPublicSidecar struct {
	Unit              string `json:"unit"`
	InvocationID      string `json:"invocationId"`
	PID               int    `json:"pid"`
	StartTicks        string `json:"startTicks"`
	Active            bool   `json:"active"`
	Stopped           bool   `json:"stopped"`
	ResourcesVerified bool   `json:"resourcesVerified"`
}
type labBrowserReply struct {
	Placement           string                   `json:"placement"`
	ConfigRestored      bool                     `json:"configRestored"`
	Sidecar             *labBrowserPublicSidecar `json:"sidecar"`
	SchemaVersion       int                      `json:"schemaVersion"`
	Kind                string                   `json:"kind"`
	Action              string                   `json:"action"`
	RuntimeID           string                   `json:"runtimeId"`
	Nonce               string                   `json:"nonce"`
	Profile             string                   `json:"profile"`
	Installed           bool                     `json:"installed"`
	Removed             bool                     `json:"removed"`
	Replayed            bool                     `json:"replayed"`
	PrivateURLException bool                     `json:"privateUrlException"`
	Backend             string                   `json:"backend"`
	hermes.ChromiumAsset
}
type labBrowserProbeDiagnostic struct {
	CDPReady       bool   `json:"cdpReady"`
	ReadinessError string `json:"readinessError"`
	Outcome        string `json:"outcome"`
	ExitCode       *int   `json:"exitCode"`
	Signal         *int   `json:"signal"`
	TimedOut       bool   `json:"timedOut"`
	StderrTail     string `json:"stderrTail"`
	Truncated      bool   `json:"truncated"`
}

type labBrowserWorker struct {
	ProfileAbsent   bool                       `json:"profileAbsent"`
	CDPURL          string                     `json:"cdpUrl"`
	ProbeDiagnostic *labBrowserProbeDiagnostic `json:"probeDiagnostic"`
	Before          *labBrowserBefore          `json:"before"`
	Installed       *bool                      `json:"installed"`
	Removed         *bool                      `json:"removed"`
}
type labBrowserDeps struct {
	PlanSidecar        func(context.Context, string, hermes.ChromiumAsset) (labBrowserSidecarSpec, error)
	StartSidecar       func(context.Context, labBrowserSidecarSpec) (labBrowserSidecarState, error)
	InspectSidecar     func(context.Context, labBrowserSidecarSpec) (labBrowserSidecarState, error)
	StopSidecar        func(context.Context, labBrowserSidecarSpec, labBrowserSidecarState) (labBrowserSidecarState, error)
	Target             labCrashDependencies
	StateDir           string
	SystemDependencies func(context.Context) error
	Ensure             func(context.Context) (hermes.ChromiumAsset, error)
	Run                func(context.Context, map[string]any) (labBrowserWorker, error)
}

func parseLabBrowser(env cli.Env, args []string) (labMCPOptions, error) {
	if len(args) == 0 || (args[0] != "setup" && args[0] != "receipts" && args[0] != "remove") {
		return labMCPOptions{}, errors.New("browser-fixture requires setup, receipts or remove")
	}
	fs := newFlagSet("lab browser-fixture", env)
	version := fs.Int("schema-version", 0, "require browser fixture evidence schema 2")
	yes, allow, output := fs.Bool("yes", false, "confirm owned fixture"), fs.Bool("allow-lab-fault", false, "allow development fixture"), fs.Bool("json", false, "write bounded JSON evidence")
	name, runtimeID, nonce, profile := fs.String("name", "", "connector"), fs.String("runtime-id", "", "exact runtime UUID"), fs.String("nonce", "", "fixture UUID"), fs.String("profile", "", "fresh owned e2e-* profile")
	if err := fs.Parse(args[1:]); err != nil {
		return labMCPOptions{}, err
	}
	if fs.NArg() != 0 || *version != 2 || !*yes || !*allow || !*output || !labUUID.MatchString(*runtimeID) || !labUUID.MatchString(*nonce) || !labMCPProfile.MatchString(*profile) {
		return labMCPOptions{}, errors.New("browser fixture requires --schema-version 2 --yes --allow-lab-fault --json and exact runtime/nonce/profile")
	}
	instance, err := layout.ParseConnectorInstance(*name)
	if err != nil {
		return labMCPOptions{}, err
	}
	return labMCPOptions{Action: args[0], Profile: *profile, Target: labCrashOptions{Instance: instance, RuntimeID: *runtimeID, Nonce: *nonce}}, nil
}

func runLabBrowserFixture(env cli.Env, args []string) int {
	options, err := parseLabBrowser(env, args)
	if err != nil {
		return fail(env, cli.ExitUsage, "%v", err)
	}
	if runtime.GOOS != "linux" {
		return fail(env, cli.ExitNotImpl, "lab browser fixtures require the managed Linux host")
	}
	if code := requireRoot(env); code != 0 {
		return code
	}
	if fsx.Exists(guard.Default(runner).Active()) || fsx.Exists(layout.ProxyActive) {
		return fail(env, cli.ExitRefused, "a host transaction is active")
	}
	unlock, err := lockUpgrade(layout.UpgradeLock)
	if err != nil {
		return fail(env, cli.ExitRefused, "host upgrade lock: %v", err)
	}
	defer unlock()
	ctx, cancel := ctxWithSignals()
	defer cancel()
	ctx, deadline := context.WithTimeout(ctx, 300*time.Second)
	defer deadline()
	deps := labBrowserDeps{Target: labCrashDependencies{Runner: runner, ReadLink: readLabCrashLink, Environment: labCrashEnvironment, Owner: fsx.Root}, StateDir: filepath.Join(layout.ToolStateDir, "lab-browser-fixtures"), Ensure: hermes.EnsureLabChromium}
	deps.PlanSidecar = func(ctx context.Context, nonce string, asset hermes.ChromiumAsset) (labBrowserSidecarSpec, error) {
		user, err := account.New(runner).Get(ctx, layout.ServiceUser)
		if err != nil || user == nil {
			return labBrowserSidecarSpec{}, errors.New("managed Hermes service account is unavailable")
		}
		return labBrowserSidecarSpec{Nonce: nonce, UID: user.UID, Asset: asset, LogToStderr: true, ShortTmpDir: true}, nil
	}
	deps.StartSidecar = func(ctx context.Context, spec labBrowserSidecarSpec) (labBrowserSidecarState, error) {
		return startLabBrowserSidecar(ctx, runner, spec)
	}
	deps.InspectSidecar = func(ctx context.Context, spec labBrowserSidecarSpec) (labBrowserSidecarState, error) {
		return inspectLabBrowserSidecar(ctx, runner, spec)
	}
	deps.StopSidecar = func(ctx context.Context, spec labBrowserSidecarSpec, state labBrowserSidecarState) (labBrowserSidecarState, error) {
		return stopLabBrowserSidecar(ctx, runner, spec, state)
	}
	deps.SystemDependencies = func(ctx context.Context) error { return hermes.EnsureLabChromiumDependencies(ctx, runner) }
	deps.Run = func(ctx context.Context, request map[string]any) (labBrowserWorker, error) {
		body, err := json.Marshal(request)
		if err != nil {
			return labBrowserWorker{}, err
		}
		command := hermes.CLIWith(layout.VenvBin+"/python", "-I", "-c", labBrowserProgram)
		command.Stdin = body
		command.Timeout = 20 * time.Second
		result, err := exec.Must(ctx, runner, command)
		if err != nil {
			return labBrowserWorker{}, errors.New("owned browser fixture worker refused; original receipt retained")
		}
		var out labBrowserWorker
		if len(result.Stdout) > 32768 || json.Unmarshal([]byte(result.Stdout), &out) != nil {
			return out, errors.New("browser fixture worker returned malformed evidence")
		}
		return out, nil
	}
	out, err := executeLabBrowser(ctx, options, deps)
	if err != nil {
		return fail(env, cli.ExitFailure, "lab browser fixture: %v", err)
	}
	if err := json.NewEncoder(env.Stdout).Encode(out); err != nil {
		return fail(env, cli.ExitFailure, "write browser evidence: %v", err)
	}
	return cli.ExitOK
}

func browserOwned(asset hermes.ChromiumAsset) map[string]any {
	return map[string]any{"allow_private_urls": true, "cloud_provider": "local", "use_gateway": false, "engine": "auto", "headed": false, "cdp_url": "", "user_data_dir": "", "use_real_profile": false, "chromium_args": []string{}, "executable_path": asset.Executable}
}

func executeLabBrowser(ctx context.Context, options labMCPOptions, deps labBrowserDeps) (*labBrowserReply, error) {
	if !labMCPProfile.MatchString(options.Profile) || (options.Action != "setup" && options.Action != "receipts" && options.Action != "remove") {
		return nil, errors.New("invalid owned browser action/profile")
	}
	if _, err := requireLabTarget(ctx, options.Target, deps.Target); err != nil {
		return nil, err
	}
	info, err := fsx.Lstat(deps.StateDir)
	if err != nil || (info.Exists && (!info.Dir || info.Symlink || info.Owner != deps.Target.Owner || info.Mode != 0o700)) {
		return nil, errors.New("private browser receipt directory is unsafe")
	}
	if !info.Exists {
		if options.Action != "setup" {
			return nil, errors.New("no owned browser receipt exists")
		}
		if err := fsx.EnsureDir(deps.StateDir, 0o700, deps.Target.Owner); err != nil {
			return nil, err
		}
	}
	// One receipt per profile refuses another nonce taking over a live fixture.
	path := filepath.Join(deps.StateDir, options.Profile+".json")
	data, err := fsx.ReadRegular(path, 0o600, deps.Target.Owner)
	replayed := err == nil
	var receipt labBrowserReceipt
	if errors.Is(err, os.ErrNotExist) && options.Action == "setup" {
		receipt = labBrowserReceipt{SchemaVersion: 1, RuntimeID: options.Target.RuntimeID, Nonce: options.Target.Nonce, Profile: options.Profile, Phase: "preparing"}
		if err = saveLabBrowser(path, receipt, deps.Target.Owner); err != nil {
			return nil, err
		}
	} else if err != nil || json.Unmarshal(data, &receipt) != nil {
		return nil, errors.New("no readable owned browser receipt exists")
	}
	if receipt.SchemaVersion != 1 || receipt.RuntimeID != options.Target.RuntimeID || receipt.Nonce != options.Target.Nonce || receipt.Profile != options.Profile {
		return nil, errors.New("browser receipt does not own this exact runtime/nonce/profile")
	}
	if receipt.Phase == "removed" {
		receipt.ConfigRestored = true
		if options.Action == "setup" {
			return nil, errors.New("removed browser fixture cannot be recreated")
		}
		return labBrowserResponse(options, &receipt, replayed, false, true), nil
	}
	if receipt.Phase != "preparing" && receipt.Phase != "installed" && receipt.Phase != "removing" {
		return nil, errors.New("invalid browser ownership phase")
	}
	if receipt.Before == nil {
		if options.Action != "setup" {
			if options.Action == "receipts" {
				return labBrowserResponse(options, &receipt, replayed, false, false), nil
			}
			receipt.Phase = "removed"
			receipt.ConfigRestored = true
			if err := saveLabBrowser(path, receipt, deps.Target.Owner); err != nil {
				return nil, err
			}
			return labBrowserResponse(options, &receipt, replayed, false, true), nil
		}
		observed, err := deps.Run(ctx, map[string]any{"action": "prepare", "profile": receipt.Profile})
		if err != nil {
			return nil, err
		}
		if observed.Before == nil || observed.Before.Fields == nil {
			return nil, errors.New("browser original fields were not captured")
		}
		receipt.Before = observed.Before
		if err := saveLabBrowser(path, receipt, deps.Target.Owner); err != nil {
			return nil, err
		}
	}
	return runLabBrowserLifecycle(ctx, options, deps, path, &receipt, replayed)
}

func labBrowserResponse(options labMCPOptions, receipt *labBrowserReceipt, replayed, installed, removed bool) *labBrowserReply {
	reply := &labBrowserReply{SchemaVersion: 2, Kind: "browser-fixture", Action: options.Action, RuntimeID: receipt.RuntimeID, Nonce: receipt.Nonce, Profile: receipt.Profile, Installed: installed, Removed: removed, Replayed: replayed, PrivateURLException: installed, Backend: "local", Placement: "user-unit", ConfigRestored: receipt.ConfigRestored, ChromiumAsset: receipt.ChromiumAsset}
	if state := receipt.SidecarState; state != nil && state.MainPID > 0 && state.InvocationID != "" {
		reply.Sidecar = &labBrowserPublicSidecar{Unit: state.Unit, InvocationID: state.InvocationID, PID: state.MainPID, StartTicks: state.StartTicks, Active: state.Running, Stopped: state.Stopped, ResourcesVerified: state.ResourcesVerified}
	}
	return reply
}

func saveLabBrowser(path string, receipt labBrowserReceipt, owner fsx.Owner) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	return fsx.WriteAtomic(path, data, 0o600, owner)
}

func validLabBrowserProbe(value *labBrowserProbeDiagnostic) bool {
	if value == nil || len(value.StderrTail) > 8192 || len(value.ReadinessError) > 250 {
		return false
	}
	for _, char := range value.StderrTail + value.ReadinessError {
		if char < 32 && char != '\n' && char != '\r' && char != '\t' || char > 126 {
			return false
		}
	}
	switch value.Outcome {
	case "succeeded", "failed", "timeout", "launch_failed":
	default:
		return false
	}
	if value.ExitCode != nil && (*value.ExitCode < 0 || *value.ExitCode > 255) || value.Signal != nil && (*value.Signal < 1 || *value.Signal > 127) || value.ExitCode != nil && value.Signal != nil {
		return false
	}
	if value.Outcome == "succeeded" {
		return value.CDPReady && !value.TimedOut && (value.ExitCode == nil && value.Signal == nil || value.ExitCode != nil && *value.ExitCode == 0 || value.Signal != nil && *value.Signal == 9)
	}
	if value.Outcome == "timeout" {
		return value.TimedOut && (value.ExitCode != nil || value.Signal != nil)
	}
	if value.Outcome == "failed" {
		return !value.TimedOut && (value.Signal != nil || value.ExitCode != nil)
	}
	return !value.TimedOut && value.ExitCode == nil && value.Signal == nil
}
