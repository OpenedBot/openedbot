package operator

import (
	osexec "os/exec"
	"strings"
	"testing"
)

// Run our actual embedded creation/proof program against the public .23
// per-profile terminal scope seam, with real tempfile layouts and config IO.
func TestFreshProfileWorkspacePolicyAndRefusals(t *testing.T) {
	code := `import json, os, pathlib, shutil, sys, tempfile, types
scope = {"__name__": "profile_workspace_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
original_delete = scope["delete_named_profile"]
package = types.ModuleType("tools")
terminal = types.ModuleType("tools.terminal_scope")
sys.modules["tools"] = package
sys.modules["tools.terminal_scope"] = terminal
projection_overlay = {}
def project(home):
    config = json.loads((pathlib.Path(home) / "config.yaml").read_text())
    result = {}
    for key, value in config.get("terminal", {}).items():
        name = "TERMINAL_ENV" if key == "backend" else "TERMINAL_" + key.upper()
        result[name] = json.dumps(value) if isinstance(value, (list, dict)) else str(value)
    result.update(projection_overlay)
    return result
terminal.build_profile_terminal_scope = project
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    (root / "profiles").mkdir(mode=0o700)
    shared = root / "workspaces"
    shared.mkdir(mode=0o700)
    original_file = shared / "keep.txt"
    original_file.write_text("existing operator data")
    config = {"terminal": {"backend":"docker", "cwd":"/workspace", "docker_volumes":[str(shared) + ":/workspace"],
      "docker_extra_args":["--volume", "/other:/other"], "docker_shared_container_key":"old-shared", "docker_mount_cwd_to_workspace":True}, "untouched":{"value":7}}
    (root / "config.yaml").write_text(json.dumps(config))
    root_before = (root / "config.yaml").read_bytes()
    scope["hermes_home"] = lambda: str(root)
    scope["load_profile_config"] = lambda name: json.loads((root / "profiles" / name / "config.yaml").read_text())
    scope["save_profile_config"] = lambda name, cfg: (root / "profiles" / name / "config.yaml").write_text(json.dumps(cfg))
    def seed(name, backend="docker"):
        home = root / "profiles" / name
        home.mkdir(mode=0o700)
        # Upstream .23 already seeds an empty workspace using the ambient umask.
        (home / "workspace").mkdir(mode=0o755)
        cfg = json.loads(json.dumps(config)); cfg["terminal"]["backend"] = backend
        (home / "config.yaml").write_text(json.dumps(cfg))
        return home
    old = seed("old")
    old_before = (old / "config.yaml").read_bytes()
    for name in ("alpha", "beta"):
        home = seed(name)
        assert scope["configure_new_profile_workspace"](name) is True
        saved = json.loads((home / "config.yaml").read_text())
        assert saved["untouched"] == {"value":7}
        assert saved["terminal"]["docker_volumes"] == [str(home / "workspace") + ":/workspace"]
        assert saved["terminal"]["cwd"] == "/workspace"
        assert saved["terminal"]["docker_shared_container_key"] == ""
        assert saved["terminal"]["docker_extra_args"] == []
        assert saved["terminal"]["docker_mount_cwd_to_workspace"] is False
        assert (home / "workspace").stat().st_mode & 0o777 == 0o700
        assert (home / "sandboxes").stat().st_mode & 0o777 == 0o700
        assert scope["verb_profile_workspace"]({"name":name}) == {"profile":name, "isolated":True, "sharedRoot":False}
    assert (root / "config.yaml").read_bytes() == root_before
    assert (old / "config.yaml").read_bytes() == old_before
    assert scope["verb_profile_workspace"]({"name":"old"})["isolated"] is False
    # "old" mounts the shared root but adds Docker args and a cwd bind: no proof.
    assert scope["verb_profile_workspace"]({"name":"old"})["sharedRoot"] is False
    legacy = seed("legacy")
    plain = json.loads((legacy / "config.yaml").read_text())
    plain["terminal"].update({"docker_extra_args": [], "docker_mount_cwd_to_workspace": False})
    (legacy / "config.yaml").write_text(json.dumps(plain))
    assert scope["verb_profile_workspace"]({"name":"legacy"}) == {"profile":"legacy", "isolated":False, "sharedRoot":True}
    plain["terminal"]["docker_volumes"] = [str(shared) + ":/workspace", "/etc:/host-etc"]
    (legacy / "config.yaml").write_text(json.dumps(plain))
    assert scope["verb_profile_workspace"]({"name":"legacy"})["sharedRoot"] is False
    assert scope["verb_profile_workspace"]({"name":"missing"})["sharedRoot"] is False
    assert original_file.read_text() == "existing operator data"
    native = seed("native", "local")
    before = (native / "config.yaml").read_bytes()
    assert scope["configure_new_profile_workspace"]("native") is False
    assert (native / "config.yaml").read_bytes() == before
    assert not (native / "sandboxes").exists()
    assert scope["profile_workspace_isolated"]("native") is False
    # A managed overlay or a config change after creation cannot be hidden by a cached profile view.
    projection_overlay["TERMINAL_DOCKER_VOLUMES"] = json.dumps([str(shared) + ":/workspace"])
    assert scope["profile_workspace_isolated"]("alpha") is False
    projection_overlay.clear()
    alpha = root / "profiles" / "alpha"
    changed = scope["load_profile_config"]("alpha")
    changed["terminal"]["docker_extra_args"] = ["--mount=type=bind,src=/,dst=/host"]
    scope["save_profile_config"]("alpha", changed)
    assert scope["profile_workspace_isolated"]("alpha") is False
    for name in ("default", "../beta", "a/b", "UPPER"):
        try: scope["verb_profile_workspace"]({"name":name})
        except scope["Refused"] as exc: assert exc.code == "PROFILE_INVALID"
        else: raise AssertionError("invalid profile was accepted")
    # Unsafe and non-empty directories must never be followed, overwritten, or adopted.
    unsafe = seed("unsafe")
    (unsafe / "workspace").rmdir()
    (unsafe / "workspace").symlink_to(root / "profiles" / "beta" / "workspace")
    assert scope["profile_workspace_isolated"]("unsafe") is False
    try: scope["configure_new_profile_workspace"]("unsafe")
    except scope["Refused"] as exc: assert exc.code == "PROFILE_WORKSPACE_UNVERIFIED"
    else: raise AssertionError("workspace symlink was adopted")
    nonempty = seed("nonempty")
    (nonempty / "workspace" / "keep.txt").write_text("do not overwrite")
    try: scope["configure_new_profile_workspace"]("nonempty")
    except scope["Refused"] as exc: assert exc.code == "PROFILE_WORKSPACE_UNVERIFIED"
    else: raise AssertionError("nonempty clone was adopted")
    assert (nonempty / "workspace" / "keep.txt").read_text() == "do not overwrite"
    # Exercise the real create failure cleanup; shutil.rmtree must not follow a planted child symlink.
    scope["multiplex_enabled"] = lambda: True
    scope["create_named_profile"] = lambda name, display: seed(name)
    scope["install_profile_a2a_guard"] = lambda name: None
    scope["profile_view"] = lambda name: {"name":name,"model":{}}
    scope["named_profile_names"] = lambda: [p.name for p in (root / "profiles").iterdir()]
    cleaned = []
    def cleanup(name):
        cleaned.append(name)
        shutil.rmtree(root / "profiles" / name)
    scope["delete_named_profile"] = cleanup
    projection_overlay["TERMINAL_DOCKER_VOLUMES"] = "[]"
    try: scope["invoke_handler"]("profile-create", {"name":"failed", "apiServerKey":"fixture-do-not-print"})
    except scope["Refused"] as exc:
        assert exc.code == "PROFILE_WORKSPACE_UNVERIFIED"
        assert "fixture-do-not-print" not in exc.message
    else: raise AssertionError("unproven fresh profile was returned")
    assert cleaned == ["failed"] and not (root / "profiles" / "failed").exists()
    assert original_file.read_text() == "existing operator data"
    # The existing delete path removes only its own private tree, never a
    # different profile reached by a planted workspace symlink.
    package = types.ModuleType("hermes_cli"); package.__path__ = []
    profiles_module = types.ModuleType("hermes_cli.profiles")
    def delete_profile(name, yes=False):
        assert yes is True
        shutil.rmtree(root / "profiles" / name)
    profiles_module.delete_profile = delete_profile
    sys.modules["hermes_cli"] = package
    sys.modules["hermes_cli.profiles"] = profiles_module
    kept = root / "profiles" / "beta" / "workspace" / "keep.txt"
    kept.write_text("sibling data stays")
    original_delete("unsafe")
    assert kept.read_text() == "sibling data stays"
    assert not (root / "profiles" / "unsafe").exists()
    projection_overlay.clear()
    created = scope["invoke_handler"]("profile-create", {"name":"created", "apiServerKey":"fixture-do-not-print"})
    assert created["verified"] is True
    assert scope["profile_workspace_isolated"]("created") is True
print("fresh workspace policy, disk proof, existing data and cleanup verified")
`
	python, err := osexec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	cmd := osexec.Command(python, "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("workspace policy fixture: %v\n%s", err, out)
	}
}
