package operator

import (
	osexec "os/exec"
	"strings"
	"testing"
)

// The gateway publishes no context window anywhere: not /v1/models, not
// /api/model/options, not /v1/capabilities. This route is the only place a
// caller can read it, so the numbers it publishes have to be trustworthy on
// their own: an unknown window reads as zero, never as a full bar.

func TestModelContextPublishesTheEffectiveWindow(t *testing.T) {
	replies := map[string]string{
		"model-context": `{"model":"claude-sonnet-5","provider":"anthropic","autoContextLength":200000,` +
			`"configContextLength":0,"effectiveContextLength":200000,"maxOutputTokens":64000}`,
	}
	_, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	status, out := call(t, srv, "GET", "/model-context", "")
	if status != 200 || out["model"] != "claude-sonnet-5" || out["provider"] != "anthropic" {
		t.Fatalf("%d %v", status, out)
	}
	if out["effectiveContextLength"] != float64(200000) || out["maxOutputTokens"] != float64(64000) {
		t.Fatalf("%v", out)
	}
}

// A configured override is what the agent applies. An operator running an
// older probe could report the auto value as effective; the route re-applies
// the precedence so the two readings can never contradict each other.
func TestModelContextPrefersTheConfiguredOverride(t *testing.T) {
	replies := map[string]string{
		"model-context": `{"model":"gpt-5.6","provider":"openai-api","autoContextLength":400000,` +
			`"configContextLength":120000,"effectiveContextLength":400000}`,
	}
	_, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	_, out := call(t, srv, "GET", "/model-context", "")
	if out["effectiveContextLength"] != float64(120000) {
		t.Fatalf("%v", out)
	}
}

// An implausible window is not a window. Zero tells the caller to fall back to
// its own table; a denominator of sixty billion would make every reading round
// to zero percent and the bar would look empty forever.
func TestModelContextRefusesAnImplausibleWindow(t *testing.T) {
	replies := map[string]string{
		"model-context": `{"model":"m","provider":"p","autoContextLength":60000000000,` +
			`"configContextLength":-5,"effectiveContextLength":60000000000}`,
	}
	_, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	_, out := call(t, srv, "GET", "/model-context", "")
	if out["autoContextLength"] != float64(0) || out["configContextLength"] != float64(0) ||
		out["effectiveContextLength"] != float64(0) {
		t.Fatalf("%v", out)
	}
}

// The profile is the only argument the route reads, and it is a slug. Anything
// else is refused before the probe is even started.
func TestModelContextRefusesAnInvalidProfile(t *testing.T) {
	_, _, srv := inventoryServer(t, nil, `{"data":[]}`)
	status, out := call(t, srv, "GET", "/model-context?profile=../etc", "")
	failure, _ := out["error"].(map[string]any)
	if status != 400 || failure["code"] != "PROFILE_INVALID" {
		t.Fatalf("%d %v", status, out)
	}
}

// A named profile reaches the probe as a body field, never as a path or a
// command fragment.
func TestModelContextForwardsTheProfileToTheProbe(t *testing.T) {
	replies := map[string]string{
		"model-context": `{"profile":"atlas","model":"m","provider":"p","effectiveContextLength":1000}`,
	}
	recorder, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	if status, _ := call(t, srv, "GET", "/model-context?profile=atlas", ""); status != 200 {
		t.Fatalf("%d", status)
	}
	if len(recorder.bodies) == 0 || recorder.bodies[0] != `{"profile":"atlas"}` {
		t.Fatalf("%v", recorder.bodies)
	}
}

// The preamble crosses as sizes and names only, in a fixed bucket order. An
// unknown bucket, a negative or implausible count, a duplicate and an empty
// name are dropped; "not measured" (null) stays null and never becomes zero.
func TestModelContextBoundsThePreamble(t *testing.T) {
	replies := map[string]string{
		"model-context": `{"model":"m","provider":"p","effectiveContextLength":1000,"preamble":{"buckets":[` +
			`{"key":"mcp","tokens":null,"items":[{"name":"linear","tokens":null}]},` +
			`{"key":"secrets","tokens":5,"items":[]},` +
			`{"key":"identity","tokens":120,"items":[]},` +
			`{"key":"identity","tokens":999,"items":[]},` +
			`{"key":"tools","tokens":-4,"items":[{"name":"","tokens":3},{"name":"terminal","tokens":60000000000}]}]}}`,
	}
	_, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	status, out := call(t, srv, "GET", "/model-context", "")
	if status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	preamble, _ := out["preamble"].(map[string]any)
	buckets, _ := preamble["buckets"].([]any)
	if len(buckets) != 3 {
		t.Fatalf("%v", preamble)
	}
	keys := []string{}
	for _, raw := range buckets {
		keys = append(keys, raw.(map[string]any)["key"].(string))
	}
	if keys[0] != "identity" || keys[1] != "tools" || keys[2] != "mcp" {
		t.Fatalf("%v", keys)
	}
	identity := buckets[0].(map[string]any)
	if identity["tokens"] != float64(120) {
		t.Fatalf("%v", identity)
	}
	tools := buckets[1].(map[string]any)
	items, _ := tools["items"].([]any)
	if tools["tokens"] != nil || len(items) != 1 || items[0].(map[string]any)["tokens"] != nil {
		t.Fatalf("%v", tools)
	}
	mcp := buckets[2].(map[string]any)
	if mcp["tokens"] != nil {
		t.Fatalf("%v", mcp)
	}
}

// An older probe prints no preamble: the route does not invent one.
func TestModelContextOmitsAnAbsentPreamble(t *testing.T) {
	replies := map[string]string{
		"model-context": `{"model":"m","provider":"p","effectiveContextLength":1000}`,
	}
	_, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	_, out := call(t, srv, "GET", "/model-context", "")
	if _, present := out["preamble"]; present {
		t.Fatalf("%v", out)
	}
}

// Exercise the embedded Python on a throwaway home: sizes and names come out,
// content never does, and a tool list that cannot be resolved reads as not
// measured instead of zero.
func TestInventoryProbeMeasuresThePreamble(t *testing.T) {
	code := `import os, sys, tempfile, json
scope = {"__name__": "preamble_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
home = tempfile.mkdtemp()
os.makedirs(os.path.join(home, "memories"))
os.makedirs(os.path.join(home, "skills", "notes", "daily-brief"))
os.makedirs(os.path.join(home, "skills", "off"))
open(os.path.join(home, "SOUL.md"), "w").write("s" * 400)
open(os.path.join(home, "memories", "MEMORY.md"), "w").write("SECRET-MEMORY" + "m" * 87)
open(os.path.join(home, "memories", "USER.md"), "w").write("u" * 40)
open(os.path.join(home, "skills", "notes", "daily-brief", "SKILL.md"), "w").write("---\nname: daily-brief\ndescription: Morning summary\n---\nBODY-NEVER-READ")
open(os.path.join(home, "skills", "off", "SKILL.md"), "w").write("---\ndescription: x\n---\n")
config = {"memory": {"memory_enabled": True, "user_profile_enabled": False}, "disabled_skills": ["off"]}
identity = scope["preamble_identity"](home)
assert identity == {"key": "identity", "tokens": 100, "items": []}, identity
memory = scope["preamble_memory"](home, config)
assert memory["items"] == [{"name": "MEMORY.md", "tokens": 25}], memory
assert memory["tokens"] == 25
skills = scope["preamble_skills"](home, config)
assert [item["name"] for item in skills["items"]] == ["daily-brief"], skills
assert skills["tokens"] == -(-(len("daily-brief") + len("Morning summary") + 4) // 4)
scope["platform_entries"] = lambda config: {"web", "linear"}
scope["mcp_servers"] = lambda config=None: {"linear": {"url": "https://example.test/mcp"}}
def unresolved(toolsets):
    raise ImportError("no model_tools here")
scope["tool_schema_definitions"] = unresolved
before = dict(os.environ)
tools = scope["preamble_tools"](home, config)
assert tools == {"key": "tools", "tokens": None, "items": []}, tools
assert dict(os.environ) == before
def resolved(toolsets):
    assert toolsets == ["web"], toolsets
    assert os.environ["HERMES_HOME"] != home
    return [{"type": "function", "function": {"name": "web_search", "parameters": {"q": "x" * 30}}}]
scope["tool_schema_definitions"] = resolved
tools = scope["preamble_tools"](home, config)
assert [item["name"] for item in tools["items"]] == ["web_search"] and tools["tokens"] > 0, tools
mcp = scope["preamble_mcp"](config)
assert mcp == {"key": "mcp", "tokens": None, "items": [{"name": "linear", "tokens": None}]}, mcp
encoded = json.dumps(scope["context_preamble"](None, config))
assert "SECRET-MEMORY" not in encoded and "BODY-NEVER-READ" not in encoded and home not in encoded
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("preamble probe: %v\n%s", err, output)
	}
}
