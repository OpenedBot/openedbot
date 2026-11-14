package operator

import (
	osexec "os/exec"
	"strings"
	"testing"
)

// The browser callback's RFC 9207 issuer reaches upstream's flow; an older
// upstream whose deliver_callback has no `iss` still gets the code. Exercises
// the actual embedded Python.
func TestMCPOAuthProbeDeliversTheIssuer(t *testing.T) {
	code := `import sys
scope = {"__name__": "mcp_oauth_probe_iss_test"}
exec(compile(sys.stdin.read(), "mcp_oauth_probe.py", "exec"), scope)
def run(flow, lines):
    queue = list(lines)
    scope["read_line"] = lambda: queue.pop(0) if queue else None
    scope["deliver_callback"](flow)
class Flow:
    def __init__(self): self.calls, self.status = [], "pending"
    def snapshot(self): return {"status": self.status}
    def deliver_callback(self, *, code, state, error, iss=None):
        self.calls.append((code, state, error, iss)); self.status = "approved"
    def mark_error(self, error): self.status = "error"
flow = Flow()
run(flow, [{"code": "c", "state": "s", "iss": "https://mcp.linear.app"}])
assert flow.calls == [("c", "s", None, "https://mcp.linear.app")], flow.calls
flow = Flow()
run(flow, [{"code": "c", "state": "s"}])
assert flow.calls == [("c", "s", None, None)], flow.calls
class OldFlow(Flow):
    def deliver_callback(self, *, code, state, error):
        self.calls.append((code, state, error)); self.status = "approved"
flow = OldFlow()
run(flow, [{"code": "c", "state": "s", "iss": "https://mcp.linear.app"}])
assert flow.calls == [("c", "s", None)], flow.calls
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(mcpOAuthProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("iss delivery: %v\n%s", err, output)
	}
}
