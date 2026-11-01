import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class _Agent:
    def __init__(self, ttl="1h", disabled=False):
        self._cache_ttl = ttl
        self._cache_disabled = disabled


def _fake_adapter(agent):
    calls = []

    class Adapter:
        def _create_agent(self, ephemeral_system_prompt=None, model_options=None, **kwargs):
            calls.append(model_options)
            return agent

    return Adapter, calls


class PromptCacheTtlHookTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("ohb_prompt_cache_ttl_hook_test", Path(__file__).with_name("handler.py"))
        self.module = importlib.util.module_from_spec(spec)
        # Outside Hermes the import-time install finds no API server: it warns and stays off.
        with self.assertLogs("ohb.prompt_cache_ttl", level="WARNING"):
            spec.loader.exec_module(self.module)
        self.assertFalse(self.module._installed)

    def test_a_run_that_asks_for_5m_gets_it_on_its_agent(self):
        agent = _Agent("1h")
        adapter, calls = _fake_adapter(agent)
        self.assertTrue(self.module.install(adapter))
        options = {"reasoning_effort": "low", "prompt_cache_ttl": "5m"}
        self.assertIs(adapter()._create_agent(model_options=options), agent)
        self.assertEqual(agent._cache_ttl, "5m")
        # The factory still receives the options untouched.
        self.assertEqual(calls, [options])

    def test_no_option_or_an_unknown_value_keeps_the_configured_tier(self):
        for options in (None, {}, {"prompt_cache_ttl": "24h"}, {"prompt_cache_ttl": 5}, "5m"):
            agent = _Agent("1h")
            adapter, _ = _fake_adapter(agent)
            self.module._installed = False
            self.module.install(adapter)
            adapter()._create_agent(model_options=options)
            self.assertEqual(agent._cache_ttl, "1h", options)

    def test_an_agent_with_caching_off_stays_off(self):
        for agent in (_Agent(None, disabled=True), _Agent(None)):
            adapter, _ = _fake_adapter(agent)
            self.module._installed = False
            self.module.install(adapter)
            adapter()._create_agent(model_options={"prompt_cache_ttl": "1h"})
            self.assertIsNone(agent._cache_ttl)

    def test_install_is_idempotent_and_never_wraps_twice(self):
        adapter, _ = _fake_adapter(_Agent())
        self.module.install(adapter)
        first = adapter._create_agent
        self.assertTrue(self.module.install(adapter))
        self.assertIs(adapter._create_agent, first)

    def test_missing_factory_leaves_hermes_untouched(self):
        class Bare:
            pass
        with self.assertLogs("ohb.prompt_cache_ttl", level="WARNING"):
            self.assertFalse(self.module.install(Bare))
        self.assertFalse(hasattr(Bare, "_create_agent"))

    def test_gateway_startup_installs_and_other_events_do_nothing(self):
        adapter, _ = _fake_adapter(_Agent())
        api_server = types.ModuleType("gateway.platforms.api_server")
        api_server.APIServerAdapter = adapter
        modules = {"gateway": types.ModuleType("gateway"), "gateway.platforms": types.ModuleType("gateway.platforms"),
                   "gateway.platforms.api_server": api_server}
        with patch.dict(sys.modules, modules):
            asyncio.run(self.module.handle("agent:start", {}))
            self.assertFalse(self.module._installed)
            asyncio.run(self.module.handle("gateway:startup", {"platforms": []}))
        self.assertTrue(self.module._installed)
        self.assertTrue(hasattr(adapter._create_agent, "__wrapped__"))


if __name__ == "__main__":
    unittest.main()
