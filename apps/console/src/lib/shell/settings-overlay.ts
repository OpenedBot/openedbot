import { createContext, useContext } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { SHOW_DEV_SETTINGS } from "./dev-settings-ui";
import type { RuntimeSection } from "../../screens/settings/installation/cloud/cloud-shared";

/**
 * Les rubriques des réglages qui s'ouvrent PAR-DESSUS l'écran courant, au
 * bureau. Ouvrir `/settings` comme une page démontait toute l'app (le fil, la
 * barre, le cadre) puis la remontait sous la modale : mesuré à ~400 ms sur un
 * long fil. Ici l'URL affichée reste `/settings/...` (masque TanStack), mais
 * l'emplacement réel ne change pas : le fil reste monté derrière.
 *
 * Runtime tabs use the masked URL search while the underlying app stays mounted.
 * Reloading or pasting a settings URL still opens its standalone route.
 */
export const OVERLAY_SETTINGS_PATHS = [
  "/settings",
  "/settings/account",
  "/settings/profile",
  "/settings/team",
  "/settings/clients",
  "/settings/journal",
  "/settings/agents",
  "/settings/runtime",
  "/settings/models",
  "/settings/appearance",
  "/settings/archives",
  "/settings/connectors",
  "/settings/notifications",
  "/settings/decisions",
  "/settings/policies",
  "/settings/security",
  "/settings/billing",
  "/settings/developer",
] as const;

export type OverlaySettingsPath = (typeof OVERLAY_SETTINGS_PATHS)[number];

const DEV_ONLY_PATHS: ReadonlySet<string> = new Set(["/settings/billing", "/settings/developer"]);
const OVERLAY_PATHS: ReadonlySet<string> = new Set(OVERLAY_SETTINGS_PATHS);

/** La clé d'état d'historique qui porte la rubrique ouverte en surcouche. */
export const SETTINGS_OVERLAY_STATE_KEY = "ohbSettingsOverlay";

export function isOverlaySettingsPath(path: string): path is OverlaySettingsPath {
  return OVERLAY_PATHS.has(path) && (SHOW_DEV_SETTINGS || !DEV_ONLY_PATHS.has(path));
}

/** La rubrique ouverte en surcouche d'après l'état d'historique, ou `null`. */
export function settingsOverlayPath(state: unknown): OverlaySettingsPath | null {
  if (typeof state !== "object" || state === null) return null;
  const value = (state as Record<string, unknown>)[SETTINGS_OVERLAY_STATE_KEY];
  return typeof value === "string" && isOverlaySettingsPath(value) ? value : null;
}

export type SettingsOverlay = {
  open: (to: OverlaySettingsPath, options?: { section?: RuntimeSection; replace?: boolean }) => void;
  close: () => void;
};

/**
 * Fourni par le cadre bureau de l'app ; absent sur mobile et dans la page
 * `/settings`. Valeur stable : la rubrique ouverte n'y est pas, sinon chaque
 * ouverture re-rendrait tous les consommateurs, écran de conversation compris.
 */
export const SettingsOverlayContext = createContext<SettingsOverlay | null>(null);

export function useSettingsOverlay(): SettingsOverlay | null {
  return useContext(SettingsOverlayContext);
}

/**
 * Ouvre une rubrique des réglages : en surcouche quand le cadre la porte et
 * que la rubrique s'y prête, sinon comme une page. Le cadre ne porte la
 * surcouche que si l'opérateur a choisi « Fenêtre » (`settings-display.ts`).
 *
 * Sans rubrique : « Mon compte » au bureau, « Activité » n'étant plus la porte
 * d'entrée des réglages ; sur téléphone, `/settings` est la liste des rubriques.
 */
export function useOpenSettings(): (to?: string) => void {
  const overlay = useSettingsOverlay();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  return (to = isMobile ? "/settings" : "/settings/account") => {
    if (overlay && isOverlaySettingsPath(to)) overlay.open(to);
    else void navigate({ to });
  };
}
