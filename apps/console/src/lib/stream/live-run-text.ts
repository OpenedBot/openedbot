import type { StoredProductEvent } from "@openedbot/contracts-events";
import { eventText, rendersNothing } from "@/lib/thread/thread-event-text";
import { LIVE_NARRATION_MAX } from "./live-answer";

/**
 * The text of an answer being written, held OUTSIDE the thread cache
 * (D1c, the streaming smoothness step).
 *
 * Every `agent.message` fragment patched into the thread snapshot re-rendered
 * the whole conversation screen: the header, the sidebar (the roster
 * moves with it), the timeline and its model, several O(n) passes over the
 * thread's events. While a confirmed answer grows, its
 * fragments are therefore held by `useThreadStream` (`LiveTextHold`); only
 * that answer's bubble subscribes to this store (`LiveTimelineEntry`). The
 * snapshot receives them all, in stream order, at the latest
 * `LIVE_TEXT_COMMIT_MS` later, or before any other event.
 *
 * The store copies the text of EVERY run of the open thread, held or not, with
 * its cuts (a tool call, a notice…). The bubble displays `its text
 * in the snapshot + the run's text after that run's last event
 * in this snapshot, up to the first cut`: exactly what the
 * timeline model would add there. The marker is the run's `sequence`, not
 * the cursor: text fragments arrive before their commit, without a
 * cursor (`api-client.ts`), and do not advance the snapshot's. The
 * pair comes from one render, and the store is always ahead of the
 * snapshot (it is fed before the patch): even a bubble re-rendered by the
 * store with the props of an older snapshot shows the right text, with no
 * duplicate and no step back.
 */

/** The open thread's store and the events of the snapshot rendered with it: what `LiveTimelineEntry` reads. */
export type ThreadLiveText = { store: LiveRunText; events: readonly StoredProductEvent[] };

/** At most this delay between two snapshot patches during an answer. */
export const LIVE_TEXT_COMMIT_MS = 1_000;

/** The runs kept (a room writes several at once); the oldest are forgotten. */
const KEPT_RUNS = 4;

/** A `MEDIA:` tag changes the rendered text (`withoutMediaLines`): it cuts. */
const MEDIA_TAG = "MEDIA:";

type RunText = {
  sequences: number[];
  texts: string[];
  /** Cut sequences, increasing. */
  breaks: number[];
  /** The end of the copied text, to see a tag split across two fragments. */
  tail: string;
  listeners: Set<() => void>;
  cache: { after: number; length: number; breaks: number; text: string } | null;
};

export type LiveRunText = {
  /**
   * The run's text after its `after` sequence (its last event in the
   * snapshot the caller displays, `lastRunSequence`), up to the first
   * cut.
   */
  textAfter(runId: string, after: number): string;
  subscribe(runId: string, listener: () => void): () => void;
  /** Stream side: an event of the open thread, in stream order, without notifying. */
  record(event: StoredProductEvent): void;
  /** Notifies the subscribers of the runs that received text since the last call. */
  publish(): void;
};

export function createLiveRunText(): LiveRunText {
  const runs = new Map<string, RunText>();
  const touched = new Set<string>();
  const runText = (runId: string): RunText => {
    let run = runs.get(runId);
    if (run) return run;
    run = { sequences: [], texts: [], breaks: [], tail: "", listeners: new Set(), cache: null };
    runs.set(runId, run);
    // Forgetting a run removes nothing from a bubble that still shows it: it
    // receives nothing more, therefore no more notification, and its next render
    // will come from a snapshot that already contains all of its text.
    for (const id of runs.keys()) {
      if (runs.size <= KEPT_RUNS) break;
      if (runs.get(id)!.listeners.size === 0) runs.delete(id);
    }
    return run;
  };
  const cut = (run: RunText, sequence: number) => {
    if (sequence > (run.breaks.at(-1) ?? Number.NEGATIVE_INFINITY)) run.breaks.push(sequence);
    run.tail = "";
  };
  return {
    textAfter(runId, after) {
      const run = runs.get(runId);
      if (!run || run.sequences.length === 0) return "";
      const cached = run.cache;
      if (cached && cached.after === after && cached.length === run.sequences.length && cached.breaks === run.breaks.length) {
        return cached.text;
      }
      const limit = run.breaks.find((at) => at > after) ?? Number.POSITIVE_INFINITY;
      const parts: string[] = [];
      for (let index = run.sequences.length - 1; index >= 0 && run.sequences[index]! > after; index -= 1) {
        if (run.sequences[index]! < limit) parts.push(run.texts[index]!);
      }
      const text = parts.reverse().join("");
      run.cache = { after, length: run.sequences.length, breaks: run.breaks.length, text };
      return text;
    },
    subscribe(runId, listener) {
      const run = runText(runId);
      run.listeners.add(listener);
      return () => run.listeners.delete(listener);
    },
    record(event) {
      const run = runText(event.runId);
      const sequence = event.sequence;
      // A sequence already seen (replay) or unreadable teaches the store nothing.
      if (!Number.isSafeInteger(sequence) || sequence <= Math.max(run.sequences.at(-1) ?? -1, run.breaks.at(-1) ?? -1)) return;
      if (event.type === "agent.message") {
        const text = eventText(event);
        if (`${run.tail}${text}`.includes(MEDIA_TAG)) return cut(run, sequence);
        run.sequences.push(sequence);
        run.texts.push(text);
        run.tail = `${run.tail}${text}`.slice(-(MEDIA_TAG.length - 1));
        touched.add(event.runId);
        return;
      }
      // Events with no render do not cut the bubble (`mergeTimelineEntries`),
      // except those that can change its text or its place: a notice
      // (a room « pass » hides the run), an approval request.
      if (rendersNothing(event) && event.type !== "system.notice" && event.type !== "approval.requested") return;
      cut(run, sequence);
    },
    publish() {
      for (const runId of touched) for (const listener of runs.get(runId)?.listeners ?? []) listener();
      touched.clear();
    },
  };
}

/** The sequence of the run's last event in `events` (-1: none). */
export function lastRunSequence(events: readonly StoredProductEvent[], runId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.runId === runId) return events[index]!.sequence;
  }
  return -1;
}

/**
 * Can the `event` fragment OPEN a hold, given the thread snapshot?
 *
 * Only when the end of the thread is already this run's confirmed answer: the
 * last event is an `agent.message` of the same run, and the text the
 * timeline model merges with it (`mergeTimelineEntries`: its
 * fragments, over the events with no render) exceeds
 * `LIVE_NARRATION_MAX`. The suffix is then added to a bubble that stays the
 * answer: nothing the timeline decides about this text (narration or
 * answer, activity block, empty bubble) can change with it. Only the
 * length counts, not the shape (`isConfirmedLiveAnswer`): the text
 * walked here can be shorter than the model's, never longer,
 * and a shape read on a suffix could lie.
 *
 * Refused when in doubt: a notice of the run (a room « pass » hides all of
 * its text), an approval request (it cuts the bubble when it is
 * open), a `MEDIA:` tag in the text.
 */
export function canStartLiveText(events: readonly StoredProductEvent[], event: StoredProductEvent): boolean {
  return liveTextBubble(events, event) !== null;
}

/** The text of the bubble `event` would extend, or `null` if it cannot open a hold. */
function liveTextBubble(events: readonly StoredProductEvent[], event: StoredProductEvent): string | null {
  const last = events.at(-1);
  if (last?.type !== "agent.message" || last.runId !== event.runId) return null;
  const parts: string[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index]!;
    if (candidate.runId !== event.runId) continue;
    if (candidate.type === "agent.message") {
      parts.push(eventText(candidate));
      continue;
    }
    if (candidate.type === "system.notice" || candidate.type === "approval.requested") return null;
    if (!rendersNothing(candidate)) break;
  }
  const text = parts.reverse().join("");
  if (`${text}${eventText(event)}`.includes(MEDIA_TAG)) return null;
  return text.trim().length > LIVE_NARRATION_MAX ? text : null;
}

/**
 * Can the suffix be added as-is to the displayed text? No if a
 * `MEDIA:` tag forms at the junction (« …MED » + « IA:/… »): the snapshot will
 * handle it (`withoutMediaLines`), the raw suffix would display it.
 */
export function joinsLiveText(text: string, suffix: string): boolean {
  return !`${text.slice(-(MEDIA_TAG.length - 1))}${suffix}`.includes(MEDIA_TAG);
}

/**
 * The hold on the stream side: the `agent.message` fragments that `useThreadStream`
 * does not yet patch into the snapshot. They always form the end of the thread's
 * stream, of a single run: any other event first makes them release
 * (`release`), so that the snapshot receives them in the exact stream order.
 */
export type LiveTextHold = {
  /**
   * Holds `event`, an event of the open thread (true); false if the caller
   * must release the hold and then apply it.
   */
  offer(event: StoredProductEvent, snapshot: { events: readonly StoredProductEvent[] } | undefined): boolean;
  /** The held fragments, in order; the hold empties. */
  release(): StoredProductEvent[];
  /** Milliseconds before the hold is due (0: due), `null` if it is empty. */
  dueIn(now: number): number | null;
};

export function createLiveTextHold(clock: () => number): LiveTextHold {
  let held: StoredProductEvent[] = [];
  let tail = "";
  let since = 0;
  return {
    offer(event, snapshot) {
      if (event.type !== "agent.message" || !snapshot || !Number.isSafeInteger(event.sequence)) return false;
      const text = eventText(event);
      const first = held[0];
      if (first) {
        // A reread snapshot that already covers the hold: it releases (the
        // duplicates are dropped at the patch) and everything starts again from that snapshot.
        if (first.runId !== event.runId || `${tail}${text}`.includes(MEDIA_TAG)) return false;
        if (lastRunSequence(snapshot.events, event.runId) >= first.sequence) return false;
      } else {
        if (event.sequence <= lastRunSequence(snapshot.events, event.runId)) return false;
        const bubble = liveTextBubble(snapshot.events, event);
        if (bubble === null) return false;
        since = clock();
        // The end of the bubble counts: a tag can start in the snapshot.
        tail = bubble.slice(-(MEDIA_TAG.length - 1));
      }
      held.push(event);
      tail = `${tail}${text}`.slice(-(MEDIA_TAG.length - 1));
      return true;
    },
    release() {
      const released = held;
      held = [];
      tail = "";
      return released;
    },
    dueIn(now) {
      return held.length === 0 ? null : Math.max(0, since + LIVE_TEXT_COMMIT_MS - now);
    },
  };
}
