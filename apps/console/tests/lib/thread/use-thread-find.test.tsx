import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ThreadMessageDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../src/lib/i18n";
import { THREAD_REVEAL_EVENT, type ThreadRevealDetail } from "../../../src/lib/thread/thread-reveal";
import { useThreadFind } from "../../../src/lib/thread/use-thread-find";

const messages: ThreadMessageDto[] = Array.from({ length: 3 }, (_, index) => ({
  id: `m-${index}`,
  role: "user",
  content: [{ type: "text", text: index === 1 ? "la clé de voûte" : `message ${index}` }],
  runId: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  authorBot: null,
}));

function Harness() {
  const find = useThreadFind({ messages, events: [] });
  return <div>{find.bar}</div>;
}

const reveals: ThreadRevealDetail[] = [];
const record = (event: Event) => reveals.push((event as CustomEvent<ThreadRevealDetail>).detail);

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
  reveals.length = 0;
  document.addEventListener(THREAD_REVEAL_EVENT, record);
});

afterEach(() => {
  cleanup();
  document.removeEventListener(THREAD_REVEAL_EVENT, record);
});

// The match may sit in a turn the virtual rows have not mounted: the find
// bar asks the thread to land on it instead of looking for it in the DOM.
test("the current match is handed to the thread, which mounts its turn when needed", () => {
  render(<I18nProvider><Harness /></I18nProvider>);
  act(() => {
    fireEvent.keyDown(window, { key: "f", metaKey: true });
  });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "voûte" } });
  expect(reveals).toEqual([{ targetId: "message:m-1", block: "center", behavior: "smooth" }]);
});
