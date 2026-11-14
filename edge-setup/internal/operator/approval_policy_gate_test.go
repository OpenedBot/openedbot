package operator

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

var updateGateGolden = flag.Bool("update", false, "rewrite golden files")

// The golden is read back by openedbot (`modules/execution/tests/gate-identity-golden.test.ts`),
// which must identify each gate exactly as it stands for: the plugin and its
// reader are twins and this file is their shared contract.
const approvalGateGolden = "../../test/golden/operator/approval_gates.json"

type approvalGateCase struct {
	Name    string   `json:"name"`
	Tool    string   `json:"tool"`
	Args    any      `json:"args"`
	Blocked []string `json:"blocked,omitempty"`
	Mode    string   `json:"mode,omitempty"`
	// The Hermes registry raises on this call's lookup.
	RegistryRaises bool `json:"registry_raises,omitempty"`
}

// A run key as openedbot signs it (`<run id>.<32 base64url>`): no descriptor may carry it.
const fixtureRunKey = "0b7c3a52-5d0e-4c55-9a4c-2b8d1f0e6a11.FixtureRunKeyFixtureRunKeyFixture"

var approvalGateCases = []approvalGateCase{
	{Name: "write_file", Tool: "write_file", Args: map[string]any{"path": "./notes/../notes/todo.md", "content": "hello"}},
	{Name: "write_file_empties", Tool: "write_file", Args: map[string]any{"path": "notes/todo.md", "content": ""}},
	{Name: "write_file_sensitive", Tool: "write_file", Args: map[string]any{"path": "/root/.ssh/authorized_keys", "content": "ssh-ed25519 AAAA"}},
	{Name: "patch_replace", Tool: "patch", Args: map[string]any{"mode": "replace", "path": "src/app.py", "old_string": "a", "new_string": "b"}},
	{Name: "patch_v4a_delete", Tool: "patch", Args: map[string]any{"mode": "patch", "patch": "*** Begin Patch\n*** Update File: src/a.py\n@@\n-x\n+y\n*** Delete File: src/b.py\n*** End Patch"}},
	{Name: "patch_unreadable", Tool: "patch", Args: map[string]any{"mode": "patch", "patch": "not a patch"}},
	{Name: "skill_single_create_023", Tool: "skill_manage", Args: map[string]any{"operations": []any{map[string]any{"action": "create", "name": "e2e-fixture-create", "content": "fixture-secret-content-not-in-descriptor"}}}},
	{Name: "skill_delete", Tool: "skill_manage", Args: map[string]any{"action": "delete", "name": "plan"}},
	{Name: "send_message", Tool: "send_message", Args: map[string]any{"action": "send", "target": "telegram:42", "message": "hi"}},
	{Name: "execute_code", Tool: "execute_code", Args: map[string]any{"code": "print(1)"}},
	{Name: "cronjob", Tool: "cronjob", Args: map[string]any{"action": "create"}},
	{Name: "mcp", Tool: "mcp__linear__create_issue", Args: map[string]any{"title": "Bug", "api_token": "sk-fixturefixturefixture"}},
	{Name: "mcp_legacy_name", Tool: "mcp_old_server_search", Args: map[string]any{"q": "x"}},
	{Name: "mcp_large", Tool: "mcp__linear__create_issue", Args: map[string]any{"body": strings.Repeat("x", 2000)}},
	{Name: "mcp_unregistered", Tool: "mcp__ghost__tool", Args: map[string]any{}},
	{Name: "blocked", Tool: "write_file", Args: map[string]any{"path": "a.txt", "content": "x"}, Blocked: []string{"write_file"}},
	// openedbot's routine tool: `list` reads and passes, every other call is a gate without its run key.
	{Name: "routine_list", Tool: routineTool, Args: map[string]any{"action": "list", "run_key": fixtureRunKey}},
	{Name: "routine_list_plan_mode", Tool: routineTool, Args: map[string]any{"action": "list", "run_key": fixtureRunKey}, Mode: "block_writes"},
	{Name: "routine_list_blocked", Tool: routineTool, Args: map[string]any{"action": "list", "run_key": fixtureRunKey}, Blocked: []string{"mcp:openedbot_routines:routine_manage"}},
	{Name: "routine_create", Tool: routineTool, Args: map[string]any{"action": "create", "run_key": fixtureRunKey, "name": "Weekly review", "prompt": "Ask what moved this week.", "schedule": "every monday at 9am", "timezone": "Europe/Paris"}},
	{Name: "routine_create_long_prompt", Tool: routineTool, Args: map[string]any{"action": "create", "run_key": fixtureRunKey, "name": "Weekly review", "prompt": strings.Repeat("é", 900), "schedule": "every monday at 9am", "timezone": "Europe/Paris"}},
	{Name: "routine_create_plan_mode", Tool: routineTool, Args: map[string]any{"action": "create", "run_key": fixtureRunKey, "name": "x", "prompt": "y", "schedule": "in 2m"}, Mode: "block_writes"},
	{Name: "routine_list_unclassified_case", Tool: routineTool, Args: map[string]any{"action": "LIST", "run_key": fixtureRunKey}},
	{Name: "routine_list_unclassified_type", Tool: routineTool, Args: map[string]any{"action": []any{"list"}, "run_key": fixtureRunKey}},
	{Name: "routine_list_unclassified_space", Tool: routineTool, Args: map[string]any{"action": "list ", "run_key": fixtureRunKey}},
	{Name: "routine_list_unclassified_zero_width", Tool: routineTool, Args: map[string]any{"action": "list\u200b", "run_key": fixtureRunKey}},
	{Name: "routine_list_unclassified_title", Tool: routineTool, Args: map[string]any{"action": "List", "run_key": fixtureRunKey}},
	{Name: "routine_list_unclassified_prefix", Tool: routineTool, Args: map[string]any{"action": "lists", "run_key": fixtureRunKey}},
	{Name: "routine_list_json_string", Tool: routineTool, Args: `{"action":"list","run_key":"` + fixtureRunKey + `"}`},
	{Name: "routine_list_registry_raises", Tool: routineTool, Args: map[string]any{"action": "list", "run_key": fixtureRunKey}, RegistryRaises: true},
	{Name: "routine_no_action", Tool: routineTool, Args: map[string]any{"run_key": fixtureRunKey}},
	{Name: "routine_no_args", Tool: routineTool, Args: nil},
	{Name: "routine_list_other_server", Tool: "mcp__other__routine_manage", Args: map[string]any{"action": "list"}},
	{Name: "bot_settings", Tool: "mcp__openedbot_bot_settings__bot_settings_propose", Args: map[string]any{"run_key": fixtureRunKey, "reason": "Shorter answers", "label": "Brief"}},
}

const routineTool = "mcp__openedbot_routines__routine_manage"

// The calls that pass without a gate: `routine_manage` reading, in every mode.
var ungatedReads = map[string]bool{"routine_list": true, "routine_list_plan_mode": true}

// Stubs of the two Hermes modules the plugin imports: the tool registry
// (`mcp-<server>` toolsets) and the display redaction.
var approvalGateStubs = map[string]string{
	"tools/__init__.py": "",
	"tools/registry.py": `class _Registry:
    raises = False
    _toolsets = {"mcp__linear__create_issue": "mcp-linear", "mcp_old_server_search": "mcp-old_server",
                 "mcp__openedbot_routines__routine_manage": "mcp-openedbot_routines",
                 "mcp__openedbot_bot_settings__bot_settings_propose": "mcp-openedbot_bot_settings",
                 "mcp__other__routine_manage": "mcp-other"}
    def get_toolset_for_tool(self, name):
        if self.raises:
            raise RuntimeError("registry unavailable")
        return self._toolsets.get(name)
registry = _Registry()
`,
	"agent/__init__.py": "",
	"agent/redact.py": `import re
def redact_sensitive_text(text, force=False):
    return re.sub(r"sk-[A-Za-z0-9]{8,}", "sk-***", text)
`,
}

const approvalGateDriver = `import importlib.util,json,pathlib,sys,types
root=pathlib.Path(sys.argv[1]); policy=root/'policy.json'
ctx=types.SimpleNamespace(register_hook=lambda name,fn: setattr(ctx,'hook',fn))
spec=importlib.util.spec_from_file_location('plugin',sys.argv[2]); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); mod.register(ctx)
out=[]
import tools.registry as reg
for case in json.load(sys.stdin):
    reg.registry.raises=case.get('registry_raises',False)
    policy.write_text(json.dumps({'mode':case.get('mode') or 'ask_writes','blocked_tools':case.get('blocked',[])}))
    out.append({'name':case['name'],'tool':case['tool'],'result':ctx.hook(case['tool'],args=case['args'])})
print(json.dumps(out,indent=2,sort_keys=True))
`

func TestApprovalPolicyPluginGateIdentityGolden(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	plugin, err := approvalPolicyFiles.ReadFile("approval_policy_plugin/__init__.py")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	pluginDir := filepath.Join(root, "plugin")
	stubs := filepath.Join(root, "stubs")
	for name, body := range map[string]string{filepath.Join(pluginDir, "__init__.py"): string(plugin)} {
		if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for name, body := range approvalGateStubs {
		path := filepath.Join(stubs, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	input, _ := json.Marshal(approvalGateCases)
	cmd := exec.Command(python, "-c", approvalGateDriver, pluginDir, filepath.Join(pluginDir, "__init__.py"))
	cmd.Stdin = bytes.NewReader(input)
	cmd.Env = append(os.Environ(), "PYTHONPATH="+stubs, "PYTHONDONTWRITEBYTECODE=1")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	got, err := cmd.Output()
	if err != nil {
		t.Fatalf("plugin gate driver: %v\n%s", err, stderr.String())
	}

	var results []struct {
		Name   string `json:"name"`
		Result *struct {
			Action  string `json:"action"`
			Message string `json:"message"`
			RuleKey string `json:"rule_key"`
		} `json:"result"`
	}
	if err := json.Unmarshal(got, &results); err != nil || len(results) != len(approvalGateCases) {
		t.Fatalf("plugin gate driver output: %v\n%s", err, got)
	}
	for _, result := range results {
		if ungatedReads[result.Name] {
			if result.Result != nil {
				t.Errorf("%s: a routine read passes without a gate: %+v", result.Name, result.Result)
			}
			continue
		}
		if result.Result == nil {
			t.Errorf("%s: every other call is gated or blocked", result.Name)
			continue
		}
		message, ruleKey := result.Result.Message, result.Result.RuleKey
		lines := strings.Split(message, "\n")
		if strings.Contains(message, fixtureRunKey) || strings.Contains(message, "run_key") {
			t.Errorf("%s: an openedbot run key never leaves the host in a gate: %s", result.Name, message)
		}
		switch result.Name {
		case "blocked", "routine_list_blocked", "routine_create_plan_mode":
			if result.Result.Action != "block" || ruleKey != "" {
				t.Errorf("%s: a blocked tool must block without a gate: %+v", result.Name, result.Result)
			}
		case "mcp_unregistered", "routine_list_registry_raises":
			// No provable identity: no rule key, no descriptor, still a gate.
			if result.Result.Action != "approve" || ruleKey != "" || len(lines) != 1 {
				t.Errorf("%s: %+v", result.Name, result.Result)
			}
		default:
			if result.Result.Action != "approve" || !strings.HasPrefix(ruleKey, "openedbot/v1/") || len(lines) != 2 || !strings.HasPrefix(lines[1], "openedbot-gate/v1 ") {
				t.Errorf("%s: an identified gate needs a rule key and one descriptor line: %+v", result.Name, result.Result)
				continue
			}
			fields := strings.SplitN(lines[1], " ", 3)
			if len(fields) != 3 || len(fields[2]) > 1024 || strings.Contains(fields[2], "sk-fixture") || strings.Contains(fields[2], "ssh-ed25519") {
				t.Errorf("%s: the descriptor is bounded and never carries a secret or a file content: %s", result.Name, lines[1])
			}
		}
	}

	if *updateGateGolden {
		if err := os.MkdirAll(filepath.Dir(approvalGateGolden), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(approvalGateGolden, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(approvalGateGolden)
	if err != nil {
		t.Fatalf("missing golden %s (run with -update): %v", approvalGateGolden, err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("plugin gates differ from %s (review, then run with -update)\n--- got ---\n%s", approvalGateGolden, got)
	}
}
