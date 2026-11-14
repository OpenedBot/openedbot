package operator

import (
	osexec "os/exec"
	"strings"
	"testing"
)

// The program saves the config.yaml only once the operator granted its lock:
// the grant travels on the same stdin as the callback, is never mistaken for
// a callback, and EOF before it refuses the save instead of writing unlocked.
// Exercises the actual embedded Python.
func TestMCPOAuthProbeSavesOnlyUnderTheGrantedConfigLock(t *testing.T) {
	code := `import sys, threading
scope = {"__name__": "mcp_oauth_probe_lock_test"}
exec(compile(sys.stdin.read(), "mcp_oauth_probe.py", "exec"), scope)
events = []
scope["emit"] = lambda event, **fields: events.append(event)
scope["CONFIG_LOCK_TIMEOUT_SECONDS"] = 5.0
class Flow:
    def __init__(self): self.calls, self.status = [], "pending"
    def snapshot(self): return {"status": self.status}
    def deliver_callback(self, *, code, state, error, iss=None):
        self.calls.append((code, state)); self.status = "exchanging"
    def mark_error(self, error, cancelled=False): self.status = "error"
def reader(lines):
    queue = list(lines)
    gate = threading.Event()
    def read_line():
        if not queue:
            gate.wait()
            return None
        return queue.pop(0)
    scope["read_line"] = read_line
    return gate

# The grant after the callback: the callback reaches the flow, the grant does not.
gate = reader([{"code": "c", "state": "s"}, {"configLock": "held"}])
flow = Flow()
threading.Thread(target=scope["deliver_callback"], args=(flow,), daemon=True).start()
scope["acquire_config_lock"]()
assert events == ["config_lock"], events
assert flow.calls == [("c", "s")], flow.calls
gate.set()

# EOF before any grant: the save is refused, never done without the lock.
scope["_config_lock_held"].clear()
scope["_stdin_closed"].clear()
events.clear()
gate = reader([])
gate.set()
flow = Flow()
threading.Thread(target=scope["deliver_callback"], args=(flow,), daemon=True).start()
try:
    scope["acquire_config_lock"]()
    raise AssertionError("saved without the lock")
except scope["Refused"] as refused:
    assert refused.code == "OAUTH_CANCELLED", refused.code
assert flow.status == "error", flow.status

# Granted, then EOF right after: the grant does not outlive the operator
# giving up, nothing is written.
scope["_config_lock_held"].clear()
scope["_stdin_closed"].clear()
gate = reader([{"configLock": "held"}])
gate.set()
scope["deliver_callback"](Flow())
assert scope["_config_lock_held"].is_set() and scope["_stdin_closed"].is_set()
try:
    scope["acquire_config_lock"]()
    raise AssertionError("saved after the operator gave up")
except scope["Refused"] as refused:
    assert refused.code == "OAUTH_CANCELLED", refused.code
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(mcpOAuthProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("config lock handshake: %v\n%s", err, output)
	}
}

// authorize() itself never saves the server without the lock: with the
// upstream modules stubbed, a lock that is never granted means no save, and a
// granted one means the save happens after the config_lock request.
func TestMCPOAuthProbeAuthorizeSavesOnlyAfterTheLock(t *testing.T) {
	code := `import sys, types, contextlib
scope = {"__name__": "mcp_oauth_probe_authorize_test"}
exec(compile(sys.stdin.read(), "mcp_oauth_probe.py", "exec"), scope)
calls = []
scope["emit"] = lambda event, **fields: calls.append(event)
scope["CONFIG_LOCK_TIMEOUT_SECONDS"] = 5.0
scope["set_platform_entry"] = lambda name: calls.append("platform")
def module(name, **attrs):
    mod = types.ModuleType(name)
    mod.__dict__.update(attrs)
    sys.modules[name] = mod
@contextlib.contextmanager
def nothing(*args, **kwargs):
    yield
class Storage:
    def __init__(self, name): pass
    def snapshot(self): return None
    def restore(self, backup, only_if_absent=False): calls.append("restore")
class Manager:
    def remove(self, name): return None
    def restore_entry(self, name, entry): pass
module("hermes_cli")
module("tools")
module("hermes_cli.mcp_config", _oauth_tokens_present=lambda name: True,
       _probe_single_server=lambda name, cfg, connect_timeout: [("search",)],
       _save_mcp_server=lambda name, cfg: calls.append("save") or True)
module("tools.mcp_dashboard_oauth", dashboard_oauth_flow=nothing)
module("tools.mcp_oauth", HermesTokenStorage=Storage, force_interactive_oauth=nothing)
module("tools.mcp_oauth_manager", get_manager=lambda: Manager())
class Flow:
    def mark_approved(self): calls.append("approved")

# Never granted, the operator gone: no save, the previous OAuth state restored.
scope["_stdin_closed"].set()
try:
    scope["authorize"]("linear", {"url": "https://mcp.linear.app/mcp"}, Flow())
    raise AssertionError("authorize returned without the lock")
except scope["Refused"] as refused:
    assert refused.code == "OAUTH_CANCELLED", refused.code
assert calls == ["config_lock", "restore"], calls

# Granted: the save follows the request for the lock.
calls.clear()
scope["_stdin_closed"].clear()
scope["_config_lock_held"].set()
tools = scope["authorize"]("linear", {"url": "https://mcp.linear.app/mcp"}, Flow())
assert tools == ["search"], tools
assert calls == ["config_lock", "save", "platform", "approved"], calls
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(mcpOAuthProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("authorize under the lock: %v\n%s", err, output)
	}
}
