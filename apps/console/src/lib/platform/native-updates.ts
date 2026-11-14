import { useSyncExternalStore } from "react";
import type { UpdateErrorCode, UpdateMenuAction, UpdatePhase, UpdateRequirement, UpdateState } from "@openedbot/contracts-native-bridge";
import { nativeBridge } from "./native-bridge";

/**
 * The Tauri desktop app's update, as the shell drives it
 * (`apps/desktop-tauri/src-tauri/src/update_engine.rs`): the console only
 * shows it (chip, account-menu row, Settings › Updates,
 * « mise à jour requise » screen) and forwards the user's
 * consent. Outside the Tauri app, nothing: the bridge has no `updates`, and
 * the web build drops this code at compile time (`VITE_OPENEDBOT_SHELL`).
 */
export type NativeUpdateState = UpdateState;
export type NativeUpdatePhase = UpdatePhase;
export type NativeUpdateRequirement = UpdateRequirement;
export type NativeUpdateErrorCode = UpdateErrorCode;

export type NativeUpdatesBridge = {
  /** Receives the last known state at once, then each change; returns the unsubscribe. */
  onState(listener: (state: NativeUpdateState) => void): () => void;
  check(): Promise<void>;
  /**
   * The consent: install `version`, the one the user saw. The
   * shell restarts if it is still offered; otherwise a named error
   * (`UPDATE_SUPERSEDED`, `UPDATE_WITHDRAWN`, `UPDATE_FEED_UNREACHABLE`…).
   */
  install(version: string): Promise<void>;
  /** The API's 426: the shell switches to « requise » and queries the feed. */
  reportRequired(minimum: string | null): Promise<void>;
  /** The in-flight runs seen by the console, `null` if it cannot say: an install at rest waits for a known zero. */
  reportRuns(count: number | null): Promise<void>;
  setAutoInstall(enabled: boolean): Promise<void>;
  /** The app menu's « Rechercher des mises à jour… » item. */
  onMenu(listener: (action: UpdateMenuAction) => void): () => void;
};

/**
 * True in the Tauri desktop build only. Constant at build time: the mount
 * points (`components/desktop-update/entry.ts`) test it, and the web
 * build drops the components and their chunks.
 */
export const DESKTOP_UPDATES = import.meta.env.VITE_OPENEDBOT_SHELL === "tauri";

/** The updates bridge, if it exists (Tauri shell); the components mounted behind `DESKTOP_UPDATES` read it. */
export function nativeUpdates(): NativeUpdatesBridge | null {
  return nativeBridge()?.updates ?? null;
}

let current: NativeUpdateState | null = null;
let unsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!unsubscribe) {
    const updates = nativeUpdates();
    if (updates) {
      unsubscribe = updates.onState((state) => {
        current = state;
        for (const notify of listeners) notify();
      });
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The update state, `null` outside the Tauri app or before the shell's first response. */
export function useNativeUpdateState(): NativeUpdateState | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/** What makes the update mandatory, or `null` (always `null` on the web). */
export const useNativeUpdateRequired: () => NativeUpdateRequirement | null = DESKTOP_UPDATES
  ? () => useNativeUpdateState()?.required ?? null
  : () => null;

/** Tests only. */
export function resetNativeUpdates(): void {
  unsubscribe?.();
  unsubscribe = null;
  current = null;
  for (const listener of listeners) listener();
}
