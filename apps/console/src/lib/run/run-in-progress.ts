import { useEffect } from "react";
import { create } from "zustand";

/**
 * Un run occupe-t-il le fil ouvert (bot ou groupe) ? Lu hors de l'écran de
 * conversation, par la mise à jour de la console : recharger pendant un run
 * couperait son flux SSE au milieu de la réponse. Les brouillons, eux,
 * survivent au rechargement (`workspace-draft` : texte en localStorage, pièces jointes en sessionStorage).
 */
type RunInProgress = {
  running: boolean;
  setRunning: (running: boolean) => void;
};

export const useRunInProgress = create<RunInProgress>()((set) => ({
  running: false,
  setRunning: (running) => set((state) => (state.running === running ? state : { running })),
}));

/** Publie l'état du fil ouvert ; le démontage de l'écran le remet à faux. */
export function usePublishRunInProgress(running: boolean): void {
  const setRunning = useRunInProgress((state) => state.setRunning);
  useEffect(() => {
    setRunning(running);
    return () => setRunning(false);
  }, [running, setRunning]);
}
