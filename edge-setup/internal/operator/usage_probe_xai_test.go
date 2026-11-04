package operator

import (
	osexec "os/exec"
	"strings"
	"testing"
)

// Exercise the embedded Python itself: Grok's billing document becomes one
// window, and nothing else (a malformed or partial document) is a reading.
func TestUsageProbeReadsGrokBillingAsOneWindow(t *testing.T) {
	code := `import sys, types
account_usage = types.ModuleType("agent.account_usage")
account_usage.fetch_account_usage = lambda *a, **k: None
sys.modules["agent"] = types.ModuleType("agent")
sys.modules["agent.account_usage"] = account_usage
scope = {"__name__": "usage_probe_xai_test"}
exec(compile(sys.stdin.read(), "usage_probe.py", "exec"), scope)
read = scope["xai_billing_usage"]
period = {"type": "USAGE_PERIOD_TYPE_WEEKLY", "start": "2026-11-03T00:00:00Z", "end": "2026-11-10T00:00:00.250Z"}
assert read({"config": {"creditUsagePercent": 42.5, "currentPeriod": period}}) == {"windows": [{"label": "Weekly", "used_percent": 42.5, "reset_at": "2026-11-10T00:00:00Z"}]}
# Grok omits a zero percentage but keeps a complete period.
assert read({"config": {"currentPeriod": period}})["windows"][0]["used_percent"] == 0.0
assert read({"config": {"currentPeriod": dict(period, type="USAGE_PERIOD_TYPE_MONTHLY")}})["windows"][0]["label"] == "Monthly"
# Out of range is clamped; an unknown period keeps a neutral label and no reset.
assert read({"config": {"creditUsagePercent": 140}}) == {"windows": [{"label": "Subscription", "used_percent": 100.0}]}
for body in [None, [], {}, {"config": None}, {"config": {}},
             {"config": {"creditUsagePercent": "12"}}, {"config": {"creditUsagePercent": True}},
             {"config": {"creditUsagePercent": float("nan")}},
             {"config": {"currentPeriod": dict(period, start=period["end"], end=period["start"])}},
             {"config": {"currentPeriod": dict(period, end="2026-11-10")}},
             {"config": {"currentPeriod": dict(period, type="USAGE_PERIOD_TYPE_DAILY")}}]:
    assert read(body) is None, body

# The whole probe: the gateway's token, one fixed GET, never a refresh, no
# upstream text relayed on failure.
calls = []
class Response:
    def __init__(self, status, body):
        self.status, self.body, self.content = status, body, b"{}"
    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError("HTTP %d WKE=privacy-mode: secret diagnostic" % self.status)
    def json(self):
        return self.body
reply = Response(200, {"config": {"creditUsagePercent": 7, "currentPeriod": period}})
class Client:
    def __init__(self, **kw):
        calls.append(("client", kw))
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def get(self, url, headers):
        calls.append(("get", url, headers))
        return reply
sys.modules["httpx"] = types.SimpleNamespace(Client=Client)
refreshes = []
def resolve(refresh_if_expiring=True, **kw):
    refreshes.append(refresh_if_expiring)
    return {"api_key": "tok-xyz"}
sys.modules["hermes_cli"] = types.ModuleType("hermes_cli")
sys.modules["hermes_cli.auth_xai"] = types.SimpleNamespace(resolve_xai_oauth_runtime_credentials=resolve)
result = scope["probe"]("xai-oauth")
assert result == {"provider": "xai-oauth", "usage": {"windows": [{"label": "Weekly", "used_percent": 7.0, "reset_at": "2026-11-10T00:00:00Z"}]}}, result
assert refreshes == [False], refreshes
get = [c for c in calls if c[0] == "get"][0]
assert get[1] == "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
assert get[2]["Authorization"] == "Bearer tok-xyz"
assert [c for c in calls if c[0] == "client"][0][1]["follow_redirects"] is False
reply = Response(403, {"error": "WKE=privacy-mode: x"})
assert scope["probe"]("xai-oauth") == {"provider": "xai-oauth", "unavailableReason": "account usage is unavailable"}
reply = Response(200, {"config": {"creditUsagePercent": 7}})
reply.content = b"x" * (64 * 1024 + 1)
assert scope["probe"]("xai-oauth")["unavailableReason"] == "account usage is unavailable"
# No token at all: not a reading, and no request leaves the host.
calls.clear()
sys.modules["hermes_cli.auth_xai"] = types.SimpleNamespace(resolve_xai_oauth_runtime_credentials=lambda **kw: {"api_key": ""})
assert scope["probe"]("xai-oauth")["unavailableReason"] == "account usage is unavailable"
assert calls == [], calls
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(usageProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("grok usage probe: %v\n%s", err, output)
	}
}
