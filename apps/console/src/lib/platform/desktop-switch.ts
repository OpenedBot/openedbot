import type { OpenedbotNativeBridge } from "./native-bridge";
import { nativeTitlebarFor } from "./native-titlebar";

/**
 * Le passage de l'app Electron à l'app native sur Mac (ADR 0001, D3).
 *
 * L'app Electron 1.0.x n'a aucun mécanisme de mise à jour : elle charge la
 * console web distante, et c'est cette console qui peut lui annoncer la
 * nouvelle app. L'app native (Tauri) reprend le même identifiant
 * (`app.openedbot.desktop`) et le même nom : installée depuis le dmg, elle
 * remplace l'ancienne dans Applications. Elle ne lit pas la session
 * d'Electron (une reconnexion, une seule fois) ni ses brouillons (Q1).
 */

/** La première version native sur Mac. */
export const MAC_NATIVE_APP_VERSION = "1.1.0";

const SEMVER = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

function older(version: string, than: string): boolean {
  const left = SEMVER.exec(version);
  const right = SEMVER.exec(than);
  if (!left || !right) return false;
  for (let index = 1; index <= 3; index++) {
    const delta = Number(left[index]) - Number(right[index]);
    if (delta !== 0) return delta < 0;
  }
  return false;
}

/**
 * Vrai dans l'app Electron sur Mac, plus vieille que l'app native : pas de
 * pont de mise à jour (la coque Tauri en a un), barre de titre macOS,
 * version lisible et antérieure. Faux dans un navigateur, sous Windows et
 * Linux (Electron y reste), et dans l'app native.
 */
export function offersMacSwitch(bridge: OpenedbotNativeBridge | null, nav: { platform: string; userAgent: string }): boolean {
  if (!bridge || bridge.updates) return false;
  if (nativeTitlebarFor(bridge, nav) !== "mac") return false;
  return older(bridge.shell?.version?.trim() ?? "", MAC_NATIVE_APP_VERSION);
}
