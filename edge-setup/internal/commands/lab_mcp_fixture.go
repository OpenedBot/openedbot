package commands

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/cli"
	"github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
	"github.com/OpenedBot/openedbot/edge-setup/internal/guard"
	"github.com/OpenedBot/openedbot/edge-setup/internal/hermes"
	"github.com/OpenedBot/openedbot/edge-setup/internal/layout"
)

//go:embed lab_mcp_fixture.py
var labMCPFixtureScript []byte

var labMCPProfile = regexp.MustCompile(`^e2e-[a-z0-9][a-z0-9-]{0,58}$`)

type labMCPOptions struct {
	Target          labCrashOptions
	Action, Profile string
}
type labMCPCall struct {
	Challenge string `json:"challenge"`
	Succeeded bool   `json:"succeeded"`
}
type labMCPProcess struct {
	PID        int    `json:"pid"`
	StartTicks string `json:"startTicks"`
	Running    bool   `json:"running"`
}
type labMCPResult struct {
	Installed bool            `json:"installed"`
	Online    bool            `json:"online"`
	Calls     []labMCPCall    `json:"calls"`
	Removed   bool            `json:"removed"`
	Processes []labMCPProcess `json:"processes"`
	Starts    int             `json:"starts"`
}
type labMCPReceipt struct {
	SchemaVersion int    `json:"schemaVersion"`
	RuntimeID     string `json:"runtimeId"`
	Nonce         string `json:"nonce"`
	Profile       string `json:"profile"`
	ServerName    string `json:"serverName"`
	Secret        string `json:"secret"`
	EntryHash     string `json:"entryHash"`
	State         string `json:"state"`
	labMCPResult
}
type labMCPReply struct {
	SchemaVersion int    `json:"schemaVersion"`
	Kind          string `json:"kind"`
	Action        string `json:"action"`
	RuntimeID     string `json:"runtimeId"`
	Nonce         string `json:"nonce"`
	Profile       string `json:"profile"`
	ServerName    string `json:"serverName"`
	ToolName      string `json:"toolName"`
	Secret        string `json:"secret,omitempty"`
	Replayed      bool   `json:"replayed"`
	labMCPResult
}
type labMCPDependencies struct {
	Target       labCrashDependencies
	StateDir     string
	ScriptPath   string
	ResolveEntry func(string, string) (string, error)
	Install      func() error
	Run          func(context.Context, map[string]any) (labMCPResult, error)
}

func validLabMCPAction(action string) bool {
	switch action {
	case "setup", "online", "offline", "receipts", "remove":
		return true
	}
	return false
}

func parseLabMCP(env cli.Env, args []string) (labMCPOptions, error) {
	var options labMCPOptions
	if len(args) == 0 || !validLabMCPAction(args[0]) {
		return options, errors.New("mcp-fixture requires setup, online, offline, receipts or remove")
	}
	fs := newFlagSet("lab mcp-fixture", env)
	yes, allow, output := fs.Bool("yes", false, "confirm the owned lab fixture"), fs.Bool("allow-lab-fault", false, "allow this development fixture"), fs.Bool("json", false, "write bounded JSON evidence")
	name, runtimeID, nonce, profile := fs.String("name", "", "connector instance"), fs.String("runtime-id", "", "exact runtime UUID"), fs.String("nonce", "", "fixture UUID"), fs.String("profile", "", "fresh E2E profile explicitly owned by the runner")
	if err := fs.Parse(args[1:]); err != nil {
		return options, err
	}
	if fs.NArg() != 0 || !*yes || !*allow || !*output || !labUUID.MatchString(*runtimeID) || !labUUID.MatchString(*nonce) || !labMCPProfile.MatchString(*profile) {
		return options, errors.New("the fixture requires explicit --yes --allow-lab-fault --json, canonical runtime/nonce UUIDs and an e2e-* profile")
	}
	instance, err := layout.ParseConnectorInstance(*name)
	if err != nil {
		return options, err
	}
	return labMCPOptions{Target: labCrashOptions{Instance: instance, RuntimeID: *runtimeID, Nonce: *nonce}, Action: args[0], Profile: *profile}, nil
}

func runLabMCPFixture(env cli.Env, args []string) int {
	options, err := parseLabMCP(env, args)
	if err != nil {
		return fail(env, cli.ExitUsage, "%v", err)
	}
	if runtime.GOOS != "linux" {
		return fail(env, cli.ExitNotImpl, "lab MCP fixtures require the managed Linux host")
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
	ctx, deadline := context.WithTimeout(ctx, 85*time.Second)
	defer deadline()
	sum := sha256.Sum256(labMCPFixtureScript)
	scriptPath := filepath.Join(layout.ToolInstallDir, "lab-mcp-fixture-"+hex.EncodeToString(sum[:8])+".py")
	deps := labMCPDependencies{Target: labCrashDependencies{Runner: runner, ReadLink: readLabCrashLink, Environment: labCrashEnvironment, Owner: fsx.Root}, StateDir: filepath.Join(layout.ToolStateDir, "lab-mcp-fixtures"), ScriptPath: scriptPath}
	deps.ResolveEntry = func(hash, nonce string) (string, error) {
		return resolveLabMCPEntry(layout.ToolInstallDir, scriptPath, hash, nonce, fsx.Root)
	}
	deps.Install = func() error { return installLabMCPScript(scriptPath) }
	deps.Run = func(ctx context.Context, request map[string]any) (labMCPResult, error) {
		body, _ := json.Marshal(request)
		command := hermes.CLIWith(layout.VenvBin+"/python", scriptPath, "control")
		command.Stdin, command.Timeout = body, 80*time.Second
		result, err := exec.Must(ctx, runner, command)
		if err != nil {
			return labMCPResult{}, errors.New("the owned MCP fixture worker failed; output withheld and ownership receipt retained")
		}
		return parseLabMCPResult(result.Stdout)
	}
	reply, err := executeLabMCP(ctx, options, deps)
	if err != nil {
		return fail(env, cli.ExitFailure, "lab MCP fixture: %v", err)
	}
	if err := json.NewEncoder(env.Stdout).Encode(reply); err != nil {
		return fail(env, cli.ExitFailure, "write fixture evidence: %v", err)
	}
	return cli.ExitOK
}

func installLabMCPScript(path string) error {
	info, err := fsx.Lstat(filepath.Dir(path))
	if err != nil || !info.Exists || !info.Dir || info.Symlink || info.Owner != fsx.Root || info.Mode&0o022 != 0 {
		return errors.New("the fixed fixture script directory is not safely owned by the installer")
	}
	data, err := fsx.ReadRegular(path, 0o644, fsx.Root)
	if err == nil {
		if string(data) != string(labMCPFixtureScript) {
			return errors.New("the fixed fixture script changed ownership/content")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return errors.New("the fixed fixture script is unsafe")
	}
	return fsx.WriteAtomic(path, labMCPFixtureScript, 0o644, fsx.Root)
}

func labMCPEntryHash(path, nonce string) string {
	body, _ := json.Marshal(map[string]any{"command": layout.VenvBin + "/python", "args": []string{path, "serve", nonce}})
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func newLabMCPReceipt(options labMCPOptions, path string) (*labMCPReceipt, error) {
	var proof [16]byte
	if _, err := rand.Read(proof[:]); err != nil {
		return nil, err
	}
	return &labMCPReceipt{SchemaVersion: 1, RuntimeID: options.Target.RuntimeID, Nonce: options.Target.Nonce, Profile: options.Profile, ServerName: "e2e_" + strings.ReplaceAll(options.Target.Nonce, "-", ""), Secret: "MCP_" + hex.EncodeToString(proof[:]), EntryHash: labMCPEntryHash(path, options.Target.Nonce), State: "preparing", labMCPResult: labMCPResult{Calls: []labMCPCall{}, Processes: []labMCPProcess{}}}, nil
}
