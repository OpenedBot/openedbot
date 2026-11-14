import { lazy } from "react";

/**
 * The mount points of the Tauri app update. Outside the desktop
 * build (`VITE_OPENEDBOT_SHELL=tauri`), each is `null` from
 * compilation: the web build renders nothing of them and ships no chunk of them
 * (`make bundle-budget`). In the app, each surface is its own chunk,
 * loaded when it mounts.
 */
const DESKTOP = import.meta.env.VITE_OPENEDBOT_SHELL === "tauri";

export const DesktopUpdatePill = DESKTOP ? lazy(() => import("./update-pill").then((module) => ({ default: module.UpdatePill }))) : null;
export const DesktopUpdateRailButton = DESKTOP ? lazy(() => import("./update-rail-button").then((module) => ({ default: module.UpdateRailButton }))) : null;
export const DesktopUpdateMenuRow = DESKTOP ? lazy(() => import("./update-pill").then((module) => ({ default: module.UpdateMenuRow }))) : null;
export const DesktopUpdateLayer = DESKTOP ? lazy(() => import("./update-layer").then((module) => ({ default: module.DesktopUpdateLayer }))) : null;
export const DesktopUpdateRequired = DESKTOP ? lazy(() => import("./update-required").then((module) => ({ default: module.DesktopUpdateRequired }))) : null;
