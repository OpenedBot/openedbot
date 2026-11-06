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
