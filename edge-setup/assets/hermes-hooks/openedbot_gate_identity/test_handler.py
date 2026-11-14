import importlib.util
import unittest
from pathlib import Path


class _Events:
    def __init__(self):
        self.frames = []

    def publish(self, session_id, payload, *, event_type="message.complete", execution=None):
        self.frames.append((event_type, payload))


class _Controls:
    """The shape of Hermes 0.23 PendingControls.register: the prompt drops pattern_key."""

    def __init__(self, events):
        self.events = events

    def register(self, session_id, route, generation, data, *, timeout_s=None):
        prompt = {"kind": "approval", "prompt_id": data["request_id"], "execution_generation": generation,
                  "command": data.get("command", ""), "description": data.get("description", ""), "choices": ["once", "deny"]}
        self.events.publish(session_id, prompt, event_type="approval.request")


class GateIdentityHookTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("openedbot_gate_identity_hook_test", Path(__file__).with_name("handler.py"))
        self.module = importlib.util.module_from_spec(spec)
        # Outside Hermes the import-time install finds no session prompts: it warns and stays off.
        with self.assertLogs("openedbot.gate_identity", level="WARNING"):
            spec.loader.exec_module(self.module)
        self.assertFalse(self.module._installed)
        self.events_class = type("Events", (_Events,), {})
        self.controls_class = type("Controls", (_Controls,), {})
        self.assertTrue(self.module.install(self.controls_class, self.events_class))
        self.events = self.events_class()
        self.controls = self.controls_class(self.events)

    def test_the_published_prompt_carries_the_plugin_pattern_key(self):
        self.controls.register("s1", None, 4, {"request_id": "p1", "pattern_key": "plugin_rule:openedbot/v1/write_file",
                                               "pattern_keys": ["plugin_rule:openedbot/v1/write_file"], "description": "x"})
        event_type, payload = self.events.frames[-1]
        self.assertEqual(event_type, "approval.request")
        self.assertEqual(payload["pattern_key"], "plugin_rule:openedbot/v1/write_file")
        self.assertEqual(payload["pattern_keys"], ["plugin_rule:openedbot/v1/write_file"])
        self.assertEqual(payload["execution_generation"], 4)
        self.assertEqual(self.module._pending, {})

    def test_a_malformed_or_missing_key_adds_nothing(self):
        for data in ({"request_id": "p2"}, {"request_id": "p3", "pattern_key": "a\nb"},
                     {"request_id": "p4", "pattern_key": "k" * 201}, {"request_id": "p5", "pattern_key": 7}):
            self.controls.register("s1", None, 1, data)
            self.assertNotIn("pattern_key", self.events.frames[-1][1])

    def test_bad_pattern_keys_keep_only_the_pattern_key(self):
        self.controls.register("s1", None, 1, {"request_id": "p6", "pattern_key": "recursive delete", "pattern_keys": ["ok", 3]})
        payload = self.events.frames[-1][1]
        self.assertEqual(payload["pattern_key"], "recursive delete")
        self.assertNotIn("pattern_keys", payload)

    def test_other_events_and_other_prompts_are_untouched(self):
        self.events.publish("s1", {"prompt_id": "p7"}, event_type="approval.settled")
        self.events.publish("s1", {"kind": "approval", "prompt_id": "unregistered"}, event_type="approval.request")
        self.assertEqual(self.events.frames, [("approval.settled", {"prompt_id": "p7"}),
                                              ("approval.request", {"kind": "approval", "prompt_id": "unregistered"})])

    def test_a_payload_that_already_has_a_key_is_left_alone(self):
        self.module._pending["p8"] = {"pattern_key": "from-register"}
        self.events.publish("s1", {"prompt_id": "p8", "pattern_key": "upstream"}, event_type="approval.request")
        self.assertEqual(self.events.frames[-1][1]["pattern_key"], "upstream")
        self.module._pending.clear()

    def test_install_is_idempotent(self):
        self.assertTrue(self.module.install(self.controls_class, self.events_class))


if __name__ == "__main__":
    unittest.main()
