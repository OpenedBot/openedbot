package operator

import (
	"encoding/json"
	osexec "os/exec"
	"strings"
	"testing"
)

// The real embedded probe, with a temporary home: carrying an MCP entry is not
// a connection. A profile's server says whether ITS token file is there
// (never the root's, never the content), with the endpoint and auth mode the
// catalogue identity rule needs. A client registration left by a failed
// authorization is not a token; an unreadable token directory is unknown,
// never « absent ».
func TestInventoryProbeReportsProfileMCPTokenFacts(t *testing.T) {
	code := `import os, sys, tempfile
home = tempfile.mkdtemp()
def write(path, content="{}"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write(content)
scout = os.path.join(home, "profiles", "scout")
write(os.path.join(scout, "mcp-tokens", "linear.json"), '{"access_token":"never-read"}')
write(os.path.join(scout, "mcp-tokens", "notion.client.json"))
write(os.path.join(scout, "mcp-tokens", "empty.json"), "")
os.makedirs(os.path.join(scout, "mcp-tokens", "folder.json"))
# The root holds a cloudflare token: a profile never borrows it.
write(os.path.join(home, "mcp-tokens", "cloudflare.json"))
os.makedirs(os.path.join(home, "profiles", "fresh"))
locked = os.path.join(home, "profiles", "locked")
write(os.path.join(locked, "mcp-tokens", "linear.json"))
oauth = lambda url: {"url": url, "auth": "oauth"}
configs = {
    "scout": {"mcp_servers": {
        # Keys a YAML file can hold that name no server, BEFORE valid ones:
        # each fact must still land on its own server.
        7: oauth("https://seven.example/mcp"),
        "  ": oauth("https://blank.example/mcp"),
        "linear": oauth("https://mcp.linear.app/mcp"),
        "notion": dict(oauth("https://mcp.notion.com/mcp"), enabled=False),
        "cloudflare": oauth("https://mcp.cloudflare.com/mcp"),
        "empty": oauth("https://empty.example/mcp"),
        "folder": oauth("https://folder.example/mcp"),
        "docs": {"url": "https://docs.example/mcp", "headers": {"Authorization": "Bearer never-sent"}},
        "local": {"command": "fixed-test"},
        "bare": {"enabled": False},
        "off": False,
        "bad name": oauth("https://bad.example/mcp"),
    }},
    "fresh": {"mcp_servers": {"linear": oauth("https://mcp.linear.app/mcp")}},
    "locked": {"mcp_servers": {"linear": oauth("https://mcp.linear.app/mcp")}},
    "listed": {"mcp_servers": ["linear"]},
    "alias": {"mcpServers": {"linear": oauth("https://mcp.linear.app/mcp")}},
    "none": {},
}
scope = {"__name__": "profile_mcp_facts_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
scope["hermes_home"] = lambda: home
def view(name):
    flags, described = scope["profile_mcp_servers"](name, configs[name])
    return {flag["name"]: flag for flag in flags}, described

scout, described = view("scout")
assert described is True
assert list(scout) == ["linear", "notion", "cloudflare", "empty", "folder", "docs", "local", "bare", "off", "bad name"], list(scout)
assert scout["linear"] == {"name": "linear", "enabled": True, "endpoint": "https://mcp.linear.app/mcp", "auth": "oauth", "oauthTokenPresent": True}, scout["linear"]
assert scout["notion"]["enabled"] is False and scout["notion"]["oauthTokenPresent"] is False, scout["notion"]
assert scout["cloudflare"]["oauthTokenPresent"] is False, "the root's token is not the profile's"
assert scout["empty"]["oauthTokenPresent"] is False, scout["empty"]
assert scout["folder"]["oauthTokenPresent"] is False, scout["folder"]
assert scout["docs"] == {"name": "docs", "enabled": True, "endpoint": "https://docs.example/mcp", "auth": "header", "oauthTokenPresent": None}, scout["docs"]
assert scout["local"]["auth"] == "none" and scout["local"]["endpoint"] is None, scout["local"]
# A mapping without an address is described (not a catalog server); a
# non-mapping entry describes nothing: name and state only.
assert scout["bare"] == {"name": "bare", "enabled": False, "endpoint": None, "auth": "none", "oauthTokenPresent": None}, scout["bare"]
assert scout["off"] == {"name": "off", "enabled": False}, scout["off"]
assert scout["bad name"]["oauthTokenPresent"] is None, scout["bad name"]
encoded = repr(scope["profile_mcp_servers"]("scout", configs["scout"]))
assert "never-read" not in encoded and "never-sent" not in encoded, encoded

# No token directory at all: absent, not unknown.
assert view("fresh")[0]["linear"]["oauthTokenPresent"] is False

# An unreadable token directory: unknown.
if os.geteuid() != 0:
    os.chmod(os.path.join(locked, "mcp-tokens"), 0)
    try:
        assert view("locked")[0]["linear"]["oauthTokenPresent"] is None, view("locked")
    finally:
        os.chmod(os.path.join(locked, "mcp-tokens"), 0o700)
assert view("locked")[0]["linear"]["oauthTokenPresent"] is True

# The list form describes no entry; the camelCase alias does; no server at all is described.
assert view("listed") == ({"linear": {"name": "linear", "enabled": True}}, False), view("listed")
assert view("alias")[0]["linear"]["auth"] == "oauth" and view("alias")[1] is True
assert view("none") == ({}, True), view("none")
`
	runProbeScript(t, "profile MCP facts", code)
}

// With the upstream token storage present, it is the one asked, under the
// profile home the authorization helper writes to, and the file must agree:
// a disagreement or a failure is unknown, never « absent ».
func TestInventoryProbeAsksUpstreamTokenStorageForAProfile(t *testing.T) {
	code := `import os, sys, tempfile, types
home = tempfile.mkdtemp()
elsewhere = tempfile.mkdtemp()
def write(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write("{}")
write(os.path.join(elsewhere, "scout", "mcp-tokens", "linear.json"))
current = [None]
answers = {"linear": True, "notion": True, "cloudflare": False, "broken": None}
asked = []
class Storage:
    def __init__(self, name):
        self.name = name
        self.home = current[0]
    def has_cached_tokens(self):
        asked.append((self.name, self.home))
        if self.name == "broken":
            raise OSError("upstream failure")
        return answers[self.name]
def mod(name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module
mod("tools"); mod("tools.mcp_oauth", HermesTokenStorage=Storage)
mod("hermes_cli"); mod("hermes_cli.profiles", get_profile_dir=lambda name: os.path.join(elsewhere, name))
def set_override(path):
    previous = current[0]
    current[0] = path
    return previous
mod("hermes_constants", set_hermes_home_override=set_override, reset_hermes_home_override=lambda token: current.__setitem__(0, token))
scope = {"__name__": "profile_mcp_upstream_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
scope["hermes_home"] = lambda: home
present = scope["profile_oauth_token_present"]
resolved = os.path.realpath(os.path.join(elsewhere, "scout"))
# Upstream and the file in the profile directory upstream resolves agree.
assert present("scout", "linear") is True
assert asked[-1] == ("linear", resolved) and current[0] is None, (asked, current)
# Upstream says present, no file there: a rule changed upstream, unknown.
assert present("scout", "notion") is None
# Both say absent.
assert present("scout", "cloudflare") is False
# Upstream fails: unknown, and the override is always reset.
assert present("scout", "broken") is None and current[0] is None
`
	runProbeScript(t, "upstream token storage", code)
}

func runProbeScript(t *testing.T, label, code string) {
	t.Helper()
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s: %v\n%s", label, err, output)
	}
}

// GET /profiles carries the facts the probe gives, and an older probe's
// name-and-state entry stays exactly that: no fact is invented on the way.
func TestProfileInventoryCarriesMCPFactsOnlyWhenTheProbeGivesThem(t *testing.T) {
	reply := strings.Replace(scoutInventory, `"mcpServers":[{"name":"linear","enabled":false}]`,
		`"mcpServers":[{"name":"linear","enabled":true,"endpoint":"https://mcp.linear.app/mcp","auth":"oauth","oauthTokenPresent":false},`+
			`{"name":"docs","enabled":true,"endpoint":"https://docs.example/mcp","auth":"header","oauthTokenPresent":null},`+
			`{"name":"old","enabled":false}],"mcpFacts":true`, 1)
	_, _, srv := inventoryServer(t, map[string]string{"profiles": reply}, `{"data":[]}`)
	status, out := call(t, srv, "GET", "/profiles", "")
	if status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	row := out["profiles"].([]any)[0].(map[string]any)
	if row["mcpFacts"] != true {
		t.Fatalf("mcpFacts %v", row["mcpFacts"])
	}
	raw, _ := json.Marshal(row["mcpServers"])
	want := `[{"auth":"oauth","enabled":true,"endpoint":"https://mcp.linear.app/mcp","name":"linear","oauthTokenPresent":false},` +
		`{"auth":"header","enabled":true,"endpoint":"https://docs.example/mcp","name":"docs"},` +
		`{"enabled":false,"name":"old"}]`
	if string(raw) != want {
		t.Fatalf("mcpServers\n got %s\nwant %s", raw, want)
	}
}

// An older probe sends no marker, and none is added on the way.
func TestProfileInventoryAddsNoMCPFactsMarkerForAnOlderProbe(t *testing.T) {
	_, _, srv := inventoryServer(t, map[string]string{"profiles": scoutInventory}, `{"data":[]}`)
	status, out := call(t, srv, "GET", "/profiles", "")
	if status != 200 {
		t.Fatalf("%d %v", status, out)
	}
	if _, ok := out["profiles"].([]any)[0].(map[string]any)["mcpFacts"]; ok {
		t.Fatalf("an older probe's profile gained mcpFacts: %v", out)
	}
}
