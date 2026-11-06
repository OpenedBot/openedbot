import { lazy } from "react";

/**
 * Les points de montage de la mise à jour de l'app Tauri. Hors du build
 * desktop (`VITE_OPENEDBOT_SHELL=tauri`), chacun vaut `null` dès la
 * compilation : le build web n'en rend rien et n'en embarque aucun chunk
 * (`make bundle-budget`). Dans l'app, chaque surface est son propre chunk,
 * chargé quand elle se monte.
 */
const DESKTOP = import.meta.env.VITE_OPENEDBOT_SHELL === "tauri";

export const DesktopUpdatePill = DESKTOP ? lazy(() => import("./update-pill").then((module) => ({ default: module.UpdatePill }))) : null;
export const DesktopUpdateMenuRow = DESKTOP ? lazy(() => import("./update-pill").then((module) => ({ default: module.UpdateMenuRow }))) : null;
export const DesktopUpdateLayer = DESKTOP ? lazy(() => import("./update-layer").then((module) => ({ default: module.DesktopUpdateLayer }))) : null;
export const DesktopUpdateRequired = DESKTOP ? lazy(() => import("./update-required").then((module) => ({ default: module.DesktopUpdateRequired }))) : null;

/**
 * L'invitation de l'app Electron sur Mac à passer à l'app native (ADR 0001,
 * D3, `electron-switch.tsx`). Éteinte tant que la 1.1.0 n'est pas publiée :
 * `false` la retire du build web. La publication la passe à `true` (une
 * ligne, puis un déploiement de la console web, que l'app Electron charge).
 */
export const ELECTRON_MAC_SWITCH_LIVE = false;

export const ElectronMacSwitchPill = !DESKTOP && ELECTRON_MAC_SWITCH_LIVE
  ? lazy(() => import("./electron-switch").then((module) => ({ default: module.ElectronMacSwitchPill })))
  : null;
