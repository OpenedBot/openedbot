import { createContext, useContext } from "react";

/**
 * Les réglages ne s'ouvrent plus en fenêtre depuis le 02-11-2026 (décision
 * opérateur) : toujours en page du cadre. Aucune modale ne fournit plus ce
 * contexte, `useSettingsModal()` rend donc `null` ; il reste exporté parce
 * qu'il fait partie de l'API des modules (`pro-console/host.ts`), qu'un
 * module déjà publié peut encore appeler.
 */
export type SettingsModalValue = {
  close: () => void;
  openAsPage?: () => void;
};

export const SettingsModalContext = createContext<SettingsModalValue | null>(null);

export function useSettingsModal(): SettingsModalValue | null {
  return useContext(SettingsModalContext);
}
