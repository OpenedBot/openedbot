package operator

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	osexec "os/exec"
	"strings"
	"testing"
)

// An unsettled identity is a refusal, never a 204: openedbot keeps the bot in the
// trash and the next purge retries the settlement.
func TestProfileDeleteUnsettledIdentityIsNotASuccess(t *testing.T) {
	for _, tc := range []struct {
		name     string
		reply    string
		profiles string
		status   int
		code     string
	}{
		{"settled", `{"deleted":"scout"}`, `[]`, http.StatusNoContent, ""},
		{"unsettled", `{"error":{"code":"PROFILE_UNVERIFIED","message":"not settled"}}`, `[]`, http.StatusBadGateway, "PROFILE_UNVERIFIED"},
		{"retained", `{"deleted":"scout"}`, `[{"name":"scout"}]`, http.StatusBadGateway, "PROFILE_UNVERIFIED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := &probeRecorder{replies: map[string]string{
				"profile-delete": tc.reply,
				"profiles":       `{"multiplex":true,"profiles":` + tc.profiles + `}`,
			}}
			s := &Server{Probe: recorder.probe()}
			request := httptest.NewRequest(http.MethodDelete, "/profiles/scout", nil)
			request.SetPathValue("slug", "scout")
			response := httptest.NewRecorder()
			s.deleteProfile(response, request)
			if response.Code != tc.status {
				t.Fatalf("status %d: %s", response.Code, response.Body.String())
			}
			if tc.code != "" && !strings.Contains(response.Body.String(), tc.code) {
				t.Fatalf("body %s, want code %s", response.Body.String(), tc.code)
			}
		})
	}
}

// Execute only our embedded probe. The upstream library is replaced by narrow
// fixtures modelling its public signatures and v0.22.2 partial-delete result.
func TestProfileLifecycleRefusalsAndSettlement(t *testing.T) {
	code := `import json, pathlib, shutil, sys, tempfile, types
scope = {"__name__": "profile_lifecycle_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
package = types.ModuleType("hermes_cli")
profiles = types.ModuleType("hermes_cli.profiles")
package.profiles = profiles
sys.modules["hermes_cli"] = package
sys.modules["hermes_cli.profiles"] = profiles
identity = types.ModuleType("hermes_cli.profile_identity")
package.profile_identity = identity
sys.modules["hermes_cli.profile_identity"] = identity
class Pending(RuntimeError):
    pass
profiles.ProfileIdentitySettlementPending = Pending
codes = set()
def refused(verb, request, expected):
    try:
        scope["invoke_handler"](verb, request)
    except scope["Refused"] as exc:
        assert exc.code == expected, (exc.code, expected)
        assert "fixture-secret" not in exc.message
        codes.add(exc.code)
    else:
        raise AssertionError("operation unexpectedly succeeded")
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    name = "ohb-fixture-8f2a"
    directory = root / "profiles" / name
    scope["hermes_home"] = lambda: str(root)
    scope["named_profile_names"] = lambda: [name] if (directory / "config.yaml").exists() else []
    scope["multiplex_enabled"] = lambda: True
    request = {"name": name, "apiServerKey": "fixture-private-profile-bearer"}
    def seed():
        directory.mkdir(parents=True)
        (directory / "config.yaml").write_text("{}")
    # (raises pending, upstream purge-identity retry answer, settled)
    for raises, retry, settled in ((False, None, True), (True, True, True), (True, False, False)):
        seed()
        retries = []
        def delete(name, yes=False):
            assert yes is True
            shutil.rmtree(directory)
            if raises:
                raise Pending("fixture-secret")
        def purge(name):
            assert not directory.exists(), "retry ran before the directory was removed"
            retries.append(name)
            return retry
        profiles.delete_profile = delete
        identity.purge_profile_identity = purge
        if settled:
            result = scope["invoke_handler"]("profile-delete", {"name": name})
            assert result == {"deleted": name}, result
        else:
            refused("profile-delete", {"name": name}, "PROFILE_UNVERIFIED")
        assert retries == ([name] if raises else []), retries
        assert not directory.exists()
    # Never call a retained directory a completed deletion, even if an upstream
    # exception incorrectly claims that it has already been removed.
    seed()
    profiles.delete_profile = lambda *a, **kw: (_ for _ in ()).throw(Pending("fixture-secret"))
    refused("profile-delete", {"name": name}, "PROFILE_CONFIG_REFUSED")
    assert directory.exists()
    calls = []
    def broken_delete(name, yes=False):
        calls.append(yes)
        raise TypeError("fixture-secret")
    profiles.delete_profile = broken_delete
    refused("profile-delete", {"name": name}, "PROFILE_CONFIG_REFUSED")
    assert calls == [True], calls
    shutil.rmtree(directory)
    # A retry of an unsettled delete settles first: NOT_FOUND means fully gone.
    identity.purge_profile_identity = lambda name: False
    refused("profile-delete", {"name": name}, "PROFILE_UNVERIFIED")
    identity.purge_profile_identity = lambda name: True
    refused("profile-delete", {"name": name}, "PROFILE_NOT_FOUND")
    # Upstream publishes the directory, then fails: the half profile is removed.
    def publish_then_fail(name, clone_from=None, clone_config=False, description=None):
        seed()
        raise RuntimeError("fixture-secret")
    profiles.create_profile = publish_then_fail
    profiles.delete_profile = lambda name, yes=False: shutil.rmtree(directory)
    refused("profile-create", request, "PROFILE_CONFIG_REFUSED")
    assert not directory.exists(), "a failed upstream create stranded the profile"
    # A TypeError inside a compatible API must not invoke the manual fallback.
    calls.clear()
    def broken_create(name, clone_from=None, clone_config=False, description=None):
        calls.append((clone_from, clone_config, description))
        raise TypeError("fixture-secret")
    profiles.create_profile = broken_create
    scope["manual_clone_profile"] = lambda *a: (_ for _ in ()).throw(AssertionError("mutation replayed"))
    refused("profile-create", {**request, "displayName": "Fixture"}, "PROFILE_CONFIG_REFUSED")
    assert calls == [("default", True, "Fixture")], calls
    assert not directory.exists()
    # 0.22.2 validates reserved names and refuses marker-less directories.
    for error, expected in [(ValueError, "PROFILE_INVALID"), (FileExistsError, "PROFILE_EXISTS")]:
        def rejected_create(name, clone_from=None, clone_config=False, description=None):
            raise error("fixture-secret")
        profiles.create_profile = rejected_create
        refused("profile-create", request, expected)
    # All finalization is rollback-protected, including display-name writes
    # and CLI SystemExit (which is not an Exception).
    def create(name, clone_from=None, clone_config=False, description=None):
        seed()
    profiles.create_profile = create
    profiles.delete_profile = lambda name, yes=False: shutil.rmtree(directory)
    for failure in (OSError, SystemExit):
        scope["set_profile_display_name"] = lambda *a: (_ for _ in ()).throw(failure("fixture-secret"))
        refused("profile-create", {**request, "displayName": "Fixture"}, "PROFILE_CONFIG_REFUSED")
        assert not directory.exists(), "failed initialization stranded the profile"
    # Unknown upstream failures and exits still cross the closed Go contract.
    for verb in ("profile-create", "profile-delete"):
        for failure in (PermissionError, ImportError, RuntimeError, SystemExit):
            scope["HANDLERS"][verb] = lambda request: (_ for _ in ()).throw(failure("fixture-secret"))
            refused(verb, request, "PROFILE_CONFIG_REFUSED")
print(json.dumps(sorted(codes)))
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("profile lifecycle: %v\n%s", err, output)
	}
	var codes []string
	if err := json.Unmarshal(output, &codes); err != nil {
		t.Fatalf("profile lifecycle result: %v\n%s", err, output)
	}
	for _, code := range codes {
		if _, ok := probeRefusals[code]; !ok {
			t.Errorf("probe returned out-of-contract refusal %q", code)
		}
	}
}

// The targeted read-back of a fresh profile (DEV-OHB-244) must say "verified"
// only when the host lists the profile under that name and the model block
// carries the requested pair; anything else sends the operator to the full
// inventory.
func TestCreatedProfileVerifiedIsStrict(t *testing.T) {
	code := `import json, sys
scope = {"__name__": "created_profile_verified_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
verify = scope["created_profile_verified"]
view = {"name": "scout", "model": {"provider": "anthropic", "default": "claude-sonnet-4"}}
out = {}
scope["named_profile_names"] = lambda: ["scout"]
scope["profile_exists"] = lambda name: True
out["plain"] = verify("scout", view, None, None)
out["model_ok"] = verify("scout", view, "anthropic", "claude-sonnet-4")
out["model_other"] = verify("scout", view, "anthropic", "claude-opus-4")
out["other_name"] = verify("other", view, None, None)
scope["named_profile_names"] = lambda: []
out["unlisted"] = verify("scout", view, None, None)
scope["named_profile_names"] = lambda: ["scout"]
scope["profile_exists"] = lambda name: False
out["no_config"] = verify("scout", view, None, None)
def boom():
    raise RuntimeError("fixture-secret")
scope["named_profile_names"] = boom
out["raises"] = verify("scout", view, None, None)
print(json.dumps(out))
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("created profile verified: %v\n%s", err, output)
	}
	var got map[string]bool
	if err := json.Unmarshal(output, &got); err != nil {
		t.Fatalf("result: %v\n%s", err, output)
	}
	want := map[string]bool{"plain": true, "model_ok": true, "model_other": false, "other_name": false, "unlisted": false, "no_config": false, "raises": false}
	for key, expected := range want {
		if got[key] != expected {
			t.Fatalf("%s: got %v want %v (%v)", key, got[key], expected, got)
		}
	}
}
