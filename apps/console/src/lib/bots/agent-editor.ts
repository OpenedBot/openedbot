import { create } from "zustand";

/**
 * The « éditeur d'agent » panel to the right of the conversation (BoardUI
 * template). Closed on entry and when changing bots. Only the title pill or
 * an explicit edit action opens it; its close button hides it again.
 *
 * `botId` at `null` follows the open thread's bot. « Modifier le bot » from
 * another bot's row pins the panel on that one without leaving the current
 * thread, like the template; opening another thread releases it.
 */

/** Above 1100 px the editor shares the row; below that it overlays (measured on the target). */
export const EDITOR_INLINE_QUERY = "(min-width: 1100px)";

type AgentEditorState = {
  open: boolean;
  botId: string | null;
  show: (botId?: string | null) => void;
  toggle: () => void;
  close: () => void;
  release: () => void;
};

export const useAgentEditor = create<AgentEditorState>()((set, get) => ({
  open: false,
  botId: null,
  show: (botId = null) => {
    set({ open: true, botId });
  },
  toggle: () => {
    // Below 1100 px the panel overlays and starts closed: the pill opens it.
    if (typeof window !== "undefined" && !window.matchMedia(EDITOR_INLINE_QUERY).matches) {
      set({ open: true, botId: null });
      return;
    }
    const next = !(get().open && get().botId === null);
    set({ open: next, botId: null });
  },
  close: () => {
    set({ open: false, botId: null });
  },
  release: () => set({ open: false, botId: null }),
}));
