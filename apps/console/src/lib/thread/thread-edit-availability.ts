import { create } from "zustand";

/**
 * Whether edit / regenerate is allowed for the open thread (run in progress, gate).
 * A store rather than a prop: a toggle re-renders only the subscribed message
 * shells (`MessageInteractionShell`), not every turn cached
 * by the thread (measured: 40 turns re-rendered at every run start and end).
 */
type ThreadEditAvailability = {
  canEdit: boolean;
  setCanEdit: (canEdit: boolean) => void;
};

export const useThreadEditAvailability = create<ThreadEditAvailability>()((set) => ({
  canEdit: true,
  setCanEdit: (canEdit) => set((state) => (state.canEdit === canEdit ? state : { canEdit })),
}));
