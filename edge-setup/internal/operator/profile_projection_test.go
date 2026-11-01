package operator

import (
	osexec "os/exec"
	"strings"
	"testing"
)

// Exercise the actual embedded Python, not a mock of its output.
func TestInventoryProbeProfileProjection(t *testing.T) {
	code := `import sys
scope = {"__name__": "profile_projection_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
routine = scope["routine_view"]
for schedule, expected in [
    ({"kind":"cron", "expr":"0 9 * * *"}, "0 9 * * *"),
    ({"kind":"interval", "minutes":30}, "every 30m"),
    ({"kind":"once", "run_at":"2026-09-07T09:00:00Z"}, "once"),
    ("every 2h", "every 2h"), ("0 9 * * *", "0 9 * * *"),
    ({"kind":"interval", "minutes":True}, ""),
    ({"kind":"interval", "minutes":0}, ""),
    ({"kind":"interval", "minutes":-1}, ""),
    ({"kind":"interval", "minutes":"30"}, ""),
]:
    assert routine({"schedule":schedule})["schedule"] == expected, schedule
flags = scope["profile_toolset_flags"]
assert flags({"platform_toolsets":{"api_server":["web", "memory"]}}) == [{"name":"web","enabled":True},{"name":"memory","enabled":True}]
assert flags({"platform_toolsets":{"api_server":[]},"toolsets":["web"]}) == []
assert flags({"toolsets":["web"]}) == [{"name":"web","enabled":True}]
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("profile projection: %v\n%s", err, output)
	}
}

func TestInventoryProbeProfileBundledSkillsSet(t *testing.T) {
	code := `import json, os, sys, tempfile
scope = {"__name__": "profile_bundled_skills_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
home = tempfile.mkdtemp()
scope["hermes_home"] = lambda: home
scope["named_profile_names"] = lambda: ["scout", "empty"]
scope["yaml_load"] = json.loads
def load(name):
    path = os.path.join(home, "profiles", name, "config.yaml")
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)
def save(name, config):
    path = os.path.join(home, "profiles", name, "config.yaml")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(config, handle)
scope["load_profile_config"] = load
scope["save_profile_config"] = save
for name, skills in [("scout", ["alpha", "hermes-agent", "learned"]), ("empty", [])]:
    directory = os.path.join(home, "profiles", name)
    skills_dir = os.path.join(directory, "skills")
    os.makedirs(skills_dir)
    with open(os.path.join(directory, "config.yaml"), "w", encoding="utf-8") as handle:
        json.dump({}, handle)
    for skill in skills:
        skill_dir = os.path.join(skills_dir, skill)
        os.makedirs(skill_dir)
        with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as handle:
            handle.write("skill")
with open(os.path.join(home, "profiles", "scout", "skills", ".bundled_manifest"), "w", encoding="utf-8") as handle:
    handle.write("alpha:abc123\nhermes-agent:def456\n")
handler = scope["HANDLERS"]["profile-bundled-skills-set"]
disabled = handler({"name": "scout", "enabled": False})
assert disabled == {"profile": "scout", "enabled": False, "bundled": 2, "bundledEnabled": 1, "essential": 1}, disabled
config = load("scout")
assert config["disabled_skills"] == ["alpha"], config
assert "learned" not in config["disabled_skills"] and "hermes-agent" not in config["disabled_skills"]
enabled = handler({"name": "scout", "enabled": True})
assert enabled["bundledEnabled"] == 2, enabled
assert load("scout")["disabled_skills"] == [], load("scout")
missing = handler({"name": "empty", "enabled": False})
assert missing == {"profile": "empty", "enabled": False, "bundled": 0, "bundledEnabled": 0, "essential": 0}, missing
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("profile bundled skills probe: %v\n%s", err, output)
	}
}

func TestInventoryProbeProfileToolsetSuppress(t *testing.T) {
	code := `import json, os, sys, tempfile
scope = {"__name__": "profile_toolset_suppress_test"}
exec(compile(sys.stdin.read(), "inventory_probe.py", "exec"), scope)
configs = {"scout": {"agent": {"disabled_toolsets": "['memory']"}}, "root": {"agent": {"disabled_toolsets": ["web"]}}}
scope["profile_exists"] = lambda name: name in ("scout",)
scope["load_profile_config"] = lambda name: json.loads(json.dumps(configs[name]))
def save(name, config):
    configs[name] = json.loads(json.dumps(config))
scope["save_profile_config"] = save
scope["load_config"] = lambda: configs["root"]
handler = scope["HANDLERS"]["profile-toolset-suppress"]
assert handler({"name": "scout", "toolset": "x_search", "suppressed": True}) == {"profile": "scout", "toolset": "x_search", "suppressed": True}
assert configs["scout"]["agent"]["disabled_toolsets"] == ["memory", "x_search"], configs
handler({"name": "scout", "toolset": "x_search", "suppressed": True})
assert configs["scout"]["agent"]["disabled_toolsets"] == ["memory", "x_search"], configs
assert handler({"name": "scout", "toolset": "x_search", "suppressed": False})["suppressed"] is False
# The root suppresses web: the operator's choice is never lifted from a profile.
configs["scout"]["agent"]["disabled_toolsets"] = ["web"]
assert handler({"name": "scout", "toolset": "web", "suppressed": False})["suppressed"] is True
for bad in ({"name": "scout", "toolset": "../x", "suppressed": True}, {"name": "scout", "toolset": "web", "suppressed": "yes"}, {"name": "ghost", "toolset": "web", "suppressed": True}):
    try:
        handler(bad)
    except scope["Refused"]:
        pass
    else:
        raise AssertionError(bad)
configs["scout"]["agent"]["disabled_toolsets"] = "not a list"
try:
    handler({"name": "scout", "toolset": "web", "suppressed": True})
except scope["Refused"] as refusal:
    assert refusal.code == "PROFILE_CONFIG_REFUSED"
else:
    raise AssertionError("an unreadable list was overwritten")
`
	cmd := osexec.Command("python3", "-c", code)
	cmd.Stdin = strings.NewReader(string(inventoryProbeScript))
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("profile toolset suppress probe: %v\n%s", err, output)
	}
}
