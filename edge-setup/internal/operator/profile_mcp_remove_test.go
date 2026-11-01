package operator

import (
	"net/http"
	"net/http/httptest"
	osexec "os/exec"
	"strings"
	"testing"
)

// DELETE /profiles/{slug}/mcp/servers/{server} validates both names before any
// interpreter starts, runs the profile-mcp-remove verb, and returns its
// document as is: `removed` and `tokensRemoved` are the caller's only proof.
func TestRemoveProfileMCPValidatesAndReturnsTheVerbDocument(t *testing.T) {
	replies := map[string]string{
		"profile-mcp-remove": `{"profile":"scout","name":"linear","removed":true,"tokensRemoved":true}`,
	}
	recorder, _, srv := inventoryServer(t, replies, `{"data":[]}`)

	for _, tc := range []struct{ path, code string }{
		{"/profiles/default/mcp/servers/linear", "PROFILE_INVALID"},
		{"/profiles/Bad%20Slug/mcp/servers/linear", "PROFILE_INVALID"},
		{"/profiles/scout/mcp/servers/bad%20name", "NAME_INVALID"},
	} {
		status, out := call(t, srv, "DELETE", tc.path, "")
		if status != http.StatusBadRequest || errorCode(out) != tc.code {
			t.Fatalf("%s: %d %v", tc.path, status, out)
		}
	}
	if len(recorder.seen) != 0 {
		t.Fatalf("an invalid name reached the host: %v", recorder.seen)
	}

	status, out := call(t, srv, "DELETE", "/profiles/scout/mcp/servers/linear", "")
	if status != http.StatusOK || out["profile"] != "scout" || out["name"] != "linear" || out["removed"] != true || out["tokensRemoved"] != true {
		t.Fatalf("remove %d %v", status, out)
	}
	if len(recorder.seen) != 1 || recorder.seen[0] != "profile-mcp-remove" ||
		!strings.Contains(recorder.bodies[0], `"name":"scout"`) || !strings.Contains(recorder.bodies[0], `"server":"linear"`) {
		t.Fatalf("probe %v %v", recorder.seen, recorder.bodies)
	}
}

func TestRemoveProfileMCPKeepsRefusalCodesAndTheLock(t *testing.T) {
	replies := map[string]string{
		"profile-mcp-remove": `{"error":{"code":"PROFILE_NOT_FOUND","message":"no profile named ghost exists"}}`,
	}
	_, _, srv := inventoryServer(t, replies, `{"data":[]}`)
	status, out := call(t, srv, "DELETE", "/profiles/ghost/mcp/servers/linear", "")
	if status != http.StatusNotFound || errorCode(out) != "PROFILE_NOT_FOUND" {
		t.Fatalf("missing profile %d %v", status, out)
	}

	busy := &Server{Probe: (&probeRecorder{}).probe()}
	busy.mcpBusy.Lock()
	defer busy.mcpBusy.Unlock()
	srvBusy := httptest.NewServer(busy.Handler())
	defer srvBusy.Close()
	status, out = call(t, srvBusy, "DELETE", "/profiles/scout/mcp/servers/linear", "")
	if status != http.StatusConflict || errorCode(out) != "MCP_IN_PROGRESS" {
		t.Fatalf("busy %d %v", status, out)
	}
}

// The real embedded verbs, with stubbed Hermes modules and a temporary home:
// the profile loses the server and its token files, the root keeps both, a
// second call is idempotent and still clears a leftover client registration,
// and the root removal clears the root's tokens.
func TestInventoryProbeRemovesMCPServersWithTheirTokens(t *testing.T) {
	code := `import os, sys, tempfile, types
home = tempfile.mkdtemp()
profile = os.path.join(home, "profiles", "scout")
os.makedirs(os.path.join(profile, "mcp-tokens"))
os.makedirs(os.path.join(home, "mcp-tokens"))
open(os.path.join(profile, "config.yaml"), "w").write("x")
def touch(directory, *names):
    for name in names:
        open(os.path.join(directory, "mcp-tokens", name), "w").write("{}")
touch(profile, "linear.json", "linear.client.json", "linear.meta.json", "notion.json")
touch(home, "linear.json", "linear.client.json")
calls = []
def mod(name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module
def remove_oauth_tokens(name, hermes_home=None):
    calls.append((name, hermes_home))
    raise TypeError("older Hermes: no hermes_home")
mod("tools")
mod("tools.mcp_oauth", remove_oauth_tokens=remove_oauth_tokens)
mod("hermes_cli")
root_config = {"mcp_servers": {"linear": {"url": "https://mcp.linear.app/mcp", "auth": "oauth"}}}
mod("hermes_cli.mcp_config", _get_mcp_servers=lambda config=None: root_config.get("mcp_servers", {}),
    _remove_mcp_server=lambda name: root_config["mcp_servers"].pop(name, None) is not None)
mod("hermes_cli.mcp_catalog", is_installed=lambda name: False, uninstall_entry=lambda name: False)
configs = {"scout": {"mcp_servers": {"linear": {"url": "https://mcp.linear.app/mcp", "auth": "oauth", "enabled": True},
                                     "notion": {"url": "https://mcp.notion.com/mcp"}},
                     "platform_toolsets": {"api_server": ["linear", "notion", "web"]}}}
saved = []
scope = {"__name__": "profile_mcp_remove_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
scope["hermes_home"] = lambda: home
scope["named_profile_names"] = lambda: ["scout"]
scope["load_profile_config"] = lambda name: configs[name]
def save(name, config):
    saved.append(name)
    configs[name] = config
scope["save_profile_config"] = save
scope["platform_entries"] = lambda config: set(config.get("platform_toolsets", {}).get("api_server", []))
scope["set_platform_entry"] = lambda name, enabled: None
remove = scope["verb_profile_mcp_remove"]

result = remove({"name": "scout", "server": "linear"})
assert result == {"profile": "scout", "name": "linear", "removed": True, "tokensRemoved": True}, result
assert "linear" not in configs["scout"]["mcp_servers"], configs
assert configs["scout"]["platform_toolsets"]["api_server"] == ["notion", "web"], configs
left = sorted(os.listdir(os.path.join(profile, "mcp-tokens")))
assert left == ["notion.json"], left
assert sorted(os.listdir(os.path.join(home, "mcp-tokens"))) == ["linear.client.json", "linear.json"], "the root token is not the profile's"
assert calls == [("linear", profile)], calls

touch(profile, "linear.client.json")
result = remove({"name": "scout", "server": "linear"})
assert result["removed"] is False and result["tokensRemoved"] is True, result
assert saved == ["scout"], saved
assert sorted(os.listdir(os.path.join(profile, "mcp-tokens"))) == ["notion.json"]

for bad, code in (({"name": "default", "server": "linear"}, "PROFILE_INVALID"),
                  ({"name": "ghost", "server": "linear"}, "PROFILE_NOT_FOUND"),
                  ({"name": "scout", "server": "bad name"}, "NAME_INVALID")):
    try:
        remove(bad)
    except scope["Refused"] as refused:
        assert refused.code == code, (bad, refused.code)
    else:
        raise AssertionError("refusal expected for " + repr(bad))

result = scope["verb_mcp_remove"]({"name": "linear"})
assert result == {"removed": "linear", "tokensRemoved": True}, result
assert os.listdir(os.path.join(home, "mcp-tokens")) == []
assert calls[-1] == ("linear", None), calls
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("profile-mcp-remove: %v\n%s", err, output)
	}
}
