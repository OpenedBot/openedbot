import { useLayoutEffect } from "react";
import { create } from "zustand";

/**
 * Whether edit / regenerate is allowed for the open thread (run in progress, gate).
 * A store rather than a prop: a toggle re-renders only the subscribed message
 * shells (`MessageInteractionShell`), not every turn cached
 * by the thread (measured: 40 turns re-rendered at every run start and end).
 */
type ThreadEditAvailability = {
  canEdit: boolean;
  /** Why not, when the conversation cannot send: the sentence the composer gives. */
  reason: string | null;
  setCanEdit: (canEdit: boolean, reason?: string | null) => void;
};

export const useThreadEditAvailability = create<ThreadEditAvailability>()((set) => ({
  canEdit: true,
  reason: null,
  setCanEdit: (canEdit, reason = null) =>
    set((state) => (state.canEdit === canEdit && state.reason === reason ? state : { canEdit, reason })),
}));

/**
 * The thread publishes whether edit / regenerate is allowed, and why not;
 * leaving the thread allows it again.
 */
export function usePublishEditAvailability(canEdit: boolean, reason?: string): void {
  const setCanEdit = useThreadEditAvailability((state) => state.setCanEdit);
  useLayoutEffect(() => {
    setCanEdit(canEdit, reason);
    return () => setCanEdit(true);
  }, [canEdit, reason, setCanEdit]);
}
