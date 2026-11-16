import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ThreadTimelineProps } from "../../components/thread-timeline-props";
import { readThreadScrollBox, type OutgoingUserInput } from "./thread-anchor";

/**
 * A turn sent from this console is keyed by its submission: its optimistic
 * bubble and the saved row that replaces it are ONE element, and so is the
 * status row of the run it opened (`activity:<turn key>`).
 */
export const sentTurnKey = (submissionId: string) => `turn:${submissionId}`;

/** React keys of the rows and run hosts that belong to a turn sent from this console. */
export function sentTurnKeys(inputs: ThreadTimelineProps["userInputs"]) {
  const byInput = new Map<string, string>();
  const byRun = new Map<string, string>();
  const submissions = new Set<string>();
  const openedRuns = new Set<string>();
  for (const input of inputs) {
    const submission = input.clientSubmissionId;
    // A repeated key (a replayed submission) keeps the plain keys: React keys must stay unique.
    const unique = Boolean(submission) && !submissions.has(submission!);
    if (unique) {
      submissions.add(submission!);
      byInput.set(input.id, sentTurnKey(submission!));
    }
    // Only the message that opened a run keys its row: a steered message joins a run already keyed.
    if (!input.runId || openedRuns.has(input.runId)) continue;
    openedRuns.add(input.runId);
    if (unique) byRun.set(input.runId, sentTurnKey(submission!));
  }
  return {
    row: (key: string) => byInput.get(key) ?? key,
    host: (runId: string) => `activity:${byRun.get(runId) ?? runId}`,
    /** The run's head line (the bot's name, then its summary), keyed like its host. */
    head: (runId: string) => `head:${byRun.get(runId) ?? runId}`,
  };
}

/**
 * How the thread follows its bottom (the same rule as assistant-ui's
 * viewport): it follows the stream only if the reader is ALREADY at the
 * bottom. Before, the forced scroll on every event stuck the thread back at
 * the bottom every 500 ms during a stream, even when scrolled up to reread
 * (measured).
 *
 * A sent message moves the thread ONCE: its bubble and its run's status row
 * are inserted in the same commit, and the thread lands at the bottom
 * before that commit paints. The reply then grows at the bottom, followed
 * by the ResizeObserver while the reader stays pinned.
 */
export function useThreadScrollFollow({
  scroller,
  content,
  threadKey,
  userInputs,
  outgoing,
  approvalCount,
  resnap,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  threadKey: string | null;
  userInputs: ThreadTimelineProps["userInputs"];
  outgoing: OutgoingUserInput | null;
  /** A new approval, or a resnap request, brings the reader back to the bottom. */
  approvalCount: number;
  resnap: ThreadTimelineProps["resnap"];
}) {
  const pinned = useRef(true);
  // Last box seen: `onScroll` compares in order to tell a gesture
  // (scrollTop ↓, stable heights: assistant-ui #4141) from an image that
  // decodes (scrollHeight ↑, the browser fires `scroll` and one let go).
  const scrollBox = useRef(readThreadScrollBox({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }));
  // Reactive reflection of `pinned`: the ref drives the scroll (every frame,
  // no re-render), the state drives only the « aller en bas » button
  // (like assistant-ui's `ThreadPrimitive.ScrollToBottom`): the two must
  // never be confused.
  const [atBottom, setAtBottom] = useState(true);
  const pinFrame = useRef<number | null>(null);
  const schedulePin = useCallback(() => {
    if (pinFrame.current !== null) return;
    pinFrame.current = requestAnimationFrame(() => {
      pinFrame.current = null;
      const node = scroller.current;
      if (node && pinned.current) node.scrollTop = node.scrollHeight;
    });
  }, [scroller]);
  useEffect(() => () => {
    // The ref survives remounting (StrictMode in dev): a cancelled frame id
    // left in place blocked `schedulePin` for the whole life of the thread.
    if (pinFrame.current !== null) cancelAnimationFrame(pinFrame.current);
    pinFrame.current = null;
  }, []);
  const pinToBottom = useCallback(() => {
    pinned.current = true;
    setAtBottom(true);
    schedulePin();
  }, [schedulePin]);

  const submissionKeys = useMemo(() => sentTurnKeys(userInputs), [userInputs]);
  const outgoingKey = outgoing ? sentTurnKey(outgoing.clientSubmissionId ?? outgoing.id) : null;
  const outgoingFailed = Boolean(outgoing?.failed);
  const lastUserInputId = userInputs[userInputs.length - 1]?.id ?? null;
  const lastUserInputByBot = Boolean(userInputs[userInputs.length - 1]?.authorBot);
  const sendSeen = useRef<{ thread: string | null; outgoingKey: string | null; inputId: string | null } | null>(null);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    pinned.current = true;
    setAtBottom(true);
    node.scrollTop = node.scrollHeight;
    scrollBox.current = readThreadScrollBox(node);
  }, [scroller, threadKey]);

  useEffect(() => {
    pinToBottom();
  }, [approvalCount, resnap, pinToBottom]);

  // A new optimistic bubble, or an operator message that arrived without one
  // (another device, an edit, the thread lab): the thread lands at the
  // bottom in this commit, before paint, whatever the reader was reading.
  useLayoutEffect(() => {
    const seen = sendSeen.current;
    sendSeen.current = { thread: threadKey, outgoingKey, inputId: lastUserInputId };
    // A thread's first render and a thread switch land at the bottom (above).
    if (!seen || seen.thread !== threadKey) return;
    const sent = outgoingKey !== null && outgoingKey !== seen.outgoingKey && !outgoingFailed;
    const arrived = lastUserInputId !== null && seen.inputId !== null && lastUserInputId !== seen.inputId && !lastUserInputByBot;
    if (!sent && !arrived) {
      if (outgoingKey !== seen.outgoingKey || lastUserInputId !== seen.inputId) pinToBottom();
      return;
    }
    const node = scroller.current;
    pinned.current = true;
    setAtBottom(true);
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    scrollBox.current = readThreadScrollBox(node);
  }, [scroller, threadKey, outgoingKey, outgoingFailed, lastUserInputId, lastUserInputByBot, pinToBottom]);

  useEffect(() => {
    // The ResizeObserver follows the bottom (pinned reader) IN its callback, before paint: deferred to rAF,
    // the thread painted one frame too high then jumped (the send's « bump »). `onScroll` rereads `scrollBox`.
    const contentNode = content.current;
    if (!contentNode || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      if (!entries.some((entry) => entry.target === contentNode)) return;
      const node = scroller.current;
      if (node && pinned.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(contentNode);
    return () => observer.disconnect();
  }, [content, scroller]);

  return { pinned, scrollBox, atBottom, setAtBottom, submissionKeys, outgoingKey };
}
