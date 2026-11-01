package operator

import (
	osexec "os/exec"
	"strings"
	"testing"
)

// Adding an OAuth server only proves an OAuth client can be built: upstream
// refuses to build one with no cached token outside a terminal
// (OAuthNonInteractiveError), which is "authorization still to do", not
// "OAuth unsupported". Any other failure still refuses. Exercises the actual
// embedded Python with stubbed Hermes modules.
func TestInventoryProbeMCPAddOAuthBeforeAuthorization(t *testing.T) {
	code := `import sys, types
class OAuthNonInteractiveError(Exception):
    pass
mode = {"raise": OAuthNonInteractiveError}
class Manager:
    def get_or_build_provider(self, name, url, cfg):
        raise mode["raise"]("no cached tokens")
saved = {}
def mod(name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module
mod("tools")
mod("tools.mcp_oauth", OAuthNonInteractiveError=OAuthNonInteractiveError)
mod("tools.mcp_oauth_manager", get_manager=lambda: Manager())
mod("hermes_cli")
def probe(name, entry):
    raise RuntimeError("401 before authorization")
def save(name, entry):
    saved[name] = dict(entry)
    return True
mod("hermes_cli.mcp_config", _bearer_auth_headers=None, _probe_single_server=probe,
    _save_bearer_auth_token=None, _save_mcp_server=save)
mod("hermes_cli.mcp_security", validate_mcp_server_entry=lambda name, entry: [])
scope = {"__name__": "mcp_add_oauth_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
scope["mcp_servers"] = lambda config=None: dict(saved)
scope["load_config"] = lambda: {}
scope["platform_entries"] = lambda config: []
scope["set_platform_entry"] = lambda name, enabled: None
add = scope["verb_mcp_add"]
result = add({"name": "linear", "url": "https://mcp.linear.app/mcp", "auth": "oauth"})
assert saved["linear"]["auth"] == "oauth", saved
assert saved["linear"]["enabled"] is False, saved
assert result["server"]["unreachable"] is True, result
mode["raise"] = RuntimeError
saved.clear()
try:
    add({"name": "other", "url": "https://mcp.example.com/mcp", "auth": "oauth"})
except scope["Refused"] as refused:
    assert refused.code == "OAUTH_UNSUPPORTED", refused.code
else:
    raise AssertionError("a provider that cannot be built must refuse")
assert "other" not in saved
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("mcp-add oauth: %v\n%s", err, output)
	}
}
