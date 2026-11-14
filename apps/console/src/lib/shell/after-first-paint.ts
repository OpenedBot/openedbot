import { create } from "zustand";

/**
 * Secondary reads (inbox count, MCP plugin names, provider usage, model
 * context) wait for the conversation to be on screen: each of
 * their answers re-rendered the frame while the thread was still loading.
 *
 * `ThreadTimeline` opens the gate once its first messages are painted. Screens
 * without a thread open it after `FALLBACK_MS`, so nothing waits forever.
 */
const FALLBACK_MS = 1_500;

/** `performance.mark` set once, when the first thread messages are painted. */
export const THREAD_FIRST_PAINT_MARK = "openedbot:thread-first-paint";

type AfterFirstPaint = {
  ready: boolean;
  open: () => void;
};

export const useAfterFirstPaint = create<AfterFirstPaint>()((set) => ({
  ready: false,
  open: () => set((state) => (state.ready ? state : { ready: true })),
}));

if (typeof window !== "undefined") {
  window.setTimeout(() => useAfterFirstPaint.getState().open(), FALLBACK_MS);
}

export function useSecondaryReadsReady(): boolean {
  return useAfterFirstPaint((state) => state.ready);
}

export function openSecondaryReads(): void {
  useAfterFirstPaint.getState().open();
}
