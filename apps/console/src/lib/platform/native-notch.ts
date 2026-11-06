import { useSyncExternalStore } from "react";
import type { DisplayMode, NotchState } from "@openedbot/contracts-native-bridge";
import { nativeBridge } from "./native-bridge";

/**
 * L'encoche de l'app de bureau Tauri sur Mac, telle que la coque la mène
 * (`apps/desktop-tauri/src-tauri/src/notch.rs`) : la console montre le choix
 * de la première connexion et Réglages › Encoche, et transmet le choix. Hors
 * de l'app Tauri, rien : le pont n'a pas de `notch`, et le build web écarte
 * ce code dès la compilation (`VITE_OPENEDBOT_SHELL`).
 */
export type NativeNotchMode = DisplayMode;
export type NativeNotchState = NotchState;

export type NativeNotchBridge = {
  /** Reçoit aussitôt le dernier état connu, puis chaque changement ; renvoie le désabonnement. */
  onState(listener: (state: NativeNotchState) => void): () => void;
  /** Le choix de l'utilisateur, gardé par la coque : `window`, `both` ou `popup` (l'encoche seule). */
  setMode(mode: NativeNotchMode): Promise<NativeNotchState>;
  /** « Revoir la démonstration » : sans toucher au choix gardé. */
  playDemo(): Promise<NativeNotchState>;
};

/** Le pont de l'encoche, s'il existe (coque Tauri). */
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

/** L'état de l'encoche, `null` hors de l'app Tauri ou avant la première réponse de la coque. */
export function useNativeNotchState(): NativeNotchState | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/** Envoie un choix et retient l'état que la coque renvoie (l'évènement suit aussi). */
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
