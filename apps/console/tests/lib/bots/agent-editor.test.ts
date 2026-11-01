import { afterEach, expect, test } from "bun:test";
import { useAgentEditor } from "../../../src/lib/bots/agent-editor";

afterEach(() => {
  useAgentEditor.getState().close();
  window.localStorage.removeItem("ohb.agentEditor.open");
});

test("the editor starts closed instead of opening its canvas on arrival", () => {
  expect(useAgentEditor.getState().open).toBe(false);
});

test("entering another bot closes an explicitly opened editor", () => {
  useAgentEditor.getState().show();
  expect(useAgentEditor.getState().open).toBe(true);
  useAgentEditor.getState().release();
  expect(useAgentEditor.getState().open).toBe(false);
  expect(useAgentEditor.getState().botId).toBeNull();
});

test("leaving the conversation clears a pinned editor too", () => {
  useAgentEditor.getState().show("another-bot");
  useAgentEditor.getState().release();
  expect(useAgentEditor.getState().open).toBe(false);
  expect(useAgentEditor.getState().botId).toBeNull();
});
