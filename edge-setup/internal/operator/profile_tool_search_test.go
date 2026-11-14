package operator

import (
	"context"
	"os"
	osexec "os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// toolSearchPythonPrelude loads inventory_probe.py with a stand-in for
// Hermes's platform resolution (`_get_platform_tools`): a listed MCP server,
// or every enabled one when the list names none, plus the listed toolsets.
const toolSearchPythonPrelude = `import copy, os, sys, types
scope = {"__name__": "profile_tool_search_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)

def platform_tools(config, platform, include_default_mcp_servers=True):
    listed = [str(n) for n in (config.get("platform_toolsets") or {}).get(platform) or []]
    servers = config.get("mcp_servers") or {}
    enabled = {str(n) for n, e in servers.items() if (e.get("enabled") is not False if isinstance(e, dict) else e is not False)}
    named = [n for n in listed if n in servers]
    mcp = {n for n in named if n in enabled} if named or not include_default_mcp_servers else enabled
    return {n for n in listed if n not in servers} | mcp

tools_config = types.ModuleType("hermes_cli.tools_config")
tools_config._get_platform_tools = platform_tools
sys.modules["hermes_cli"] = types.ModuleType("hermes_cli")
sys.modules["hermes_cli.tools_config"] = tools_config
converge = scope["converge_tool_search"]
ROUTINES = {"url": "https://openedbot.example/api/mcp/routines/x", "enabled": True}
NOTION = {"url": "https://mcp.notion.example/mcp", "enabled": True}

def profile(servers, listed, **extra):
    config = {"mcp_servers": copy.deepcopy(servers), "platform_toolsets": {"api_server": listed}}
    config.update(copy.deepcopy(extra))
    return config
`

func runToolSearchPython(t *testing.T, code string, env ...string) {
	t.Helper()
	cmd := osexec.Command("python3", "-c", toolSearchPythonPrelude+code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	cmd.Env = append(os.Environ(), env...)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("tool search rule: %v\n%s", err, output)
	}
}

// The rule on a config alone: openedbot's servers only (or none) turn tool
// search off; a live third-party server or hosted connectors take the key
// back; anything the owner set is left alone; a second pass changes nothing.
func TestToolSearchRuleFollowsTheLiveMCPServers(t *testing.T) {
	runToolSearchPython(t, `
# openedbot's routines only: off, and ours.
config = profile({"openedbot_routines": ROUTINES}, ["web", "openedbot_routines"])
assert converge(config, False) == (True, True)
assert config["tools"] == {"tool_search": {"enabled": "off"}}, config
# Idempotent: already off and ours, nothing moves.
before = copy.deepcopy(config)
assert converge(config, True) == (False, True) and config == before

# Both reserved servers, or no MCP server at all: deferral buys nothing either.
config = profile({"openedbot_routines": ROUTINES, "openedbot_bot_settings": ROUTINES}, ["openedbot_routines", "openedbot_bot_settings"])
assert converge(config, False) == (True, True)
config = profile({}, ["web", "session_search"])
assert converge(config, False) == (True, True)

# A third-party server enabled on the profile: our value goes, empty parents with it.
config["mcp_servers"]["notion"] = dict(NOTION)
config["platform_toolsets"]["api_server"].append("notion")
assert converge(config, True) == (True, False)
assert "tools" not in config, config
# ...and nothing is written while it stays live.
assert converge(config, False) == (False, False) and "tools" not in config

# Disabled again: off again.
config["mcp_servers"]["notion"]["enabled"] = False
assert converge(config, False) == (True, True)
assert config["tools"]["tool_search"]["enabled"] == "off"

# A third-party server the platform list leaves out is not live: off.
config = profile({"openedbot_routines": ROUTINES, "notion": NOTION}, ["openedbot_routines"])
assert converge(config, False) == (True, True)
# No MCP name listed: Hermes serves every enabled server, Notion included.
config = profile({"openedbot_routines": ROUTINES, "notion": NOTION}, ["web"])
assert converge(config, False) == (False, False) and "tools" not in config

# Hosted connectors are reachable only through the bridge.
config = profile({"openedbot_routines": ROUTINES}, ["openedbot_routines", "connections"])
assert converge(config, False) == (False, False) and "tools" not in config

# Other tool_search keys of the owner stay when ours goes.
config = profile({"notion": NOTION}, ["notion"], tools={"tool_search": {"enabled": "off", "threshold_pct": 3}, "x": 1})
assert converge(config, True) == (True, False)
assert config["tools"] == {"tool_search": {"threshold_pct": 3}, "x": 1}, config

# What the owner set is never touched, whatever the servers say.
for owned in ["auto", "on", "off", False, True]:
    for servers, listed in [({"openedbot_routines": ROUTINES}, ["openedbot_routines"]), ({"notion": NOTION}, ["notion"])]:
        config = profile(servers, listed, tools={"tool_search": {"enabled": owned}})
        before = copy.deepcopy(config)
        assert converge(config, False) == (False, False) and config == before, (owned, config)
# A value changed by hand after ours is the owner's from then on: the marker goes.
config = profile({"notion": NOTION}, ["notion"], tools={"tool_search": {"enabled": "auto"}})
assert converge(config, True) == (False, False) and config["tools"]["tool_search"]["enabled"] == "auto"
# YAML's bare off loads as False: still ours when the marker says so.
config = profile({"notion": NOTION}, ["notion"], tools={"tool_search": {"enabled": False}})
assert converge(config, True) == (True, False) and "tools" not in config
# The legacy boolean form and a non-mapping tools block are the owner's.
for tools in [{"tool_search": False}, {"tool_search": True}, ["x"]]:
    config = profile({"openedbot_routines": ROUTINES}, ["openedbot_routines"], tools=tools)
    before = copy.deepcopy(config)
    assert converge(config, True) == (False, False) and config == before

# A config that does not say, or a Hermes that cannot tell: nothing moves.
for config in [{"mcp_servers": ["openedbot_routines"]}, {"mcpServers": {"x": {}}, "mcp_servers": {}}]:
    before = copy.deepcopy(config)
    assert converge(config, False) == (False, False) and config == before
tools_config._get_platform_tools = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
config = profile({"openedbot_routines": ROUTINES}, ["openedbot_routines"], tools={"tool_search": {"enabled": "off"}})
assert converge(config, True) == (False, True) and config["tools"]["tool_search"]["enabled"] == "off"
config = profile({"openedbot_routines": ROUTINES}, ["openedbot_routines"])
assert converge(config, False) == (False, False) and "tools" not in config
`)
}

// On disk, through the program's own writers: a profile MCP toggle converges
// the config it saves and keeps the marker in step; the converge verb leaves
// a converged profile's file untouched and never takes an owner's value.
func TestToolSearchConvergesThroughProfileWritesOnDisk(t *testing.T) {
	home := t.TempDir()
	for _, name := range []string{"scout", "owned", "fresh"} {
		if err := os.MkdirAll(filepath.Join(home, "profiles", name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	runToolSearchPython(t, `
import yaml
home = os.environ["HERMES_HOME"]
config_module = types.ModuleType("hermes_cli.config")
def save_config(config, **kwargs):
    raise TypeError("profile")
config_module.save_config = save_config
config_module.load_config = lambda: {"mcp_servers": {"notion": dict(NOTION)}}
config_module.get_env_value_prefer_dotenv = lambda key: "t" * 43
sys.modules["hermes_cli.config"] = config_module
scope["write_env_key"] = lambda *args: None

def path(name, file="config.yaml"):
    return os.path.join(home, "profiles", name, file)
def write(name, config):
    with open(path(name), "w") as handle:
        handle.write(yaml.safe_dump(config))
def read(name):
    with open(path(name)) as handle:
        return yaml.safe_load(handle.read())
def marked(name):
    return os.path.isfile(path(name, scope["TOOL_SEARCH_MARKER_FILE"]))

write("scout", profile({"openedbot_routines": dict(ROUTINES, enabled=False)}, ["web"]))
mcp_set = scope["invoke_handler"]
mcp_set("profile-mcp-set", {"name": "scout", "server": "openedbot_routines", "enabled": True})
assert read("scout")["tools"]["tool_search"]["enabled"] == "off" and marked("scout")
with open(path("scout")) as handle:
    assert "enabled: 'off'" in handle.read()

# A third-party server copied from the root and enabled: the key and the marker go.
mcp_set("profile-mcp-set", {"name": "scout", "server": "notion", "enabled": True})
assert "tools" not in read("scout") and not marked("scout"), read("scout")
mcp_set("profile-mcp-set", {"name": "scout", "server": "notion", "enabled": False})
assert read("scout")["tools"]["tool_search"]["enabled"] == "off" and marked("scout")
mcp_set("profile-mcp-set", {"name": "scout", "server": "notion", "enabled": True})
mcp_set("profile-mcp-remove", {"name": "scout", "server": "notion"})
assert read("scout")["tools"]["tool_search"]["enabled"] == "off" and marked("scout")

# The converge verb: an existing profile gets the rule once, then is left alone.
write("fresh", profile({"openedbot_routines": ROUTINES}, ["openedbot_routines"]))
write("owned", profile({"openedbot_routines": ROUTINES}, ["openedbot_routines"], tools={"tool_search": {"enabled": "auto"}}))
result = mcp_set("profile-tool-search-converge", {"names": ["fresh", "owned", "scout", "gone"]})
by_name = {entry["name"]: entry for entry in result["profiles"]}
assert by_name["fresh"] == {"name": "fresh", "changed": True, "managed": True}, by_name
assert by_name["owned"] == {"name": "owned", "changed": False, "managed": False}, by_name
assert by_name["scout"] == {"name": "scout", "changed": False, "managed": True}, by_name
assert by_name["gone"] == {"name": "gone", "error": "PROFILE_NOT_FOUND"}, by_name
assert read("fresh")["tools"]["tool_search"]["enabled"] == "off" and marked("fresh")
assert read("owned")["tools"]["tool_search"]["enabled"] == "auto" and not marked("owned")
stamps = {name: os.stat(path(name)).st_mtime_ns for name in ["fresh", "owned", "scout"]}
again = mcp_set("profile-tool-search-converge", {"names": ["fresh", "owned", "scout"]})
assert all(not entry["changed"] for entry in again["profiles"]), again
assert stamps == {name: os.stat(path(name)).st_mtime_ns for name in stamps}

# The owner switches it back on by hand: never overwritten, the marker goes.
config = read("fresh")
config["tools"]["tool_search"]["enabled"] = "on"
write("fresh", config)
result = mcp_set("profile-tool-search-converge", {"names": ["fresh"]})
assert result["profiles"][0] == {"name": "fresh", "changed": False, "managed": False}
assert read("fresh")["tools"]["tool_search"]["enabled"] == "on" and not marked("fresh")
mcp_set("profile-mcp-set", {"name": "fresh", "server": "notion", "enabled": True})
mcp_set("profile-mcp-set", {"name": "fresh", "server": "notion", "enabled": False})
assert read("fresh")["tools"]["tool_search"]["enabled"] == "on"

for bad in [None, "scout", ["../x"], ["default"], ["a"] * 257]:
    try:
        mcp_set("profile-tool-search-converge", {"names": bad})
    except scope["Refused"]:
        pass
    else:
        raise AssertionError("names accepted: %r" % (bad,))
`, "HERMES_HOME="+home)
}

// At start, every named profile with a config file goes to the program in
// one locked write; nothing else under profiles/ is named.
func TestConvergeToolSearchOnStartNamesEveryProfile(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"scout", "atlas", "default", "Bad Name", "empty"} {
		if err := os.MkdirAll(filepath.Join(root, "profiles", dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"scout", "atlas", "default", "Bad Name"} {
		if err := os.WriteFile(filepath.Join(root, "profiles", name, "config.yaml"), []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(root, "profiles", "scout", "config.yaml"), filepath.Join(root, "profiles", "empty", "config.yaml")); err != nil {
		t.Fatal(err)
	}
	recorder := &probeRecorder{replies: map[string]string{
		"profile-tool-search-converge": `{"profiles":[{"name":"atlas","changed":true,"managed":true},{"name":"scout","error":"PROFILE_CONFIG_REFUSED"}]}`,
	}}
	var logs []string
	s := &Server{Probe: recorder.probe(), InventoryRoots: InventoryRoots{RuntimeRoot: root},
		Logf: func(format string, args ...any) { logs = append(logs, format) }}
	s.ConvergeToolSearchOnStart(context.Background())
	if len(recorder.seen) != 1 || recorder.seen[0] != "profile-tool-search-converge" || recorder.bodies[0] != `{"names":["atlas","scout"]}` {
		t.Fatalf("probe %v %v", recorder.seen, recorder.bodies)
	}
	if !slices.Contains(configWriteTargets("profile-tool-search-converge", map[string]any{"names": []string{"atlas", "scout"}}), "scout") {
		t.Fatal("the converge verb does not take the profiles' config locks")
	}
	if len(logs) != 2 {
		t.Fatalf("logs %v", logs)
	}

	// No profiles directory yet (a host being installed): nothing runs.
	empty := &probeRecorder{}
	(&Server{Probe: empty.probe(), InventoryRoots: InventoryRoots{RuntimeRoot: t.TempDir()}}).ConvergeToolSearchOnStart(context.Background())
	if len(empty.seen) != 0 {
		t.Fatalf("probe ran without profiles: %v", empty.seen)
	}
}

// A toolset write converges the profile only when it names the hosted
// connectors, the one toolset that moves the rule.
func TestToolsetWritesConvergeToolSearchOnlyForConnectors(t *testing.T) {
	recorder := &probeRecorder{replies: map[string]string{"profile-tool-search-converge": `{"profiles":[]}`}}
	s := &Server{Probe: recorder.probe()}
	s.convergeToolSearchAfterToolsets(context.Background(), "scout", "web", "browser")
	if len(recorder.seen) != 0 {
		t.Fatalf("converged on an unrelated toolset: %v", recorder.seen)
	}
	s.convergeToolSearchAfterToolsets(context.Background(), "scout", "web", "connections")
	if len(recorder.seen) != 1 || recorder.bodies[0] != `{"names":["scout"]}` {
		t.Fatalf("probe %v %v", recorder.seen, recorder.bodies)
	}
}
