import { create } from "zustand";

/**
 * Desktop frame layout: where the account lives, and whether the shell has an icon
 * rail. Chosen in Réglages > Apparence, stored in this browser
 * (`localStorage`), like the theme. The mobile drawer ignores it.
 */
export type AccountLayout = "base" | "a" | "b" | "c";

export const ACCOUNT_LAYOUTS: readonly AccountLayout[] = ["base", "a", "b", "c"];
export const DEFAULT_ACCOUNT_LAYOUT: AccountLayout = "c";

const STORAGE_KEY = "openedbot:accountLayout";

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
    // The in-memory choice stays active if the browser refuses storage.
  }
  useAccountLayoutStore.setState({ layout: next });
}
