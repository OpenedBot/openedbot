import { createContext, useContext } from "react";

/**
 * La modale des réglages (`components/boardui/settings-modal.tsx`) se signale
 * à ce qu'elle contient. Module à part : les primitives des réglages le lisent
 * sans importer la modale, qui importe le cadre agence (cycle d'imports).
 */
export type SettingsModalValue = {
  close: () => void;
  /** Passe les réglages en page (et retient ce choix) ; absent quand la page n'existe pas. */
  openAsPage?: () => void;
};

export const SettingsModalContext = createContext<SettingsModalValue | null>(null);

/** Dans la modale, l'en-tête d'une rubrique devient celui du template (titre + croix). */
export function useSettingsModal(): SettingsModalValue | null {
  return useContext(SettingsModalContext);
}

/**
 * Les réglages en page (bureau, choix « Page » d'Apparence) : l'en-tête y porte
 * le retour en fenêtre. Absent dans la modale et sur téléphone.
 */
export type SettingsPageValue = { openAsWindow: () => void };

export const SettingsPageContext = createContext<SettingsPageValue | null>(null);

export function useSettingsPage(): SettingsPageValue | null {
  return useContext(SettingsPageContext);
}
