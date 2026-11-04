"""Toolset and MCP administration program run by hermes-operator.

This source is installed by the operator under the tool's root, owned by root,
and executed by the managed Hermes venv interpreter as the service user. It is
the *write* half of the capability surface openedbot drives: the gateway
already publishes `GET /v1/toolsets`, but it publishes no MCP inventory and no
mutation at all.

Contract, deliberately narrow:

  * argv carries ONE verb from a fixed set. Nothing else : no path, no URL, no
    command, no secret ever appears in argv, where `/proc` would expose it.
  * the request is ONE JSON object on stdin; the reply is ONE JSON object on
    stdout, bounded, and never echoes a token, a header value, or an env value.
  * a refusal is a document (`{"error": {...}}`) with exit code 0. Exit code 2
    means the program itself failed and the caller must not infer a state.

A stdio MCP server is refused here on purpose: adding one means naming an
executable and its argv, and the link carries no command toward the host. Those
arrive only through the Nous-approved catalog, whose entry names are validated
against the catalogue present on this host.
"""

import base64
import copy
import importlib
import inspect
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from contextlib import redirect_stdout
from io import StringIO

MAX_OUTPUT = 512 * 1024
MAX_NAME = 64
MAX_URL = 2048
MAX_SECRET = 4096
MAX_SERVERS = 128
MAX_CATALOG = 256
MAX_TOOLS = 256
MAX_PROFILES = 32
MAX_SOUL = 8_000
MAX_ROUTINES = 20
MAX_AVATAR = 256 * 1024
MAX_SKILLS = 1024

PLATFORM = "api_server"
VERBS = {
    "toolsets",
    "skills",
    "model-context",
    "mcp-inventory",
    "mcp-add",
    "mcp-install",
    "mcp-remove",
    "profiles",
    "profile-avatar",
    "profile-create",
    "profile-delete",
    "profile-mcp-set",
    "profile-mcp-remove",
    "profile-memory-set",
    "profile-toolset-suppress",
    "profile-memory-get",
    "profile-memory-write",
    "profile-model-set",
    "profile-models-set",
    "profile-skill-set",
    "profile-bundled-skills-set",
    "profile-credential-set",
    "profile-credential-delete",
    "profile-oauth-adopt-root",
    "skills-hub-capabilities",
    "skills-hub-search",
    "skills-hub-refresh",
    "skills-hub-inspect",
    "skills-hub-scan",
    "skills-hub-install",
    "skills-hub-uninstall",
}
PROFILE_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
SKILL_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
# Provider slug or model id written into a profile's `model` block. Wider than
# a toolset key: ids carry dots, colons and slashes (`gpt-5.6-luna`,
# `openai/gpt-4`). Same bound as the HTTP route.
MODEL_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$")
ENV_KEY_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ESSENTIAL_SKILLS = {"hermes-agent"}
OWN_MARKER = "ohb:profile-own"
OWN_KEYS_FILE = ".env.ohb-own"
PROVIDER_KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "openai-codex": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "groq": "GROQ_API_KEY",
    "xai": "XAI_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "google": "GEMINI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "together": "TOGETHER_API_KEY",
    "fireworks": "FIREWORKS_API_KEY",
    "z-ai": "ZAI_API_KEY",
    "zai": "ZAI_API_KEY",
}
BOT_ROUTINE_PREFIX = re.compile(r"^\[bot:([^\]]+)\]\s*", re.I)
ROUTINE_WRAP = re.compile(
    r"^(?:This is an automated routine named \".+\"\.|You are running as a scheduled routine named \".+\"\.)\s*\n+",
    re.I,
)

NAME_ALLOWED = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
ENV_ALLOWED = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")


class Refused(Exception):
    """A refusal that is part of the contract, not a crash."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ─── Shapes ──────────────────────────────────────────────────────────────────



# Hermes 0.22 ships ruamel.yaml instead of PyYAML in its venv; older pins
# ship PyYAML. Both are read and written through these two helpers.
try:
    import yaml as _pyyaml

    def yaml_load(text):
        return _pyyaml.safe_load(text)

    def yaml_dump(data):
        return _pyyaml.safe_dump(data, sort_keys=False, allow_unicode=True)
except ImportError:
    import io as _io
    from ruamel.yaml import YAML as _YAML

    def yaml_load(text):
        return _YAML(typ="safe", pure=True).load(text)

    def yaml_dump(data):
        dumper = _YAML(typ="safe", pure=True)
        dumper.default_flow_style = False
        dumper.allow_unicode = True
        dumper.sort_base_mapping_type_on_output = False
        buffer = _io.StringIO()
        dumper.dump(data, buffer)
        return buffer.getvalue()

def text(value, limit=200):
    return value[:limit] if isinstance(value, str) else None


def server_name(raw):
    name = raw if isinstance(raw, str) else ""
    if not name or len(name) > MAX_NAME or set(name) - NAME_ALLOWED:
        raise Refused("NAME_INVALID", "the server name must be 1-64 characters of [A-Za-z0-9_-]")
    return name


def https_url(raw):
    url = raw if isinstance(raw, str) else ""
    if not url or len(url) > MAX_URL:
        raise Refused("URL_INVALID", "the endpoint URL is missing or too long")
    if not url.startswith("https://"):
        raise Refused("URL_INVALID", "the endpoint URL must be https://")
    if any(ch < " " or ch == "\x7f" for ch in url):
        raise Refused("URL_INVALID", "the endpoint URL contains control characters")
    return url


def secret(raw, label):
    value = raw if isinstance(raw, str) else ""
    if not value or len(value) > MAX_SECRET:
        raise Refused("SECRET_INVALID", label + " is missing or too long")
    if any(ch < " " or ch == "\x7f" for ch in value):
        raise Refused("SECRET_INVALID", label + " contains control characters")
    return value


# ─── Config access ───────────────────────────────────────────────────────────


def bounded_tokens(value):
    """Un compte de jetons plausible, ou zero. Jamais un flottant, jamais un
    nombre qu'aucune fenetre de contexte n'atteint (16 M)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    number = int(value)
    return number if 0 < number <= 16_000_000 else 0


def load_config():
    from hermes_cli.config import load_config as _load

    return _load()


def multiplex_enabled(config=None):
    if config is None:
        config = load_config()
    gateway = config.get("gateway") if isinstance(config, dict) else None
    return isinstance(gateway, dict) and gateway.get("multiplex_profiles") is True


def platform_entries(config):
    """Names enabled for the api_server platform, MCP servers included."""
    from hermes_cli.tools_config import _get_platform_tools

    return set(_get_platform_tools(config, PLATFORM, include_default_mcp_servers=False))


def set_platform_entry(name, enabled):
    """Add or drop one name from platform_toolsets.api_server.

    Deliberately not `_save_platform_tools`: that helper keeps only
    *configurable toolset keys* plus whatever MCP names the config already
    carried, so it cannot ADD one. The read-modify-write below is the same
    shape `hermes tools enable` performs, and like it, it turns a platform
    still relying on its implicit composite default into an explicit list. On a
    host installed by `edge-setup` that list already exists (`up` writes it),
    so this is a no-op in practice.
    """
    from hermes_cli.config import load_config as _load, save_config
    from hermes_cli.tools_config import _get_platform_tools

    config = _load()
    entries = set(_get_platform_tools(config, PLATFORM, include_default_mcp_servers=False))
    if enabled:
        entries.add(name)
    else:
        entries.discard(name)
    existing = config.setdefault("platform_toolsets", {})
    if not isinstance(existing, dict):
        existing = {}
        config["platform_toolsets"] = existing
    existing[PLATFORM] = sorted(entries)
    save_config(config)


def mcp_servers(config=None):
    from hermes_cli.mcp_config import _get_mcp_servers

    servers = _get_mcp_servers(config)
    return servers if isinstance(servers, dict) else {}


# ─── Public views ────────────────────────────────────────────────────────────


def server_view(name, raw, enabled_entries):
    """One MCP server, with every secret-bearing field reduced to its shape."""
    entry = raw if isinstance(raw, dict) else {}
    url = text(entry.get("url"), MAX_URL)
    command = text(entry.get("command"), 200)
    headers = entry.get("headers")
    auth = text(entry.get("auth"), 32)
    if auth not in {"oauth", "header"}:
        auth = "header" if isinstance(headers, dict) and headers else "none"
    tools = entry.get("tools")
    include = tools.get("include") if isinstance(tools, dict) else None
    exclude = tools.get("exclude") if isinstance(tools, dict) else None
    env = entry.get("env")
    return {
        "name": name,
        "transport": "http" if url else ("stdio" if command else "unknown"),
        # The endpoint is a location, never a credential; a stdio command is
        # reported by name only, without its argv or environment values.
        "endpoint": url,
        "command": command,
        "auth": auth,
        "configEnabled": entry.get("enabled", True) is not False,
        "platformEnabled": name in enabled_entries,
        "toolsIncluded": [text(item, MAX_NAME) for item in include[:MAX_TOOLS]] if isinstance(include, list) else None,
        "toolsExcluded": [text(item, MAX_NAME) for item in exclude[:MAX_TOOLS]] if isinstance(exclude, list) else None,
        # Names only: an env VALUE on an MCP entry is routinely a token.
        "envKeys": sorted(str(key)[:MAX_NAME] for key in env)[:MAX_TOOLS] if isinstance(env, dict) else [],
        # An `auth: oauth` server without a token on disk is registered, not
        # usable: upstream's client refuses to open a session, so the gateway
        # never lists its tools. `None` for the other auth modes: the question
        # does not apply to them.
        "oauthTokenPresent": oauth_token_present(name) if auth == "oauth" else None,
    }


def oauth_token_present(name):
    """Whether upstream holds an OAuth token file for this server (never its content)."""
    try:
        from tools.mcp_oauth import HermesTokenStorage

        return bool(HermesTokenStorage(name).has_cached_tokens())
    except Exception:
        return False


def catalog_view():
    """The Nous-approved catalogue present on this host, or an empty list."""
    try:
        from hermes_cli.mcp_catalog import list_catalog
    except Exception:
        return []
    try:
        entries = list_catalog()
    except Exception:
        return []
    out = []
    for entry in list(entries)[:MAX_CATALOG]:
        auth = getattr(entry, "auth", None)
        env_specs = getattr(auth, "env", None) or []
        transport = getattr(entry, "transport", None)
        out.append({
            "name": text(getattr(entry, "name", None), MAX_NAME),
            "description": text(getattr(entry, "description", None), 400),
            "source": text(getattr(entry, "source", None), 400),
            "authType": text(getattr(auth, "type", None), 32) or "none",
            "authProvider": text(getattr(auth, "provider", None), MAX_NAME),
            "transport": "http" if getattr(transport, "url", None) else "stdio",
            "requiresInstall": getattr(entry, "install", None) is not None,
            "envSpecs": [
                {
                    "name": text(getattr(spec, "name", None), MAX_NAME),
                    "description": text(getattr(spec, "description", None), 200),
                    "required": bool(getattr(spec, "required", True)),
                    "secret": bool(getattr(spec, "secret", True)),
                }
                for spec in list(env_specs)[:16]
            ],
        })
    return [entry for entry in out if entry["name"]]


# ─── Verbs ───────────────────────────────────────────────────────────────────


def unavailable_reason(members):
    """Why a toolset's tools are not callable, as a closed code, or None.

    Upstream's `check_fn` answers yes or no and says nothing else. A code is
    given only when it is provable from the registry itself: every member that
    declares `requires_env` has a variable unset. Anything else is the generic
    `check_failed`. No variable name, path or value ever leaves the host.
    """
    needed = []
    for member in members:
        env = getattr(member, "requires_env", None)
        if isinstance(env, (list, tuple)):
            needed.extend(name for name in env if isinstance(name, str) and name)
    if not needed:
        return "check_failed"
    try:
        from hermes_cli.config import get_env_value
    except Exception:
        get_env_value = None
    for name in needed:
        value = os.environ.get(name)
        if not value and get_env_value is not None:
            try:
                value = get_env_value(name)
            except Exception:
                value = None
        if not value:
            return "credentials_missing"
    return "check_failed"


def toolset_availability(names):
    """Per toolset: can the model call at least one of its tools on this host.

    This is the function Hermes itself uses to decide what to advertise
    (`registry.is_toolset_available`: at least one tool whose `check_fn`
    passes), not `GET /v1/toolsets`, which expands `resolve_toolset` statically.
    `discover_builtin_tools` is the same import `model_tools` performs, minus
    the MCP discovery that module also does. `None` means "not measured":
    an older Hermes without these registry functions, a toolset the registry
    does not know (a composite, a plugin), or a check that raised.
    """
    unknown = [{"name": name, "available": None, "reason": None} for name in names]
    try:
        from tools.registry import discover_builtin_tools, registry

        discover_builtin_tools()
        registered = set(registry.get_registered_toolset_names())
        entries = list(registry.get_all_entries())
        is_available = registry.is_toolset_available
    except Exception:
        return unknown

    out = []
    for name in names:
        # `is_toolset_available` answers False for an unknown name: that would
        # read as "unavailable" for a toolset nobody measured.
        if name not in registered:
            out.append({"name": name, "available": None, "reason": None})
            continue
        try:
            available = bool(is_available(name))
        except Exception:
            out.append({"name": name, "available": None, "reason": None})
            continue
        reason = None
        if not available:
            reason = unavailable_reason([entry for entry in entries if getattr(entry, "toolset", None) == name])
        out.append({"name": name, "available": available, "reason": reason})
    return out


def verb_toolsets(_request):
    """Which toolsets this host will actually let api_server carry.

    `_save_platform_tools` silently drops a toolset restricted away from the
    platform, so a UI that offered the toggle anyway would report a successful
    no-op. Naming the settable set here is what keeps that honest.

    `availability` rides along: for every toolset the platform lists, whether
    its tools are callable on this host (see `toolset_availability`).
    """
    from hermes_cli.tools_config import (
        _get_effective_configurable_toolsets,
        _toolset_allowed_for_platform,
    )

    settable = []
    known = []
    for row in _get_effective_configurable_toolsets():
        name = text(row[0], MAX_NAME)
        if not name:
            continue
        known.append(name)
        try:
            allowed = _toolset_allowed_for_platform(name, PLATFORM)
        except Exception:
            allowed = False
        if allowed:
            settable.append(name)
    names = sorted(set(known))[:MAX_TOOLS]
    return {
        "platform": PLATFORM,
        "settable": sorted(set(settable))[:MAX_TOOLS],
        "availability": toolset_availability(names),
    }


def verb_skills(_request):
    """The root's installed skills, in the shape of the gateway's /v1/skills.

    openedbot reads it only when /v1/skills fails: Hermes 0.21.3 to 0.22.6
    pass a removed `include_editorial` keyword there and answer 500 on every
    call (upstream #142575, fix in PR #142662). This is the same listing
    without that keyword, the one `hermes skills list` and the route intend:
    name, description, category, disabled skills included.
    """
    try:
        from tools.skills_tool import find_all_skills, sort_skills
    except ImportError:
        from tools.skills_tool import _find_all_skills as find_all_skills, _sort_skills as sort_skills
    rows = []
    for skill in sort_skills(find_all_skills(skip_disabled=False))[:MAX_SKILLS]:
        name = text(skill.get("name"), MAX_NAME * 4)
        if not name:
            continue
        rows.append({
            "name": name,
            "description": text(skill.get("description"), 1024),
            "category": text(skill.get("category"), MAX_NAME * 2),
        })
    return {"object": "list", "data": rows}


def verb_mcp_inventory(_request):
    config = load_config()
    enabled = platform_entries(config)
    servers = mcp_servers(config)
    views = [server_view(str(name)[:MAX_NAME], raw, enabled) for name, raw in list(servers.items())[:MAX_SERVERS]]
    views.sort(key=lambda item: item["name"])
    return {"platform": PLATFORM, "servers": views, "catalog": catalog_view()}


def verb_mcp_add(request):
    """Add a custom HTTP MCP server, probe it, and enable it on api_server."""
    from hermes_cli.mcp_config import (
        _bearer_auth_headers,
        _probe_single_server,
        _save_bearer_auth_token,
        _save_mcp_server,
    )
    from hermes_cli.mcp_security import validate_mcp_server_entry

    name = server_name(request.get("name"))
    url = https_url(request.get("url"))
    auth = request.get("auth")
    if auth not in {"none", "header", "oauth"}:
        raise Refused("AUTH_INVALID", "auth must be none, header or oauth")
    if name in mcp_servers() and request.get("replace") is not True:
        raise Refused("SERVER_EXISTS", "a server named " + name + " already exists; pass replace to overwrite it")

    entry = {"url": url}
    if auth == "header":
        try:
            entry["headers"] = _save_bearer_auth_token(name, secret(request.get("token"), "the bearer token"))
        except Refused:
            raise
        except Exception:
            raise Refused("TOKEN_REFUSED", "the runtime refused the bearer token")
    elif auth == "oauth":
        # Only proves the runtime can build an OAuth client for this server;
        # the authorization itself is the next step (mcp_oauth_probe.py).
        # Upstream refuses to build one with no cached token outside a
        # terminal (OAuthNonInteractiveError, "run hermes mcp login first"):
        # that is "authorization still to do", exactly the state of a server
        # being added, not "OAuth unsupported". Before this, no OAuth server
        # could ever be added from openedbot (measured 2026-10-31, lab host).
        try:
            from tools.mcp_oauth import OAuthNonInteractiveError
        except Exception:
            OAuthNonInteractiveError = None
        try:
            from tools.mcp_oauth_manager import get_manager

            provider = get_manager().get_or_build_provider(name, url, None)
        except Exception as exc:
            provider = True if OAuthNonInteractiveError is not None and isinstance(exc, OAuthNonInteractiveError) else None
        if not provider:
            raise Refused(
                "OAUTH_UNSUPPORTED",
                "this host could not build an OAuth client for " + name + "; add it with a bearer token instead",
            )
        entry["auth"] = "oauth"

    issues = validate_mcp_server_entry(name, entry)
    if issues:
        # Upstream's own suspicion check. Its text names the offending field,
        # never a value, so it is safe to return.
        raise Refused("SERVER_REFUSED", "; ".join(str(issue)[:200] for issue in issues[:4]))

    probed = []
    probe_error = None
    try:
        probed = _probe_single_server(name, entry) or []
    except Exception as exc:
        probe_error = type(exc).__name__

    # An unreachable server is saved disabled rather than not saved: the
    # operator can then fix the endpoint without retyping the token.
    entry["enabled"] = probe_error is None
    if not _save_mcp_server(name, entry):
        raise Refused("SERVER_REFUSED", "the runtime refused to save " + name)
    if probe_error is None:
        set_platform_entry(name, True)

    config = load_config()
    view = server_view(name, mcp_servers(config).get(name), platform_entries(config))
    view["discoveredTools"] = [text(item[0], MAX_NAME) for item in list(probed)[:MAX_TOOLS]]
    view["unreachable"] = probe_error is not None
    return {"server": view}


def verb_mcp_install(request):
    """Install a catalogue entry by name, with its declared env values."""
    try:
        from hermes_cli.mcp_catalog import get_entry, install_entry
    except Exception:
        raise Refused("CATALOG_UNAVAILABLE", "this host carries no MCP catalogue")

    name = server_name(request.get("name"))
    entry = None
    try:
        entry = get_entry(name)
    except Exception:
        entry = None
    if entry is None:
        raise Refused("CATALOG_ENTRY_UNKNOWN", name + " is not an entry of this host's MCP catalogue")

    # The entry declares which env keys it needs; only those are accepted, and
    # only by name from the manifest : never an arbitrary key from the caller.
    declared = {}
    for spec in list(getattr(getattr(entry, "auth", None), "env", None) or [])[:16]:
        key = text(getattr(spec, "name", None), MAX_NAME)
        if key and not (set(key) - ENV_ALLOWED):
            declared[key] = bool(getattr(spec, "required", True))
    supplied = request.get("env")
    supplied = supplied if isinstance(supplied, dict) else {}
    unknown = sorted(key for key in supplied if key not in declared)
    if unknown:
        raise Refused("ENV_UNKNOWN", "this catalogue entry declares no variable named " + unknown[0])
    missing = sorted(key for key, required in declared.items() if required and not supplied.get(key))
    if missing:
        raise Refused("ENV_REQUIRED", "this catalogue entry requires a value for " + missing[0])

    from hermes_cli.config import save_env_value

    for key, value in supplied.items():
        save_env_value(key, secret(value, "the value of " + key))

    try:
        # Not a TTY: install_entry takes the manifest's tool selection and
        # never opens a checklist. Its stdout is a human transcript we drop.
        install_entry(entry, enable=True)
    except Exception as exc:
        raise Refused("INSTALL_FAILED", "the runtime could not install " + name + " (" + type(exc).__name__ + ")")

    set_platform_entry(name, True)
    config = load_config()
    return {"server": server_view(name, mcp_servers(config).get(name), platform_entries(config))}


def verb_mcp_remove(request):
    name = server_name(request.get("name"))
    if name not in mcp_servers():
        raise Refused("SERVER_UNKNOWN", "no MCP server named " + name + " is configured")
    removed = False
    try:
        from hermes_cli.mcp_catalog import is_installed, uninstall_entry

        if is_installed(name):
            removed = bool(uninstall_entry(name))
    except Exception:
        removed = False
    if not removed:
        from hermes_cli.mcp_config import _remove_mcp_server

        if not _remove_mcp_server(name):
            raise Refused("SERVER_REFUSED", "the runtime refused to remove " + name)
    set_platform_entry(name, False)
    return {"removed": name, "tokensRemoved": remove_mcp_tokens(name, None)}


MCP_TOKEN_SUFFIXES = (".json", ".client.json", ".meta.json", ".cimd-off")


def remove_mcp_tokens(name, home):
    """Delete the stored OAuth state of server `name` under `home` (the
    runtime root when `None`), the way `hermes mcp remove` does, and tell
    whether none is left. Removing a server from a config without its token
    left a refresh token on disk that nothing listed and nothing would ever
    revoke. `.refresh.lock` stays: upstream keeps it on purpose (flock is
    inode-bound). Never raises: the config change already landed, the caller
    reports `tokensRemoved: false` and the file names (never contents) go to
    stderr."""
    directory = os.path.join(home if home is not None else hermes_home(), "mcp-tokens")
    try:
        from tools.mcp_oauth import remove_oauth_tokens

        if home is None:
            remove_oauth_tokens(name)
        else:
            remove_oauth_tokens(name, hermes_home=home)
    except Exception as error:
        # An older Hermes without `hermes_home=`, or no OAuth module at all:
        # the files below are the whole state, removed by hand.
        sys.stderr.write("mcp tokens: upstream removal of " + name + " failed (" + type(error).__name__ + "), removing files\n")
    left = []
    for suffix in MCP_TOKEN_SUFFIXES:
        path = os.path.join(directory, name + suffix)
        try:
            if os.path.lexists(path):
                os.unlink(path)
        except OSError:
            pass
        if os.path.lexists(path):
            left.append(name + suffix)
    if left:
        sys.stderr.write("mcp tokens: could not remove " + ", ".join(left) + "\n")
    return not left


def hermes_home():
    """The runtime home on this host. Never returned on the wire."""
    try:
        from hermes_cli.config import get_hermes_home

        home = get_hermes_home()
        if home:
            return str(home)
    except Exception:
        pass
    env = os.environ.get("HERMES_HOME")
    if env:
        return env
    return os.path.expanduser("~/.hermes")


def profile_slug_ok(name):
    return bool(isinstance(name, str) and PROFILE_SLUG.match(name) and name != "default")


def require_profile_slug(raw):
    name = raw if isinstance(raw, str) else ""
    if not profile_slug_ok(name):
        raise Refused("PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
    return name


def require_model_token(raw, field):
    value = raw.strip() if isinstance(raw, str) else ""
    if not MODEL_TOKEN.match(value):
        raise Refused("BODY_INVALID", field + " must be 1-120 characters of [A-Za-z0-9._:/-]")
    return value


def apply_profile_model(config, provider, model):
    """Write `model.{provider, default}` without dropping other keys of the block."""
    raw = config.get("model") if isinstance(config, dict) else None
    if isinstance(raw, dict):
        block = dict(raw)
    elif isinstance(raw, str) and raw.strip():
        block = {"default": raw.strip()}
    else:
        block = {}
    block["provider"] = provider
    block["default"] = model
    config["model"] = block
    return config


def coerce_profile_names(raw):
    names = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                names.append(item)
            elif isinstance(item, dict):
                candidate = item.get("name") or item.get("id")
                if isinstance(candidate, str):
                    names.append(candidate)
            else:
                candidate = getattr(item, "name", None)
                if isinstance(candidate, str):
                    names.append(candidate)
    return names


def names_from_home():
    directory = os.path.join(hermes_home(), "profiles")
    names = []
    try:
        for entry in sorted(os.listdir(directory)):
            if entry.startswith("."):
                continue
            if os.path.isfile(os.path.join(directory, entry, "config.yaml")):
                names.append(entry)
    except Exception:
        return []
    return names


def named_profile_names():
    names = []
    for importer in (
        lambda: __import__("hermes_cli.profiles", fromlist=["list_profiles"]).list_profiles(),
        lambda: __import__("hermes_cli.config", fromlist=["list_profiles"]).list_profiles(),
        lambda: __import__("hermes_cli.config", fromlist=["get_profile_names"]).get_profile_names(),
    ):
        try:
            names = coerce_profile_names(importer())
        except Exception:
            names = []
        if names:
            break
    if not names:
        names = names_from_home()
    out = []
    seen = set()
    root = os.path.join(hermes_home(), "profiles")
    for name in names:
        if name in seen or not profile_slug_ok(name):
            continue
        # A profile IS its config.yaml. Measured 2026-09-04: after
        # `delete_profile`, a logger still alive in the running gateway
        # recreated `profiles/<slug>/logs/` : an empty shell that upstream's
        # listing surfaced, and that the app then read as an orphan agent.
        if not os.path.isfile(os.path.join(root, name, "config.yaml")):
            continue
        seen.add(name)
        out.append(name)
        if len(out) >= MAX_PROFILES:
            break
    return out


def load_profile_config(name):
    """The profile's config, for a caller that may change and save it.

    A file that exists but cannot be read as a mapping is refused: every
    mutation saves back what this returns, and an empty dict standing in for
    an unreadable file would replace the whole config with the one block the
    mutation set. Only an absent or empty file reads as {}."""
    try:
        from hermes_cli.config import load_config

        try:
            loaded = load_config(profile=name)
        except TypeError:
            loaded = None
        if isinstance(loaded, dict):
            return loaded
    except Exception:
        pass
    path = os.path.join(hermes_home(), "profiles", name, "config.yaml")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            loaded = yaml_load(handle.read())
    except FileNotFoundError:
        return {}
    except Exception:
        raise Refused("PROFILE_CONFIG_REFUSED", "the profile config cannot be read")
    if loaded is None:
        return {}
    if not isinstance(loaded, dict):
        raise Refused("PROFILE_CONFIG_REFUSED", "the profile config is not a mapping")
    return loaded


def read_profile_config(name):
    """The profile's config for a read-only view: an unreadable file shows as
    an empty config rather than hiding every other profile. Never save it."""
    try:
        return load_profile_config(name)
    except Refused:
        return {}


def save_profile_config(name, config):
    directory = profile_directory(name)
    path = os.path.join(directory, "config.yaml")
    if os.path.lexists(path) and (os.path.islink(path) or not os.path.isfile(path)):
        raise Refused("PROFILE_CONFIG_REFUSED", "the profile config is not a regular file")

    from hermes_cli.config import save_config

    try:
        save_config(config, profile=name)
        return
    except TypeError:
        # Older hermes-agent versions do not accept profile= on save_config;
        # never fall back to save_config(config), which would overwrite root.
        pass

    encoded = yaml_dump(config).encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix=".config.yaml.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def write_env_key(name, key, value):
    path = os.path.join(hermes_home(), "profiles", name, ".env")
    data = b""
    if os.path.lexists(path):
        if os.path.islink(path) or not os.path.isfile(path):
            raise Refused("PROFILE_ENV_REFUSED", "the profile environment is not a regular file")
        with open(path, "rb") as handle:
            data = handle.read()
    lines = data.decode("utf-8").splitlines(keepends=True)
    prefix = re.compile(r"^(?:export\s+)?" + re.escape(key) + r"\s*=")
    out = []
    replaced = False
    for line in lines:
        if prefix.match(line.strip()):
            if not replaced:
                out.append(key + "=" + value + "\n")
                replaced = True
            continue
        out.append(line)
    if not replaced:
        out.append(key + "=" + value + "\n")
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix=".env.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write("".join(out).encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def seed_profile_active_provider(name):
    """Give the profile the root's `active_provider`, and nothing else.

    Measured 2026-09-04 on a real host: the root selects its inference provider
    by `auth.json.active_provider` (an OAuth login, `providers` empty), so a
    fresh profile : no `auth.json` at all : ran into "No inference provider
    configured" while `/p/<slug>/api/model/options` listed that same provider
    as authenticated. Upstream reads credentials through the root as a
    per-provider fallback ONLY when the profile has zero entries for it
    (hermes_cli/auth.py, `read_credential_pool`), so the seed carries the
    selection and no grant: a copied single-use OAuth grant would be revoked
    for the root at the first refresh. Never overwrites an existing store."""
    target = os.path.join(profile_directory(name), "auth.json")
    if os.path.lexists(target):
        return
    root = os.path.join(hermes_home(), "auth.json")
    try:
        with open(root, "rb") as handle:
            data = json.loads(handle.read().decode("utf-8"))
    except Exception:
        return
    active = data.get("active_provider") if isinstance(data, dict) else None
    if not isinstance(active, str) or not active.strip():
        return
    document = {"active_provider": active.strip(), "providers": {}, "credential_pool": {}}
    if isinstance(data.get("version"), int):
        document["version"] = data["version"]
    encoded = json.dumps(document, indent=2, sort_keys=True).encode("utf-8")
    directory = os.path.dirname(target)
    fd, temporary = tempfile.mkstemp(prefix=".auth.json.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def profile_directory(name):
    directory = os.path.join(hermes_home(), "profiles", name)
    if os.path.lexists(directory) and os.path.islink(directory):
        raise Refused("PROFILE_EXISTS", "a profile with that name already exists")
    return directory


def manual_clone_profile(name, display_name):
    """Fallback for an upstream create_profile signature without clone_config."""
    source = hermes_home()
    target = profile_directory(name)
    os.makedirs(target, mode=0o700, exist_ok=False)
    for filename in ("config.yaml", ".env", "SOUL.md"):
        source_path = os.path.join(source, filename)
        if os.path.isfile(source_path) and not os.path.islink(source_path):
            shutil.copyfile(source_path, os.path.join(target, filename))
    source_skills = os.path.join(source, "skills")
    if os.path.isdir(source_skills) and not os.path.islink(source_skills):
        shutil.copytree(source_skills, os.path.join(target, "skills"))


def create_named_profile(name, display_name):
    directory = profile_directory(name)
    if os.path.lexists(directory) or name in named_profile_names():
        raise Refused("PROFILE_EXISTS", "a profile with that name already exists")
    try:
        from hermes_cli.profiles import create_profile

        # Inspect before calling: a TypeError raised INSIDE upstream must not
        # trigger a second creation against a partially published directory.
        parameters = inspect.signature(create_profile).parameters
        if "clone_config" not in parameters:
            manual_clone_profile(name, display_name)
        else:
            create_profile(name, clone_from="default", clone_config=True, description=display_name)
    except Refused:
        raise
    except FileExistsError:
        raise Refused("PROFILE_EXISTS", "a profile with that name already exists")
    except (Exception, SystemExit) as exc:
        # The name was free above, so a directory present now is ours: v0.22.2
        # publishes it before notifying the multiplexer, and a failure past
        # that point must not strand an unfinished profile. Never replayed.
        if os.path.lexists(directory):
            try:
                delete_named_profile(name)
            except (Exception, SystemExit):
                pass
        if isinstance(exc, ValueError):
            raise Refused("PROFILE_INVALID", "the host refused the profile name or clone options")
        raise


def set_profile_display_name(name, display_name):
    if display_name:
        config = load_profile_config(name)
        config["display_name"] = display_name
        if not config.get("description"):
            config["description"] = display_name
        save_profile_config(name, config)


def settle_profile_identity(name):
    """Upstream `hermes profile purge-identity`: idempotent once the directory
    is gone. A pin without the identity store has nothing to settle."""
    try:
        from hermes_cli.profile_identity import purge_profile_identity
    except ImportError:
        return True
    try:
        return purge_profile_identity(name) is True
    except Exception:
        return False


def require_settled_identity(name):
    if not settle_profile_identity(name):
        raise Refused("PROFILE_UNVERIFIED", "the profile is gone but its session identity is not settled")


def delete_named_profile(name):
    require_profile_slug(name)
    if name not in named_profile_names() and not os.path.isfile(os.path.join(hermes_home(), "profiles", name, "config.yaml")):
        # A retry after an unsettled delete lands here: settle it first, so
        # PROFILE_NOT_FOUND keeps meaning "fully gone" to openedbot.
        require_settled_identity(name)
        raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
    from hermes_cli import profiles

    try:
        # Both supported Hermes pins accept yes=True. Never replay a mutating
        # call after an internal TypeError, or fall back to interactive input.
        profiles.delete_profile(name, yes=True)
    except Exception as exc:
        pending_type = getattr(profiles, "ProfileIdentitySettlementPending", ())
        if isinstance(exc, pending_type):
            # v0.22.2 raises this ONLY after removal, when the live gateway was
            # not reached (or, without a live multiplexer, because upstream
            # tombstones the profile before purging its own state.db: seen on
            # the lab on 2026-10-21). The upstream retry settles it once the
            # directory is gone. Run it once; refuse if it still fails.
            if os.path.lexists(os.path.join(hermes_home(), "profiles", name)):
                raise Refused("PROFILE_CONFIG_REFUSED", "the deleted profile directory still exists")
            require_settled_identity(name)
            return
        if isinstance(exc, FileNotFoundError) and not profile_exists(name):
            require_settled_identity(name)
            raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
        if isinstance(exc, ValueError):
            raise Refused("PROFILE_INVALID", "the host refused the profile deletion")
        raise


def install_profile_a2a_guard(name):
    """Carry the fixed root guard into a newly cloned managed profile."""
    require_profile_slug(name)
    root = os.path.abspath(hermes_home())
    source = os.path.join(root, "plugins", "ohb_a2a_policy")
    if not os.path.lexists(source):
        from hermes_cli.config import load_config

        config = load_config()
        plugins = config.get("plugins") if isinstance(config, dict) else None
        if (isinstance(plugins, dict) and "ohb_a2a_policy" in (plugins.get("enabled") or [])
                and "ohb_a2a_policy" not in (plugins.get("disabled") or [])):
            raise Refused("PROFILE_CONFIG_REFUSED", "the enabled managed A2A guard is missing")
        return
    target_home = os.path.join(root, "profiles", name)
    uid = os.geteuid()

    def private_directory(path, create=False):
        if create:
            try:
                os.mkdir(path, 0o700)
            except FileExistsError:
                pass
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid:
            raise Refused("PROFILE_CONFIG_REFUSED", "the managed A2A guard directory is unsafe")
        if create and stat.S_IMODE(info.st_mode) != 0o700:
            os.chmod(path, 0o700, follow_symlinks=False)

    for directory in (root, os.path.join(root, "plugins"), source,
                      os.path.join(root, "profiles"), target_home):
        private_directory(directory)
    files = {}
    for filename in ("plugin.yaml", "__init__.py", "policy.py", "snapshot.py", "runtime_scope.py"):
        descriptor = os.open(os.path.join(source, filename), os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != uid
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 128 * 1024):
                raise Refused("PROFILE_CONFIG_REFUSED", "the managed A2A guard file is unsafe")
            data = handle.read(128 * 1024 + 1)
            if len(data) > 128 * 1024:
                raise Refused("PROFILE_CONFIG_REFUSED", "the managed A2A guard file is too large")
            files[filename] = data
    files["runtime-home"] = (root + "\n").encode("utf-8")
    for directory in (os.path.join(target_home, "plugins"),
                      os.path.join(target_home, "plugins", "ohb_a2a_policy")):
        private_directory(directory, create=True)
    target = os.path.join(target_home, "plugins", "ohb_a2a_policy")
    for filename, data in files.items():
        destination = os.path.join(target, filename)
        if os.path.lexists(destination):
            info = os.lstat(destination)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != uid:
                raise Refused("PROFILE_CONFIG_REFUSED", "the managed A2A guard destination is unsafe")
        descriptor, temporary = tempfile.mkstemp(prefix=".ohb-a2a-", dir=target)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                os.fchmod(handle.fileno(), 0o600)
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)


def verb_profile_create(request):
    name = require_profile_slug(request.get("name"))
    display_name = request.get("displayName")
    if display_name is not None:
        if not isinstance(display_name, str) or not display_name or len(display_name) > 120 or any(
            ch < " " or ch == "\x7f" for ch in display_name
        ):
            raise Refused("PROFILE_INVALID", "displayName must be a non-empty text value of at most 120 characters")
    api_server_key = secret(request.get("apiServerKey"), "the API server key")
    bundled_skills = request.get("bundledSkills")
    if bundled_skills is not None and bundled_skills is not False:
        raise Refused("BODY_INVALID", "bundledSkills can only be false")
    if not multiplex_enabled():
        raise Refused("MULTIPLEX_OFF", "gateway.multiplex_profiles is not enabled")
    model_raw, provider_raw = request.get("model"), request.get("provider")
    if model_raw is not None or provider_raw is not None:
        provider = require_model_token(provider_raw, "provider")
        model = require_model_token(model_raw, "model")
    else:
        provider = model = None
    create_named_profile(name, display_name)
    try:
        set_profile_display_name(name, display_name)
        install_profile_a2a_guard(name)
        write_env_key(name, "API_SERVER_KEY", api_server_key)
        seed_profile_active_provider(name)
        if provider and model:
            config = load_profile_config(name)
            apply_profile_model(config, provider, model)
            save_profile_config(name, config)
        profile = profile_view(name)
    except (Exception, SystemExit):
        # Do not leave a half-created profile when its fail-closed bearer could
        # not be installed. The cleanup itself is best effort and never emits
        # the key or its exception text.
        try:
            delete_named_profile(name)
        except (Exception, SystemExit):
            pass
        raise
    result = {"profile": profile, "verified": created_profile_verified(name, profile, provider, model)}
    if bundled_skills is False:
        # Best effort: the profile is created either way. Without the
        # `bundledSkills` answer, openedbot writes the bundled skills itself.
        try:
            result["bundledSkills"] = apply_profile_bundled_skills(name, False)
        except (Exception, SystemExit):
            pass
    return result


def created_profile_verified(name, profile, provider, model):
    """The targeted read-back of a fresh profile, in the process that wrote it.

    `profile` was just rebuilt from the files on disk (`profile_view`), after
    the last write. This adds what the full inventory would also have proven:
    the profile is listed by the host under that name, and the model block
    carries the requested pair. False never fails the creation: the operator
    then falls back to the full inventory read, as before.
    """
    try:
        if profile.get("name") != name or name not in named_profile_names() or not profile_exists(name):
            return False
        if provider and model:
            view = profile.get("model") or {}
            return view.get("provider") == provider and view.get("default") == model
        return True
    except Exception:
        return False


def verb_profile_delete(request):
    name = require_profile_slug(request.get("name"))
    delete_named_profile(name)
    return {"deleted": name}


def profile_exists(name):
    return name in named_profile_names() or os.path.isfile(
        os.path.join(hermes_home(), "profiles", name, "config.yaml")
    )


def verb_profile_model_set(request):
    name = require_profile_slug(request.get("name"))
    provider = require_model_token(request.get("provider"), "provider")
    model = require_model_token(request.get("model"), "model")
    if not profile_exists(name):
        raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
    config = load_profile_config(name)
    apply_profile_model(config, provider, model)
    save_profile_config(name, config)
    view = model_view(load_profile_config(name))
    return {"profile": name, "provider": view.get("provider"), "model": view.get("default")}


MAX_PROFILE_MODEL_BATCH = 64


def verb_profile_models_set(request):
    """One provider/model pair into the model block of several profiles.

    A refused profile (absent, invalid name) is reported with its code and the
    others still apply; the operator proves each write on the inventory.
    """
    provider = require_model_token(request.get("provider"), "provider")
    model = require_model_token(request.get("model"), "model")
    names = request.get("names")
    if not isinstance(names, list) or not names or len(names) > MAX_PROFILE_MODEL_BATCH:
        raise Refused("BODY_INVALID", "names must list 1 to 64 profile names")
    results = []
    for raw in names:
        try:
            name = require_profile_slug(raw)
            if not profile_exists(name):
                raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
            config = load_profile_config(name)
            apply_profile_model(config, provider, model)
            save_profile_config(name, config)
            results.append({"profile": name})
        except Refused as refusal:
            results.append({"profile": raw if isinstance(raw, str) else "", "code": refusal.code})
        except Exception:
            # One unreadable config must not strand the profiles after it.
            results.append({"profile": raw if isinstance(raw, str) else "", "code": "PROFILE_CONFIG_REFUSED"})
    return {"profiles": results}


def profile_mcp_entries(config):
    raw = config.get("mcp_servers") if isinstance(config, dict) else None
    if not isinstance(raw, dict):
        raw = {}
    return raw


def verb_profile_mcp_set(request):
    name = require_profile_slug(request.get("name"))
    server = server_name(request.get("server"))
    enabled = request.get("enabled")
    if not isinstance(enabled, bool):
        raise Refused("BODY_INVALID", "enabled must be true or false")
    root_config = load_config()
    root_servers = profile_mcp_entries(root_config)
    if server not in root_servers:
        raise Refused("MCP_SERVER_NOT_FOUND", "no MCP server named " + server + " is configured at the runtime root")
    if name not in named_profile_names() and not os.path.isfile(os.path.join(hermes_home(), "profiles", name, "config.yaml")):
        raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
    config = load_profile_config(name)
    servers = profile_mcp_entries(config)
    if server not in servers:
        servers[server] = copy.deepcopy(root_servers[server])
    if not isinstance(servers[server], dict):
        servers[server] = {}
    servers[server]["enabled"] = enabled
    config["mcp_servers"] = servers
    entries = platform_entries(config)
    if enabled:
        entries.add(server)
    else:
        entries.discard(server)
    platform = config.setdefault("platform_toolsets", {})
    if not isinstance(platform, dict):
        platform = {}
        config["platform_toolsets"] = platform
    platform[PLATFORM] = sorted(entries)
    save_profile_config(name, config)
    return {"name": server, "profile": name, "platform": PLATFORM, "enabled": enabled}


def verb_profile_mcp_remove(request):
    """Disconnect one MCP server from a named profile: drop it from the
    profile's `mcp_servers` and `api_server` platform, then delete the OAuth
    state in the profile's home, the only one its runs read. Idempotent: a
    profile that does not carry the server still loses its token files (a
    failed authorization leaves `<name>.client.json` behind) and answers
    `removed: false`. The root entry is never touched: it is the template
    other bots connect from."""
    name = require_profile_slug(request.get("name"))
    server = server_name(request.get("server"))
    if name not in named_profile_names() and not os.path.isfile(os.path.join(hermes_home(), "profiles", name, "config.yaml")):
        raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
    config = load_profile_config(name)
    servers = profile_mcp_entries(config)
    entries = platform_entries(config)
    removed = server in servers
    if removed or server in entries:
        servers.pop(server, None)
        if servers:
            config["mcp_servers"] = servers
        else:
            config.pop("mcp_servers", None)
        entries.discard(server)
        platform = config.setdefault("platform_toolsets", {})
        if not isinstance(platform, dict):
            platform = {}
            config["platform_toolsets"] = platform
        platform[PLATFORM] = sorted(entries)
        save_profile_config(name, config)
    home = os.path.join(hermes_home(), "profiles", name)
    return {"profile": name, "name": server, "removed": removed, "tokensRemoved": remove_mcp_tokens(server, home)}


def verb_profile_memory_set(request):
    """Align the profile's built-in memory flags with its `memory` toolset.

    `up` forces `memory.memory_enabled` and `memory.user_profile_enabled` to
    false at the root, and a named profile clones that config. Enabling the
    `memory` toolset only edits `platform_toolsets.api_server`: upstream's
    `check_memory_requirements()` still reads the two flags, so the tool never
    reaches a run and MEMORY.md / USER.md are never injected (measured on
    2026-09-07: the bot reported "memory tool not available in this session").
    Both flags follow the toolset, on the profile only, never at the root.
    """
    name = require_profile_slug(request.get("name"))
    enabled = request.get("enabled")
    if not isinstance(enabled, bool):
        raise Refused("BODY_INVALID", "enabled must be true or false")
    if name not in named_profile_names() and not os.path.isfile(os.path.join(hermes_home(), "profiles", name, "config.yaml")):
        raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
    config = load_profile_config(name)
    memory = config.get("memory")
    if not isinstance(memory, dict):
        memory = {}
    memory["memory_enabled"] = enabled
    memory["user_profile_enabled"] = enabled
    config["memory"] = memory
    save_profile_config(name, config)
    return {"profile": name, "memoryEnabled": enabled, "userProfileEnabled": enabled}


TOOLSET_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_]{0,63}$")


def disabled_toolset_names(config):
    """`agent.disabled_toolsets` as upstream reads it: a list, or a list
    literal saved as text by `hermes config set`. Anything else is refused
    rather than overwritten."""
    agent = config.get("agent") if isinstance(config, dict) else None
    raw = agent.get("disabled_toolsets") if isinstance(agent, dict) else None
    if raw is None or raw == "":
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw.replace("'", '"'))
        except ValueError:
            raise Refused("PROFILE_CONFIG_REFUSED", "agent.disabled_toolsets is not a list")
    if not isinstance(raw, list):
        raise Refused("PROFILE_CONFIG_REFUSED", "agent.disabled_toolsets is not a list")
    return [str(item).strip() for item in raw if str(item).strip()]


def verb_profile_toolset_suppress(request):
    """Keep a profile toolset off when its platform list cannot.

    Upstream resolves an explicit EMPTY `platform_toolsets.api_server` through
    its composite path, which turns `x_search` on whenever xAI credentials
    exist (`_composite_toolsets`, `hermes_cli/tools_config.py`): disabling the
    last toolset of a profile left `x_search` on (lab, 2026-10-24).
    `agent.disabled_toolsets` is applied last and wins. Suppressing adds the
    name to the profile's list; lifting removes it, unless the runtime root
    suppresses it too: that one is the operator's choice, never openedbot's.
    """
    name = require_profile_slug(request.get("name"))
    toolset = request.get("toolset")
    if not isinstance(toolset, str) or not TOOLSET_NAME_PATTERN.match(toolset):
        raise Refused("TOOLSET_INVALID", "the toolset name is invalid")
    suppressed = request.get("suppressed")
    if not isinstance(suppressed, bool):
        raise Refused("BODY_INVALID", "suppressed must be true or false")
    if not profile_exists(name):
        raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
    config = load_profile_config(name)
    names = disabled_toolset_names(config)
    if suppressed:
        if toolset not in names:
            names.append(toolset)
    elif toolset in names and toolset not in disabled_toolset_names(load_config()):
        names = [entry for entry in names if entry != toolset]
    agent = config.get("agent")
    if not isinstance(agent, dict):
        agent = {}
    agent["disabled_toolsets"] = names
    config["agent"] = agent
    save_profile_config(name, config)
    return {"profile": name, "toolset": toolset, "suppressed": toolset in disabled_toolset_names(load_profile_config(name))}


MEMORY_TARGETS = ("memory", "user")
MEMORY_ACTIONS = ("add", "replace", "remove")
MEMORY_MAX_ENTRY = 2_000


def profile_memory_store(name):
    """Upstream `MemoryStore` bound to the profile's home: same delimiter, same
    limits, same dedup and threat scan as the bot's own `memory` tool. Upstream
    resolves the home from HERMES_HOME per call (`get_memory_dir`), exactly as
    `hermes -p <profile>` does; the resolved directory is checked against the
    profile before any read, so a stale resolver can never touch the root."""
    require_profile_slug(name)
    if name not in named_profile_names() and not os.path.isfile(os.path.join(hermes_home(), "profiles", name, "config.yaml")):
        raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
    directory = profile_directory(name)
    os.environ["HERMES_HOME"] = directory
    try:
        from tools import memory_tool
        from tools.memory_tool import load_on_disk_store
    except Exception:
        raise Refused("MEMORY_UNAVAILABLE", "the runtime does not expose its memory store")
    resolved = os.path.realpath(str(memory_tool.get_memory_dir()))
    if not resolved.startswith(os.path.realpath(directory) + os.sep):
        raise Refused("MEMORY_UNAVAILABLE", "the runtime resolved the memory store outside the profile")
    return load_on_disk_store()


def memory_view(name, store):
    view = {"profile": name, "memoryEnabled": bool(store.memory_enabled),
            "userProfileEnabled": bool(store.user_profile_enabled),
            "limits": {"memory": int(store.memory_char_limit), "user": int(store.user_char_limit)},
            "entries": {}, "usedChars": {}}
    for target in MEMORY_TARGETS:
        entries = [str(entry) for entry in store._entries_for(target)]
        view["entries"][target] = entries
        view["usedChars"][target] = store._char_count(target)
    return view


def verb_profile_memory_get(request):
    name = require_profile_slug(request.get("name"))
    store = profile_memory_store(name)
    return memory_view(name, store)


def verb_profile_memory_write(request):
    """One `add` / `replace` / `remove` on MEMORY.md or USER.md, through the
    upstream store: what the operator writes from the app obeys the caps and
    the format the bot's own tool obeys. A refusal carries the store's message
    (usage, ambiguity), never a path."""
    name = require_profile_slug(request.get("name"))
    target = request.get("target")
    action = request.get("action")
    if target not in MEMORY_TARGETS:
        raise Refused("MEMORY_INVALID", "target must be memory or user")
    if action not in MEMORY_ACTIONS:
        raise Refused("MEMORY_INVALID", "action must be add, replace or remove")
    content = request.get("content")
    old_text = request.get("oldText")
    if action in ("add", "replace"):
        if not isinstance(content, str) or not content.strip():
            raise Refused("MEMORY_INVALID", "content is required")
        if len(content) > MEMORY_MAX_ENTRY or "\n" in content:
            raise Refused("MEMORY_INVALID", "content must be a single line of at most " + str(MEMORY_MAX_ENTRY) + " characters")
    if action in ("replace", "remove"):
        if not isinstance(old_text, str) or not old_text.strip():
            raise Refused("MEMORY_INVALID", "oldText is required")
        if len(old_text) > MEMORY_MAX_ENTRY:
            raise Refused("MEMORY_INVALID", "oldText is too long")
    store = profile_memory_store(name)
    if not store.target_enabled(target):
        raise Refused("MEMORY_DISABLED", "this memory target is disabled on the profile")
    if action == "add":
        result = store.add(target, content)
    elif action == "replace":
        result = store.replace(target, old_text, content)
    else:
        result = store.remove(target, old_text)
    if not isinstance(result, dict) or not result.get("success"):
        message = text((result or {}).get("error") if isinstance(result, dict) else "", 400) or "the memory store refused the write"
        raise Refused("MEMORY_REFUSED", message)
    view = memory_view(name, store)
    view["message"] = text(result.get("message"), 200)
    return view


def require_skill_name(raw):
    name = raw if isinstance(raw, str) else ""
    name = name.strip().lower()
    if not SKILL_NAME.match(name):
        raise Refused("SKILL_INVALID", "the skill name must be 1-64 characters of [a-z0-9_-]")
    return name


def list_profile_skill_names(name):
    root = os.path.join(hermes_home(), "profiles", name, "skills")
    out = []
    seen = set()
    if os.path.islink(root) or not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [entry for entry in dirnames if not entry.startswith(".")]
        lowered = {item.lower() for item in filenames}
        if "skill.md" not in lowered:
            continue
        skill = os.path.basename(dirpath).strip().lower()
        if not SKILL_NAME.match(skill) or skill in seen:
            continue
        seen.add(skill)
        out.append(skill)
        if len(out) >= 64:
            break
    out.sort()
    return out


def profile_disabled_skill_names(config):
    names = set()
    if not isinstance(config, dict):
        return names
    top = config.get("disabled_skills")
    if isinstance(top, list):
        for item in top:
            if isinstance(item, str) and item.strip():
                names.add(item.strip().lower())
    skills_cfg = config.get("skills")
    if isinstance(skills_cfg, dict):
        disabled = skills_cfg.get("disabled")
        if isinstance(disabled, list):
            for item in disabled:
                if isinstance(item, str) and item.strip():
                    names.add(item.strip().lower())
    return names - ESSENTIAL_SKILLS


def save_profile_disabled_skills(config, disabled):
    cleaned = sorted(set(disabled) - ESSENTIAL_SKILLS)
    config["disabled_skills"] = cleaned
    skills_cfg = config.get("skills")
    if not isinstance(skills_cfg, dict):
        skills_cfg = {}
        config["skills"] = skills_cfg
    skills_cfg["disabled"] = cleaned


def profile_skill_flags(name, config):
    installed = list_profile_skill_names(name)
    disabled = profile_disabled_skill_names(config)
    return [{"name": skill, "enabled": skill not in disabled} for skill in installed]


def verb_profile_skill_set(request):
    name = require_profile_slug(request.get("name"))
    skill = require_skill_name(request.get("skill"))
    enabled = request.get("enabled")
    if not isinstance(enabled, bool):
        raise Refused("BODY_INVALID", "enabled must be true or false")
    if name not in named_profile_names() and not os.path.isfile(os.path.join(hermes_home(), "profiles", name, "config.yaml")):
        raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
    if skill not in list_profile_skill_names(name):
        raise Refused("SKILL_NOT_FOUND", "no skill named " + skill + " is installed on the profile")
    if skill in ESSENTIAL_SKILLS and not enabled:
        return {"name": skill, "profile": name, "enabled": True}
    config = load_profile_config(name)
    disabled = profile_disabled_skill_names(config)
    if enabled:
        disabled.discard(skill)
    else:
        disabled.add(skill)
    save_profile_disabled_skills(config, disabled)
    save_profile_config(name, config)
    return {"name": skill, "profile": name, "enabled": enabled}


def verb_profile_bundled_skills_set(request):
    name = require_profile_slug(request.get("name"))
    enabled = request.get("enabled")
    if not isinstance(enabled, bool):
        raise Refused("BODY_INVALID", "enabled must be true or false")
    if name not in named_profile_names() and not os.path.isfile(os.path.join(hermes_home(), "profiles", name, "config.yaml")):
        raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
    return apply_profile_bundled_skills(name, enabled)


def apply_profile_bundled_skills(name, enabled):
    """Turn the skills shipped with Hermes on or off in one profile's config,
    then read the file back. Shared by the bundled-skills verb and the profile
    creation, which applies it in the same process (one interpreter less on
    a new bot's provisioning)."""
    skills_dir = os.path.join(hermes_home(), "profiles", name, "skills")
    manifest = os.path.join(skills_dir, ".bundled_manifest")
    manifest_names = set()
    try:
        with open(manifest, "r", encoding="utf-8") as handle:
            for line in handle:
                entry = line.strip()
                if entry:
                    manifest_names.add(entry.split(":", 1)[0].strip().lower())
    except FileNotFoundError:
        pass
    bundled = manifest_names.intersection(list_profile_skill_names(name))

    config = load_profile_config(name)
    disabled = profile_disabled_skill_names(config)
    if enabled:
        disabled.difference_update(bundled)
    else:
        disabled.update(bundled)
    save_profile_disabled_skills(config, disabled)
    save_profile_config(name, config)

    config_path = os.path.join(hermes_home(), "profiles", name, "config.yaml")
    try:
        with open(config_path, "r", encoding="utf-8") as handle:
            config_after = yaml_load(handle.read())
    except Exception:
        config_after = {}
    disabled_after = profile_disabled_skill_names(config_after)
    still_enabled = len(bundled.difference(disabled_after))
    essential = len(bundled.intersection(ESSENTIAL_SKILLS))
    return {
        "profile": name,
        "enabled": enabled,
        "bundled": len(bundled),
        "bundledEnabled": still_enabled,
        "essential": essential,
    }


def _skill_identifier(request):
    value = request.get("identifier")
    if not isinstance(value, str) or not value:
        raise Refused("SKILL_IDENTIFIER_INVALID", "the skill identifier is required")
    return value


def verb_skills_hub_capabilities(request):
    try:
        from hermes_cli.skills_hub import do_search, inspect_skill, _install_skill, _scan_quarantined, do_uninstall
        from tools.skills_hub_sources import BrowseShSource, LobeHubSource, UrlSource, WellKnownSkillSource
        _ = (do_search, inspect_skill, _install_skill, _scan_quarantined, do_uninstall,
             BrowseShSource, LobeHubSource, UrlSource, WellKnownSkillSource)
    except Exception:
        return {"available": False}
    return {"available": True}


# Upstream index TTLs (tools.skills_hub.INDEX_CACHE_TTL, 1 h, and
# tools.skills_hub_search.HERMES_INDEX_TTL, 6 h) make the first search after
# expiry download every index in the foreground: well past the API's 35 s on
# a cold host, and the killed probe never fills the cache. Foreground reads
# serve any cached index, whatever its age; skills-hub-refresh, started by the
# operator in the background, refetches them at the upstream TTLs. A search
# that finds no cache at all still downloads: the operator makes it wait for
# a refresh in flight first, so that only happens if the refresh failed.
HUB_INDEX_TTLS = (("tools.skills_hub", "INDEX_CACHE_TTL"),
                  ("tools.skills_hub_search", "HERMES_INDEX_TTL"))
HUB_STALE_SERVE_TTL = float("inf")


def serve_stale_hub_indexes():
    for module_name, attribute in HUB_INDEX_TTLS:
        try:
            module = importlib.import_module(module_name)
        except Exception:
            continue
        if isinstance(getattr(module, attribute, None), (int, float)):
            setattr(module, attribute, HUB_STALE_SERVE_TTL)


def verb_skills_hub_refresh(request):
    from hermes_cli.skills_hub import do_search
    with redirect_stdout(StringIO()):
        do_search("skill", source="all", limit=1, as_json=True)
    return {"refreshed": True}


def verb_skills_hub_search(request):
    query = request.get("query")
    source = request.get("source", "all")
    limit = request.get("limit", 10)
    if not isinstance(query, str) or not isinstance(source, str) or not isinstance(limit, int):
        raise Refused("BODY_INVALID", "skills hub search fields have invalid types")
    serve_stale_hub_indexes()
    from hermes_cli.skills_hub import do_search
    captured = StringIO()
    with redirect_stdout(captured):
        do_search(query, source=source, limit=limit, as_json=True)
    raw = json.loads(captured.getvalue() or "[]")
    return [{"name": item.get("name", ""), "identifier": item.get("identifier", ""),
             "source": item.get("source", ""), "trustLevel": item.get("trust_level", ""),
             "description": item.get("description", "")} for item in raw]


def verb_skills_hub_inspect(request):
    identifier = _skill_identifier(request)
    serve_stale_hub_indexes()
    from hermes_cli.skills_hub import inspect_skill
    result = inspect_skill(identifier)
    if not isinstance(result, dict):
        raise Refused("SKILL_NOT_FOUND", "the skill was not found in the upstream hub")
    preview = result.get("skill_md_preview")
    return {"name": result.get("name", ""), "description": result.get("description", ""),
            "source": result.get("source", ""), "identifier": result.get("identifier", identifier),
            "tags": result.get("tags") if isinstance(result.get("tags"), list) else [],
            "skillMdPreview": preview if isinstance(preview, str) else None}


def _skills_hub_scan(identifier):
    from hermes_cli.skills_hub import _resolve_identifier, _sources, _scan_quarantined
    from tools.skills_hub_install import quarantine_bundle
    from rich.console import Console
    ident, meta, bundle, _src = _resolve_identifier(identifier, _sources(), Console(quiet=True))
    if not ident or bundle is None:
        raise Refused("SKILL_NOT_FOUND", "the skill was not found in the upstream hub")
    q_path = quarantine_bundle(bundle)
    try:
        result = _scan_quarantined(Console(quiet=True), q_path, bundle, meta, ident)
        from tools.skills_guard import INSTALL_POLICY, VERDICT_INDEX
        policy = INSTALL_POLICY.get(result.trust_level, INSTALL_POLICY["community"])[VERDICT_INDEX.get(result.verdict, 2)]
        return {"trustLevel": result.trust_level, "source": bundle.source, "verdict": result.verdict,
                "policy": policy, "findings": [
                    {"severity": f.severity, "category": f.category,
                     "description": f.description, "file": f.file or None, "line": f.line}
                    for f in result.findings[:128]
                ]}
    finally:
        shutil.rmtree(q_path, ignore_errors=True)


def verb_skills_hub_scan(request):
    return _skills_hub_scan(_skill_identifier(request))


def verb_skills_hub_install(request):
    identifier = _skill_identifier(request)
    from hermes_cli.skills_hub import do_install
    profile = request.get("profile")
    old_home = os.environ.get("HERMES_HOME")
    if isinstance(profile, str) and profile:
        os.environ["HERMES_HOME"] = os.path.join(hermes_home(), "profiles", profile)
    try:
        installed = do_install(identifier, skip_confirm=True, invalidate_cache=True)
    finally:
        if old_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = old_home
    if installed is not True:
        raise Refused("SKILL_INSTALL_FAILED", "the upstream skills hub refused the install")
    return {"installed": True, "profile": request.get("profile", "")}


def verb_skills_hub_uninstall(request):
    skill = require_skill_name(request.get("skill"))
    from hermes_cli.skills_hub import do_uninstall
    profile = request.get("profile")
    old_home = os.environ.get("HERMES_HOME")
    if isinstance(profile, str) and profile:
        os.environ["HERMES_HOME"] = os.path.join(hermes_home(), "profiles", profile)
    try:
        removed = do_uninstall(skill, skip_confirm=True, invalidate_cache=True)
    finally:
        if old_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = old_home
    if removed is not True:
        raise Refused("SKILL_NOT_FOUND", "the skill is not installed on the profile")
    return {"removed": skill, "profile": request.get("profile", "")}


def require_provider_slug(raw):
    name = raw if isinstance(raw, str) else ""
    name = name.strip().lower()
    if not re.match(r"^[a-z0-9][a-z0-9_-]{0,63}$", name):
        raise Refused("PROVIDER_INVALID", "provider slug is invalid")
    return name


def provider_key_env(provider):
    try:
        from hermes_cli.config_providers import find_provider_entry

        entry = find_provider_entry(provider)
        if isinstance(entry, dict):
            env = entry.get("key_env") or entry.get("api_key_env") or entry.get("env")
            if isinstance(env, str) and ENV_KEY_NAME.match(env):
                return env
        env = getattr(entry, "key_env", None) if entry is not None else None
        if isinstance(env, str) and ENV_KEY_NAME.match(env):
            return env
    except Exception:
        pass
    env = PROVIDER_KEY_ENV.get(provider)
    if not env:
        raise Refused("PROVIDER_UNKNOWN", "this host does not know the credential variable for " + provider)
    return env


def own_keys_path(name):
    return os.path.join(hermes_home(), "profiles", name, OWN_KEYS_FILE)


def read_own_keys(name):
    path = own_keys_path(name)
    keys = set()
    if os.path.islink(path) or not os.path.isfile(path):
        return keys
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = handle.read()
    except Exception:
        return keys
    for line in data.splitlines():
        candidate = line.strip().lstrip("#").strip()
        if candidate == OWN_MARKER:
            continue
        if ENV_KEY_NAME.match(candidate):
            keys.add(candidate)
    return keys


def write_own_keys(name, keys):
    path = own_keys_path(name)
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    lines = []
    for key in sorted(keys):
        lines.append("# " + OWN_MARKER + "\n")
        lines.append(key + "\n")
    encoded = "".join(lines).encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix=".env.ohb-own.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def mark_own_key(name, key):
    keys = read_own_keys(name)
    keys.add(key)
    write_own_keys(name, keys)


def unmark_own_key(name, key):
    keys = read_own_keys(name)
    keys.discard(key)
    write_own_keys(name, keys)


def write_env_key_owned(name, key, value):
    write_env_key(name, key, value)
    path = os.path.join(hermes_home(), "profiles", name, ".env")
    if os.path.islink(path) or not os.path.isfile(path):
        raise Refused("PROFILE_ENV_REFUSED", "the profile environment is not a regular file")
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.read().splitlines(keepends=True)
    out = []
    replaced = False
    skip_marker = False
    prefix = re.compile(r"^(?:export\s+)?" + re.escape(key) + r"\s*=")
    for line in lines:
        stripped = line.strip()
        if stripped == "# " + OWN_MARKER or stripped == "#" + OWN_MARKER:
            skip_marker = True
            continue
        if prefix.match(stripped):
            if not replaced:
                out.append("# " + OWN_MARKER + "\n")
                out.append(key + "=" + value + "\n")
                replaced = True
            skip_marker = False
            continue
        if skip_marker:
            skip_marker = False
        out.append(line)
    if not replaced:
        out.append("# " + OWN_MARKER + "\n")
        out.append(key + "=" + value + "\n")
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix=".env.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write("".join(out).encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)
    mark_own_key(name, key)


def delete_env_key(name, key):
    path = os.path.join(hermes_home(), "profiles", name, ".env")
    if not os.path.lexists(path):
        return
    if os.path.islink(path) or not os.path.isfile(path):
        raise Refused("PROFILE_ENV_REFUSED", "the profile environment is not a regular file")
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.read().splitlines(keepends=True)
    out = []
    prefix = re.compile(r"^(?:export\s+)?" + re.escape(key) + r"\s*=")
    pending_marker = False
    for line in lines:
        stripped = line.strip()
        if stripped == "# " + OWN_MARKER or stripped == "#" + OWN_MARKER:
            pending_marker = True
            continue
        if prefix.match(stripped):
            pending_marker = False
            continue
        if pending_marker:
            out.append("# " + OWN_MARKER + "\n")
            pending_marker = False
        out.append(line)
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix=".env.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write("".join(out).encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)
    unmark_own_key(name, key)


def verb_profile_credential_set(request):
    name = require_profile_slug(request.get("name"))
    provider = require_provider_slug(request.get("provider"))
    api_key = secret(request.get("apiKey"), "the API key")
    if name not in named_profile_names() and not os.path.isfile(os.path.join(hermes_home(), "profiles", name, "config.yaml")):
        raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
    env_name = provider_key_env(provider)
    write_env_key_owned(name, env_name, api_key)
    return {"provider": provider, "profile": name, "env": env_name}


def verb_profile_credential_delete(request):
    name = require_profile_slug(request.get("name"))
    provider = require_provider_slug(request.get("provider"))
    if name not in named_profile_names() and not os.path.isfile(os.path.join(hermes_home(), "profiles", name, "config.yaml")):
        raise Refused("PROFILE_NOT_FOUND", "no profile named " + name + " exists")
    env_name = provider_key_env(provider)
    delete_env_key(name, env_name)
    return {"provider": provider, "profile": name, "env": env_name}


# Providers whose OAuth refresh token is SINGLE-USE: redeeming it rotates the
# pair and revokes the old one. Same set as upstream
# `hermes_cli/auth_oauth_grants.py` (`SINGLE_USE_REFRESH_POOL_PROVIDERS`).
SINGLE_USE_OAUTH_PROVIDERS = {"anthropic", "openai-codex", "xai-oauth", "nous"}
# Providers whose device-code grant also lives under `providers.<id>`.
DEVICE_CODE_BLOCK_PROVIDERS = {"openai-codex", "xai-oauth", "nous"}
# Singleton files that re-seed an Anthropic OAuth pool row on the next load.
SINGLE_USE_OAUTH_SINGLETONS = {"anthropic": (".anthropic_oauth.json",)}


def oauth_pool_payload(entry):
    """Upstream `_is_oauth_pool_payload`: an OAuth grant, never an API key.

    Broader than upstream's `_is_forkable_pool_row`, which spares a nous row
    without a refresh token (agent_key only) so a surviving `providers.nous`
    block cannot be written over the root row. Here the block leaves with the
    rows, so that row is dropped too: kept, it would shadow the root pool."""
    if not isinstance(entry, dict):
        return False
    return (
        str(entry.get("auth_type") or "").strip().lower() == "oauth"
        or bool(str(entry.get("refresh_token") or "").strip())
        or str(entry.get("access_token") or "").startswith("sk-ant-oat")
    )


def profile_pool_rows(store, provider):
    pool = store.get("credential_pool") if isinstance(store, dict) else None
    rows = pool.get(provider) if isinstance(pool, dict) else None
    return rows if isinstance(rows, list) else []


def profile_provider_block(store, provider):
    """The profile's `providers.<provider>` block, or None.

    Upstream `_load_provider_state_with_source` returns the profile's block as
    soon as it is a dict, refresh token or not, and only then falls back to
    the root one: any dict here shadows the root login."""
    if provider not in DEVICE_CODE_BLOCK_PROVIDERS or not isinstance(store, dict):
        return None
    providers = store.get("providers")
    block = providers.get(provider) if isinstance(providers, dict) else None
    return block if isinstance(block, dict) else None


def profile_oauth_grants(store, provider):
    """Count the profile's own OAuth state of `provider` (pool rows + block)."""
    count = sum(1 for row in profile_pool_rows(store, provider) if oauth_pool_payload(row))
    if profile_provider_block(store, provider) is not None:
        count += 1
    return count


def strip_profile_oauth_grants(store, provider):
    """Drop the OAuth state of one provider, keep its API-key rows."""
    pool = store.get("credential_pool")
    if isinstance(pool, dict) and isinstance(pool.get(provider), list):
        kept = [row for row in pool[provider] if not oauth_pool_payload(row)]
        if kept:
            pool[provider] = kept
        else:
            # No local row: upstream `read_credential_pool` reads the root slice.
            del pool[provider]
    if profile_provider_block(store, provider) is not None:
        # A device-code block only ever holds OAuth state; without it upstream
        # `_load_provider_state` reads the root one.
        del store["providers"][provider]


# Upstream `_TERMINAL_AUTH_REASONS` plus `CREDENTIAL_PERSIST_FAILED_REASON`
# (agent/credential_pool.py): a refresh grant that will never work again.
TERMINAL_OAUTH_REASONS = frozenset({
    "token_invalidated",
    "token_revoked",
    "invalid_token",
    "invalid_grant",
    "unauthorized_client",
    "refresh_token_reused",
    "credential_persist_failed",
})


def oauth_grant(source):
    """The comparable fields of one OAuth grant: pool row, block or singleton."""
    if not isinstance(source, dict):
        return {}
    if "accessToken" in source or "refreshToken" in source:
        # `.anthropic_oauth.json` shape (upstream `_singleton_as_row`).
        return {"access_token": source.get("accessToken"), "refresh_token": source.get("refreshToken")}
    # Codex/xAI blocks nest the pair under `tokens`; nous and pool rows are flat.
    tokens = source.get("tokens") if isinstance(source.get("tokens"), dict) else source
    grant = {key: tokens.get(key) for key in ("access_token", "refresh_token", "id_token")}
    for key in ("id", "last_status", "last_error_reason"):
        grant[key] = source.get(key)
    return grant


def grant_text(grant, key):
    value = grant.get(key)
    return value.strip() if isinstance(value, str) else ""


def grant_spent(grant):
    """True when upstream recorded this grant as unusable for good.

    No refresh token: upstream's quarantine pops the pair from a block on a
    terminal failure, and an access token alone cannot be renewed. Otherwise
    the pool row's own verdict (`STATUS_DEAD`, a terminal reason). A block's
    `last_auth_error` alone is no proof: a later login (`_save_xai_oauth_tokens`)
    rewrites the tokens with `state.update` and leaves the marker behind."""
    if not grant_text(grant, "refresh_token"):
        return True
    return (
        grant_text(grant, "last_status").lower() == "dead"
        or grant_text(grant, "last_error_reason").lower() in TERMINAL_OAUTH_REASONS
    )


def jwt_claims(token):
    """Unverified JWT claims, or {}. Only compared, never logged or returned."""
    if not isinstance(token, str) or token.count(".") != 2:
        return {}
    payload = token.split(".")[1]
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode("utf-8"))
    except ValueError:
        return {}
    return claims if isinstance(claims, dict) else {}


def grant_identity(grant):
    """Upstream `_oauth_identity`: the account a Codex/xAI token names, or None."""
    for key in ("access_token", "id_token"):
        claims = jwt_claims(grant.get(key))
        if not claims:
            continue
        nested = claims.get("https://api.openai.com/auth")
        account = nested.get("chatgpt_account_id") if isinstance(nested, dict) else None
        for value in (account, claims.get("sub"), claims.get("email")):
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def shares_lineage(grant, others):
    """Upstream `_find_root_counterpart`: a copied row id or shared token material."""
    for key in ("id", "refresh_token", "access_token"):
        value = grant_text(grant, key)
        if value and any(grant_text(other, key) == value for other in others):
            return True
    return False


def store_oauth_grants(store, provider):
    """Every OAuth grant one auth.json holds for provider (pool rows + block)."""
    grants = [oauth_grant(row) for row in profile_pool_rows(store, provider) if oauth_pool_payload(row)]
    block = profile_provider_block(store, provider)
    if block is not None:
        grants.append(oauth_grant(block))
    return grants


def read_singleton_grant(path):
    try:
        with open(path, "rb") as handle:
            return oauth_grant(json.loads(handle.read().decode("utf-8-sig")))
    except (OSError, ValueError):
        # Unreadable: no token survives in it, nothing to keep.
        return {}


def root_oauth_grants(home, root, provider):
    """The live grants of the ROOT login a profile would fall back to."""
    try:
        grants = store_oauth_grants(read_auth_store(root), provider) if os.path.isfile(root) else []
    except Refused:
        # No readable root: no lineage can be proven, only spent grants leave.
        grants = []
    for singleton in SINGLE_USE_OAUTH_SINGLETONS.get(provider, ()):
        path = os.path.join(home, singleton)
        if os.path.isfile(path):
            grants.append(read_singleton_grant(path))
    return [grant for grant in grants if not grant_spent(grant)]


def holds_independent_login(grants, root_grants):
    """True when one profile grant may be the only live login of another account.

    A grant may leave only when it is spent, carries the refresh token of a
    spent grant of the same profile, names the same account as a live root
    grant, or (no identity claim on one side) shares a root grant's lineage.
    Two known identities that differ win over a copied row id: upstream
    upserts `device_code` rows by source, so a clone keeps root's row id across
    a re-login with another account. Identity is enough here, unlike in
    upstream's fork heal, because dropping a copy only makes the profile read
    root's grant of that same account."""
    spent = {grant_text(grant, "refresh_token") for grant in grants if grant_spent(grant)}
    spent.discard("")
    root_identities = {identity for identity in map(grant_identity, root_grants) if identity}
    for grant in grants:
        if grant_spent(grant) or grant_text(grant, "refresh_token") in spent:
            continue
        identity = grant_identity(grant)
        if identity and root_identities:
            if identity in root_identities:
                continue
            return True
        if not shares_lineage(grant, root_grants):
            return True
    return False


def same_auth_store(left, right):
    if os.path.abspath(left) == os.path.abspath(right):
        return True
    try:
        return os.path.exists(right) and os.path.samefile(left, right)
    except OSError:
        # Unknown identity: refuse rather than strip what may be the root store.
        return True


def read_auth_store(path):
    try:
        with open(path, "rb") as handle:
            data = json.loads(handle.read().decode("utf-8-sig"))
    except (OSError, ValueError):
        raise Refused("PROFILE_AUTH_UNREADABLE", "a profile credential store could not be read")
    if not isinstance(data, dict):
        raise Refused("PROFILE_AUTH_UNREADABLE", "a profile credential store is not a JSON object")
    return data


def write_auth_store(path, data):
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix=".auth.json.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(json.dumps(data, indent=2, sort_keys=True).encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def auth_store_lock(path):
    """Upstream's cross-process lock on one auth.json, when this Hermes has it.

    A profile worker refreshing its grant while we rewrite the file would
    otherwise lose one of the two writes."""
    try:
        from pathlib import Path

        from hermes_cli.auth import _auth_store_lock

        return _auth_store_lock(target_path=Path(path))
    except Exception:
        from contextlib import nullcontext

        return nullcontext()


def adopt_profile_store(target, provider, singleton_grants, root_grants):
    """Strip one profile store, then prove it on a fresh read.

    Returns None when the profile holds an independent login (nothing
    written), else (changed, own_api_key). Raises Refused with a per-profile
    code. The verdict is taken under the lock, on the store it rewrites."""
    changed = False
    with auth_store_lock(target):
        store = read_auth_store(target)
        if holds_independent_login(store_oauth_grants(store, provider) + singleton_grants, root_grants):
            return None
        if profile_oauth_grants(store, provider):
            strip_profile_oauth_grants(store, provider)
            write_auth_store(target, store)
            changed = True
    reread = read_auth_store(target)
    if profile_oauth_grants(reread, provider):
        raise Refused("PROFILE_AUTH_KEPT", "the profile still holds its own " + provider + " login")
    # API-key rows left: upstream `read_credential_pool` gives the profile its
    # own slice whenever it is non-empty, so it never reads the root login.
    return changed, bool(profile_pool_rows(reread, provider))


def unlink_all(paths):
    for path in paths:
        os.unlink(path)
    return bool(paths)


def verb_profile_oauth_adopt_root(request):
    """Make every named profile read the root OAuth grant of one provider.

    openedbot reconnects a provider with `hermes auth add <provider>` on
    the ROOT store. Upstream gives a profile the root grant only while the
    profile has no state of its own for that provider (`read_credential_pool`,
    `_load_provider_state`), and its fork heal never touches a profile grant
    that shares no lineage with the root one. A profile cloned from root
    (`hermes -p <slug> model`, an imported store) therefore kept its revoked
    refresh token forever: every run of its bot failed with `invalid_grant`
    although the console said "connected". This drops that provider's OAuth
    state from the profiles, API-key rows untouched, then re-reads each store.

    A profile's OAuth state leaves only when every grant in it is provably
    spent or provably root's account or lineage (`holds_independent_login`):
    a working login of another account (`hermes -p work auth add`) is never
    lost to a global reconnection.

    The reply sorts every profile it had to act on:
    - `profiles`: now reads the root login (proven on the re-read);
    - `ownApiKey`: keeps its own API key for the provider (an `.env` key is
      ingested into the pool as such a row), so it does NOT read the root
      login; never counted as adopted;
    - `independent`: holds a login that may be another live account; nothing
      in the profile was touched, never counted as adopted;
    - `refused`: `{profile, code}` for a store that could not be read
      (`PROFILE_AUTH_UNREADABLE`) or still holds an OAuth grant after the
      write (`PROFILE_AUTH_KEPT`). One broken store never strands the others.
    Profile names only: no token, path or claim ever leaves this verb.
    """
    provider = require_provider_slug(request.get("provider"))
    if provider not in SINGLE_USE_OAUTH_PROVIDERS:
        raise Refused("PROVIDER_INVALID", provider + " has no single-use OAuth grant to share")
    home = hermes_home()
    root = os.path.join(home, "auth.json")
    root_grants = root_oauth_grants(home, root, provider)
    adopted, own_api_key, independent, refused = [], [], [], []
    for name in named_profile_names():
        directory = os.path.join(home, "profiles", name)
        try:
            singletons = [
                path
                for path in (os.path.join(directory, singleton) for singleton in SINGLE_USE_OAUTH_SINGLETONS.get(provider, ()))
                if os.path.lexists(path)
            ]
            singleton_grants = [read_singleton_grant(path) for path in singletons]
            target = os.path.join(directory, "auth.json")
            reads_root = not os.path.lexists(target) or same_auth_store(target, root)
            if not reads_root and os.path.islink(target):
                # A link to ANOTHER store is shared with whoever else links it:
                # never write through it. Upstream still reads it as this
                # profile's own store, so a spent grant there is a kept login.
                linked = read_auth_store(target)
                if holds_independent_login(store_oauth_grants(linked, provider) + singleton_grants, root_grants):
                    independent.append(name)
                    continue
                changed = unlink_all(singletons)
                if profile_oauth_grants(linked, provider):
                    raise Refused("PROFILE_AUTH_KEPT", "the profile links to a store that holds its own " + provider + " login")
                if changed:
                    adopted.append(name)
                continue
            if reads_root:
                if holds_independent_login(singleton_grants, root_grants):
                    independent.append(name)
                elif unlink_all(singletons):
                    adopted.append(name)
                continue
            if not os.path.isfile(target):
                raise Refused("PROFILE_AUTH_UNREADABLE", "the profile auth store is not a regular file")
            outcome = adopt_profile_store(target, provider, singleton_grants, root_grants)
            if outcome is None:
                independent.append(name)
                continue
            stripped, keeps_key = outcome
            changed = unlink_all(singletons)
        except Refused as refusal:
            refused.append({"profile": name, "code": refusal.code})
            continue
        except OSError:
            refused.append({"profile": name, "code": "PROFILE_AUTH_UNREADABLE"})
            continue
        if keeps_key:
            own_api_key.append(name)
        elif changed or stripped:
            adopted.append(name)
    return {"provider": provider, "profiles": adopted, "ownApiKey": own_api_key, "independent": independent, "refused": refused}


def load_soul(name):
    for relative in ("SOUL.md", "soul.md"):
        path = os.path.join(hermes_home(), "profiles", name, relative)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return handle.read(MAX_SOUL + 4096)
        except Exception:
            continue
    return None


def strip_messaging_section(soul):
    """Drop the Bot Mode section `## Messaging other agents` (soul.ts:71-73)."""
    if not isinstance(soul, str) or not soul.strip():
        return None
    out = []
    skipping = False
    for line in soul.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("## messaging other agents"):
            skipping = True
            continue
        if skipping and stripped.startswith("## "):
            skipping = False
        if not skipping:
            out.append(line)
    cleaned = "\n".join(out).strip()
    if not cleaned:
        return None
    return cleaned[:MAX_SOUL]


def model_view(config):
    raw = config.get("model") if isinstance(config, dict) else None
    if isinstance(raw, str):
        return {"default": text(raw, 200), "provider": None}
    if isinstance(raw, dict):
        default = raw.get("default") or raw.get("model") or raw.get("id")
        provider = raw.get("provider")
        return {
            "default": text(default, 200) if isinstance(default, str) else None,
            "provider": text(provider, 64) if isinstance(provider, str) else None,
        }
    return {"default": None, "provider": None}


def named_enabled_list(raw, limit=64):
    out = []
    if isinstance(raw, list):
        for item in raw[:limit]:
            if isinstance(item, str) and item.strip():
                out.append({"name": item.strip()[:MAX_NAME], "enabled": True})
            elif isinstance(item, dict):
                name = item.get("name") or item.get("id") or item.get("key")
                if isinstance(name, str) and name.strip():
                    out.append({"name": name.strip()[:MAX_NAME], "enabled": item.get("enabled") is not False})
    elif isinstance(raw, dict):
        for name, value in list(raw.items())[:limit]:
            if not isinstance(name, str) or not name.strip():
                continue
            enabled = True
            if isinstance(value, dict):
                enabled = value.get("enabled") is not False
            elif value is False:
                enabled = False
            out.append({"name": name.strip()[:MAX_NAME], "enabled": enabled})
    return out


def ui_meta_view(config):
    raw = config.get("ui_meta") if isinstance(config, dict) else None
    bots = None
    if isinstance(raw, dict):
        nested = raw.get("hermes-bots") or raw.get("hermes_bots")
        bots = nested if isinstance(nested, dict) else raw
    if not isinstance(bots, dict):
        return None
    groups = []
    raw_groups = bots.get("groups")
    if isinstance(raw_groups, list):
        for item in raw_groups[:16]:
            if isinstance(item, str) and item.strip():
                groups.append(item.strip()[:MAX_NAME])
            elif isinstance(item, dict):
                label = item.get("name") or item.get("id") or item.get("title")
                if isinstance(label, str) and label.strip():
                    groups.append(label.strip()[:MAX_NAME])
    image = bots.get("imageKind") or bots.get("image")
    created = bots.get("created")
    return {
        "title": text(bots.get("title"), 120),
        "color": text(bots.get("color"), 32),
        "shape": text(bots.get("shape"), 32),
        "imageKind": text(image, 32) if isinstance(image, str) else None,
        "hidden": bots.get("hidden") is True,
        "pinned": bots.get("pinned") is True,
        "sectionId": text(bots.get("sectionId") or bots.get("section_id"), 64),
        "groups": groups,
        "created": text(created, 40) if isinstance(created, str) else None,
    }


def jobs_from_disk(name):
    home = hermes_home()
    relatives = (
        os.path.join("profiles", name, "cron", "jobs.json"),
        os.path.join("profiles", name, "cronjobs.json"),
        os.path.join("profiles", name, "cron.json"),
    )
    for relative in relatives:
        path = os.path.join(home, relative)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                raw = json.load(handle)
            if isinstance(raw, list):
                return raw
            if isinstance(raw, dict):
                for key in ("jobs", "cron", "items"):
                    if isinstance(raw.get(key), list):
                        return raw[key]
        except Exception:
            continue
    return []


def list_jobs_for_profile(name):
    for importer in (
        lambda: __import__("hermes_cli.cron", fromlist=["list_jobs"]).list_jobs(profile=name, include_disabled=True),
        lambda: __import__("hermes_cli.cron", fromlist=["list_jobs"]).list_jobs(name),
    ):
        try:
            jobs = importer()
            if isinstance(jobs, list):
                return jobs
        except Exception:
            continue
    return jobs_from_disk(name)


def unwrap_routine_name(raw):
    name = text(raw, 120) or ""
    match = BOT_ROUTINE_PREFIX.match(name)
    if match:
        name = name[match.end():].strip() or name
    return name[:100] or "routine"


def unwrap_routine_prompt(raw):
    prompt = raw if isinstance(raw, str) else ""
    prompt = ROUTINE_WRAP.sub("", prompt).strip()
    return prompt[:4000]


def profile_schedule_view(schedule):
    if isinstance(schedule, str):
        return text(schedule, 120) or ""
    if not isinstance(schedule, dict):
        return ""
    kind = schedule.get("kind")
    if kind == "cron":
        return text(schedule.get("expr"), 120) or ""
    if kind == "interval":
        minutes = schedule.get("minutes")
        if type(minutes) is int and 0 < minutes <= 9007199254740991:
            return "every %dm" % minutes
    if kind == "once" and isinstance(schedule.get("run_at"), str):
        return "once"
    return ""


def profile_toolset_flags(config):
    platforms = config.get("platform_toolsets")
    if isinstance(platforms, dict) and "api_server" in platforms:
        return named_enabled_list(platforms["api_server"])
    return named_enabled_list(config.get("toolsets") or config.get("enabled_toolsets"))


def routine_view(job):
    if not isinstance(job, dict):
        return None
    schedule = job.get("schedule") or job.get("cron") or job.get("expr") or ""
    prompt = job.get("prompt") or job.get("message") or job.get("input") or job.get("command") or ""
    deliver = job.get("deliver")
    if deliver is None:
        deliver = job.get("delivery")
    model = job.get("model")
    return {
        "name": unwrap_routine_name(job.get("name") or job.get("title") or job.get("id")),
        "schedule": profile_schedule_view(schedule),
        "prompt": unwrap_routine_prompt(prompt),
        "enabled": job.get("enabled") is not False,
        "deliver": deliver is not False,
        "model": text(model, 200) if isinstance(model, str) else None,
    }


def avatar_candidates(name):
    directory = os.path.join(hermes_home(), "profiles", name)
    return [
        (os.path.join(directory, "avatar.png"), "image/png"),
        (os.path.join(directory, "avatar.webp"), "image/webp"),
        (os.path.join(directory, "avatar.jpg"), "image/jpeg"),
        (os.path.join(directory, "avatar.jpeg"), "image/jpeg"),
        (os.path.join(directory, "avatar.gif"), "image/gif"),
        (os.path.join(directory, "assets", "avatar.png"), "image/png"),
        (os.path.join(directory, "assets", "avatar.webp"), "image/webp"),
    ]


def profile_has_avatar(name):
    for path, _ctype in avatar_candidates(name):
        try:
            if os.path.isfile(path) and os.path.getsize(path) > 0:
                return True
        except Exception:
            continue
    return False


def read_avatar(name):
    for path, content_type in avatar_candidates(name):
        try:
            with open(path, "rb") as handle:
                data = handle.read(MAX_AVATAR + 1)
            if data:
                return data, content_type
        except Exception:
            continue
    return None, None


def profile_view(name):
    config = read_profile_config(name)
    meta = ui_meta_view(config)
    title = meta["title"] if meta else None
    display = title or text(config.get("display_name") or config.get("name"), 120) or name
    description = text(config.get("description") or config.get("persona"), 400)
    soul = strip_messaging_section(load_soul(name))
    routines = []
    for job in list_jobs_for_profile(name)[:MAX_ROUTINES]:
        view = routine_view(job)
        if view:
            routines.append(view)
    skills = profile_skill_flags(name, config)
    toolsets = profile_toolset_flags(config)
    mcp_servers = named_enabled_list(
        (config.get("mcp_servers") or config.get("mcpServers")) if isinstance(config, dict) else None
    )
    return {
        "name": name,
        "displayName": display[:120],
        "title": title,
        "description": description,
        "soul": soul,
        "model": model_view(config),
        "uiMeta": meta,
        "hasAvatar": profile_has_avatar(name),
        "routines": routines,
        "skills": skills,
        "toolsets": toolsets,
        "mcpServers": mcp_servers,
    }


def module_defines(module, name):
    """True when `module` is installed and its source defines `name`.

    Read from the source, never imported: importing the gateway modules here
    would pull the gateway's whole import graph into every profiles read.
    """
    package, _, rest = module.partition(".")
    try:
        import importlib.util

        # A top-level name is found without importing anything; a dotted one
        # would import its parent package first.
        spec = importlib.util.find_spec(package)
    except Exception:
        return False
    roots = list(getattr(spec, "submodule_search_locations", None) or []) if spec else []
    origin = None
    for root in roots:
        candidate = os.path.join(root, *rest.split(".")) + ".py" if rest else None
        if candidate and os.path.isfile(candidate):
            origin = candidate
            break
    if not origin:
        return False
    try:
        with open(origin, encoding="utf-8") as handle:
            source = handle.read()
    except OSError:
        return False
    return ("def " + name + "(") in source


def mcp_live_reload_supported():
    """The installed gateway reconciles live MCP servers with the config on disk.

    Upstream's housekeeping chore `_mcp_config_reconciler` calls
    `reconcile_mcp_servers_with_config()` for every served profile on each
    tick: a server added, authorized, toggled or removed reaches runs without
    a gateway restart. Both must be present; an older gateway loads MCP at
    boot only.
    """
    return module_defines("gateway.run_profile_reconcile", "_mcp_config_reconciler") and module_defines(
        "tools.mcp_tool_discovery", "reconcile_mcp_servers_with_config"
    )


def verb_profiles(_request):
    """Named profiles on this host, excluding `default`. Read only: no .env, memories, or sessions."""
    return {
        "multiplex": multiplex_enabled(),
        "mcpLiveReload": mcp_live_reload_supported(),
        "profiles": [profile_view(name) for name in named_profile_names()],
    }


def verb_profile_avatar(request):
    name = require_profile_slug(request.get("name"))
    data, content_type = read_avatar(name)
    if not data:
        raise Refused("AVATAR_NOT_FOUND", "this profile has no avatar")
    if len(data) > MAX_AVATAR:
        raise Refused("AVATAR_TOO_LARGE", "the avatar exceeds its bound")
    return {
        "name": name,
        "contentType": content_type,
        "bytes": base64.b64encode(data).decode("ascii"),
    }


def verb_model_context(request):
    """La fenetre de contexte du modele configure, comme `GET /api/model/info`.

    Meme resolution que le Dashboard amont (hermes_cli/web_routers/models.py) :
    la valeur auto vient de `agent.model_metadata.get_model_context_length`, la
    valeur de config la remplace quand elle existe, et c'est cette derniere que
    l'agent applique reellement. Le gateway ne publie ce chiffre nulle part :
    ni /v1/models, ni /api/model/options, ni /v1/capabilities.

    Rien de ce que la sonde lit pour resoudre le contexte ne ressort : ni le
    `base_url` du modele, qui nomme un hote prive, ni la config. Seuls sortent
    l'identifiant du modele, son fournisseur et trois entiers.
    """
    name = request.get("profile")
    if name in (None, ""):
        config = load_config()
        profile = None
    else:
        profile = require_profile_slug(name)
        if not profile_exists(profile):
            raise Refused("PROFILE_UNKNOWN", "no such profile on this host")
        config = read_profile_config(profile)

    model_cfg = config.get("model", "") if isinstance(config, dict) else ""
    if isinstance(model_cfg, dict):
        model = model_cfg.get("default") or model_cfg.get("name") or ""
        provider = model_cfg.get("provider") or ""
        base_url = model_cfg.get("base_url") or ""
        config_ctx = model_cfg.get("context_length")
    else:
        model = str(model_cfg) if model_cfg else ""
        provider, base_url, config_ctx = "", "", None

    view = {
        "profile": profile,
        "model": text(model, 200) if isinstance(model, str) else None,
        "provider": text(provider, 64) if isinstance(provider, str) else None,
        "autoContextLength": 0,
        "configContextLength": 0,
        "effectiveContextLength": 0,
        "maxOutputTokens": 0,
    }
    # Measured before the model is even known: the preamble does not depend on
    # it, and a host without a configured model still has a SOUL and tools.
    view["preamble"] = context_preamble(profile, config)
    if not view["model"]:
        return view

    # Une metadonnee absente n'est pas une panne de l'hote : le modele est
    # simplement inconnu du catalogue, et l'appelant retombera sur sa propre
    # table. Un zero le dit, une erreur 502 mentirait.
    try:
        from agent.model_metadata import get_model_context_length

        auto = get_model_context_length(
            model=model, base_url=base_url, provider=provider, config_context_length=None
        )
    except Exception:
        auto = 0
    view["autoContextLength"] = bounded_tokens(auto)
    view["configContextLength"] = bounded_tokens(config_ctx)
    view["effectiveContextLength"] = view["configContextLength"] or view["autoContextLength"]

    try:
        from agent.models_dev import get_model_capabilities

        caps = get_model_capabilities(provider=provider, model=model)
    except Exception:
        caps = None
    if caps is not None:
        view["maxOutputTokens"] = bounded_tokens(getattr(caps, "max_output_tokens", 0))
        if not view["effectiveContextLength"]:
            view["autoContextLength"] = bounded_tokens(getattr(caps, "context_window", 0))
            view["effectiveContextLength"] = view["autoContextLength"]
    return view


# ─── Context preamble ────────────────────────────────────────────────────────
#
# What the gateway puts in front of every run before openedbot's own instructions:
# the identity (SOUL.md), the built-in memory (MEMORY.md, USER.md), the skills
# index, and the JSON schema of every tool the platform carries. openedbot sees none
# of it (the run body carries only its instructions, history and input), so
# its context bar was a floor. Upstream counts four characters per token
# (`agent/context_compressor.py`); so does this.
#
# Only sizes and names leave the probe: never a SOUL line, a memory entry, a
# skill body, a schema, a path or an env value. A bucket whose size cannot be
# read is published with `tokens: None` ("present, not measured"), never as 0.

PREAMBLE_CHARS_PER_TOKEN = 4
PREAMBLE_MAX_ITEMS = 64
PREAMBLE_MAX_FILE = 4 * 1024 * 1024
PREAMBLE_SKILL_HEAD = 4096


def preamble_tokens(chars):
    if not isinstance(chars, int) or chars <= 0:
        return 0
    return bounded_tokens(-(-chars // PREAMBLE_CHARS_PER_TOKEN))


def preamble_file_chars(path):
    """Characters of a regular file, or None when it is absent or unreadable."""
    try:
        if os.path.islink(path) or not os.path.isfile(path):
            return None
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return len(handle.read(PREAMBLE_MAX_FILE))
    except Exception:
        return None


def preamble_item(name, chars):
    return {"name": text(name, MAX_NAME), "tokens": None if chars is None else preamble_tokens(chars)}


def preamble_bucket(key, items, tokens=None):
    items = [item for item in items if item["name"]][:PREAMBLE_MAX_ITEMS]
    if tokens is None and items and all(item["tokens"] is not None for item in items):
        tokens = sum(item["tokens"] for item in items)
    return {"key": key, "tokens": tokens, "items": items}


def preamble_identity(home):
    for relative in ("SOUL.md", "soul.md"):
        chars = preamble_file_chars(os.path.join(home, relative))
        if chars is not None:
            return preamble_bucket("identity", [], preamble_tokens(chars))
    return None


def preamble_memory(home, config):
    memory = config.get("memory") if isinstance(config, dict) else None
    memory = memory if isinstance(memory, dict) else {}
    items = []
    for flag, filename in (("memory_enabled", "MEMORY.md"), ("user_profile_enabled", "USER.md")):
        if memory.get(flag) is False:
            continue
        chars = preamble_file_chars(os.path.join(home, "memories", filename))
        if chars:
            items.append(preamble_item(filename, chars))
    return preamble_bucket("memory", items) if items else None


def skill_description(path):
    """The `description:` of a SKILL.md front matter: what the index carries."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            head = handle.read(PREAMBLE_SKILL_HEAD)
    except Exception:
        return ""
    lines = head.splitlines()
    if not lines or lines[0].strip() != "---":
        return ""
    for line in lines[1:]:
        if line.strip() == "---":
            break
        key, _, value = line.partition(":")
        if key.strip().lower() == "description":
            return value.strip().strip("\"'")
    return ""


def preamble_skills(home, config):
    """The skills index: one line per enabled skill, its name and description."""
    root = os.path.join(home, "skills")
    if os.path.islink(root) or not os.path.isdir(root):
        return None
    disabled = profile_disabled_skill_names(config)
    items = []
    seen = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(entry for entry in dirnames if not entry.startswith("."))
        manifest = next((item for item in filenames if item.lower() == "skill.md"), None)
        if manifest is None:
            continue
        skill = os.path.basename(dirpath).strip().lower()
        if not SKILL_NAME.match(skill) or skill in seen or skill in disabled:
            continue
        seen.add(skill)
        # "- name: description\n", the shape of upstream's index line.
        chars = len(skill) + len(skill_description(os.path.join(dirpath, manifest))) + 4
        items.append(preamble_item(skill, chars))
        if len(items) >= PREAMBLE_MAX_ITEMS:
            break
    if not items:
        return None
    items.sort(key=lambda item: (-item["tokens"], item["name"]))
    return preamble_bucket("skills", items)


def load_env_file(path):
    """KEY=VALUE pairs of a .env, so tool availability checks see the runtime's
    keys. The values stay in this process: nothing here is ever returned."""
    out = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle.read(PREAMBLE_MAX_FILE).splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                if key.startswith("export "):
                    key = key[len("export "):].strip()
                if ENV_KEY_NAME.match(key):
                    out[key] = value.strip().strip("\"'")
    except Exception:
        pass
    return out


def tool_schema_definitions(toolsets):
    """Upstream's own schema list for these toolsets, or None.

    `get_tool_definitions` is what the agent sends as `tools`. Its keyword set
    moved across releases, hence the fallbacks; any failure means "not
    measured", never "no tools".
    """
    from model_tools import get_tool_definitions

    for kwargs in (
        {"enabled_toolsets": toolsets, "quiet_mode": True},
        {"enabled_toolsets": toolsets},
    ):
        try:
            definitions = get_tool_definitions(**kwargs)
        except TypeError:
            continue
        return definitions if isinstance(definitions, list) else None
    return None


def preamble_tools(home, config):
    """The tool schemas the api_server platform carries, MCP servers apart.

    Importing `model_tools` discovers MCP servers from the config under
    HERMES_HOME. Pointing HERMES_HOME at an empty directory for the import
    keeps the probe from connecting to (or spawning) any of them: their tools
    are reported separately, by server, as not measured.
    """
    try:
        entries = platform_entries(config)
    except Exception:
        return None
    servers = mcp_servers(config) if isinstance(config, dict) else {}
    toolsets = sorted(name for name in entries if name not in servers)
    if not toolsets:
        return None
    saved_env = dict(os.environ)
    scratch = tempfile.mkdtemp(prefix="ohb-preamble-")
    try:
        for key, value in load_env_file(os.path.join(home, ".env")).items():
            os.environ.setdefault(key, value)
        os.environ["HERMES_HOME"] = scratch
        definitions = tool_schema_definitions(toolsets)
    except Exception:
        definitions = None
    finally:
        os.environ.clear()
        os.environ.update(saved_env)
        shutil.rmtree(scratch, ignore_errors=True)
    if definitions is None:
        return preamble_bucket("tools", [], None)
    items = []
    for definition in definitions:
        function = definition.get("function") if isinstance(definition, dict) else None
        name = function.get("name") if isinstance(function, dict) else None
        if not isinstance(name, str) or not name:
            continue
        try:
            chars = len(json.dumps(definition, ensure_ascii=False))
        except Exception:
            chars = None
        items.append(preamble_item(name, chars))
    items.sort(key=lambda item: (-(item["tokens"] or 0), item["name"]))
    total = sum(item["tokens"] or 0 for item in items)
    return preamble_bucket("tools", items, total)


def preamble_mcp(config):
    """MCP servers the platform carries. Their schemas are only known once the
    gateway has connected to them, so they are named, never sized here."""
    try:
        entries = platform_entries(config)
        servers = mcp_servers(config)
    except Exception:
        return None
    names = []
    for name, raw in servers.items():
        entry = raw if isinstance(raw, dict) else {}
        if name in entries and entry.get("enabled", True) is not False:
            names.append(str(name))
    if not names:
        return None
    return preamble_bucket("mcp", [{"name": text(name, MAX_NAME), "tokens": None} for name in sorted(names)], None)


def context_preamble(profile, config):
    home = os.path.join(hermes_home(), "profiles", profile) if profile else hermes_home()
    buckets = []
    for build in (
        lambda: preamble_identity(home),
        lambda: preamble_memory(home, config),
        lambda: preamble_skills(home, config),
        lambda: preamble_tools(home, config),
        lambda: preamble_mcp(config),
    ):
        try:
            bucket = build()
        except Exception:
            bucket = None
        if bucket is not None:
            buckets.append(bucket)
    return {"buckets": buckets}


HANDLERS = {
    "toolsets": verb_toolsets,
    "skills": verb_skills,
    "model-context": verb_model_context,
    "mcp-inventory": verb_mcp_inventory,
    "mcp-add": verb_mcp_add,
    "mcp-install": verb_mcp_install,
    "mcp-remove": verb_mcp_remove,
    "profiles": verb_profiles,
    "profile-avatar": verb_profile_avatar,
    "profile-create": verb_profile_create,
    "profile-delete": verb_profile_delete,
    "profile-mcp-set": verb_profile_mcp_set,
    "profile-mcp-remove": verb_profile_mcp_remove,
    "profile-memory-set": verb_profile_memory_set,
    "profile-toolset-suppress": verb_profile_toolset_suppress,
    "profile-memory-get": verb_profile_memory_get,
    "profile-memory-write": verb_profile_memory_write,
    "profile-model-set": verb_profile_model_set,
    "profile-models-set": verb_profile_models_set,
    "profile-skill-set": verb_profile_skill_set,
    "profile-bundled-skills-set": verb_profile_bundled_skills_set,
    "profile-credential-set": verb_profile_credential_set,
    "profile-credential-delete": verb_profile_credential_delete,
    "profile-oauth-adopt-root": verb_profile_oauth_adopt_root,
    "skills-hub-capabilities": verb_skills_hub_capabilities,
    "skills-hub-search": verb_skills_hub_search,
    "skills-hub-refresh": verb_skills_hub_refresh,
    "skills-hub-inspect": verb_skills_hub_inspect,
    "skills-hub-scan": verb_skills_hub_scan,
    "skills-hub-install": verb_skills_hub_install,
    "skills-hub-uninstall": verb_skills_hub_uninstall,
}


def invoke_handler(verb, request):
    try:
        return HANDLERS[verb](request)
    except Refused:
        raise
    except (Exception, SystemExit):
        if verb not in ("profile-create", "profile-delete"):
            raise
        # Library exits and new upstream exceptions must still produce a
        # bounded, in-contract refusal, never a traceback, token, or raw path.
        raise Refused("PROFILE_CONFIG_REFUSED", "the host could not complete " + verb)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in VERBS:
        sys.stderr.write("usage: inventory-probe.py <" + "|".join(sorted(VERBS)) + ">\n")
        return 2
    verb = sys.argv[1]
    raw = sys.stdin.read(MAX_OUTPUT + 1)
    if len(raw) > MAX_OUTPUT:
        return 2
    try:
        request = json.loads(raw) if raw.strip() else {}
    except Exception:
        request = None
    if not isinstance(request, dict):
        document = {"error": {"code": "BODY_INVALID", "message": "the request body is not a JSON object"}}
    else:
        # Upstream writes a human transcript on stdout. Reserve the real stdout
        # for the single JSON document and send everything else to stderr, which
        # the operator drops.
        real_stdout = sys.stdout
        sys.stdout = sys.stderr
        try:
            document = invoke_handler(verb, request)
        except Refused as refused:
            document = {"error": {"code": refused.code, "message": refused.message}}
        except Exception as exc:
            # Upstream exception text can carry a URL, a token, or a transport
            # diagnostic. Only the class name crosses this boundary.
            document = {"error": {"code": "HOST_FAILED", "message": "the host could not complete " + verb + " (" + type(exc).__name__ + ")"}}
        finally:
            sys.stdout = real_stdout

    encoded = json.dumps(document, ensure_ascii=False)
    if len(encoded) > MAX_OUTPUT:
        encoded = json.dumps({"error": {"code": "RESPONSE_TOO_LARGE", "message": "the host response exceeded its bound"}})
    sys.stdout.write(encoded)
    sys.stdout.flush()
    # MCP probes leave asyncio loops and subprocess reapers alive; the document
    # is already flushed, so leaving is correct and waiting is not.
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
