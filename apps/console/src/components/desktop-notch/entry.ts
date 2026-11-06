import { lazy } from "react";

/**
 * Le point de montage du choix de l'encoche à la première connexion (app
 * Tauri sur Mac). Hors du build desktop (`VITE_OPENEDBOT_SHELL=tauri`), il
 * vaut `null` dès la compilation : le build web n'en rend rien et n'en
 * embarque aucun chunk (`make bundle-budget`).
 */
const DESKTOP = import.meta.env.VITE_OPENEDBOT_SHELL === "tauri";

export const DesktopNotchOnboarding = DESKTOP ? lazy(() => import("./notch-onboarding").then((module) => ({ default: module.NotchOnboarding }))) : null;
