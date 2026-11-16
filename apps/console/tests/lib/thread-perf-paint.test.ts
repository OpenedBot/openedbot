import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ThreadPerfProbe } from "../../src/lib/dev/thread-perf-probe";
import { createElement } from "react";
import { createPortal } from "react-dom";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "../../src/lib/i18n";
import { StreamThoughtsPanel } from "../../src/components/stream/stream-thoughts-panel";

let now = 1_000;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const raf = globalThis.requestAnimationFrame;
const cancelRaf = globalThis.cancelAnimationFrame;
let probe: ThreadPerfProbe;
let clock: ReturnType<typeof spyOn>;
let geometry: ReturnType<typeof spyOn>;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function frame(at: number) {
  now = at;
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(at);
}

function insertText(markup = '<p data-assistant-text data-y="10">Ça va !</p>', answer = true) {
  const root = document.createElement(answer ? "div" : "section");
  root.dataset.runId = "run";
  if (answer) root.dataset.assistantResponse = "";
  root.innerHTML = markup;
  document.querySelector("[data-thread-messages]")!.append(root);
  return root;
}

function marks() { return probe.getSnapshot().samples[0]!.run; }
function receive(accepted = true, at = 1_100) {
  now = at;
  if (accepted) probe.recordRunAccepted("run");
  probe.recordRunEvent("run", "agent.message");
}

beforeEach(() => {
  now = 1_000; nextFrame = 0; frames.clear();
  globalThis.requestAnimationFrame = (callback) => { const id = ++nextFrame; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  clock = spyOn(performance, "now").mockImplementation(() => now);
  // happy-dom has no layout engine: model text-line rectangles, leaving real
  // DOM mutations, visibility styles, observers and probe lifecycle intact.
  geometry = spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    const element = this.startContainer.parentElement?.closest<HTMLElement>("[data-y]");
    const top = Number(element?.dataset.y ?? 10);
    return [new DOMRect(10, top, 150, 20)] as unknown as DOMRectList;
  });
  document.body.innerHTML = '<main data-thread-messages></main><textarea data-composer></textarea>';
  probe = new ThreadPerfProbe(); probe.start();
  const composer = document.querySelector<HTMLTextAreaElement>("textarea")!;
  composer.value = "salut";
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  composer.value = "";
});

afterEach(() => {
  cleanup();
  probe.stop(); probe.reset(); frames.clear();
  globalThis.requestAnimationFrame = raf;
  globalThis.cancelAnimationFrame = cancelRaf;
  clock.mockRestore(); geometry.mockRestore(); document.body.innerHTML = "";
});

describe("reply paint observation", () => {
  test("the frame wait starts from nonempty DOM, not the earlier SSE event", async () => {
    receive(); frame(1_116); frame(1_132);
    expect(marks().firstPaintedTextMs).toBeNull();
    insertText(); await flush();
    frame(1_148); // observes the actual text
    frame(1_164);
    expect(marks().firstPaintedTextMs).toBeNull();
    frame(1_180);
    expect(marks().answerPaintedMs).toBe(180);
  });

  test("preserves a DOM paint that precedes the 202", async () => {
    receive(false); insertText(); await flush();
    frame(1_116); frame(1_132); frame(1_148);
    expect(marks().runId).toBeNull();
    now = 1_900; probe.recordRunAccepted("run");
    expect(marks().acceptedMs).toBe(900);
    expect(marks().firstPaintedTextMs).toBe(148);
    expect(marks().answerPaintedMs).toBe(148);
  });

  test("a retry after 10 s retains events and paints for the original logical request", async () => {
    probe.recordSendSubmission("same-key");
    now = 12_000;
    const composer = document.querySelector<HTMLTextAreaElement>("textarea")!;
    composer.value = "salut"; composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); composer.value = "";
    probe.recordSendSubmission("same-key");
    now = 12_100; probe.recordRunEvent("run", "agent.message"); insertText(); await flush();
    frame(12_116); frame(12_132); frame(12_148);
    now = 12_200; probe.recordRunAccepted("run", "same-key");
    expect(marks()).toMatchObject({ runId: "run", acceptedMs: 11_200, firstTextMs: 11_100, firstPaintedTextMs: 11_148 });
    expect(probe.getSnapshot().samples[1]!.run.runId).toBeNull();
  });

  test("bubble padding cannot substitute for visible text", async () => {
    receive(); insertText('<div data-assistant-layout><p data-assistant-text data-y="100000">Hidden text</p></div>'); await flush();
    frame(1_116); frame(1_132); frame(1_148);
    expect(marks().firstPaintedTextMs).toBeNull();
  });

  test("checks all activity rows and measures authorless assistant status", async () => {
    receive(); insertText('<p data-assistant-text data-y="-100">Clipped first</p><p data-feed-row="status" data-assistant-text data-y="10">Visible second</p>', false); await flush();
    frame(1_116); frame(1_132); frame(1_148);
    expect(marks().firstPaintedTextMs).toBe(148);
    expect(marks().answerPaintedMs).toBeNull();
  });

  test("observes the real Thoughts panel portalled outside the transcript", async () => {
    receive();
    const slot = document.createElement("aside"); document.body.append(slot);
    render(createElement(I18nProvider, null, createPortal(createElement(StreamThoughtsPanel, {
      runId: "run", items: [{ id: "n", kind: "status", text: "Portalled narration", assistantText: true }],
      speaker: null, onClose: () => {},
    }), slot)));
    expect(slot.querySelector('[data-run-id="run"] [data-assistant-text]')?.textContent).toBe("Portalled narration");
    expect(document.querySelector("[data-thread-messages]")!.contains(slot)).toBe(false);
    await flush(); frame(1_116); frame(1_132); frame(1_148);
    expect(marks().firstPaintedTextMs).toBe(148);
    expect(marks().answerPaintedMs).toBeNull();
  });

  test.each(["scroll", "resize", "visibilitychange"])("remeasures text revealed by %s without a child mutation", async (type) => {
    receive(); const root = insertText('<p data-assistant-text data-y="100000">Text</p>'); await flush();
    frame(1_116); frame(1_132); frame(1_148);
    root.querySelector<HTMLElement>("p")!.dataset.y = "10";
    // data-y only drives the fake layout; it isn't an observed attribute.
    if (type === "resize") window.dispatchEvent(new Event(type));
    else document.dispatchEvent(new Event(type));
    frame(1_200); frame(1_216); frame(1_232);
    expect(marks().firstPaintedTextMs).toBe(232);
  });

  test("rejects a hidden descendant, then observes its reveal", async () => {
    receive(); const root = insertText('<div data-assistant-text><span style="visibility:hidden" data-y="10">Hidden</span></div>'); await flush();
    frame(1_116); frame(1_132); frame(1_148);
    expect(marks().firstPaintedTextMs).toBeNull();
    root.querySelector<HTMLElement>("span")!.style.visibility = "visible"; await flush();
    frame(1_200); frame(1_216); frame(1_232);
    expect(marks().firstPaintedTextMs).toBe(232);
  });

  test("a replaced text node receives its own wait", async () => {
    receive(); const root = insertText(); await flush(); frame(1_116); frame(1_132);
    root.querySelector("p")!.textContent = "Different text"; await flush();
    frame(1_148);
    expect(marks().firstPaintedTextMs).toBeNull();
    frame(1_164); frame(1_180);
    expect(marks().firstPaintedTextMs).toBe(180);
  });

  test("reset cancels pending paints, and stop/restart rebinds the observer", async () => {
    receive(); insertText(); await flush(); frame(1_116);
    probe.reset(); frame(1_132); frame(1_148);
    expect(probe.getSnapshot().samples).toHaveLength(0);
    probe.stop(); probe.start();
    now = 2_000;
    const composer = document.querySelector<HTMLTextAreaElement>("textarea")!;
    composer.value = "salut"; composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); composer.value = "";
    receive(true, 2_100); await flush(); frame(2_200); frame(2_216); frame(2_232);
    expect(marks().firstPaintedTextMs).not.toBeNull();
  });

  test("navigation rebinds to a replacement thread without another send", async () => {
    receive();
    document.querySelector("main")!.remove();
    const next = document.createElement("main"); next.dataset.threadMessages = ""; document.body.append(next);
    insertText(); await flush(); frame(1_116); frame(1_132); frame(1_148);
    expect(marks().firstPaintedTextMs).toBe(148);
  });
});
