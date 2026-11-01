"""Bridge the gateway startup event when an upstream bridge is available.

Hermes 0.22.2 keeps plugin event subscriptions inside its dispatch manager and
does not expose a supported gateway-hook-to-plugin event bridge. The A2A
policy plugin therefore remains fail-closed and this hook records the gap
once instead of reaching into that private manager.
"""

import logging

_started = False
_warned = False
_log = logging.getLogger("ohb.a2a.policy")


async def handle(event_type, context):
    global _warned
    if event_type != "gateway:startup" or _started:
        return
    if not isinstance(context, dict) or not isinstance(context.get("platforms"), list):
        return
    if not _warned:
        _warned = True
        _log.warning("A2A policy snapshot is unavailable: Hermes exposes no supported plugin event bridge")
