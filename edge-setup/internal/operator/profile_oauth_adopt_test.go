package operator

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	osexec "os/exec"
	"slices"
	"strings"
	"sync"
	"testing"
)

// A reconnection from the console lands in the ROOT store. Before this, a
// profile that held its own xAI login kept its revoked refresh token and its
// bot failed with `invalid_grant` while the console said "connected".
func TestOAuthConnectedMakesNamedProfilesAdoptTheRootLogin(t *testing.T) {
	s, _, srv := newServer(t, `{"providers":[{"slug":"xai-oauth","authenticated":true}]}`)
	recorder := &probeRecorder{replies: map[string]string{
		"profile-oauth-adopt-root": `{"provider":"xai-oauth","profiles":["pilote-live"]}`,
	}}
	s.Probe = recorder.probe()
	login := newFakeLogin()
	s.StartLogin = func(context.Context, string) (Login, error) { return login, nil }
	_, out := call(t, srv, "POST", "/providers/xai-oauth/oauth", `{}`)
	id := out["sessionId"].(string)
	login.finish(nil)
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/providers/xai-oauth/oauth/"+id, "")
		return v["status"] == StatusConnected
	})
	if strings.Join(recorder.seen, ",") != "profile-oauth-adopt-root" || recorder.bodies[0] != `{"provider":"xai-oauth"}` {
		t.Fatalf("probe %v %v", recorder.seen, recorder.bodies)
	}
}

// finishOAuth runs one console login to its end and returns the last session.
func finishOAuth(t *testing.T, s *Server, srv *httptest.Server, provider string) map[string]any {
	t.Helper()
	login := newFakeLogin()
	s.StartLogin = func(context.Context, string) (Login, error) { return login, nil }
	_, out := call(t, srv, "POST", "/providers/"+provider+"/oauth", `{}`)
	id := out["sessionId"].(string)
	login.finish(nil)
	var last map[string]any
	waitFor(t, func() bool {
		_, last = call(t, srv, "GET", "/providers/"+provider+"/oauth/"+id, "")
		return last["status"] == StatusConnected || last["status"] == StatusFailed
	})
	return last
}

// A profile that still holds its own login is not a success: its bot would
// keep running on the dead grant. The message names it.
func TestOAuthReportsFailureWhenAProfileKeepsItsOwnLogin(t *testing.T) {
	s, _, srv := newServer(t, `{"providers":[{"slug":"xai-oauth","authenticated":true}]}`)
	s.Probe = (&probeRecorder{replies: map[string]string{
		"profile-oauth-adopt-root": `{"provider":"xai-oauth","profiles":["fresh"],"ownApiKey":[],"refused":[{"profile":"pilote-live","code":"PROFILE_AUTH_KEPT"}]}`,
	}}).probe()
	last := finishOAuth(t, s, srv, "xai-oauth")
	msg, _ := last["error"].(string)
	if last["status"] != StatusFailed || !strings.Contains(msg, "pilote-live still use their own older login of xai-oauth") {
		t.Fatalf("session %v", last)
	}
}

// One unreadable store is not an older login: its own message, and the
// profiles the probe could adopt are not hidden behind it.
func TestOAuthNamesAnUnreadableProfileStoreApart(t *testing.T) {
	s, _, srv := newServer(t, `{"providers":[{"slug":"xai-oauth","authenticated":true}]}`)
	s.Probe = (&probeRecorder{replies: map[string]string{
		"profile-oauth-adopt-root": `{"provider":"xai-oauth","profiles":["pilote-live"],"refused":[{"profile":"broken","code":"PROFILE_AUTH_UNREADABLE"}]}`,
	}}).probe()
	last := finishOAuth(t, s, srv, "xai-oauth")
	msg, _ := last["error"].(string)
	if last["status"] != StatusFailed || !strings.Contains(msg, "credential store of the named profile(s) broken could not be read") || strings.Contains(msg, "older login") {
		t.Fatalf("session %v", last)
	}
}

// A probe that fails as a whole (timeout, crash) says so, never "a profile
// still uses its own login".
func TestOAuthReportsAProbeFailureAsUnchecked(t *testing.T) {
	s, _, srv := newServer(t, `{"providers":[{"slug":"xai-oauth","authenticated":true}]}`)
	s.Probe = (&probeRecorder{replies: map[string]string{}}).probe()
	last := finishOAuth(t, s, srv, "xai-oauth")
	msg, _ := last["error"].(string)
	if last["status"] != StatusFailed || !strings.Contains(msg, "could not be checked") || strings.Contains(msg, "still use") {
		t.Fatalf("session %v", last)
	}
}

// A profile that keeps its own API key for the provider is a per-bot key, not
// a failure of the root login: the session connects, the profile is not
// counted as adopted.
func TestOAuthConnectsWhenAProfileKeepsItsOwnAPIKey(t *testing.T) {
	s, _, srv := newServer(t, `{"providers":[{"slug":"anthropic","authenticated":true}]}`)
	s.Probe = (&probeRecorder{replies: map[string]string{
		"profile-oauth-adopt-root": `{"provider":"anthropic","profiles":[],"ownApiKey":["pilote-live"],"refused":[]}`,
	}}).probe()
	if last := finishOAuth(t, s, srv, "anthropic"); last["status"] != StatusConnected {
		t.Fatalf("session %v", last)
	}
}

// A profile that keeps a live login of another account is a deliberate
// per-bot login, not a failure of the root one: the session connects, the
// profile is not counted as adopted, and the log counts it without naming a
// token.
func TestOAuthConnectsWhenAProfileKeepsAnIndependentLogin(t *testing.T) {
	s, _, srv := newServer(t, `{"providers":[{"slug":"xai-oauth","authenticated":true}]}`)
	s.Probe = (&probeRecorder{replies: map[string]string{
		"profile-oauth-adopt-root": `{"provider":"xai-oauth","profiles":["pilote-live"],"ownApiKey":[],"independent":["work"],"refused":[]}`,
	}}).probe()
	var mu sync.Mutex
	var logs []string
	s.Logf = func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		logs = append(logs, fmt.Sprintf(format, args...))
	}
	if last := finishOAuth(t, s, srv, "xai-oauth"); last["status"] != StatusConnected {
		t.Fatalf("session %v", last)
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Contains(logs, "1 named profile(s) keep their own xai-oauth login of another account") {
		t.Fatalf("logs %q", logs)
	}
}

// API-key providers have no single-use grant: no profile is touched.
func TestOAuthOfAnAPIKeyProviderLeavesProfilesAlone(t *testing.T) {
	s, _, srv := newServer(t, `{"providers":[{"slug":"openrouter","authenticated":true}]}`)
	recorder := &probeRecorder{replies: map[string]string{}}
	s.Probe = recorder.probe()
	login := newFakeLogin()
	s.StartLogin = func(context.Context, string) (Login, error) { return login, nil }
	_, out := call(t, srv, "POST", "/providers/openrouter/oauth", `{}`)
	id := out["sessionId"].(string)
	login.finish(nil)
	waitFor(t, func() bool {
		_, v := call(t, srv, "GET", "/providers/openrouter/oauth/"+id, "")
		return v["status"] == StatusConnected
	})
	if len(recorder.seen) != 0 {
		t.Fatalf("probe ran for an API-key provider: %v", recorder.seen)
	}
}

// adoptProbePrelude loads our embedded probe and a fixture HERMES_HOME. The
// upstream lock is absent from the fixture, so the probe falls back to its own
// atomic write. upstream_pool and upstream_state resolve a profile's login the
// way upstream does (`read_credential_pool`, `_load_provider_state_with_source`
// in hermes_cli/auth.py): the profile's pool slice wins when it has ANY entry,
// the profile's providers block wins as soon as it is a dict.
const adoptProbePrelude = `import base64, json, os, sys, tempfile
scope = {"__name__": "profile_oauth_adopt_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
home = tempfile.mkdtemp()
os.environ["HERMES_HOME"] = home
root = os.path.join(home, "auth.json")
def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        json.dump(data, handle)
def read(path):
    with open(path) as handle:
        return json.load(handle)
def profile(name):
    return os.path.join(home, "profiles", name, "auth.json")
def upstream_pool(name, provider):
    rows = (read(profile(name)).get("credential_pool") or {}).get(provider)
    if isinstance(rows, list) and rows:
        return [row.get("id") for row in rows]
    return [row.get("id") for row in (read(root).get("credential_pool") or {}).get(provider) or []]
def upstream_state(name, provider):
    block = (read(profile(name)).get("providers") or {}).get(provider)
    if isinstance(block, dict):
        return block
    return (read(root).get("providers") or {}).get(provider)
# An unsigned JWT-shaped access token naming one account (xAI / Codex shape).
def jwt(subject):
    claims = base64.urlsafe_b64encode(json.dumps({"sub": subject}).encode()).decode().rstrip("=")
    return "e30." + claims + ".sig"
`

// runAdoptProbe runs the prelude then body; body prints a JSON list of the
// top-level refusal codes it saw, each of which must be in the contract.
func runAdoptProbe(t *testing.T, body string) {
	t.Helper()
	cmd := osexec.Command("python3", "-c", adoptProbePrelude+body)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("profile oauth adopt: %v\n%s", err, output)
	}
	var codes []string
	if err := json.Unmarshal(output, &codes); err != nil {
		t.Fatalf("profile oauth adopt result: %v\n%s", err, output)
	}
	for _, code := range codes {
		if _, ok := probeRefusals[code]; !ok {
			t.Errorf("probe returned out-of-contract refusal %q", code)
		}
	}
}

// The root store, other providers and API-key rows stay untouched; each
// outcome is checked the way upstream resolves a profile's login, not only on
// the file contents.
func TestProfileOAuthAdoptRootProbe(t *testing.T) {
	runAdoptProbe(t, `root_store = {"active_provider": "xai-oauth",
              "providers": {"xai-oauth": {"tokens": {"access_token": "root-a", "refresh_token": "root-r"}},
                            "nous": {"access_token": "root-na", "refresh_token": "root-nr", "agent_key": "root-k"}},
              "credential_pool": {"xai-oauth": [{"id": "root", "auth_type": "oauth", "refresh_token": "root-r"}],
                                  "nous": [{"id": "root-nous", "auth_type": "oauth", "refresh_token": "root-nr"}]}}
write(root, root_store)
for name in ("pilote-live", "mixed", "noref", "fresh", "linked", "other", "broken", "nousy", "shared", "sharedclean"):
    write(os.path.join(home, "profiles", name, "config.yaml"), {})
# The clone of root whose copied grant died with invalid_grant: upstream marked
# the pool row dead and quarantined the block (tokens cleared, marker set).
write(profile("pilote-live"), {
    "active_provider": "xai-oauth",
    "providers": {"xai-oauth": {"tokens": {}, "last_auth_error": {"code": "invalid_grant", "relogin_required": True}},
                  "openai-codex": {"tokens": {"refresh_token": "codex-r"}}},
    "credential_pool": {
        "xai-oauth": [{"id": "dead", "auth_type": "oauth", "access_token": "dead-a", "refresh_token": "dead-r",
                       "last_status": "dead", "last_error_reason": "invalid_grant"}],
        "anthropic": [{"id": "claude", "auth_type": "oauth", "refresh_token": "claude-r"}],
    },
})
# Mixed store: a spent OAuth row and an API-key row of the same provider.
write(profile("mixed"), {"credential_pool": {"xai-oauth": [
    {"id": "old-grant", "auth_type": "oauth", "refresh_token": "old-r", "last_status": "exhausted", "last_error_reason": "refresh_token_reused"},
    {"id": "old-key", "auth_type": "api_key", "access_token": "xai-key"}]}})
# A device-code block with an access token and no refresh token: unrenewable.
write(profile("noref"), {"providers": {"xai-oauth": {"tokens": {"access_token": "x"}}}})
# A copy of the root row itself (same pool id).
write(profile("other"), {"providers": {}, "credential_pool": {"xai-oauth": [{"id": "root", "refresh_token": "other-r"}]}})
with open(profile("broken"), "w") as handle:
    handle.write("{not json")
# A nous login without a refresh token: agent_key-only row plus its block.
write(profile("nousy"), {"providers": {"nous": {"access_token": "na", "agent_key": "k"}},
                         "credential_pool": {"nous": [{"id": "agent-only", "auth_type": "oauth", "access_token": "na", "agent_key": "k"}]}})
os.symlink(root, os.path.join(home, "profiles", "linked", "auth.json"))
# Links to a store that is NOT the root: never written through. One holding a
# spent grant is a kept login (upstream reads it as the profile's own); a clean
# one needs nothing.
elsewhere = os.path.join(home, "elsewhere", "auth.json")
write(elsewhere, {"credential_pool": {"xai-oauth": [{"id": "far", "auth_type": "oauth", "refresh_token": "far-r", "last_status": "dead"}]}})
os.symlink(elsewhere, profile("shared"))
clean = os.path.join(home, "clean", "auth.json")
write(clean, {"credential_pool": {}})
os.symlink(clean, profile("sharedclean"))
codes = []
def refused(verb, request, expected):
    try:
        scope["invoke_handler"](verb, request)
    except scope["Refused"] as error:
        assert error.code == expected, (error.code, expected)
        codes.append(error.code)
        return
    raise AssertionError(verb + " was not refused")
result = scope["invoke_handler"]("profile-oauth-adopt-root", {"provider": "xai-oauth"})
assert result["provider"] == "xai-oauth", result
assert sorted(result["profiles"]) == ["noref", "other", "pilote-live"], result
assert result["ownApiKey"] == ["mixed"], result
assert result["independent"] == [], result
assert sorted(result["refused"], key=lambda r: r["profile"]) == [{"profile": "broken", "code": "PROFILE_AUTH_UNREADABLE"}, {"profile": "shared", "code": "PROFILE_AUTH_KEPT"}], result
assert read(elsewhere)["credential_pool"]["xai-oauth"][0]["refresh_token"] == "far-r", "a shared store was written through its link"
store = read(profile("pilote-live"))
assert "xai-oauth" not in store["providers"], store
assert store["providers"]["openai-codex"]["tokens"]["refresh_token"] == "codex-r", store
assert "xai-oauth" not in store["credential_pool"], store
assert store["credential_pool"]["anthropic"][0]["refresh_token"] == "claude-r", store
assert store["active_provider"] == "xai-oauth", store
for name in ("pilote-live", "noref", "other"):
    assert upstream_pool(name, "xai-oauth") == ["root"], name
    assert upstream_state(name, "xai-oauth")["tokens"]["refresh_token"] == "root-r", name
# The mixed profile keeps its own key and, upstream, never reads the root login.
assert read(profile("mixed"))["credential_pool"]["xai-oauth"] == [{"id": "old-key", "auth_type": "api_key", "access_token": "xai-key"}]
assert upstream_pool("mixed", "xai-oauth") == ["old-key"]
assert read(root) == root_store, "the root store changed"
assert not os.path.exists(profile("fresh"))
mode = os.stat(profile("pilote-live")).st_mode & 0o777
assert mode == 0o600, oct(mode)
# Idempotent: nothing left to adopt, the kept key and the broken store stay reported.
again = scope["invoke_handler"]("profile-oauth-adopt-root", {"provider": "xai-oauth"})
assert again["profiles"] == [] and again["ownApiKey"] == ["mixed"] and sorted(again["refused"], key=lambda r: r["profile"]) == [{"profile": "broken", "code": "PROFILE_AUTH_UNREADABLE"}, {"profile": "shared", "code": "PROFILE_AUTH_KEPT"}], again
# nous without a refresh token: the row and its block leave together.
nous = scope["invoke_handler"]("profile-oauth-adopt-root", {"provider": "nous"})
assert nous["profiles"] == ["nousy"], nous
assert upstream_pool("nousy", "nous") == ["root-nous"]
assert upstream_state("nousy", "nous")["refresh_token"] == "root-nr"
# A write the re-read does not see is a refusal, never an adoption.
write(profile("noref"), {"providers": {"xai-oauth": {"tokens": {"access_token": "x"}}}})
scope["write_auth_store"] = lambda path, data: None
kept = scope["invoke_handler"]("profile-oauth-adopt-root", {"provider": "xai-oauth"})
assert {"profile": "noref", "code": "PROFILE_AUTH_KEPT"} in kept["refused"] and "noref" not in kept["profiles"], kept
refused("profile-oauth-adopt-root", {"provider": "openrouter"}, "PROVIDER_INVALID")
refused("profile-oauth-adopt-root", {"provider": "../x"}, "PROVIDER_INVALID")
print(json.dumps(sorted(codes)))
`)
}

// A global reconnection must never cost a profile a login of ANOTHER account
// that still works (`hermes -p work auth add xai-oauth`). A profile grant is
// dropped only when it is provably spent, or provably root's own account or
// lineage; anything else is left byte for byte and reported as independent.
func TestProfileOAuthAdoptRootKeepsAnIndependentLogin(t *testing.T) {
	runAdoptProbe(t, `root_store = {"active_provider": "xai-oauth",
              "providers": {"xai-oauth": {"tokens": {"access_token": jwt("acct-root"), "refresh_token": "root-r2"}}},
              "credential_pool": {"xai-oauth": [{"id": "root", "auth_type": "oauth", "source": "device_code",
                                                 "access_token": jwt("acct-root"), "refresh_token": "root-r2", "last_status": "ok"}]}}
write(root, root_store)
root_singleton = {"accessToken": "sk-ant-oat-root", "refreshToken": "root-ar", "expiresAt": 1}
write(os.path.join(home, ".anthropic_oauth.json"), root_singleton)
stores = {
    # Another, healthy account added on the profile itself.
    "work": {"credential_pool": {"xai-oauth": [{"id": "w1", "auth_type": "oauth", "source": "manual:device_code",
                                                "access_token": jwt("acct-work"), "refresh_token": "work-r", "last_status": "ok"}]}},
    # Re-logged after an old failure: upstream keeps the marker, the tokens are live.
    "relogged": {"providers": {"xai-oauth": {"tokens": {"access_token": jwt("acct-work"), "refresh_token": "work-r3"},
                                             "last_auth_error": {"code": "xai_refresh_failed", "relogin_required": True}}}},
    # No identity claim and no material shared with root: nothing proves it is root's.
    "opaque": {"credential_pool": {"xai-oauth": [{"id": "o1", "auth_type": "oauth", "access_token": "opaque-a", "refresh_token": "opaque-r"}]}},
    # A copied row id (upstream upserts device_code rows by source) whose tokens name another account.
    "forked": {"credential_pool": {"xai-oauth": [{"id": "root", "auth_type": "oauth", "access_token": jwt("acct-old"), "refresh_token": "old-r"}]}},
    # The pilote-live case: the copied grant died with invalid_grant, its block was quarantined.
    "dead": {"providers": {"xai-oauth": {"tokens": {}, "last_auth_error": {"code": "invalid_grant", "relogin_required": True}}},
             "credential_pool": {"xai-oauth": [{"id": "c1", "auth_type": "oauth", "access_token": jwt("acct-old"), "refresh_token": "spent-r",
                                                "last_status": "dead", "last_error_reason": "invalid_grant"}]}},
    # Exhausted with a terminal reason; the block still holds that same spent refresh token.
    "reused": {"providers": {"xai-oauth": {"tokens": {"access_token": "spent-a", "refresh_token": "reused-r"}}},
               "credential_pool": {"xai-oauth": [{"id": "c2", "auth_type": "oauth", "refresh_token": "reused-r",
                                                  "last_status": "exhausted", "last_error_reason": "refresh_token_reused"}]}},
    # Same lineage: the root row id, copied at clone time.
    "copied": {"credential_pool": {"xai-oauth": [{"id": "root", "auth_type": "oauth", "access_token": "copied-a", "refresh_token": "copied-r"}]}},
    # Its own grant of the account root now holds.
    "sameacct": {"providers": {"xai-oauth": {"tokens": {"access_token": jwt("acct-root"), "refresh_token": "mine-r"}}}},
    # Root's refresh token itself.
    "twin": {"credential_pool": {"xai-oauth": [{"id": "t1", "auth_type": "oauth", "access_token": "twin-a", "refresh_token": "root-r2"}]}},
}
for name, data in stores.items():
    write(os.path.join(home, "profiles", name, "config.yaml"), {})
    write(profile(name), data)
# A link to a shared store holding another live account: kept, never written.
far = os.path.join(home, "team", "auth.json")
far_store = {"credential_pool": {"xai-oauth": [{"id": "team", "auth_type": "oauth", "access_token": jwt("acct-team"), "refresh_token": "team-r"}]}}
write(far, far_store)
write(os.path.join(home, "profiles", "sharedwork", "config.yaml"), {})
os.symlink(far, profile("sharedwork"))
# Anthropic singletons: another account's own file, and a copy of root's.
for name, data in (("claude-work", {"accessToken": "sk-ant-oat-work", "refreshToken": "work-ar", "expiresAt": 1}),
                   ("claude-copy", root_singleton)):
    write(os.path.join(home, "profiles", name, "config.yaml"), {})
    write(os.path.join(home, "profiles", name, ".anthropic_oauth.json"), data)
result = scope["invoke_handler"]("profile-oauth-adopt-root", {"provider": "xai-oauth"})
assert sorted(result["independent"]) == ["forked", "opaque", "relogged", "sharedwork", "work"], result
assert sorted(result["profiles"]) == ["copied", "dead", "reused", "sameacct", "twin"], result
assert result["ownApiKey"] == [] and result["refused"] == [], result
for name in ("forked", "opaque", "relogged", "work"):
    assert read(profile(name)) == stores[name], name
assert read(far) == far_store, "a shared store was written through its link"
for name in ("copied", "dead", "reused", "sameacct", "twin"):
    assert upstream_pool(name, "xai-oauth") == ["root"], name
    assert upstream_state(name, "xai-oauth")["tokens"]["refresh_token"] == "root-r2", name
assert read(root) == root_store, "the root store changed"
# The wire result names profiles only, never token material.
wire = json.dumps(result)
for secret in ("work-r", "opaque-r", "old-r", "spent-r", "root-r2", jwt("acct-work")):
    assert secret not in wire, secret
# Idempotent: the independent logins stay reported, nothing left to adopt.
again = scope["invoke_handler"]("profile-oauth-adopt-root", {"provider": "xai-oauth"})
assert sorted(again["independent"]) == ["forked", "opaque", "relogged", "sharedwork", "work"] and again["profiles"] == [], again
claude = scope["invoke_handler"]("profile-oauth-adopt-root", {"provider": "anthropic"})
assert claude["independent"] == ["claude-work"] and claude["profiles"] == ["claude-copy"], claude
assert os.path.exists(os.path.join(home, "profiles", "claude-work", ".anthropic_oauth.json"))
assert not os.path.exists(os.path.join(home, "profiles", "claude-copy", ".anthropic_oauth.json"))
print("[]")
`)
}
