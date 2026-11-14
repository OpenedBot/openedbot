import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { joinsLiveText, lastRunSequence, type ThreadLiveText } from "../lib/stream/live-run-text";
import type { Entry } from "../lib/thread/thread-timeline-model";

const NO_SUBSCRIPTION = () => () => {};

/**
 * A reply in the thread. The one a run is still writing receives `live` and becomes
 * the only timeline entry subscribed to the text in progress
 * (`live-run-text.ts`): its fragments re-render it, it alone, without
 * going back through the snapshot, the timeline or the screen. `render` is the timeline's
 * entry render, applied to the full text: splitting off a
 * question, a transmission directive and an empty bubble are decided as if the
 * snapshot had everything.
 *
 * Every reply goes through this component, live or not: a
 * reply that stops being live thus keeps its tree (its smoothing, its
 * already parsed blocks) instead of being remounted. `live` is a prop, not a
 * context: the other replies, served by the timeline's cache, do not
 * re-render when the snapshot changes.
 */
export function LiveTimelineEntry({ entry, live, render }: {
  entry: Extract<Entry, { kind: "assistant" }>;
  live: ThreadLiveText | null;
  render: (entry: Entry) => ReactNode;
}): ReactNode {
  const store = live?.store ?? null;
  // The last event of this run in the rendered snapshot: the text beyond comes from the store.
  const events = live?.events;
  const after = useMemo(() => (events ? lastRunSequence(events, entry.runId) : -1), [events, entry.runId]);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(entry.runId, listener) ?? NO_SUBSCRIPTION(),
    [store, entry.runId],
  );
  const read = () => store?.textAfter(entry.runId, after) ?? "";
  const suffix = useSyncExternalStore(subscribe, read, read);
  // A `MEDIA:` tag straddling the snapshot and the suffix: the snapshot alone, until the next patch.
  return render(suffix && joinsLiveText(entry.text, suffix) ? { ...entry, text: entry.text + suffix } : entry);
}
