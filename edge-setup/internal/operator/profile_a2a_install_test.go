package operator

import (
	osexec "os/exec"
	"strings"
	"testing"
)

func TestNewProfileGetsRootA2AGuardAndUnsafeCopyCleansUp(t *testing.T) {
	code := `import os, pathlib, sys, tempfile, types
scope = {"__name__": "profile_a2a_install_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
config = types.ModuleType("hermes_cli.config")
config.load_config = lambda: {"plugins": {"enabled": []}}
sys.modules["hermes_cli.config"] = config
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    profile = root / "profiles" / "ohb-client"
    profile.mkdir(parents=True, mode=0o700)
    scope["hermes_home"] = lambda: str(root)
    install = scope["install_profile_a2a_guard"]
    install("ohb-client")
    assert not (profile / "plugins").exists()
    config.load_config = lambda: {"plugins": {"enabled": ["ohb_a2a_policy"]}}
    try:
        install("ohb-client")
    except scope["Refused"]:
        pass
    else:
        raise AssertionError("enabled guard missing from root was ignored")
    source = root / "plugins" / "ohb_a2a_policy"
    source.mkdir(parents=True, mode=0o700)
    names = ("plugin.yaml", "__init__.py", "policy.py", "snapshot.py", "runtime_scope.py")
    for name in names:
        path = source / name
        path.write_bytes(("fixture:" + name).encode())
        path.chmod(0o600)
    install("ohb-client")
    target = profile / "plugins" / "ohb_a2a_policy"
    for name in names:
        assert (target / name).read_bytes() == (source / name).read_bytes()
        assert (target / name).stat().st_mode & 0o777 == 0o600
    assert (target / "runtime-home").read_text() == str(root) + "\n"
    assert not (profile / "hooks").exists()
    (source / "policy.py").unlink()
    (source / "policy.py").symlink_to(root / "outside")
    (root / "outside").write_text("must not follow")
    try:
        install("ohb-client")
    except (OSError, scope["Refused"]):
        pass
    else:
        raise AssertionError("guard copy followed a symlink")
    cleaned = []
    scope["multiplex_enabled"] = lambda: True
    scope["create_named_profile"] = lambda *_: None
    scope["delete_named_profile"] = cleaned.append
    scope["write_env_key"] = lambda *_: (_ for _ in ()).throw(AssertionError("key write ran after unsafe guard"))
    try:
        scope["verb_profile_create"]({"name":"ohb-client", "apiServerKey":"fixture-private-profile-bearer"})
    except (OSError, scope["Refused"]):
        pass
    else:
        raise AssertionError("unsafe profile was reported as created")
    assert cleaned == ["ohb-client"]
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("profile A2A installation: %v\n%s", err, output)
	}
}
