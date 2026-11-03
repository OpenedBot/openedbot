import asyncio
import importlib.util
from pathlib import Path
import unittest


class GatewayStartupBridgeTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("ohb_policy_hook_test", Path(__file__).with_name("handler.py"))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def run_hook(self, event="gateway:startup", context=None):
        asyncio.run(self.module.handle(event, {"platforms": ["a2a"]} if context is None else context))

    def test_unsupported_plugin_bridge_warns_once_and_stays_fail_closed(self):
        with self.assertLogs("ohb.a2a.policy", level="WARNING") as logs:
            self.run_hook()
            self.run_hook()
        self.assertEqual(len(logs.records), 1)
        self.assertIn("no supported plugin event bridge", logs.output[0])
        self.assertFalse(self.module._started)

    def test_other_events_and_invalid_context_do_not_start(self):
        def unexpected(**payload):
            self.fail("an unrelated event started the snapshot")
        self.run_hook(event="agent:start")
        self.run_hook(context={})
        self.assertFalse(self.module._started)


if __name__ == "__main__":
    unittest.main()
