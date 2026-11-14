package operator

import (
	osexec "os/exec"
	"strings"
	"testing"
)

func TestProfileLocalMCPToggleDoesNotRequireOrModifyRootTemplate(t *testing.T) {
	code := `import copy, sys
scope = {"__name__": "profile_local_mcp_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
configs = {"scout": {"mcp_servers": {"local": {"command": "fixed-test", "args": ["probe"], "enabled": True}}, "platform_toolsets": {"api_server": ["local", "web"]}}}
root = {"mcp_servers": {"template": {"url": "https://template.example/mcp", "enabled": True}}}
scope["named_profile_names"] = lambda: ["scout"]
scope["load_profile_config"] = lambda name: copy.deepcopy(configs[name])
scope["save_profile_config"] = lambda name, config: configs.__setitem__(name, copy.deepcopy(config))
scope["platform_entries"] = lambda config: set(config.get("platform_toolsets", {}).get("api_server", []))
reads = []
scope["load_config"] = lambda: (reads.append("root") or root)
handler = scope["verb_profile_mcp_set"]
for enabled in [False, True]:
    result = handler({"name": "scout", "server": "local", "enabled": enabled})
    assert result["enabled"] is enabled
    entry = configs["scout"]["mcp_servers"]["local"]
    assert entry == {"command": "fixed-test", "args": ["probe"], "enabled": enabled}, entry
    assert ("local" in configs["scout"]["platform_toolsets"]["api_server"]) is enabled
assert reads == [], reads
assert root == {"mcp_servers": {"template": {"url": "https://template.example/mcp", "enabled": True}}}
handler({"name": "scout", "server": "template", "enabled": False})
assert reads == ["root"], reads
assert configs["scout"]["mcp_servers"]["template"] == {"url": "https://template.example/mcp", "enabled": False}
assert root["mcp_servers"]["template"]["enabled"] is True
try:
    handler({"name": "scout", "server": "missing", "enabled": True})
except scope["Refused"] as error:
    assert error.code == "MCP_SERVER_NOT_FOUND"
else:
    raise AssertionError("missing profile/root entry accepted")
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("profile-local MCP: %v\n%s", err, output)
	}
}

func TestRoutineMCPEnablingCopiesOnlyDedicatedProfileCredential(t *testing.T) {
	code := `import copy, sys, types
scope = {"__name__": "profile_routine_secret_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
config = {"mcp_servers": {"openedbot_routines": {"url": "http://127.0.0.1:8857/api/mcp/routines/test", "enabled": False}}}
scope["named_profile_names"] = lambda: ["scout"]
scope["load_profile_config"] = lambda name: copy.deepcopy(config)
saved = []
scope["save_profile_config"] = lambda name, value: saved.append(copy.deepcopy(value))
scope["platform_entries"] = lambda config: set()
writes = []
scope["write_env_key"] = lambda *args: writes.append(args)
credential = ["x" * 43]
reads = []
module = types.ModuleType("hermes_cli.config")
module.get_env_value_prefer_dotenv = lambda key: (reads.append(key) or credential[0])
sys.modules["hermes_cli"] = types.ModuleType("hermes_cli")
sys.modules["hermes_cli.config"] = module
handler = scope["verb_profile_mcp_set"]
handler({"name": "scout", "server": "openedbot_routines", "enabled": True})
assert reads == ["MCP_OPENEDBOT_ROUTINES_API_KEY"]
assert writes == [("scout", "MCP_OPENEDBOT_ROUTINES_API_KEY", "x" * 43)]
assert saved[-1]["mcp_servers"]["openedbot_routines"]["enabled"] is True
handler({"name": "scout", "server": "openedbot_routines", "enabled": False})
assert len(reads) == len(writes) == 1
for invalid in [None, "", "unsafe\nvalue", "op://unresolved"]:
    credential[0] = invalid
    count = len(saved)
    try:
        handler({"name": "scout", "server": "openedbot_routines", "enabled": True})
    except scope["Refused"] as error:
        assert error.code == "ROUTINE_TOKEN_REQUIRED"
    else:
        raise AssertionError("missing/invalid credential accepted")
    assert len(saved) == count and len(writes) == 1
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("profile routine credential: %v\n%s", err, output)
	}
}
