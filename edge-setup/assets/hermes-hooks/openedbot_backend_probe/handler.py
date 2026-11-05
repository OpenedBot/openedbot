"""Answer Hermes' docker backend probe from the host kernel.

Hermes 0.22 describes a remote terminal backend in the system prompt with a
live probe (``agent.prompt_builder._probe_remote_backend``): it starts a
throwaway sandbox container only to run ``uname -s`` and ``uname -r``. The
probe is cached per process and per profile, so the first turn of every
profile after each gateway start, every new bot and every model check pays a
cold container start (~1.2 s on the reference VM) before the model is called.
Upstream knows (NousResearch/hermes-agent#131409) and offers only an off
switch, still unmerged.

A runc container shares the host kernel, so on a Linux host both values are
the host's own ``os.uname()``. The managed runtime runs rootless dockerd with
its default runc runtime, and the answer goes through Hermes' own formatter:
the prompt text, and therefore the prompt-cache prefix, stays byte-identical.
Any other backend, or a non-Linux host (Docker Desktop runs a VM kernel),
keeps the upstream probe.

This is a gateway hook, not a plugin: Hermes loads every hook of the root
home into the gateway process at startup, whatever the profile enables, and
that one process serves every profile. The route is installed when the hook
is loaded, before the gateway serves a run; the startup event only repeats it.
"""

import logging
import os
import sys
import threading

_log = logging.getLogger("openedbot.backend_probe")
_lock = threading.Lock()
_installed = False


def _host_kernel_probe(formatter):
    uname = os.uname()
    return formatter(f"os={uname.sysname}\nkernel={uname.release}\n") or None


def install(prompt_builder=None):
    """Route the docker probe to the host kernel once per process.

    Returns False, and leaves Hermes untouched, when the pinned Hermes no
    longer exposes the probe: the runtime then pays the container start
    again, which the warning makes visible instead of failing a turn.
    """
    global _installed
    with _lock:
        if _installed:
            return True
        try:
            if prompt_builder is None:
                from agent import prompt_builder
            upstream = prompt_builder._probe_remote_backend
            formatter = prompt_builder._format_backend_probe
        except (ImportError, AttributeError):
            _log.warning("Hermes backend probe not found; the docker backend keeps its container probe")
            return False

        def probe(env_type):
            if env_type == "docker" and sys.platform.startswith("linux"):
                return _host_kernel_probe(formatter)
            return upstream(env_type)

        probe.__wrapped__ = upstream
        prompt_builder._probe_remote_backend = probe
        _installed = True
        return True


async def handle(event_type, context):
    if event_type == "gateway:startup":
        install()


# Hermes imports this file in the gateway process when it loads its hooks.
install()
