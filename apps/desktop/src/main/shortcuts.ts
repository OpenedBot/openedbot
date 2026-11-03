import { globalShortcut } from "electron";
import { log } from "./log";

export const TOGGLE_ACCELERATOR = "CommandOrControl+Shift+O";

/** Registers the global show/hide shortcut. Returns false when another app already owns it. */
export function registerShortcuts(toggle: () => void): boolean {
  const ok = globalShortcut.register(TOGGLE_ACCELERATOR, toggle);
  // Not fatal: the tray icon still works. Windows gives the shortcut to whoever registered first.
  if (!ok) log.warn(`global shortcut ${TOGGLE_ACCELERATOR} is already taken by another application`);
  return ok;
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
