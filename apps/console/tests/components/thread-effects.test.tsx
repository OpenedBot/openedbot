import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";
import { I18nProvider } from "../../src/lib/i18n";
import type { SpeechSynthesisAdapter } from "../../src/lib/voice/web-speech-synthesis";
import { ThreadTimeline } from "../../src/components/thread-timeline";
import { ThreadMarkdown } from "../../src/components/thread-markdown";
import { ActivityRow, TurnActivity } from "../../src/components/thread-turn-activity";
import { formatElapsed, ThinkingStatus } from "../../src/components/thread-thinking-status";

const css = (name: string) => readFileSync(new URL(`../../src/styles/components/${name}`, import.meta.url), "utf8");
const reducedMotion = (source: string) => source.slice(source.lastIndexOf("@media (prefers-reduced-motion: reduce)"));

const speechAdapter: SpeechSynthesisAdapter = {
  supported: false,
  voices: () => [],
  subscribeVoicesChanged: () => () => {},
  speak: () => {},
  cancel: () => {},
};

const fixedNumber = (value: number, options?: Intl.NumberFormatOptions) =>
  value.toLocaleString("fr-FR", options);

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(cleanup);

describe("thinking status", () => {
  test("formats the stopwatch: one decimal under a minute, m:ss after, never negative", () => {
    expect(formatElapsed(700, fixedNumber)).toMatch(/^0,7\s?s$/);
    expect(formatElapsed(12_340, fixedNumber)).toMatch(/^12,3\s?s$/);
    expect(formatElapsed(65_000, fixedNumber)).toBe("1:05");
    expect(formatElapsed(-500, fixedNumber)).toMatch(/^0,0\s?s$/);
  });

  test("counts from the run's real start and ticks every 100 ms", async () => {
    const { container } = render(
      <I18nProvider><ThinkingStatus since={Date.now() - 2000} /></I18nProvider>,
    );
    const elapsed = () => container.querySelector("[data-thinking-elapsed]")!.textContent!;
    expect(elapsed()).toMatch(/^2,[0-1]\s?s$/);
    const first = elapsed();
    await waitFor(() => expect(elapsed()).not.toBe(first), { timeout: 600 });
    expect(container.querySelector("[role='status']")).not.toBeNull();
    expect(container.querySelectorAll("[data-thinking-dots] > i")).toHaveLength(3);
  });
});

describe("live turn header", () => {
  const calls: ToolCall[] = [{ tool: "web_search", done: true, preview: "acme pricing" }];
  const view = (props: { live: boolean; answering?: boolean; waiting?: boolean; workedMs?: number | null }) => (
    <I18nProvider>
      <TurnActivity
        calls={calls}
        live={props.live}
        answering={props.answering}
        waiting={props.waiting}
        workedMs={props.workedMs}
        since={Date.now() - 2000}
        forceOpen={false}
        author={null}
        showAuthorLabel={false}
      >
        <ActivityRow kind="thinking">log row</ActivityRow>
      </TurnActivity>
    </I18nProvider>
  );

  test("thinks while working, reads « Réflexions » while the answer streams, then « Réflexion : Ns »", () => {
    const { container, rerender } = render(view({ live: true }));
    const block = () => container.querySelector<HTMLElement>("[data-turn-activity]")!;
    const head = () => block().querySelector<HTMLButtonElement>("[data-activity-head]")!;
    expect(block().hasAttribute("data-thinking")).toBe(true);
    expect(head().querySelector("[data-thinking-elapsed]")?.textContent).toBe("2s");

    rerender(view({ live: true, answering: true }));
    expect(block().hasAttribute("data-thinking")).toBe(false);
    expect(head().querySelector("[data-thinking-elapsed]")).toBeNull();
    expect(head().querySelector("[data-activity-summary]")?.textContent).toBe("Réflexions");

    rerender(view({ live: false, workedMs: 6400 }));
    expect(head().querySelector("[data-activity-summary]")?.textContent).toBe("Réflexion : 6s");
    expect(head().getAttribute("aria-expanded")).toBe("false");
  });

  test("a turn waiting on a decision opens its log and does not roll the feed", () => {
    const { container } = render(view({ live: true, waiting: true }));
    expect(container.querySelector("[data-turn-activity]")!.hasAttribute("data-thinking")).toBe(false);
    expect(container.querySelector("[data-turn-activity] > [data-open]")!.getAttribute("data-open")).toBe("true");
  });
});

describe("answer stream words", () => {
  const words = (container: HTMLElement) => [...container.querySelectorAll(".grok-w")].map((node) => node.textContent);

  test("only blocks the stream writes carry word spans; a settled answer carries none", () => {
    const settled = render(<ThreadMarkdown>{"Un.\n\nDeux."}</ThreadMarkdown>);
    expect(settled.container.querySelector(".grok-w")).toBeNull();
    settled.unmount();

    // Mounted mid-stream with a block already there: only the block being written is wrapped.
    const midStream = render(<ThreadMarkdown streaming>{"Un deux.\n\nTrois"}</ThreadMarkdown>);
    expect(words(midStream.container)).toEqual(["Trois"]);
    midStream.rerender(<ThreadMarkdown streaming>{"Un deux.\n\nTrois quatre.\n\nCinq"}</ThreadMarkdown>);
    expect(words(midStream.container)).toEqual(["Cinq"]);
    // Ending the stream keeps the spans of a block it wrote: its last words finish their blur.
    midStream.rerender(<ThreadMarkdown>{"Un deux.\n\nTrois quatre.\n\nCinq six."}</ThreadMarkdown>);
    expect(words(midStream.container)).toEqual(["Cinq ", "six."]);
  });

  test("a word already on screen keeps its node as the stream grows: only new words blur in", () => {
    const view = render(<ThreadMarkdown streaming>{""}</ThreadMarkdown>);
    view.rerender(<ThreadMarkdown streaming>{"Bonjour à"}</ThreadMarkdown>);
    const first = view.container.querySelector(".grok-w")!;
    view.rerender(<ThreadMarkdown streaming>{"Bonjour à tous, voici"}</ThreadMarkdown>);
    expect(view.container.querySelector(".grok-w")).toBe(first);
    expect(words(view.container)).toEqual(["Bonjour ", "à ", "tous, ", "voici"]);
    expect(view.container.querySelector(".ohb-stream-caret, .ohb-stream-tail")).toBeNull();
  });

  test("a streamed lead title still reads as a title", () => {
    const view = render(<ThreadMarkdown streaming>{""}</ThreadMarkdown>);
    view.rerender(<ThreadMarkdown streaming>{"Ce qui tient\nLa suite arrive"}</ThreadMarkdown>);
    expect(view.container.querySelector("[data-lead-title]")?.textContent).toBe("Ce qui tient");
    view.rerender(<ThreadMarkdown streaming>{"Prix : dix euros"}</ThreadMarkdown>);
    expect(view.container.querySelector("[data-lead-label]")?.textContent).toBe("Prix");
    expect(view.container.querySelector("p")!.textContent).toBe("Prix : dix euros");
  });
});


describe("thread timeline status and action row", () => {
  function timeline(props: { events: StoredProductEvent[]; runs: Array<Pick<RunDto, "id" | "status" | "completionKind" | "stepKind" | "createdAt">>; running: boolean }) {
    return (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider>
          <ThreadTimeline
            events={props.events}
            userInputs={[{ id: "m1", text: "Bonjour", runId: "run-1" }]}
            runs={props.runs}
            approvals={[]}
            running={props.running}
            speechAdapter={speechAdapter}
            defaultAuthor={null}
          />
        </I18nProvider>
      </QueryClientProvider>
    );
  }
  const runOf = (status: RunDto["status"]) => ({
    id: "run-1",
    status,
    completionKind: null,
    stepKind: null,
    createdAt: new Date(Date.now() - 3000).toISOString(),
  });
  const text = (value: string): StoredProductEvent => ({
    cursor: 1,
    sequence: 1,
    runId: "run-1",
    type: "agent.message",
    payload: { text: value },
    occurredAt: new Date(),
  });

  test("a queued run shows the thinking status before any step, counting from the run's start", () => {
    const { container } = render(timeline({ events: [], runs: [runOf("queued")], running: true }));
    const status = container.querySelector("[data-thread-thinking][data-thinking-status]");
    expect(status).not.toBeNull();
    expect(container.querySelector("[data-thinking-elapsed]")!.textContent).toMatch(/^3s$/);
  });

  test("a salon marks the member whose turn it is while their run has no block yet", () => {
    const camille = { id: "bot-camille", name: "Camille", slug: "camille", face: null };
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider>
          <ThreadTimeline
            events={[]}
            userInputs={[{ id: "m1", text: "Bonjour", runId: "run-1" }]}
            runs={[runOf("queued")]}
            approvals={[]}
            running
            speechAdapter={speechAdapter}
            runAuthors={new Map([["run-1", camille]])}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(container.querySelector("[data-thread-thinking]")!.getAttribute("data-author")).toBe("bot-camille");
  });

  test("a salon keeps the live block of a member still working after another member's run closed", () => {
    const event = (cursor: number, runId: string, type: StoredProductEvent["type"], payload: StoredProductEvent["payload"]): StoredProductEvent => ({
      cursor, sequence: cursor, runId, type, payload, occurredAt: new Date(),
    });
    const call = (cursor: number, runId: string): StoredProductEvent =>
      event(cursor, runId, "tool.call", { tool: "web_search", callId: `${runId}-call`, preview: "acme pricing" });
    const { container } = render(timeline({
      events: [call(1, "run-1"), call(2, "run-2"), event(3, "run-1", "run.completed", {})],
      runs: [{ ...runOf("completed"), id: "run-1" }, { ...runOf("running"), id: "run-2" }],
      running: true,
    }));
    expect(container.querySelector("[data-turn-activity][data-live]")).not.toBeNull();
  });

  test("the status gives way once the answer has text", () => {
    const long = `${"Une réponse assez longue pour être confirmée. ".repeat(8)}`;
    const { container } = render(timeline({ events: [text(long)], runs: [runOf("running")], running: true }));
    expect(container.querySelector("[data-thread-thinking]")).toBeNull();
    expect(container.querySelector("[data-assistant-layout='grok']")).not.toBeNull();
  });

  test("a finished answer carries grok's action row, risen in once; no stopwatch", () => {
    const long = `${"Une réponse assez longue pour être confirmée. ".repeat(8)}`;
    const done = text(long);
    const live = render(timeline({ events: [done], runs: [runOf("running")], running: true }));
    expect(live.container.querySelector("[data-message-actions-placement='below']")).toBeNull();
    live.rerender(timeline({ events: [done], runs: [runOf("completed")], running: false }));
    const row = live.container.querySelector("[data-message-actions-placement='below']");
    expect(row).not.toBeNull();
    expect(row!.className).toContain("opacity-100");
    expect(row!.className).toContain("grok-enter");
    expect(row!.querySelector("button[aria-label]")).not.toBeNull();
    expect(live.container.querySelector("[data-run-timing]")).toBeNull();
  });
});

describe("prefers-reduced-motion", () => {
  test("the block reveal, the fade-up and the caret blink stop", () => {
    const reduced = reducedMotion(css("thread-timeline.css"));
    expect(reduced).toMatch(/\.ohb-reveal,\s*\.ohb-fade-up \{\s*animation: none;/);
    expect(reduced).toMatch(/\.ohb-stream-caret \{\s*animation: none;/);
  });

  test("every grok.com motion stops: words, feed, dots, shimmer, pop", () => {
    const reduced = reducedMotion(css("grok-motion.css"));
    for (const name of [".grok-w", ".grok-feed-in", ".grok-feed-out", ".grok-dot", ".grok-shimmer", ".grok-pop", ".grok-enter"]) {
      expect(reduced).toContain(`${name},`);
    }
    expect(reduced).toContain("animation: none !important;");
  });

  test("the dots' pop-in and the guide draw stop", () => {
    // Grok Bot's typing dots never wave: only their pop-in moves.
    expect(css("agent-activity.css")).not.toMatch(/\.ohb-thinking-dots > i \{[^}]*animation/);
    expect(reducedMotion(css("thread-motion.css"))).toContain(".ohb-typing-enter .ohb-thinking-dots");
    expect(reducedMotion(css("agent-activity.css"))).toMatch(/\.ohb-activity-list \[data-activity-row\]::before \{\s*animation: none;/);
  });
});

describe("grok.com's thread theme", () => {
  const theme = css("thread-theme.css");
  const block = (selector: string) => {
    const start = theme.indexOf(`${selector} {`);
    return theme.slice(start, theme.indexOf("}", start));
  };

  test("grok.com's dark tokens, and their light transposition", () => {
    expect(block(".dark")).toContain("--grok-base: #131211;");
    expect(block(".dark")).toContain("--grok-raised: #201f1d;");
    expect(block(".dark")).toContain("--grok-fg: #fcfcfc;");
    expect(block(".dark")).toContain("--grok-fg2: #9e9e9e;");
    expect(block(":root")).toContain("--grok-base: #ffffff;");
    expect(block(":root")).toContain("--grok-blue: #299fff;");
  });

  test("the answer has no bubble: 15/22.5, headings 20/28 at 550, blocks 15 px apart", () => {
    expect(block('[data-assistant-layout="grok"] .prose')).toContain("line-height: 22.5px;");
    expect(block('[data-assistant-layout="grok"] .prose :is(h1, h2, h3, h4, h5, h6)')).toContain("font-weight: 550;");
    expect(block('[data-assistant-layout="grok"] .prose > * + *')).toContain("margin-top: 15px;");
    expect(block('[data-assistant-layout="grok"] [data-md-table]')).toContain("border-radius: 16px;");
  });

  test("the bubbles are Grok Bot's: agent veil, user ink or the bot's fill, per theme", () => {
    expect(theme).toContain("--ohb-bubble-agent: rgb(28 28 28 / 0.06);");
    expect(theme).toContain("--ohb-bubble-agent: rgb(245 245 245 / 0.04);");
    expect(theme).toContain("--ohb-bubble-user: #1c1c1c;");
    expect(theme).toContain("--ohb-bubble-user: rgb(245 245 245 / 0.18);");
    expect(theme).toMatch(/\[data-assistant-layout="grok"\] \{\s*background-color: var\(--ohb-bubble-agent\);/);
    expect(theme).toMatch(/\n\[data-user-bubble\] \{\s*background-color: var\(--ohb-user-fill, var\(--ohb-bubble-user\)\);/);
    expect(theme).toMatch(/\.dark \[data-thread-column\] \{\s*--ohb-user-fill: var\(--ohb-user-fill-dark\);/);
  });

  test("inline code is Grok Bot's in both themes: the text's ink on a 4 % / 2 % veil", () => {
    expect(theme).toContain("--ohb-code-inline: rgb(28 28 28 / 0.04);");
    expect(theme).toContain("--ohb-code-inline: rgb(245 245 245 / 0.02);");
    expect(theme).toMatch(/\.prose :not\(pre\) > code \{\s*color: inherit;\s*background-color: var\(--ohb-code-inline\);/);
    // Typography's inks follow the thread tokens, never its light-only defaults.
    expect(theme).toContain("--tw-prose-code: var(--grok-fg);");
  });

  test("the composer is grok's: radius 24, 16/28 field, blue send that pops, a quiet disabled send when empty", () => {
    expect(theme).toContain("border-radius: 24px;");
    expect(theme).toContain("line-height: 28px;");
    expect(theme).toContain("background: var(--grok-blue);");
    expect(theme).toContain("animation: grok-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both;");
    expect(theme).toContain("[data-composer-send-action]:disabled {");
    expect(theme).not.toContain("data-composer-voice");
    expect(theme).not.toContain("data-voice-mode");
  });

  test("a date is a plain centred line, not a pill", () => {
    const chip = block("[data-thread-date] .bui-date-chip");
    expect(chip).toContain("background: none;");
    expect(chip).toContain("font-size: 13px;");
  });
});
