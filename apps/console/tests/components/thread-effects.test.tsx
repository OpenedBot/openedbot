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

  test("thinks while working, collapses to the worked line when the answer starts, then settles", () => {
    const { container, rerender } = render(view({ live: true }));
    const block = () => container.querySelector<HTMLElement>("[data-turn-activity]")!;
    const head = () => block().querySelector<HTMLButtonElement>("[data-activity-head]")!;
    expect(block().hasAttribute("data-thinking")).toBe(true);
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(head().querySelector("[data-thinking-elapsed]")).not.toBeNull();

    rerender(view({ live: true, answering: true }));
    expect(block().hasAttribute("data-thinking")).toBe(false);
    expect(head().querySelector("[data-thinking-status]")).toBeNull();
    expect(head().getAttribute("aria-expanded")).toBe("false");
    // The timer froze where the answer started (about 2 s of the run).
    expect(head().querySelector("[data-activity-summary]")?.textContent).toMatch(/^A travaillé 2\s?s$/);

    rerender(view({ live: false, workedMs: 6400 }));
    expect(head().querySelector("[data-activity-summary]")?.textContent).toMatch(/^A travaillé 6,4\s?s$/);
  });

  test("names the tool that is running, from its preview, instead of the generic status", () => {
    const running: ToolCall[] = [
      { tool: "web_search", done: true, preview: "old query" },
      { tool: "web_search", done: false, preview: "cours du bitcoin en euros" },
    ];
    const label = (container: HTMLElement) => container.querySelector("[data-turn-activity] [data-thinking-label]")?.textContent;
    const { container, rerender } = render(
      <I18nProvider>
        <TurnActivity calls={running} live since={Date.now()} forceOpen={false} author={null} showAuthorLabel={false}>
          <ActivityRow kind="thinking">log row</ActivityRow>
        </TurnActivity>
      </I18nProvider>,
    );
    expect(label(container)).toBe("Recherche : cours du bitcoin en euros");

    // Every tool closed: the model is thinking again, and the line says so.
    rerender(
      <I18nProvider>
        <TurnActivity calls={[{ tool: "web_search", done: true, preview: "x" }]} live since={Date.now()} forceOpen={false} author={null} showAuthorLabel={false}>
          <ActivityRow kind="thinking">log row</ActivityRow>
        </TurnActivity>
      </I18nProvider>,
    );
    // Not held: the 800 ms hold paces one tool label after another, but a
    // tool that ended returns to the generic line at once (086376fb).
    expect(label(container)).toBe("Réfléchit…");
  });

  test("a turn waiting on a decision stays open but does not animate as thinking", () => {
    const { container } = render(view({ live: true, waiting: true }));
    expect(container.querySelector("[data-turn-activity]")!.hasAttribute("data-thinking")).toBe(false);
    expect(container.querySelector("[data-thinking-status]")).toBeNull();
    expect(container.querySelector("[data-activity-head]")!.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("answer reveal", () => {
  const blocks = (container: HTMLElement) =>
    [...container.querySelectorAll("p, li")].map((node) => `${node.textContent}:${node.classList.contains("ohb-reveal")}`);

  test("only blocks born while streaming blur in; a settled answer carries no reveal class", () => {
    const settled = render(<ThreadMarkdown>{"Un.\n\nDeux."}</ThreadMarkdown>);
    expect(settled.container.querySelector(".ohb-reveal")).toBeNull();
    settled.unmount();

    // Mounted mid-stream with a block already there: that block does not replay.
    const midStream = render(<ThreadMarkdown streaming>{"Un."}</ThreadMarkdown>);
    expect(blocks(midStream.container)).toEqual(["Un.:false"]);
    midStream.rerender(<ThreadMarkdown streaming>{"Un.\n\nDeux."}</ThreadMarkdown>);
    expect(blocks(midStream.container)).toEqual(["Un.:false", "Deux.:true"]);
    // Ending the stream keeps the class on the revealed block (no cut animation);
    // a block that only the final flush brings is born in the same mount, so it reveals too.
    midStream.rerender(<ThreadMarkdown>{"Un.\n\nDeux.\n\nTrois."}</ThreadMarkdown>);
    expect(blocks(midStream.container)).toEqual(["Un.:false", "Deux.:true", "Trois.:true"]);
  });

  test("an answer that starts empty reveals every block, and a list reveals item by item", () => {
    const view = render(<ThreadMarkdown streaming>{""}</ThreadMarkdown>);
    view.rerender(<ThreadMarkdown streaming>{"Intro.\n\n- a\n- b"}</ThreadMarkdown>);
    expect(blocks(view.container)).toEqual(["Intro.:true", "a:true", "b:true"]);
    expect(view.container.querySelector("ul")!.classList.contains("ohb-reveal")).toBe(false);
  });

  test("the caret flips data-tick on every update so its blink restarts", () => {
    const view = render(<ThreadMarkdown streaming>{"Bon"}</ThreadMarkdown>);
    const tick = () => view.container.querySelector(".ohb-stream-caret")!.getAttribute("data-tick");
    const first = tick();
    view.rerender(<ThreadMarkdown streaming>{"Bonjour"}</ThreadMarkdown>);
    expect(tick()).not.toBe(first);
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
    const status = container.querySelector("[data-thread-thinking] [data-thinking-status]");
    expect(status).not.toBeNull();
    expect(container.querySelector("[data-thinking-elapsed]")!.textContent).toMatch(/^3,[0-9]\s?s$/);
  });

  test("a salon names the member whose turn it is while their run has no block yet", () => {
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
    expect(container.querySelector("[data-thread-thinking] [data-thinking-label]")!.textContent).toBe("Camille réfléchit…");
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
    expect(container.querySelector("[data-assistant-layout='bubble']")).not.toBeNull();
  });

  test("a finished answer has nothing under it, as in Grok Bot: no action row, no stopwatch", () => {
    const long = `${"Une réponse assez longue pour être confirmée. ".repeat(8)}`;
    const done = text(long);
    const live = render(timeline({ events: [done], runs: [runOf("running")], running: true }));
    live.rerender(timeline({ events: [done], runs: [runOf("completed")], running: false }));
    expect(live.container.querySelector("[data-message-actions-row]")).toBeNull();
    expect(live.container.querySelector("[data-message-hover-actions]")).toBeNull();
    expect(live.container.querySelector(".tabular-nums")).toBeNull();
  });
});

describe("prefers-reduced-motion", () => {
  test("the block reveal, the fade-up and the caret blink stop", () => {
    const reduced = reducedMotion(css("thread-timeline.css"));
    expect(reduced).toMatch(/\.ohb-reveal,\s*\.ohb-fade-up \{\s*animation: none;/);
    expect(reduced).toMatch(/\.ohb-stream-caret \{\s*animation: none;/);
  });

  test("the dots' pop-in and the guide draw stop", () => {
    // Grok Bot's typing dots never wave: only their pop-in moves.
    expect(css("agent-activity.css")).not.toMatch(/\.ohb-thinking-dots > i \{[^}]*animation/);
    expect(reducedMotion(css("thread-motion.css"))).toContain(".ohb-typing-enter .ohb-thinking-dots");
    expect(reducedMotion(css("agent-activity.css"))).toMatch(/\.ohb-activity-list \[data-activity-row\]::before \{\s*animation: none;/);
  });
});

describe("Grok Bot's thread theme", () => {
  const theme = css("thread-theme.css");
  const block = (selector: string) => {
    const start = theme.indexOf(`${selector} {`);
    return theme.slice(start, theme.indexOf("}", start));
  };

  test("the measured surfaces, light and dark", () => {
    expect(block(":root")).toContain("--ohb-thread-page: #fcfcfc;");
    expect(block(":root")).toContain("--ohb-bubble-agent: rgb(28 28 28 / 0.06);");
    expect(block(".dark")).toContain("--ohb-thread-page: #121212;");
    expect(block(".dark")).toContain("--ohb-bubble-agent: rgb(245 245 245 / 0.04);");
    expect(block(".dark [data-thread-column]")).toContain("--bui-background-primary-default: #1f1f1f;");
  });

  test("the operator's bubble is the bot's colour, darkened 12 % in light and 8 % in dark", () => {
    expect(block(":root")).toContain("--ohb-bubble-user-mix: 88%;");
    expect(block(".dark")).toContain("--ohb-bubble-user-mix: 92%;");
    expect(theme).toContain("color-mix(in srgb, var(--bot-tint) var(--ohb-bubble-user-mix), black)");
  });

  test("a bot without colour: the operator's bubble and send button are ink, as Grok Bot's grey bot", () => {
    expect(block(":root")).toContain("--ohb-bubble-user-neutral: #1c1c1c;");
    expect(block(":root")).toContain("--ohb-send-neutral: #1c1c1c;");
    expect(block(".dark")).toContain("--ohb-bubble-user-neutral: rgb(245 245 245 / 0.18);");
    expect(block(".dark")).toContain("--ohb-send-neutral: #f5f5f5;");
    expect(theme).toMatch(/\n\[data-user-bubble\] \{\s*background-color: var\(--ohb-bubble-user-neutral\);/);
  });

  test("a code block is Grok Bot's card: radius 14, mono 12/18", () => {
    expect(block("[data-code-block]")).toContain("border-radius: 14px;");
    expect(block("[data-code-block] > :is(.ohb-code, pre)")).toContain("line-height: 18px;");
  });

  test("a date is a plain centred line, not a pill", () => {
    const chip = block("[data-thread-date] .bui-date-chip");
    expect(chip).toContain("background: none;");
    expect(chip).toContain("font-size: 12px;");
  });
});
