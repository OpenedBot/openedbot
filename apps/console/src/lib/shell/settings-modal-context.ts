import { createContext, useContext } from "react";

/**
 * Settings no longer open in a window since 02-11-2026 (operator
 * decision): always as a page of the frame. No modal provides this
 * context anymore, so `useSettingsModal()` returns `null`; it stays exported because
 * it is part of the modules' API (`pro-console/host.ts`), which an
 * already published module may still call.
 */
export type SettingsModalValue = {
  close: () => void;
  openAsPage?: () => void;
};

export const SettingsModalContext = createContext<SettingsModalValue | null>(null);

export function useSettingsModal(): SettingsModalValue | null {
  return useContext(SettingsModalContext);
}
