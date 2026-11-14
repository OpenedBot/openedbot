"""MCP OAuth authorization program run by hermes-operator.

This source is installed by the operator under the tool's root, owned by root,
and executed by the managed Hermes venv interpreter as the service user. It
plays, for ONE configured `auth: oauth` MCP server, the authorization-code +
PKCE flow that upstream's Dashboard plays behind `POST /api/mcp/servers/{name}/auth`,
with the browser leg moved to openedbot instead of a loopback listener
that a headless host cannot offer.

Unlike the inventory program this one is LONG-LIVED: it must hold the PKCE
verifier and the dynamic-client registration in memory between the moment it
prints the authorization URL and the moment the callback code arrives.

Contract, deliberately narrow:

  * argv carries nothing. The request is ONE JSON line on stdin:
    `{"name": <server>, "redirectUri": <url>, "profile"?: <slug>}`.
  * without `profile` the authorization is the runtime root's, as before.
    With a named profile it is THAT profile's: upstream keeps MCP tokens per
    Hermes home (`<home>/mcp-tokens`) and a profile's runs read its own home,
    so a token obtained at the root never reaches a bot's profile. The flow
    then runs under the profile's home and secret scope, exactly like the
    Dashboard's `?profile=` path, and the server lands in the profile's
    config (copied from the root entry when the profile does not carry it)
    only once a token is proven.
  * stdout carries JSON LINES, each one an event of a closed set:
      {"event":"authorization_url","url":...}   the user must open this URL
      {"event":"approved","tools":[...]}         tokens proven on disk
      {"event":"error","code":...,"message":...} a refusal of the contract
  * the callback is ONE more JSON line on stdin: `{"code":..., "state":..., "iss":...}`
    or `{"error": ...}`. EOF before it means the caller gave up.
  * once the token is proven and before the config.yaml it rewrites is
    saved, the program prints `{"event":"config_lock"}` and waits for
    `{"configLock":"held"}` on stdin: the operator's lock of that file, the
    one its own config writers take, held until the verdict line.
  * no token, no client secret, no header value ever appears on stdout, and
    an upstream exception crosses only by its class name.

Everything OAuth-specific: discovery, DCR, PKCE, state, token exchange and
storage: stays upstream's (`tools.mcp_oauth`, `tools.mcp_dashboard_oauth`);
this program only moves the two human callbacks to stdin/stdout.
"""

import json
import os
import secrets
import sys
import threading
import time

MAX_LINE = 64 * 1024
MAX_NAME = 64
MAX_URL = 2048
MAX_TOOLS = 256
MAX_CODE = 4096
# The OAuth callback window upstream uses (300 s) plus headroom, like the
# Dashboard's own re-auth path.
CONNECT_TIMEOUT_SECONDS = 315.0
URL_TIMEOUT_SECONDS = 60.0
# How long the save waits for the operator's config lock: the other writers
# hold it for one probe verb, seconds, not minutes.
CONFIG_LOCK_TIMEOUT_SECONDS = 120.0

PLATFORM = "api_server"
NAME_ALLOWED = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
PROFILE_ALLOWED = set("abcdefghijklmnopqrstuvwxyz0123456789_-")
MAX_PROFILE = 63


class Refused(Exception):
    """A refusal that is part of the contract, not a crash."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


_stdout_lock = threading.Lock()
_real_stdout = sys.stdout
# Set by the stdin reader: the operator granted the config lock, or closed
# stdin (it gave up, the lock will never come).
_config_lock_held = threading.Event()
_stdin_closed = threading.Event()


def emit(event, **fields):
    document = {"event": event}
    document.update(fields)
    encoded = json.dumps(document, ensure_ascii=False)
    with _stdout_lock:
        _real_stdout.write(encoded + "\n")
        _real_stdout.flush()


def server_name(raw):
    name = raw if isinstance(raw, str) else ""
    if not name or len(name) > MAX_NAME or set(name) - NAME_ALLOWED:
        raise Refused("NAME_INVALID", "the server name must be 1-64 characters of [A-Za-z0-9_-]")
    return name


def profile_slug(raw):
    """`None` for the runtime root; a named profile slug otherwise."""
    if raw is None:
        return None
    name = raw if isinstance(raw, str) else ""
    if (not name or len(name) > MAX_PROFILE or set(name) - PROFILE_ALLOWED
            or name[0] in "_-" or name == "default"):
        raise Refused("PROFILE_INVALID", "the profile name must be 1-63 characters of [a-z0-9_-], and not default")
    return name


def redirect_uri(raw):
    """The openedbot callback the provider will redirect the browser to.

    https only, except a loopback http origin, which is what a development
    openedbot behind an SSH tunnel presents. Never a scheme, a host or a
    path chosen here: the value is registered verbatim with the provider.
    """
    url = raw if isinstance(raw, str) else ""
    if not url or len(url) > MAX_URL:
        raise Refused("REDIRECT_INVALID", "the redirect URI is missing or too long")
    if any(ch < " " or ch == "\x7f" for ch in url):
        raise Refused("REDIRECT_INVALID", "the redirect URI contains control characters")
    loopback = url.startswith("http://localhost:") or url.startswith("http://localhost/") \
        or url.startswith("http://127.0.0.1:") or url.startswith("http://127.0.0.1/")
    if not url.startswith("https://") and not loopback:
        raise Refused("REDIRECT_INVALID", "the redirect URI must be https:// (or a loopback http:// origin)")
    return url


def read_line():
    raw = sys.stdin.readline(MAX_LINE + 1)
    if not raw:
        return None
    if len(raw) > MAX_LINE:
        raise Refused("BODY_INVALID", "the request line exceeds its bound")
    try:
        document = json.loads(raw)
    except Exception:
        raise Refused("BODY_INVALID", "the request line is not JSON")
    if not isinstance(document, dict):
        raise Refused("BODY_INVALID", "the request line is not a JSON object")
    return document


def set_platform_entry(name):
    """Carry the server on the api_server platform once it is authorized.

    Same read-modify-write shape as the inventory program and as
    `hermes tools enable`: the helper upstream cannot ADD an MCP name.
    """
    from hermes_cli.config import load_config, save_config
    from hermes_cli.tools_config import _get_platform_tools

    config = load_config()
    entries = set(_get_platform_tools(config, PLATFORM, include_default_mcp_servers=False))
    entries.add(name)
    existing = config.setdefault("platform_toolsets", {})
    if not isinstance(existing, dict):
        existing = {}
        config["platform_toolsets"] = existing
    existing[PLATFORM] = sorted(entries)
    save_config(config)


def load_server(name, fallback=None):
    """The server's entry in the current home, else `fallback` (the root's
    entry, for a profile that does not carry the server yet)."""
    from hermes_cli.mcp_config import _get_mcp_servers

    servers = _get_mcp_servers()
    servers = servers if isinstance(servers, dict) else {}
    raw = servers.get(name)
    if not isinstance(raw, dict) and isinstance(fallback, dict):
        raw = fallback
    if not isinstance(raw, dict):
        raise Refused("SERVER_UNKNOWN", "no MCP server named " + name + " is configured")
    cfg = dict(raw)
    if not cfg.get("url"):
        raise Refused("OAUTH_UNSUPPORTED", name + " is a local-command server; it authenticates through its environment, not OAuth")
    if cfg.get("headers") and cfg.get("auth") != "oauth":
        raise Refused("OAUTH_UNSUPPORTED", name + " authenticates with a bearer header, not OAuth")
    cfg["auth"] = "oauth"
    return cfg


class profile_scope:
    """Install a named profile's Hermes home and secret scope, like upstream's
    `_profile_secret_scope`. Refused, never silently the root, when the host
    cannot resolve the profile or does not carry the override API."""

    def __init__(self, profile):
        self.profile = profile
        self.home = None
        self._tokens = None

    def __enter__(self):
        from pathlib import Path

        try:
            from agent.secret_scope import build_profile_secret_scope, set_secret_scope
            from hermes_cli.profiles import get_profile_dir, profile_exists
            from hermes_constants import set_hermes_home_override
        except Exception:
            raise Refused("OAUTH_UNSUPPORTED", "this runtime cannot authorize an MCP server for a named profile; update Hermes on the host")
        if not profile_exists(self.profile):
            raise Refused("PROFILE_NOT_FOUND", "no profile named " + self.profile + " exists")
        home = str(Path(get_profile_dir(self.profile)).expanduser().resolve(strict=False))
        home_token = set_hermes_home_override(home)
        try:
            secret_token = set_secret_scope(build_profile_secret_scope(Path(home)), profile_home=home)
        except Exception:
            from hermes_constants import reset_hermes_home_override

            reset_hermes_home_override(home_token)
            raise
        self.home = home
        self._tokens = (home_token, secret_token)
        return self

    def __exit__(self, *exc):
        from agent.secret_scope import reset_secret_scope
        from hermes_constants import reset_hermes_home_override

        home_token, secret_token = self._tokens
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)
        return False


def diagnostic(text):
    """A bounded line for the operator's journal only, never for the link."""
    emit("diagnostic", text=str(text)[:300])


def watch_authorization_url(flow):
    """Print the authorization URL each time upstream publishes one.

    EACH time, not once: the MCP client retries a connection that did not
    complete (the browser callback waits 300 s per attempt), and every attempt
    generates a fresh PKCE verifier, a fresh `state` and therefore a fresh
    URL. A page that kept the first URL would send the user to a `state` the
    flow no longer expects. Polled through the public snapshot rather than the
    private event: the flow object is upstream's, its internals not a contract.
    """
    deadline = time.monotonic() + URL_TIMEOUT_SECONDS
    last = None
    while True:
        snapshot = flow.snapshot()
        status = snapshot.get("status")
        url = snapshot.get("authorization_url")
        if status == "authorization_required" and url and url != last:
            last = url
            emit("authorization_url", url=str(url)[:MAX_URL])
        if status in {"approved", "error"}:
            return
        if last is None and time.monotonic() > deadline:
            flow.mark_error("the provider did not produce an authorization URL in time")
            return
        time.sleep(0.1)


def deliver_callback(flow):
    """Feed the browser's callbacks (from stdin) into upstream's flow.

    Callbacks are read until the flow ends. One that the flow refuses: a
    `state` from a previous attempt's URL, a duplicate: is reported to the
    journal and does not end the authorization: the Dashboard's callback
    route rejects it the same way and keeps waiting. EOF means the operator
    gave up.

    The same stdin carries the operator's config lock grant, which arrives
    after the callback, once the token is proven: this reader is the only one
    and keeps reading until EOF.
    """
    while True:
        try:
            document = read_line()
        except Refused as refused:
            diagnostic("callback refused: " + refused.message)
            continue
        if document is None:
            _stdin_closed.set()
            if flow.snapshot().get("status") in {"approved", "error"}:
                return
            # The operator cancelled (it closes stdin). `cancelled` keeps a
            # retry from minting a new URL; an older upstream lacks it.
            try:
                flow.mark_error("the authorization was cancelled", cancelled=True)
            except TypeError:
                flow.mark_error("the authorization was cancelled")
            return
        if document.get("configLock") == "held":
            _config_lock_held.set()
            continue
        if flow.snapshot().get("status") in {"approved", "error"}:
            continue
        code = document.get("code")
        state = document.get("state")
        error = document.get("error")
        # RFC 9207 issuer: upstream's flow carries it to the SDK, which
        # refuses a redirect without it when the server advertises it.
        iss = document.get("iss")
        if not isinstance(iss, str) or not iss or len(iss) > MAX_CODE:
            iss = None
        if not isinstance(code, str) or len(code) > MAX_CODE:
            code = None
        if not isinstance(state, str) or len(state) > MAX_CODE:
            state = None
        if not isinstance(error, str) or not error:
            error = None
        try:
            deliver = {"code": code, "state": state, "error": error[:200] if error else None}
            if iss is not None:
                deliver["iss"] = iss
            try:
                flow.deliver_callback(**deliver)
            except TypeError:
                # An older upstream without `iss` also never checks it.
                deliver.pop("iss", None)
                flow.deliver_callback(**deliver)
        except ValueError as exc:
            diagnostic("callback rejected: " + str(exc))


def acquire_config_lock():
    """Wait for the operator's lock of the config.yaml about to be saved.

    The operator's own writers (capability and model toggles, connections)
    rewrite the same file under that lock; a save outside it could interleave
    with theirs and silently drop one of the two changes. Refused, never a
    save without the lock, when the operator closed stdin or did not grant it
    in time.
    """
    emit("config_lock")
    deadline = time.monotonic() + CONFIG_LOCK_TIMEOUT_SECONDS
    while not _config_lock_held.wait(0.1):
        if _stdin_closed.is_set():
            raise Refused("OAUTH_CANCELLED", "the authorization was cancelled")
        if time.monotonic() > deadline:
            raise Refused("OAUTH_FAILED", "the host did not grant the configuration lock in time")
    # Granted, then given up (stdin closed right after the grant): the
    # operator no longer follows this program, so nothing is written.
    if _stdin_closed.is_set():
        raise Refused("OAUTH_CANCELLED", "the authorization was cancelled")


def authorize(name, cfg, flow):
    """The Dashboard worker, verbatim in shape (`_run_dashboard_mcp_oauth`).

    Runs under whatever Hermes home is current: the root, or the profile's
    home installed by `profile_scope`. Every read and write below (config,
    token storage, platform entry) follows it.
    """
    from hermes_cli.mcp_config import _oauth_tokens_present, _probe_single_server, _save_mcp_server
    from tools.mcp_dashboard_oauth import dashboard_oauth_flow
    from tools.mcp_oauth import HermesTokenStorage, force_interactive_oauth
    from tools.mcp_oauth_manager import get_manager

    with force_interactive_oauth(), dashboard_oauth_flow(flow):
        manager = get_manager()
        storage = HermesTokenStorage(name)
        backup = storage.snapshot()
        previous_entry = None
        try:
            previous_entry = manager.remove(name)
            connect_timeout = max(float(cfg.get("connect_timeout", 0) or 0), CONNECT_TIMEOUT_SECONDS)
            tools = _probe_single_server(name, cfg, connect_timeout=connect_timeout)
            if not _oauth_tokens_present(name):
                raise Refused(
                    "OAUTH_NO_TOKEN",
                    "the server answered but no OAuth token was obtained; this provider may require a pre-registered OAuth client",
                )
            # A server added without a token was saved disabled (its probe
            # could not reach it): the token just proved it reachable, so the
            # authorization turns it on instead of leaving it inert.
            cfg.pop("enabled", None)
            # Held by the operator from here until the verdict line.
            acquire_config_lock()
            if not _save_mcp_server(name, cfg):
                raise Refused("SERVER_REFUSED", "the runtime refused to save " + name)
            set_platform_entry(name)
            flow.mark_approved()
            return [str(item[0])[:MAX_NAME] for item in list(tools or [])[:MAX_TOOLS]]
        except Exception:
            storage.restore(backup, only_if_absent=True)
            manager.restore_entry(name, previous_entry)
            raise


def failure_code(exc):
    """Map an upstream failure to a code of the closed set, without its text."""
    if isinstance(exc, Refused):
        return exc.code, exc.message
    kind = type(exc).__name__
    text = str(exc).lower()
    if kind == "TimeoutError" or "timed out" in text:
        return "OAUTH_TIMEOUT", "the authorization was not completed in time"
    if "state mismatch" in text or "already received" in text or "already used" in text:
        return "OAUTH_CALLBACK_INVALID", "the OAuth callback was invalid or already used"
    if "cancelled" in text:
        return "OAUTH_CANCELLED", "the authorization was cancelled"
    if "403" in text or "registration" in text:
        return "OAUTH_REGISTRATION_REFUSED", "the provider refused to register an OAuth client for this host; it may require a pre-registered client"
    return "OAUTH_FAILED", "the host could not complete the authorization (" + kind + ")"


def main():
    # Upstream writes a human transcript on stdout. Reserve the real stdout
    # for the event lines and send everything else to stderr, which the
    # operator drops.
    sys.stdout = sys.stderr
    try:
        request = read_line()
        if request is None:
            raise Refused("BODY_INVALID", "the request line is missing")
        name = server_name(request.get("name"))
        redirect = redirect_uri(request.get("redirectUri"))
        profile = profile_slug(request.get("profile"))
        # The root entry is read BEFORE any profile scope: it is what a
        # profile that does not carry the server yet receives.
        root_cfg = load_server(name)
        try:
            from hermes_constants import get_hermes_home
            from tools.mcp_dashboard_oauth import DashboardOAuthFlow
        except Exception:
            raise Refused("OAUTH_UNSUPPORTED", "this runtime does not carry the MCP OAuth bridge; update Hermes on the host")

        def run(cfg, home):
            flow = DashboardOAuthFlow(
                flow_id=secrets.token_urlsafe(16),
                server_name=name,
                profile=profile,
                hermes_home=home,
                redirect_uri=redirect,
                reconnect_live=False,
            )
            threading.Thread(target=watch_authorization_url, args=(flow,), daemon=True).start()
            threading.Thread(target=deliver_callback, args=(flow,), daemon=True).start()
            return authorize(name, cfg, flow)

        if profile is None:
            tools = run(root_cfg, str(get_hermes_home().expanduser().resolve(strict=False)))
        else:
            with profile_scope(profile) as scope:
                tools = run(load_server(name, fallback=root_cfg), scope.home)
        emit("approved", tools=tools)
    except Exception as exc:
        diagnostic(type(exc).__name__ + ": " + str(exc))
        code, message = failure_code(exc)
        emit("error", code=code, message=message)
    # MCP probes leave asyncio loops and subprocess reapers alive; the events
    # are already flushed, so leaving is correct and waiting is not.
    os._exit(0)


if __name__ == "__main__":
    main()
