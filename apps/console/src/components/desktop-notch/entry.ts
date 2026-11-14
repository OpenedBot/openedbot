import { lazy } from "react";

/**
 * The mount point of the notch choice on first sign-in (Tauri
 * app on Mac). Outside the desktop build (`VITE_OPENEDBOT_SHELL=tauri`), it
 * is `null` from compilation: the web build renders nothing of it and
 * ships no chunk of it (`make bundle-budget`).
 */
const DESKTOP = import.meta.env.VITE_OPENEDBOT_SHELL === "tauri";

export const DesktopNotchOnboarding = DESKTOP ? lazy(() => import("./notch-onboarding").then((module) => ({ default: module.NotchOnboarding }))) : null;
