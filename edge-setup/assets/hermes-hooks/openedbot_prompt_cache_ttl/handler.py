"""Let one ``/v1/runs`` request choose its Anthropic prompt-cache tier.

Hermes 0.22 reads ``prompt_caching.cache_ttl`` once per agent, from the
config: one tier for every run of a process. The managed runtime sets
``auto``, which gives every API run the ``1h`` tier (2x the input price on a
write, worth it when a person pauses between turns) and machine-paced calls
(compaction, auxiliary, delegated children) the ``5m`` tier (1.25x).

openedbot knows better per run: a routine, a delegated step or a greeting is
not read again within the hour, so its ``1h`` write is wasted. It sends
``model_options.prompt_cache_ttl``; the API server already carries
``model_options`` to ``_create_agent`` untouched. This hook sets the tier on
the agent that call returns, the way Hermes itself clamps a delegated child
(``tools/delegate_tool._apply_child_cache_ttl``). An agent whose caching is
off keeps it off, and Hermes still clamps the tier to what the route accepts
(``effective_cache_ttl``). Without the hook, the key is ignored.

Hermes 0.23 runs API turns under its session authority: the turn no longer
calls ``_create_agent``, agents are reused from one turn to the next, and the
request's ``model_options`` are read per turn from ``api_execution``. The hook
then wraps ``TurnRunner._wire_turn_agent_callbacks`` (called on every turn)
and sets the requested tier, or puts back the configured one a previous turn
replaced. The ``_create_agent`` wrapper stays for Hermes 0.22 (deprecated).

Like ``openedbot_backend_probe``, a gateway hook of the root home: loaded into the
one gateway process that serves every profile, whatever a profile enables.
"""

import functools
import logging
import threading

_log = logging.getLogger("openedbot.prompt_cache_ttl")
_lock = threading.Lock()
_installed = False

OPTION = "prompt_cache_ttl"
TIERS = frozenset({"5m", "1h"})


def requested_tier(model_options):
    """The tier a request asks for, or None for the configured one."""
    if not isinstance(model_options, dict):
        return None
    value = model_options.get(OPTION)
    return value if isinstance(value, str) and value in TIERS else None


def apply_tier(agent, model_options):
    tier = requested_tier(model_options)
    if tier is None or agent is None or getattr(agent, "_cache_disabled", False):
        return
    if getattr(agent, "_cache_ttl", None) is None:
        return
    agent._cache_ttl = tier


CONFIGURED = "_openedbot_configured_cache_ttl"


def apply_turn_tier(agent, model_options):
    """Hermes 0.23: one reused agent per session, so every turn sets its tier.

    The configured tier is remembered on the agent the first time it is seen,
    and put back on a turn that asks for none.
    """
    if agent is None or getattr(agent, "_cache_disabled", False):
        return
    current = getattr(agent, "_cache_ttl", None)
    if current is None:
        return
    if not hasattr(agent, CONFIGURED):
        setattr(agent, CONFIGURED, current)
    agent._cache_ttl = requested_tier(model_options) or getattr(agent, CONFIGURED)


def _turn_model_options():
    try:
        from gateway.session_api_turn import api_execution
    except ImportError:
        return None
    api = api_execution.get()
    settings = api.get("settings") if isinstance(api, dict) else None
    return settings.get("model_options") if isinstance(settings, dict) else None


def _install_turn_runner(runner_class, options_reader):
    upstream = runner_class._wire_turn_agent_callbacks

    @functools.wraps(upstream)
    def _wire_turn_agent_callbacks(self, agent, *args, **kwargs):
        result = upstream(self, agent, *args, **kwargs)
        try:
            apply_turn_tier(agent, options_reader())
        except Exception:  # a tier is an optimisation: it never fails a turn
            _log.warning("prompt-cache tier not applied to this turn", exc_info=True)
        return result

    _wire_turn_agent_callbacks.__wrapped__ = upstream
    runner_class._wire_turn_agent_callbacks = _wire_turn_agent_callbacks


def _install_agent_factory(adapter_class):
    """@deprecated Hermes 0.22: the API server built one agent per run.

    Remove once no host runs a Hermes below 0.23.
    """
    upstream = adapter_class._create_agent

    @functools.wraps(upstream)
    def _create_agent(self, *args, **kwargs):
        agent = upstream(self, *args, **kwargs)
        apply_tier(agent, kwargs.get("model_options"))
        return agent

    _create_agent.__wrapped__ = upstream
    adapter_class._create_agent = _create_agent


def install(adapter_class=None, runner_class=None, options_reader=None):
    """Wrap the per-turn wiring (Hermes 0.23) and the agent factory (0.22) once.

    Returns False, and leaves Hermes untouched, when neither exists: every
    run then takes the configured tier, which the warning makes visible
    instead of failing a turn.
    """
    global _installed
    with _lock:
        if _installed:
            return True
        wired = False
        try:
            if runner_class is None:
                from gateway.run_turn_runner import TurnRunner as runner_class
            runner_class._wire_turn_agent_callbacks
        except (ImportError, AttributeError):
            runner_class = None
        if runner_class is not None:
            _install_turn_runner(runner_class, options_reader or _turn_model_options)
            wired = True
        try:
            if adapter_class is None:
                from gateway.platforms.api_server import APIServerAdapter as adapter_class
            adapter_class._create_agent
        except (ImportError, AttributeError):
            adapter_class = None
        if adapter_class is not None:
            _install_agent_factory(adapter_class)
            wired = True
        if not wired:
            _log.warning("Hermes API agent factory not found; every run keeps the configured prompt-cache tier")
            return False
        _installed = True
        return True


async def handle(event_type, context):
    if event_type == "gateway:startup":
        install()


# Hermes imports this file in the gateway process when it loads its hooks.
install()
