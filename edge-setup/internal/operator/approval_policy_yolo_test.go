package operator

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenedBot/openedbot/edge-setup/internal/yolohardline"
)

// The plugin under a YOLO lease, run by python3 as Hermes would: each case
// writes policy.json and yolo.json (or breaks them), calls the hook, and
// reports its answer and what reached the spool.
const yoloPluginDriver = `import importlib.util,json,os,pathlib,shutil,sys,types
plugin_dir=pathlib.Path(sys.argv[1])
ctx=types.SimpleNamespace(register_hook=lambda name,fn: setattr(ctx,'hook',fn))
spec=importlib.util.spec_from_file_location('plugin',sys.argv[2]); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); mod.register(ctx)
spool=plugin_dir/'yolo-audit.jsonl'
out=[]
for case in json.load(sys.stdin):
    (plugin_dir/'policy.json').write_text(json.dumps({'mode':case.get('mode','ask_writes')}))
    yolo=plugin_dir/'yolo.json'
    if yolo.exists(): yolo.unlink()
    if case.get('yolo') == 'corrupt': yolo.write_text('{"v":1,"leases":[{')
    elif case.get('yolo') is not None: yolo.write_text(json.dumps(case['yolo']))
    if spool.is_dir(): shutil.rmtree(spool)
    elif spool.exists(): spool.unlink()
    if case.get('spoolBlocked'): spool.mkdir()
    kwargs={'args':case['args']}
    if case.get('session'): kwargs['session_id']=case['session']
    result=ctx.hook(case['tool'],**kwargs)
    lines=spool.read_text().splitlines() if spool.is_file() else []
    out.append({'name':case['name'],'result':result,'spool':[json.loads(l) for l in lines]})
verdicts=[mod._yolo_verdict(mod._rules(plugin_dir),{'deny':c['deny'],'protect':[]},c.get('tool'),c.get('paths',[]),c.get('command')) for c in json.loads(sys.argv[3])]
print(json.dumps({'cases':out,'verdicts':verdicts}))
`

type yoloPluginCase struct {
	Name         string         `json:"name"`
	Tool         string         `json:"tool"`
	Args         map[string]any `json:"args"`
	Session      string         `json:"session,omitempty"`
	Mode         string         `json:"mode,omitempty"`
	Yolo         any            `json:"yolo"`
	SpoolBlocked bool           `json:"spoolBlocked,omitempty"`
	// want: "pass", "ask" (an approval gate) or "block".
	want string
}

func yoloDoc(scope string, profile, sessionID any, from, until int64, deny yolohardline.Deny) map[string]any {
	key := any(nil)
	if s, ok := sessionID.(string); ok {
		key = sessionKeyOf(s)
	}
	return map[string]any{"v": 1, "leases": []any{map[string]any{
		"leaseId": "5d0c7f3e-9a41-4b7e-8c2d-3f6a1b0e9d01", "scope": scope, "profile": profile, "sessionKey": key,
		"notBefore": from, "expiresAt": until, "deny": deny, "protect": yolohardline.DefaultProtect(),
	}}}
}

func TestApprovalPolicyPluginYoloMode(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	plugin, err := approvalPolicyFiles.ReadFile("approval_policy_plugin/__init__.py")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	pluginDir := filepath.Join(root, "profiles", "designer", "plugins", approvalPolicyPlugin)
	stubs := filepath.Join(root, "stubs")
	for path, body := range map[string][]byte{
		filepath.Join(pluginDir, "__init__.py"):   plugin,
		filepath.Join(pluginDir, "hardline.json"): yolohardline.JSON,
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, body, 0o600); err != nil {
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
	now := time.Now().Unix()
	deny := yolohardline.Deny{Commands: []string{"git push --force"}, Tools: []string{"send_message"}, Paths: []string{".aws"}}
	bot := yoloDoc("bot", "designer", nil, now-60, now+3600, deny)
	write := map[string]any{"path": "/tmp/build/out.txt", "content": "x"}
	cases := []yoloPluginCase{
		{Name: "no lease asks", Tool: "write_file", Args: write, want: "ask"},
		{Name: "bot lease passes a write", Tool: "write_file", Args: write, Yolo: bot, want: "pass"},
		{Name: "protected path", Tool: "write_file", Args: map[string]any{"path": "app/.env", "content": "K=v"}, Yolo: bot, want: "block"},
		{Name: "hardline tool", Tool: "cronjob", Args: map[string]any{"action": "create"}, Yolo: bot, want: "block"},
		{Name: "lease widening itself", Tool: "write_file", Args: map[string]any{"path": "plugins/ohb_approval_policy/yolo.json", "content": "{}"}, Yolo: bot, want: "block"},
		{Name: "deny-listed tool", Tool: "send_message", Args: map[string]any{"action": "send", "target": "telegram:1", "message": "hi"}, Yolo: bot, want: "block"},
		{Name: "deny-listed path", Tool: "write_file", Args: map[string]any{"path": "/home/me/.aws/config", "content": "x"}, Yolo: bot, want: "block"},
		{Name: "other bot's lease", Tool: "write_file", Args: write, Yolo: yoloDoc("bot", "writer", nil, now-60, now+3600, deny), want: "ask"},
		{Name: "runtime lease", Tool: "write_file", Args: write, Yolo: yoloDoc("runtime", nil, nil, now-60, now+3600, deny), want: "pass"},
		{Name: "thread lease, its session", Tool: "write_file", Args: write, Session: "sess-1", Yolo: yoloDoc("thread", "designer", "sess-1", now-60, now+3600, deny), want: "pass"},
		{Name: "thread lease, another session", Tool: "write_file", Args: write, Session: "sess-2", Yolo: yoloDoc("thread", "designer", "sess-1", now-60, now+3600, deny), want: "ask"},
		{Name: "thread lease, no session", Tool: "write_file", Args: write, Yolo: yoloDoc("thread", "designer", "sess-1", now-60, now+3600, deny), want: "ask"},
		{Name: "expired lease", Tool: "write_file", Args: write, Yolo: yoloDoc("bot", "designer", nil, now-7200, now-1, deny), want: "ask"},
		{Name: "not yet valid", Tool: "write_file", Args: write, Yolo: yoloDoc("bot", "designer", nil, now+60, now+3600, deny), want: "ask"},
		{Name: "corrupted yolo.json", Tool: "write_file", Args: write, Yolo: "corrupt", want: "ask"},
		{Name: "audit unwritable", Tool: "write_file", Args: write, Yolo: bot, SpoolBlocked: true, want: "ask"},
		{Name: "unreadable patch", Tool: "patch", Args: map[string]any{"mode": "patch", "patch": "not a patch"}, Yolo: bot, want: "ask"},
		{Name: "plan mode wins", Tool: "write_file", Args: write, Mode: "block_writes", Yolo: bot, want: "block"},
		{Name: "terminal hardline", Tool: "terminal", Args: map[string]any{"command": "rm -rf /"}, Yolo: bot, want: "block"},
		{Name: "terminal deny-list", Tool: "terminal", Args: map[string]any{"command": "git push --force origin"}, Yolo: bot, want: "block"},
		{Name: "terminal plain", Tool: "terminal", Args: map[string]any{"command": "ls -la"}, Yolo: bot, want: "pass"},
		{Name: "terminal without lease", Tool: "terminal", Args: map[string]any{"command": "rm -rf /"}, want: "pass"},
		{Name: "code reading a key", Tool: "execute_code", Args: map[string]any{"code": "open('/root/.ssh/id_ed25519').read()"}, Yolo: bot, want: "block"},
	}
	// Parity: the Python verdicts are the Go ones (internal/yolohardline).
	type parityCase struct {
		Tool    string            `json:"tool,omitempty"`
		Paths   []string          `json:"paths,omitempty"`
		Command *string           `json:"command"`
		Deny    yolohardline.Deny `json:"deny"`
	}
	var parity []parityCase
	var hard struct {
		Cases []struct{ Kind, Input string } `json:"cases"`
	}
	if err := json.Unmarshal(yolohardline.JSON, &hard); err != nil {
		t.Fatal(err)
	}
	for _, c := range hard.Cases {
		p := parityCase{Deny: deny}
		switch c.Kind {
		case "command":
			p.Command = &c.Input
		case "path":
			p.Paths = []string{c.Input}
		case "tool":
			p.Tool = c.Input
		}
		parity = append(parity, p)
	}
	for _, command := range []string{"cd x && sudo git push --force", "git push origin", "echo 'open", "cp a ~/.hermes/profiles/x/plugins/ohb_approval_policy/policy.json"} {
		parity = append(parity, parityCase{Command: &command, Deny: deny})
	}
	parityJSON, _ := json.Marshal(parity)
	input, _ := json.Marshal(cases)
	cmd := exec.Command(python, "-c", yoloPluginDriver, pluginDir, filepath.Join(pluginDir, "__init__.py"), string(parityJSON))
	cmd.Stdin = bytes.NewReader(input)
	cmd.Env = append(os.Environ(), "PYTHONPATH="+stubs, "PYTHONDONTWRITEBYTECODE=1")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	got, err := cmd.Output()
	if err != nil {
		t.Fatalf("yolo driver: %v\n%s", err, stderr.String())
	}
	var out struct {
		Cases []struct {
			Name   string                   `json:"name"`
			Result *struct{ Action string } `json:"result"`
			Spool  []map[string]any         `json:"spool"`
		} `json:"cases"`
		Verdicts []*string `json:"verdicts"`
	}
	if err := json.Unmarshal(got, &out); err != nil || len(out.Cases) != len(cases) || len(out.Verdicts) != len(parity) {
		t.Fatalf("driver output: %v\n%s", err, got)
	}
	for i, c := range cases {
		r := out.Cases[i]
		action := "pass"
		if r.Result != nil {
			action = map[string]string{"approve": "ask", "block": "block"}[r.Result.Action]
		}
		if action != c.want {
			t.Errorf("%s: got %s (%+v), want %s", c.Name, action, r.Result, c.want)
		}
		// Exactly the passed writes reach the spool, hashes only.
		wantSpool := action == "pass" && c.Tool != "terminal"
		if wantSpool != (len(r.Spool) == 1) {
			t.Errorf("%s: spool %v", c.Name, r.Spool)
		}
		if len(r.Spool) == 1 {
			line := r.Spool[0]
			raw, _ := json.Marshal(line)
			if line["v"] != float64(1) || line["gateKind"] != "plugin_tool" || line["toolKey"] != c.Tool || len(line["argsHash"].(string)) != 64 || strings.Contains(string(raw), "/tmp/build") {
				t.Errorf("%s: spool line %s", c.Name, raw)
			}
		}
	}
	for i, p := range parity {
		s := yolohardline.Subject{ToolKey: p.Tool, Paths: p.Paths}
		if p.Command != nil {
			s.Command, s.HasCommand = *p.Command, true
		}
		goVerdict := yolohardline.Block(s, nil, p.Deny)
		pyVerdict := ""
		if out.Verdicts[i] != nil {
			pyVerdict = *out.Verdicts[i]
		}
		if (goVerdict == "") != (pyVerdict == "") || category(goVerdict) != category(pyVerdict) {
			t.Errorf("parity %+v: go %q, python %q", p, goVerdict, pyVerdict)
		}
	}
}

func sessionKeyOf(sessionID string) string {
	sum := sha256.Sum256([]byte(sessionID))
	return hex.EncodeToString(sum[:])
}

// category maps both spellings to one: hardline / protected / denied.
func category(verdict string) string {
	switch {
	case verdict == "":
		return ""
	case strings.HasPrefix(verdict, "hardline"):
		return "hardline " + strings.TrimLeft(strings.TrimPrefix(strings.TrimPrefix(verdict, "hardline"), ":"), " ")
	case strings.HasPrefix(verdict, "protected"):
		return "protected " + strings.TrimLeft(strings.TrimPrefix(strings.TrimPrefix(verdict, "protected"), ":"), " ")
	case verdict == "unreadable" || verdict == "unreadable command":
		return "unreadable"
	}
	return "denied"
}
