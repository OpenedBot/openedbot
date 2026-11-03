import { create } from "zustand";

/**
 * Éditer / régénérer permis ou non pour le fil ouvert (run en cours, gate).
 * Un store plutôt qu'une prop : une bascule ne re-rend que les coques de
 * message abonnées (`MessageInteractionShell`), pas chaque tour mis en cache
 * par le fil (OHB-88 : 40 tours re-rendus à chaque début et fin de run).
 */
type ThreadEditAvailability = {
  canEdit: boolean;
  setCanEdit: (canEdit: boolean) => void;
};

export const useThreadEditAvailability = create<ThreadEditAvailability>()((set) => ({
  canEdit: true,
  setCanEdit: (canEdit) => set((state) => (state.canEdit === canEdit ? state : { canEdit })),
}));
