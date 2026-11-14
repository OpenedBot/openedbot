import { useEffect } from "react";
import { create } from "zustand";

/**
 * Does a run occupy the open thread (bot or group)? Read outside the conversation
 * screen, by the console update: reloading during a run
 * would cut its SSE stream in the middle of the answer. Drafts, by contrast,
 * survive a reload (`workspace-draft`: text in localStorage, attachments in sessionStorage).
 */
type RunInProgress = {
  running: boolean;
  setRunning: (running: boolean) => void;
};

export const useRunInProgress = create<RunInProgress>()((set) => ({
  running: false,
  setRunning: (running) => set((state) => (state.running === running ? state : { running })),
}));

/** Publishes the open thread's state; unmounting the screen sets it back to false. */
export function usePublishRunInProgress(running: boolean): void {
  const setRunning = useRunInProgress((state) => state.setRunning);
  useEffect(() => {
    setRunning(running);
    return () => setRunning(false);
  }, [running, setRunning]);
}
