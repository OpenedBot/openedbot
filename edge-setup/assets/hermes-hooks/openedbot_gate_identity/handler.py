"""Keep ``pattern_key`` on the approval prompt Hermes 0.23 publishes.

Hermes 0.22 sent the whole approval on ``/v1/runs``: ``request_id``,
``pattern_key`` (``plugin_rule:openedbot/v1/<tool>`` for a gate our approval
plugin raised) and ``description``. openedbot trusts a gate as its own only
through that ``pattern_key``: Hermes sets it from the plugin's rule, never
from text a tool or an MCP server controls.

Hermes 0.23 runs every API turn under its session authority and publishes the
gate as a session prompt (``gateway/session_pending_controls.py``): only
``prompt_id``, ``execution_generation``, ``command``, ``description`` and
``choices``. Without ``pattern_key`` every gate reads as ``unknown`` and goes
to a person, even one the bot's policy would answer.

This hook remembers the ``pattern_key`` of the approval being registered
(``PendingControls.register``) and adds it to the one ``approval.request``
frame published for that prompt (``SessionEvents.publish``). The values come
from the approval Hermes built, bounded and checked; nothing else changes.
On Hermes 0.22 the classes do not exist: the hook stays off, and the 0.22
event already carries the key.
"""

import functools
import logging
import re
import threading

_log = logging.getLogger("openedbot.gate_identity")
_lock = threading.Lock()
_installed = False
# prompt_id -> {"pattern_key": ..., "pattern_keys": [...]}, only while register runs.
_pending = {}

PATTERN_KEY_MAX_CHARS = 200
PATTERN_KEYS_MAX = 16
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def _key(value):
    return isinstance(value, str) and 0 < len(value) <= PATTERN_KEY_MAX_CHARS and not _CONTROL.search(value)


def gate_identity(data):
    """The bounded ``pattern_key`` / ``pattern_keys`` of an approval, or None."""
    if not isinstance(data, dict) or not _key(data.get("pattern_key")):
        return None
    identity = {"pattern_key": data["pattern_key"]}
    keys = data.get("pattern_keys")
    if isinstance(keys, list) and 0 < len(keys) <= PATTERN_KEYS_MAX and all(_key(k) for k in keys):
        identity["pattern_keys"] = list(keys)
    return identity


def install(controls_class=None, events_class=None):
    """Wrap the pending-control registration and the session event publisher once.

    Returns False and leaves Hermes untouched when either class is missing
    (Hermes 0.22, or a later Hermes that renamed them): 0.23 gates then stay
    ``unknown`` in openedbot, which the warning makes visible.
    """
    global _installed
    with _lock:
        if _installed:
            return True
        try:
            if controls_class is None:
                from gateway.session_pending_controls import PendingControls as controls_class
            if events_class is None:
                from gateway.session_events import SessionEvents as events_class
            register_upstream = controls_class.register
            publish_upstream = events_class.publish
        except (ImportError, AttributeError):
            _log.warning("Hermes session prompts not found; approval gates keep their published shape")
            return False

        @functools.wraps(register_upstream)
        def register(self, session_id, route, generation, data, *args, **kwargs):
            prompt_id = data.get("request_id") if isinstance(data, dict) else None
            identity = gate_identity(data) if isinstance(prompt_id, str) else None
            if identity is None:
                return register_upstream(self, session_id, route, generation, data, *args, **kwargs)
            with _lock:
                _pending[prompt_id] = identity
            try:
                return register_upstream(self, session_id, route, generation, data, *args, **kwargs)
            finally:
                with _lock:
                    _pending.pop(prompt_id, None)

        @functools.wraps(publish_upstream)
        def publish(self, session_id, payload, *args, **kwargs):
            event_type = kwargs.get("event_type")
            if event_type == "approval.request" and isinstance(payload, dict) and "pattern_key" not in payload:
                with _lock:
                    identity = _pending.get(payload.get("prompt_id"))
                if identity is not None:
                    payload = {**payload, **identity}
            return publish_upstream(self, session_id, payload, *args, **kwargs)

        register.__wrapped__ = register_upstream
        publish.__wrapped__ = publish_upstream
        controls_class.register = register
        events_class.publish = publish
        _installed = True
        return True


async def handle(event_type, context):
    if event_type == "gateway:startup":
        install()


# Hermes imports this file in the gateway process when it loads its hooks.
install()
