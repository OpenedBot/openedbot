import { useSyncExternalStore } from "react";
import type { UpdateErrorCode, UpdateMenuAction, UpdatePhase, UpdateRequirement, UpdateState } from "@openedbot/contracts-native-bridge";
import { nativeBridge } from "./native-bridge";

/**
 * La mise à jour de l'app de bureau Tauri, telle que la coque la mène
 * (`apps/desktop-tauri/src-tauri/src/update_engine.rs`) : la console ne fait
 * que la montrer (pastille, ligne du menu du compte, Réglages › Mises à jour,
 * écran « mise à jour requise ») et transmettre le consentement de
 * l'utilisateur. Hors de l'app Tauri, rien : le pont n'a pas de `updates`, et
 * le build web écarte ce code dès la compilation (`VITE_OPENEDBOT_SHELL`).
 */
export type NativeUpdateState = UpdateState;
export type NativeUpdatePhase = UpdatePhase;
export type NativeUpdateRequirement = UpdateRequirement;
export type NativeUpdateErrorCode = UpdateErrorCode;

export type NativeUpdatesBridge = {
  /** Reçoit aussitôt le dernier état connu, puis chaque changement ; renvoie le désabonnement. */
  onState(listener: (state: NativeUpdateState) => void): () => void;
  check(): Promise<void>;
  /**
   * Le consentement : installer `version`, celle que l'utilisateur a vue. La
   * coque redémarre si elle est toujours proposée ; sinon une erreur nommée
   * (`UPDATE_SUPERSEDED`, `UPDATE_WITHDRAWN`, `UPDATE_FEED_UNREACHABLE`…).
   */
  install(version: string): Promise<void>;
  /** Le 426 de l'API : la coque passe en « requise » et interroge le flux. */
  reportRequired(minimum: string | null): Promise<void>;
  /** Les runs en cours vus par la console, `null` si elle ne peut pas le dire : l'installation au repos attend un zéro connu. */
  reportRuns(count: number | null): Promise<void>;
  setAutoInstall(enabled: boolean): Promise<void>;
  /** L'élément « Rechercher des mises à jour… » du menu de l'app. */
  onMenu(listener: (action: UpdateMenuAction) => void): () => void;
};

/**
 * Vrai dans le build desktop Tauri seulement. Constant au build : les points
 * de montage (`components/desktop-update/entry.ts`) le testent, et le build
 * web en retire les composants et leurs chunks.
 */
export const DESKTOP_UPDATES = import.meta.env.VITE_OPENEDBOT_SHELL === "tauri";

/** Le pont des mises à jour, s'il existe (coque Tauri) ; les composants montés derrière `DESKTOP_UPDATES` le lisent. */
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

/** L'état de la mise à jour, `null` hors de l'app Tauri ou avant la première réponse de la coque. */
export function useNativeUpdateState(): NativeUpdateState | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/** Ce qui rend la mise à jour obligatoire, ou `null` (toujours `null` sur le web). */
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
