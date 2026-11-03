import json
import os
import stat
from pathlib import Path

# Both directions of a profile toolset batch in ONE process. Each
# `hermes -p <slug> tools enable|disable` spawn costs ~2.4 s on the lab
# (Python + Hermes imports, 2026-11-02); this applies the same upstream change
# (`_apply_toolset_change`, what `tools enable|disable` calls) to the
# profile's configuration, scoped like approval_policy_config.py: HERMES_HOME
# is the profile's home BEFORE Hermes is imported, and the configuration
# Hermes resolves must be that profile's file, or nothing is written (the
# upstream save would otherwise land on the root's configuration).
root = Path(os.environ["OPENEDBOT_TOOLSETS_ROOT"])
slug = os.environ["OPENEDBOT_TOOLSETS_PROFILE"]
enable = [name for name in os.environ.get("OPENEDBOT_TOOLSETS_ENABLE", "").split(",") if name]
disable = [name for name in os.environ.get("OPENEDBOT_TOOLSETS_DISABLE", "").split(",") if name]
home = (root / "profiles" / slug).absolute()
config_path = home / "config.yaml"
os.environ["HERMES_HOME"] = str(home)

from hermes_cli.config import get_config_path, load_config, save_config  # noqa: E402
from hermes_cli.tools_config_mcp import _apply_toolset_change  # noqa: E402

if Path(get_config_path()).absolute() != config_path:
    raise SystemExit("Hermes resolves another configuration file")
descriptor = os.open(config_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
try:
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        raise SystemExit("profile configuration is not a regular file")
finally:
    os.close(descriptor)

config = load_config()
if not isinstance(config, dict):
    raise SystemExit("profile configuration must be a mapping")
if enable:
    _apply_toolset_change(config, "api_server", enable, "enable")
if disable:
    _apply_toolset_change(config, "api_server", disable, "disable")
save_config(config)
print(json.dumps({"profile": slug, "enabled": enable, "disabled": disable}))
