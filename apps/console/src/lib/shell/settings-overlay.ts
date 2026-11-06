import { createContext, useContext } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { SHOW_DEV_SETTINGS } from "./dev-settings-ui";
import type { RuntimeSection } from "../../screens/settings/installation/cloud/cloud-shared";

/**
 * Les rubriques des réglages. Au bureau elles s'ouvrent en page du cadre
 * depuis le 02-11-2026 (la fenêtre au-dessus de l'écran courant a été retirée,
 * décision opérateur). La surcouche ne sert plus qu'à la fenêtre compacte du
 * desktop, qui ouvre la rubrique dans le navigateur (`compact-frame.tsx`), et
 * `settingsOverlayPath` relit les entrées d'historique écrites du temps de la
 * fenêtre (`SettingsOverlayHost`).
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
  "/settings/updates",
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
export const SETTINGS_OVERLAY_STATE_KEY = "openedbotSettingsOverlay";

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

/** Fourni par la fenêtre compacte du desktop seulement. */
export const SettingsOverlayContext = createContext<SettingsOverlay | null>(null);

export function useSettingsOverlay(): SettingsOverlay | null {
  return useContext(SettingsOverlayContext);
}

/**
 * Ouvre une rubrique des réglages : comme une page, sauf dans la fenêtre
 * compacte du desktop, qui la confie au navigateur.
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
