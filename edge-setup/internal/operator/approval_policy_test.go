package operator

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	hostexec "github.com/OpenedBot/openedbot/edge-setup/internal/exec"
	"github.com/OpenedBot/openedbot/edge-setup/internal/fsx"
)

type approvalPolicyRunner struct {
	root         string
	enableRuns   int
	cliEnables   int
	failReadback bool
}

func (r *approvalPolicyRunner) Run(_ context.Context, cmd hostexec.Cmd) (hostexec.Result, error) {
	if strings.Contains(strings.Join(cmd.Args, " "), "plugins enable") {
		r.cliEnables++
		return hostexec.Result{}, nil
	}
	if strings.Contains(cmd.Path, "python") && strings.Contains(strings.Join(cmd.Env, " "), "OPENEDBOT_APPROVAL_ENABLE=1") {
		r.enableRuns++
		config := filepath.Join(r.root, "profiles", "scout", "config.yaml")
		return hostexec.Result{}, os.WriteFile(config, []byte("plugins:\n  enabled:\n    - ohb_approval_policy\n"), 0o600)
	}
	if strings.Contains(cmd.Path, "python") {
		if r.failReadback && r.enableRuns > 0 {
			return hostexec.Result{}, os.ErrPermission
		}
		config := filepath.Join(r.root, "profiles", "scout", "config.yaml")
		data, err := os.ReadFile(config)
		if err != nil {
			return hostexec.Result{}, err
		}
		text := string(data)
		enabled := strings.Contains(text, "enabled:\n    - ohb_approval_policy")
		disabled := strings.Contains(text, "disabled:\n    - ohb_approval_policy")
		return hostexec.Result{Stdout: `{"enabled":` + strconv.FormatBool(enabled) + `,"disabled":` + strconv.FormatBool(disabled) + `}`}, nil
	}
	return hostexec.Result{}, nil
}

func TestApprovalPolicySetProvesPolicyAndOnlyFirstInstallMarksRestart(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, "profiles", "scout")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("plugins:\n  enabled: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &approvalPolicyRunner{root: root}
	marker := filepath.Join(root, "restart-pending")
	server := &Server{RestartMarker: marker, Now: func() time.Time { return time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC) }}
	service := approvalPolicyService{runtimeRoot: root, owner: fsx.Current(), runner: runner,
		command:        func(args ...string) hostexec.Cmd { return hostexec.Cmd{Path: "hermes", Args: args} },
		python:         func(args ...string) hostexec.Cmd { return hostexec.Cmd{Path: "python3", Args: args} },
		markPending:    server.markGatewayRestartPending,
		restartPending: func() bool { _, err := os.Stat(marker); return err == nil },
	}
	first, err := service.set(context.Background(), "scout", approvalPolicyAsk)
	markerBefore, markerErr := os.ReadFile(marker)
	if err != nil || markerErr != nil || first.Mode != approvalPolicyAsk || !first.PluginEnabled || first.Effective {
		t.Fatalf("first write: %#v, %v, marker error=%v", first, err, markerErr)
	}
	// No gateway answers the reload here, so the profile stays pending and the
	// later write retries the load (the enable program runs again); it must
	// not mark another restart.
	second, err := service.set(context.Background(), "scout", approvalPolicyBlock)
	markerAfter, markerErr := os.ReadFile(marker)
	if err != nil || markerErr != nil || second.Mode != approvalPolicyBlock || !second.PluginEnabled || second.Effective || string(markerAfter) != string(markerBefore) || runner.enableRuns != 2 || runner.cliEnables != 0 {
		t.Fatalf("later write: %#v, %v, marker error=%v enables=%d", second, err, markerErr, runner.enableRuns)
	}
	if _, err := service.state(context.Background(), "default"); err == nil {
		t.Fatal("default profile was accepted")
	}
}

func TestApprovalPolicyRestartMarkerSurvivesFailureAfterEnable(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, "profiles", "scout")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("plugins:\n  enabled: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "restart-pending")
	runner := &approvalPolicyRunner{root: root, failReadback: true}
	server := &Server{RestartMarker: marker}
	service := approvalPolicyService{runtimeRoot: root, owner: fsx.Current(), runner: runner,
		command:        func(args ...string) hostexec.Cmd { return hostexec.Cmd{Path: "hermes", Args: args} },
		python:         func(args ...string) hostexec.Cmd { return hostexec.Cmd{Path: "python3", Args: args} },
		markPending:    server.markGatewayRestartPending,
		restartPending: func() bool { _, err := os.Stat(marker); return err == nil },
	}
	if _, err := service.set(context.Background(), "scout", approvalPolicyAsk); err == nil {
		t.Fatal("read-back failure was accepted")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("restart marker was lost after partial enable: %v", err)
	}
	if runner.enableRuns != 1 {
		t.Fatalf("enable runs = %d", runner.enableRuns)
	}
}

func TestApprovalPolicyDisabledTakesPrecedenceOverEnabled(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, "profiles", "scout")
	if err := os.MkdirAll(filepath.Join(profile, "plugins", approvalPolicyPlugin), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("plugins:\n  enabled:\n    - ohb_approval_policy\n  disabled:\n    - ohb_approval_policy\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	policyPath := filepath.Join(profile, "plugins", approvalPolicyPlugin, "policy.json")
	if err := os.WriteFile(policyPath, []byte(`{"mode":"ask_writes"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	runner := &approvalPolicyRunner{root: root}
	service := approvalPolicyService{runtimeRoot: root, owner: fsx.Current(), runner: runner,
		command: func(args ...string) hostexec.Cmd { return hostexec.Cmd{Path: "hermes", Args: args} },
		python:  func(args ...string) hostexec.Cmd { return hostexec.Cmd{Path: "python3", Args: args} },
	}
	state, err := service.state(context.Background(), "scout")
	if err != nil {
		t.Fatal(err)
	}
	if state.PluginEnabled || state.Effective {
		t.Fatalf("disabled plugin reported active: %#v", state)
	}
}

func TestApprovalPolicyConfigScriptValidatesListsAndClearsDisabledEntry(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	program, err := approvalPolicyFiles.ReadFile("approval_policy_config.py")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	profile := filepath.Join(root, "profiles", "scout")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(profile, "config.yaml")
	if err := os.WriteFile(config, []byte("plugins:\n  enabled:\n    - ohb_approval_policy\n  disabled:\n    - ohb_approval_policy\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The host venv has no PyYAML: the program must go through Hermes' own
	// config API. This stand-in mirrors the four functions it imports, scoped
	// to HERMES_HOME like the real module; it may use PyYAML itself.
	stubs := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stubs, "hermes_cli"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stubs, "hermes_cli", "__init__.py"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	stub := "import os, yaml\n" +
		"def get_config_path():\n    return os.path.join(os.environ['HERMES_HOME'], 'config.yaml')\n" +
		"def load_config():\n    with open(get_config_path()) as f:\n        return yaml.safe_load(f) or {}\n" +
		"load_config_readonly = load_config\n" +
		"def save_config(data):\n    with open(get_config_path(), 'w') as f:\n        yaml.safe_dump(data, f)\n"
	if err := os.WriteFile(filepath.Join(stubs, "hermes_cli", "config.py"), []byte(stub), 0o600); err != nil {
		t.Fatal(err)
	}
	if exec.Command(python, "-c", "import yaml").Run() != nil {
		t.Skip("PyYAML unavailable for the hermes_cli stand-in")
	}
	run := func(clear bool) string {
		t.Helper()
		cmd := exec.Command(python, "-")
		cmd.Stdin = strings.NewReader(string(program))
		cmd.Env = append(os.Environ(), "OPENEDBOT_APPROVAL_ROOT="+root, "OPENEDBOT_APPROVAL_PROFILE=scout", "PYTHONPATH="+stubs)
		if clear {
			cmd.Env = append(cmd.Env, "OPENEDBOT_APPROVAL_ENABLE=1")
		}
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("approval config script: %v: %s", err, output)
		}
		return strings.TrimSpace(string(output))
	}
	// The answer also carries `load` (null on a read, the reload outcome on an
	// enable); this test only pins the enabled and disabled lists.
	lists := func(got string) string {
		t.Helper()
		var answer struct {
			Enabled  bool `json:"enabled"`
			Disabled bool `json:"disabled"`
		}
		if err := json.Unmarshal([]byte(got), &answer); err != nil {
			t.Fatalf("approval config answer %q: %v", got, err)
		}
		return fmt.Sprintf("enabled=%t disabled=%t", answer.Enabled, answer.Disabled)
	}
	if got := run(false); lists(got) != "enabled=true disabled=true" {
		t.Fatalf("conflicting configuration: %s", got)
	}
	if got := run(true); lists(got) != "enabled=true disabled=false" {
		t.Fatalf("disabled entry was not removed: %s", got)
	}
	if err := os.WriteFile(config, []byte("plugins:\n  enabled: invalid\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(python, "-")
	cmd.Stdin = strings.NewReader(string(program))
	cmd.Env = append(os.Environ(), "OPENEDBOT_APPROVAL_ROOT="+root, "OPENEDBOT_APPROVAL_PROFILE=scout", "PYTHONPATH="+stubs)
	if err := cmd.Run(); err == nil {
		t.Fatal("invalid plugin list was accepted")
	}
}

func TestApprovalPolicyPluginDecisionsAndFailClosedPolicyRead(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	plugin, err := approvalPolicyFiles.ReadFile("approval_policy_plugin/__init__.py")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	pluginPath := filepath.Join(root, "plugin.py")
	if err := os.WriteFile(pluginPath, plugin, 0o600); err != nil {
		t.Fatal(err)
	}
	program := `import importlib.util,json,pathlib,sys,types
root=pathlib.Path(sys.argv[1]); p=root/'policy.json'
ctx=types.SimpleNamespace(register_hook=lambda name,fn: setattr(ctx,'hook',fn))
spec=importlib.util.spec_from_file_location('plugin',sys.argv[2]); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); mod.register(ctx)
def result(mode,tool):
 p.write_text(json.dumps({'mode':mode})); return ctx.hook(tool)
decision=result('ask_writes','write_file'); assert decision['action']=='approve' and 'write_file' in decision['message']
assert result('ask_writes','skill_manage')['action']=='approve'
assert result('ask_writes','mcp_linear_search')['action']=='approve'
assert result('ask_writes','terminal') is None and result('ask_writes','read_file') is None
decision=result('block_writes','patch'); assert decision['action']=='block' and 'plan mode' in decision['message']
assert 'plan mode' in result('block_writes','cronjob')['message']
assert result('off','write_file') is None
p.unlink(); assert ctx.hook('write_file')['action']=='approve'
`
	cmd := exec.Command(python, "-c", program, root, pluginPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("plugin decision contract: %v\n%s", err, output)
	}
}

func TestApprovalPolicyRouteReadsAndWritesBackState(t *testing.T) {
	state := approvalPolicyState{Mode: approvalPolicyAsk, PluginEnabled: true, Effective: true}
	handler := approvalPolicyHandler(func(context.Context, string) (approvalPolicyState, error) { return state, nil },
		func(_ context.Context, _ string, request approvalPolicyRequest) (approvalPolicyState, error) {
			state.Mode = request.Mode
			if request.BlockedTools != nil {
				state.BlockedTools = *request.BlockedTools
			}
			return state, nil
		})
	get := httptest.NewRequest("GET", "/profiles/scout/approval-policy", nil)
	get.SetPathValue("slug", "scout")
	got := httptest.NewRecorder()
	handler.ServeHTTP(got, get)
	var decoded approvalPolicyState
	if got.Code != 200 || json.Unmarshal(got.Body.Bytes(), &decoded) != nil || decoded.Mode != approvalPolicyAsk {
		t.Fatalf("GET: %d %s", got.Code, got.Body.String())
	}
	put := httptest.NewRequest("PUT", "/profiles/scout/approval-policy", strings.NewReader(`{"mode":"block_writes"}`))
	put.SetPathValue("slug", "scout")
	got = httptest.NewRecorder()
	handler.ServeHTTP(got, put)
	if got.Code != 200 || !strings.Contains(got.Body.String(), `"mode":"block_writes"`) {
		t.Fatalf("PUT: %d %s", got.Code, got.Body.String())
	}
}

func TestApprovalPolicyWriteClassMatchesEmbeddedPlugin(t *testing.T) {
	plugin, err := approvalPolicyFiles.ReadFile("approval_policy_plugin/__init__.py")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range approvalPolicyWriteTools {
		if !strings.Contains(string(plugin), `"`+name+`"`) {
			t.Fatalf("plugin write class is missing %s", name)
		}
	}
}

func TestApprovalPolicyBlockedToolsAndGateIdentityAreReadBack(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, "profiles", "scout")
	if err := os.MkdirAll(profile, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("plugins:\n  enabled: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, "restart-pending")
	server := &Server{RestartMarker: marker}
	service := approvalPolicyService{runtimeRoot: root, owner: fsx.Current(), runner: &approvalPolicyRunner{root: root},
		command:        func(args ...string) hostexec.Cmd { return hostexec.Cmd{Path: "hermes", Args: args} },
		python:         func(args ...string) hostexec.Cmd { return hostexec.Cmd{Path: "python3", Args: args} },
		markPending:    server.markGatewayRestartPending,
		restartPending: func() bool { _, err := os.Stat(marker); return err == nil },
	}
	ctx := context.Background()
	blocked := []string{"write_file", "mcp:linear:create_issue"}
	state, err := service.write(ctx, "scout", approvalPolicyRequest{Mode: approvalPolicyAsk, BlockedTools: &blocked})
	if err != nil || !state.GateIdentity || !slices.Equal(state.BlockedTools, blocked) {
		t.Fatalf("write with blocked tools: %#v, %v", state, err)
	}
	// An API that only sends the mode keeps the list on file.
	state, err = service.set(ctx, "scout", approvalPolicyBlock)
	if err != nil || state.Mode != approvalPolicyBlock || !slices.Equal(state.BlockedTools, blocked) {
		t.Fatalf("mode-only write lost the blocked tools: %#v, %v", state, err)
	}
	empty := []string{}
	if state, err = service.write(ctx, "scout", approvalPolicyRequest{Mode: approvalPolicyAsk, BlockedTools: &empty}); err != nil || len(state.BlockedTools) != 0 {
		t.Fatalf("clearing the blocked tools: %#v, %v", state, err)
	}
	for _, invalid := range [][]string{{"Write File"}, {"write_file", "write_file"}, {"mcp:linear"}} {
		if _, err := service.write(ctx, "scout", approvalPolicyRequest{Mode: approvalPolicyAsk, BlockedTools: &invalid}); err == nil {
			t.Fatalf("invalid blocked tools %v were accepted", invalid)
		}
	}
	// A plugin file that drifted from the bundle no longer proves the identity.
	installed := filepath.Join(profile, "plugins", approvalPolicyPlugin, "__init__.py")
	if err := os.WriteFile(installed, []byte("# older plugin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if state, err = service.state(ctx, "scout"); err != nil || state.GateIdentity {
		t.Fatalf("a drifted plugin still claims the gate identity: %#v, %v", state, err)
	}
}

func TestApprovalPolicyRouteValidatesBlockedTools(t *testing.T) {
	var seen *[]string
	handler := approvalPolicyHandler(nil, func(_ context.Context, _ string, request approvalPolicyRequest) (approvalPolicyState, error) {
		seen = request.BlockedTools
		blocked := []string{}
		if request.BlockedTools != nil {
			blocked = *request.BlockedTools
		}
		return approvalPolicyState{Mode: request.Mode, PluginEnabled: true, GateIdentity: true, BlockedTools: blocked}, nil
	})
	put := func(body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("PUT", "/profiles/scout/approval-policy", strings.NewReader(body))
		request.SetPathValue("slug", "scout")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	if got := put(`{"mode":"ask_writes","blockedTools":["patch"]}`); got.Code != 200 || seen == nil || !slices.Equal(*seen, []string{"patch"}) || !strings.Contains(got.Body.String(), `"blockedTools":["patch"]`) {
		t.Fatalf("blocked tools PUT: %d %s", got.Code, got.Body.String())
	}
	if got := put(`{"mode":"ask_writes"}`); got.Code != 200 || seen != nil {
		t.Fatalf("mode-only PUT must not name a list: %d %v", got.Code, seen)
	}
	if got := put(`{"mode":"ask_writes","blockedTools":["rm -rf"]}`); got.Code != 400 {
		t.Fatalf("an invalid tool key was accepted: %d", got.Code)
	}
}
