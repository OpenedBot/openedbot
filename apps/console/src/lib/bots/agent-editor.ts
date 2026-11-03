import { create } from "zustand";

/**
 * Le panneau « éditeur d'agent » à droite de la conversation (template
 * BoardUI). Closed on entry and when changing bots. Only the title pill or
 * an explicit edit action opens it; its close button hides it again.
 *
 * `botId` à `null` suit le bot du fil ouvert. « Modifier le bot » depuis la
 * ligne d'un AUTRE bot épingle le panneau sur celui-là sans quitter le fil
 * courant, comme le template ; ouvrir un autre fil le relâche.
 */

/** Au-dessus de 1100 px l'éditeur partage la rangée ; en dessous il se superpose (mesuré sur la cible). */
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
    // Sous 1100 px le panneau se superpose et part fermé : la pilule l'ouvre.
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
