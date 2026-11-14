import { useSyncExternalStore } from "react";
import type { DisplayMode, NotchState } from "@openedbot/contracts-native-bridge";
import { nativeBridge } from "./native-bridge";

/**
 * The notch of the Tauri desktop app on Mac, as the shell drives it
 * (`apps/desktop-tauri/src-tauri/src/notch.rs`): the console shows the choice
 * of the first sign-in and Settings › Notch, and forwards the choice. Outside
 * the Tauri app, nothing: the bridge has no `notch`, and the web build drops
 * this code at compile time (`VITE_OPENEDBOT_SHELL`).
 */
export type NativeNotchMode = DisplayMode;
export type NativeNotchState = NotchState;

export type NativeNotchBridge = {
  /** Receives the last known state at once, then each change; returns the unsubscribe. */
  onState(listener: (state: NativeNotchState) => void): () => void;
  /** The user's choice, kept by the shell: `window`, `both` or `popup` (the notch alone). */
  setMode(mode: NativeNotchMode): Promise<NativeNotchState>;
  /** « Revoir la démonstration »: without touching the kept choice. */
  playDemo(): Promise<NativeNotchState>;
};

/** The notch bridge, if it exists (Tauri shell). */
export function nativeNotch(): NativeNotchBridge | null {
  return nativeBridge()?.notch ?? null;
}

let current: NativeNotchState | null = null;
let unsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();

function deliver(state: NativeNotchState): void {
  current = state;
  for (const notify of listeners) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!unsubscribe) {
    const notch = nativeNotch();
    if (notch) unsubscribe = notch.onState(deliver);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** The notch state, `null` outside the Tauri app or before the shell's first response. */
export function useNativeNotchState(): NativeNotchState | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/** Sends a choice and keeps the state the shell returns (the event follows too). */
export async function chooseNotchMode(mode: NativeNotchMode): Promise<NativeNotchState | null> {
  const notch = nativeNotch();
  if (!notch) return null;
  const next = await notch.setMode(mode);
  deliver(next);
  return next;
}

/** Tests only. */
export function resetNativeNotch(): void {
  unsubscribe?.();
  unsubscribe = null;
  current = null;
  for (const listener of listeners) listener();
}
