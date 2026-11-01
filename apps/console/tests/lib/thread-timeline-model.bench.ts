/**
 * Coût d'un événement SSE sur un long fil : modèle complet (avant) contre
 * modèle incrémental (après), plus les lectures par tick du rendu
 * (signatures des entrées montées, splits ask_user / hand-off des bulles).
 *
 *   bun apps/console/tests/lib/thread-timeline-model.bench.ts
 *
 * Pas un test : des durées n'ont rien à faire dans `make test-unit`.
 */
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { splitAskUser } from "@openedbot/roster/domain/ask-user";
import { splitHandoff } from "@openedbot/roster/domain/bot-mode";
import {
  assistantTextParts,
  buildTimelineModel,
  createTimelineModelBuilder,
  type Entry,
  type TimelineModel,
  type TimelineModelInput,
} from "../../src/lib/thread-timeline-model";
import { THREAD_LIVE_TURN_WINDOW, windowTimelineEntries } from "../../src/lib/thread-window";
import { appendEvent, modelInput, threadFixture } from "./thread-timeline-fixture";

const DELTAS = 300;

function stats(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { median: at(0.5), p95: at(0.95) };
}

function deltas(input: TimelineModelInput): StoredProductEvent[] {
  const last = input.events.at(-1)!;
  return Array.from({ length: DELTAS }, (_, index) => ({
    ...last,
    cursor: last.cursor + index + 1,
    sequence: last.sequence + index + 1,
    type: "agent.message",
    payload: { text: `mot ${index} ` },
  }) as StoredProductEvent);
}

/** Les lectures du rendu à chaque tick, telles que `thread-timeline.tsx` les faisait avant. */
function renderReadsBefore(model: TimelineModel, input: TimelineModelInput) {
  const visible = windowTimelineEntries(model.shown, THREAD_LIVE_TURN_WINDOW).visible;
  for (const entry of visible) JSON.stringify(entry);
  for (const entry of model.shown) {
    if (entry.kind !== "assistant") continue;
    const split = splitAskUser(entry.text, { username: input.operatorUsername! });
    const shown = split.prompt ? split.body : entry.text;
    const notice = model.handoffNoticeByRun.get(entry.runId);
    if (notice) splitHandoff(shown, notice.target ? [...input.mentionables, notice.target] : input.mentionables);
  }
  for (const entry of visible) {
    if (entry.kind === "assistant") splitAskUser(entry.text, { username: input.operatorUsername! });
  }
}

const signatures = new WeakMap<Entry, string>();
function renderReadsAfter(model: TimelineModel, input: TimelineModelInput) {
  const visible = windowTimelineEntries(model.shown, THREAD_LIVE_TURN_WINDOW).visible;
  for (const entry of visible) {
    if (!signatures.has(entry)) signatures.set(entry, JSON.stringify(entry));
  }
  for (const entry of model.shown) {
    if (entry.kind !== "assistant") continue;
    assistantTextParts(entry, input.operatorUsername, model.handoffNoticeByRun.get(entry.runId) ?? null, input.mentionables);
  }
}

function bench(turns: number) {
  const base = modelInput(threadFixture({ turns }));
  const stream = deltas(base);

  const before: number[] = [];
  const beforeReads: number[] = [];
  let input = base;
  buildTimelineModel(input);
  for (const event of stream) {
    input = appendEvent(input, event);
    const start = performance.now();
    const model = buildTimelineModel(input);
    const built = performance.now();
    renderReadsBefore(model, input);
    beforeReads.push(performance.now() - built);
    before.push(built - start);
  }

  const after: number[] = [];
  const afterReads: number[] = [];
  const builder = createTimelineModelBuilder();
  input = base;
  renderReadsAfter(builder(input), input);
  for (const event of stream) {
    input = appendEvent(input, event);
    const start = performance.now();
    const model = builder(input);
    const built = performance.now();
    renderReadsAfter(model, input);
    afterReads.push(performance.now() - built);
    after.push(built - start);
  }

  const fmt = (value: number) => `${value.toFixed(3)} ms`;
  const row = (label: string, samples: number[]) => {
    const { median, p95 } = stats(samples);
    return `${label.padEnd(26)} median ${fmt(median).padStart(10)}  p95 ${fmt(p95).padStart(10)}`;
  };
  const model = buildTimelineModel(input);
  console.log(`\n${turns} tours, ${base.events.length} événements, ${model.shown.length} entrées, ${DELTAS} deltas`);
  console.log(row("modèle complet (avant)", before));
  console.log(row("modèle incrémental", after));
  console.log(row("lectures rendu (avant)", beforeReads));
  console.log(row("lectures rendu (après)", afterReads));
  const total = (a: number[], b: number[]) => a.map((value, index) => value + b[index]!);
  console.log(row("total par tick (avant)", total(before, beforeReads)));
  console.log(row("total par tick (après)", total(after, afterReads)));
}

// Échauffement JIT, puis un fil de la taille du fil Atlas (~1 300 événements)
// et un fil au plafond du snapshot (5 000 événements).
bench(20);
bench(80);
bench(300);
