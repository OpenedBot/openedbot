import { create } from "zustand";

/**
 * Disposition du cadre sur bureau : où vit le compte, et si la coque a un rail
 * d'icônes. Choisie dans Réglages > Apparence, stockée dans ce navigateur
 * (`localStorage`), comme le thème. Le tiroir mobile l'ignore.
 */
export type AccountLayout = "base" | "a" | "b" | "c";

export const ACCOUNT_LAYOUTS: readonly AccountLayout[] = ["base", "a", "b", "c"];
export const DEFAULT_ACCOUNT_LAYOUT: AccountLayout = "c";

const STORAGE_KEY = "ohb:accountLayout";

function isAccountLayout(value: string | null): value is AccountLayout {
  return value !== null && ACCOUNT_LAYOUTS.includes(value as AccountLayout);
}

function readAccountLayout(): AccountLayout {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
    return isAccountLayout(value) ? value : DEFAULT_ACCOUNT_LAYOUT;
  } catch {
    return DEFAULT_ACCOUNT_LAYOUT;
  }
}

const useAccountLayoutStore = create<{ layout: AccountLayout }>()(() => ({
  layout: readAccountLayout(),
}));

export function useAccountLayout(): AccountLayout {
  return useAccountLayoutStore((state) => state.layout);
}

export function setAccountLayout(next: AccountLayout): void {
  if (!ACCOUNT_LAYOUTS.includes(next)) return;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // Le choix en mémoire reste actif si le navigateur refuse le stockage.
  }
  useAccountLayoutStore.setState({ layout: next });
}
