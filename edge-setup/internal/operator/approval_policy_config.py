import json
import os
import stat
from pathlib import Path

# The Hermes venv ships ruamel.yaml, not PyYAML: read and write the profile
# configuration through Hermes' own config API, scoped to this profile, like
# a2a_policy_host.py. Measured on the lab on 2026-10-22: `import yaml` failed
# there, so the policy could never be proven.
root = Path(os.environ["OHB_APPROVAL_ROOT"])
slug = os.environ["OHB_APPROVAL_PROFILE"]
home = (root / "profiles" / slug).absolute()
config = home / "config.yaml"
os.environ["HERMES_HOME"] = str(home)

from hermes_cli.config import get_config_path, load_config, load_config_readonly, save_config  # noqa: E402

try:
    if Path(get_config_path()).absolute() != config:
        raise ValueError("Hermes resolves another configuration file")
    descriptor = os.open(config, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("profile configuration is not a regular file")
    finally:
        os.close(descriptor)
    # Enabling writes `plugins.enabled` itself. `hermes plugins enable` routes
    # through plugin admission, which initialised a package-manager environment
    # without the install's extras on the lab (2026-10-22: no aiohttp, no API
    # server). Startup only honours an existing PM selection and never prepares
    # one (pm/environments.py), so a config write loads the plugin on the
    # existing venv.
    enable = os.environ.get("OHB_APPROVAL_ENABLE") == "1"
    data = (load_config() if enable else load_config_readonly()) or {}
    if not isinstance(data, dict):
        raise ValueError("profile configuration must be a mapping")
    plugins = data.get("plugins")
    if plugins is None:
        plugins = {}
    if not isinstance(plugins, dict):
        raise ValueError("plugins configuration must be a mapping")
    enabled = plugins.get("enabled") or []
    disabled = plugins.get("disabled") or []
    if not isinstance(enabled, list) or not all(isinstance(item, str) for item in enabled):
        raise ValueError("plugins.enabled must be a list of strings")
    if not isinstance(disabled, list) or not all(isinstance(item, str) for item in disabled):
        raise ValueError("plugins.disabled must be a list of strings")
    if enable and ("ohb_approval_policy" in disabled or "ohb_approval_policy" not in enabled):
        disabled = [item for item in disabled if item != "ohb_approval_policy"]
        enabled = [*enabled, "ohb_approval_policy"] if "ohb_approval_policy" not in enabled else enabled
        plugins["disabled"] = disabled
        plugins["enabled"] = enabled
        data["plugins"] = plugins
        save_config(data)
    # Load the plugin in the running gateway without a restart: its control
    # socket's `reload-plugins` re-discovers this profile's plugins and answers
    # the names it loaded (gateway/run_plugin_rewire.py, Hermes 0.22.2), so the
    # load is proven by a re-read. A profile the gateway does not serve yet has
    # no plugin manager: its first use discovers the plugin on its own.
    load = None
    if os.environ.get("OHB_APPROVAL_RELOAD") == "1" and "ohb_approval_policy" in enabled:
        try:
            from gateway.control_socket import reload_gateway_plugins
            answer = reload_gateway_plugins(root, profile_home=home, timeout=20.0)
        except Exception:
            answer = None
        if isinstance(answer, dict) and answer.get("reloaded") is True and "ohb_approval_policy" in (answer.get("plugins") or []):
            load = "loaded"
        elif isinstance(answer, dict) and answer.get("reloaded") is False and answer.get("error") == "home is not served by this gateway":
            load = "lazy"
        else:
            load = "pending"
    print(json.dumps({"enabled": "ohb_approval_policy" in enabled,
                      "disabled": "ohb_approval_policy" in disabled,
                      "load": load}, separators=(",", ":")))
except Exception:
    raise SystemExit(2)
