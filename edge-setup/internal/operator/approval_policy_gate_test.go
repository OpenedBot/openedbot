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
	Name    string         `json:"name"`
	Tool    string         `json:"tool"`
	Args    map[string]any `json:"args"`
	Blocked []string       `json:"blocked,omitempty"`
}

var approvalGateCases = []approvalGateCase{
	{Name: "write_file", Tool: "write_file", Args: map[string]any{"path": "./notes/../notes/todo.md", "content": "hello"}},
	{Name: "write_file_empties", Tool: "write_file", Args: map[string]any{"path": "notes/todo.md", "content": ""}},
	{Name: "write_file_sensitive", Tool: "write_file", Args: map[string]any{"path": "/root/.ssh/authorized_keys", "content": "ssh-ed25519 AAAA"}},
	{Name: "patch_replace", Tool: "patch", Args: map[string]any{"mode": "replace", "path": "src/app.py", "old_string": "a", "new_string": "b"}},
	{Name: "patch_v4a_delete", Tool: "patch", Args: map[string]any{"mode": "patch", "patch": "*** Begin Patch\n*** Update File: src/a.py\n@@\n-x\n+y\n*** Delete File: src/b.py\n*** End Patch"}},
	{Name: "patch_unreadable", Tool: "patch", Args: map[string]any{"mode": "patch", "patch": "not a patch"}},
	{Name: "skill_delete", Tool: "skill_manage", Args: map[string]any{"action": "delete", "name": "plan"}},
	{Name: "send_message", Tool: "send_message", Args: map[string]any{"action": "send", "target": "telegram:42", "message": "hi"}},
	{Name: "execute_code", Tool: "execute_code", Args: map[string]any{"code": "print(1)"}},
	{Name: "cronjob", Tool: "cronjob", Args: map[string]any{"action": "create"}},
	{Name: "mcp", Tool: "mcp__linear__create_issue", Args: map[string]any{"title": "Bug", "api_token": "sk-fixturefixturefixture"}},
	{Name: "mcp_legacy_name", Tool: "mcp_old_server_search", Args: map[string]any{"q": "x"}},
	{Name: "mcp_large", Tool: "mcp__linear__create_issue", Args: map[string]any{"body": strings.Repeat("x", 2000)}},
	{Name: "mcp_unregistered", Tool: "mcp__ghost__tool", Args: map[string]any{}},
	{Name: "blocked", Tool: "write_file", Args: map[string]any{"path": "a.txt", "content": "x"}, Blocked: []string{"write_file"}},
}

// Stubs of the two Hermes modules the plugin imports: the tool registry
// (`mcp-<server>` toolsets) and the display redaction.
var approvalGateStubs = map[string]string{
	"tools/__init__.py": "",
	"tools/registry.py": `class _Registry:
    _toolsets = {"mcp__linear__create_issue": "mcp-linear", "mcp_old_server_search": "mcp-old_server"}
    def get_toolset_for_tool(self, name):
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
for case in json.load(sys.stdin):
    policy.write_text(json.dumps({'mode':'ask_writes','blocked_tools':case.get('blocked',[])}))
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
		Result struct {
			Action  string `json:"action"`
			Message string `json:"message"`
			RuleKey string `json:"rule_key"`
		} `json:"result"`
	}
	if err := json.Unmarshal(got, &results); err != nil || len(results) != len(approvalGateCases) {
		t.Fatalf("plugin gate driver output: %v\n%s", err, got)
	}
	for _, result := range results {
		message, ruleKey := result.Result.Message, result.Result.RuleKey
		lines := strings.Split(message, "\n")
		switch result.Name {
		case "blocked":
			if result.Result.Action != "block" || ruleKey != "" {
				t.Errorf("%s: a blocked tool must block without a gate: %+v", result.Name, result.Result)
			}
		case "mcp_unregistered":
			// No provable identity: no rule key, no descriptor, still a gate.
			if result.Result.Action != "approve" || ruleKey != "" || len(lines) != 1 {
				t.Errorf("%s: %+v", result.Name, result.Result)
			}
		default:
			if result.Result.Action != "approve" || !strings.HasPrefix(ruleKey, "ohb/v1/") || len(lines) != 2 || !strings.HasPrefix(lines[1], "ohb-gate/v1 ") {
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
