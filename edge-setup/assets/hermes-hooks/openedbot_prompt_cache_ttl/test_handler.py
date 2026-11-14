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
        spec = importlib.util.spec_from_file_location("openedbot_prompt_cache_ttl_hook_test", Path(__file__).with_name("handler.py"))
        self.module = importlib.util.module_from_spec(spec)
        # Outside Hermes the import-time install finds no API server: it warns and stays off.
        with self.assertLogs("openedbot.prompt_cache_ttl", level="WARNING"):
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
        with self.assertLogs("openedbot.prompt_cache_ttl", level="WARNING"):
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


class PromptCacheTtlTurnRunnerTests(unittest.TestCase):
    """Hermes 0.23: the agent is reused, the tier is set on every turn."""

    def setUp(self):
        spec = importlib.util.spec_from_file_location("openedbot_prompt_cache_ttl_turn_test", Path(__file__).with_name("handler.py"))
        self.module = importlib.util.module_from_spec(spec)
        with self.assertLogs("openedbot.prompt_cache_ttl", level="WARNING"):
            spec.loader.exec_module(self.module)
        self.options = None

        class Runner:
            def _wire_turn_agent_callbacks(self, agent, turn_route, reasoning_config, *rest):
                agent.wired = True

        class Bare:
            pass

        self.runner = Runner
        self.assertTrue(self.module.install(Bare, Runner, lambda: self.options))

    def wire(self, agent):
        self.runner()._wire_turn_agent_callbacks(agent, None, None, None, None, False)

    def test_each_turn_gets_its_tier_and_a_turn_without_one_gets_the_configured_tier_back(self):
        agent = _Agent("1h")
        self.options = {"prompt_cache_ttl": "5m"}
        self.wire(agent)
        self.assertTrue(agent.wired)
        self.assertEqual(agent._cache_ttl, "5m")
        self.options = {"reasoning_effort": "low"}
        self.wire(agent)
        self.assertEqual(agent._cache_ttl, "1h")
        self.options = None
        self.wire(agent)
        self.assertEqual(agent._cache_ttl, "1h")

    def test_a_failing_options_reader_never_fails_the_turn(self):
        spec = importlib.util.spec_from_file_location("openedbot_prompt_cache_ttl_failing", Path(__file__).with_name("handler.py"))
        module = importlib.util.module_from_spec(spec)
        with self.assertLogs("openedbot.prompt_cache_ttl", level="WARNING"):
            spec.loader.exec_module(module)

        class Runner:
            def _wire_turn_agent_callbacks(self, agent, *rest):
                return "wired"

        def broken():
            raise LookupError("no execution")

        self.assertTrue(module.install(type("Bare", (), {}), Runner, broken))
        with self.assertLogs("openedbot.prompt_cache_ttl", level="WARNING"):
            self.assertEqual(Runner()._wire_turn_agent_callbacks(_Agent("1h")), "wired")

    def test_an_unknown_tier_or_disabled_caching_changes_nothing(self):
        agent = _Agent("1h")
        self.options = {"prompt_cache_ttl": "24h"}
        self.wire(agent)
        self.assertEqual(agent._cache_ttl, "1h")
        off = _Agent(None, disabled=True)
        self.options = {"prompt_cache_ttl": "5m"}
        self.wire(off)
        self.assertIsNone(off._cache_ttl)


if __name__ == "__main__":
    unittest.main()
