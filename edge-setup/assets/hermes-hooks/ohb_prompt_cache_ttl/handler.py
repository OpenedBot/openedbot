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

Like ``ohb_backend_probe``, a gateway hook of the root home: loaded into the
one gateway process that serves every profile, whatever a profile enables.
"""

import functools
import logging
import threading

_log = logging.getLogger("ohb.prompt_cache_ttl")
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


def install(adapter_class=None):
    """Wrap the API server's agent factory once per process.

    Returns False, and leaves Hermes untouched, when the pinned Hermes no
    longer has the factory: every run then takes the configured tier, which
    the warning makes visible instead of failing a turn.
    """
    global _installed
    with _lock:
        if _installed:
            return True
        try:
            if adapter_class is None:
                from gateway.platforms.api_server import APIServerAdapter as adapter_class
            upstream = adapter_class._create_agent
        except (ImportError, AttributeError):
            _log.warning("Hermes API agent factory not found; every run keeps the configured prompt-cache tier")
            return False

        @functools.wraps(upstream)
        def _create_agent(self, *args, **kwargs):
            agent = upstream(self, *args, **kwargs)
            apply_tier(agent, kwargs.get("model_options"))
            return agent

        _create_agent.__wrapped__ = upstream
        adapter_class._create_agent = _create_agent
        _installed = True
        return True


async def handle(event_type, context):
    if event_type == "gateway:startup":
        install()


# Hermes imports this file in the gateway process when it loads its hooks.
install()
