import { useEffect, useMemo, type ReactNode } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { BoardFrame } from "../boardui/board-frame";
import { SettingsModal } from "../boardui/settings-modal";
import { FaceMotionProvider } from "../../lib/face-motion";
import { SETTINGS_SECTIONS } from "../../screens/settings/sections";
import {
  SETTINGS_OVERLAY_STATE_KEY,
  SettingsOverlayContext,
  settingsOverlayPath,
  type SettingsOverlay,
} from "../../lib/settings-overlay";
import { takeQueuedSettingsOverlay, useSettingsDisplay } from "../../lib/settings-display";
import { MobileFrame } from "./mobile-frame";
import { ConnectorUpdateAnnouncement } from "../connector-update-dialog";
import { useFleetFrameContext } from "../../pro-console/slots";

export function AppFrame() {
  const isMobile = useIsMobile();
  return (
    <>
      {isMobile ? <MobileFrame /> : <DesktopAppFrame />}
      <ConnectorUpdateAnnouncement />
    </>
  );
}

/**
 * Au bureau, les réglages s'ouvrent au-dessus de l'écran courant : l'URL
 * affichée est celle de la rubrique (masque TanStack), l'emplacement réel
 * reste l'écran d'origine, qui ne se démonte pas. Voir `lib/settings-overlay.ts`.
 */
export function DesktopAppFrame() {
  // Élément stable : ouvrir ou fermer la surcouche ne re-rend ni le cadre ni
  // la barre latérale. La modale est `fixed`, posée à côté du cadre.
  const frame = useMemo(() => <BoardFrame><Outlet /></BoardFrame>, []);
  return <SettingsOverlayHost>{frame}</SettingsOverlayHost>;
}

/**
 * Carries the settings overlay for a desktop frame: the app frame, and the
 * agency fleet, which is not under it. On mobile settings stay a stack of
 * screens, and in the agency frame they are a page of that frame
 * (`SettingsFrame`), so no overlay is provided there: opening a section
 * navigates to its route.
 */
export function SettingsOverlayHost({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const fleetFrame = useFleetFrameContext() !== null;
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => settingsOverlayPath(state.location.state) });
  const overlay = useMemo<SettingsOverlay>(() => ({
    open: (to, options) => void navigate({
      to: ".",
      search: true,
      params: true,
      // Mask-only changes do not trigger navigation when the real URL and state match.
      state: {
        [SETTINGS_OVERLAY_STATE_KEY]: to,
        ohbSettingsRuntimeSection: options?.section,
      } as Record<string, unknown>,
      mask: { to, search: options?.section ? { section: options.section } : {} },
      replace: options?.replace,
    }),
    close: () => void navigate({ to: ".", search: true, params: true }),
  }), [navigate]);
  // « Page » : pas de surcouche, chaque rubrique s'ouvre sur sa route.
  const display = useSettingsDisplay();
  const carriesOverlay = !isMobile && !fleetFrame && display === "modal";
  // Retour d'une page des réglages en fenêtre : la même rubrique, au-dessus
  // de l'écran d'où l'on venait (`queueSettingsOverlay`).
  useEffect(() => {
    if (!carriesOverlay) return;
    const queued = takeQueuedSettingsOverlay();
    if (queued) overlay.open(queued, { replace: true });
  }, [carriesOverlay, overlay]);
  // Une entrée qui porte encore la surcouche d'une fenêtre alors que les
  // réglages s'ouvrent en page (mode changé dans un autre onglet, ou
  // rechargement après le changement) : l'adresse dit la rubrique, l'écran
  // montrait celui de derrière. On ouvre la vraie route de la rubrique.
  // La rubrique d'un onglet du runtime vit dans la recherche de l'adresse masquée.
  const runtimeSection = useRouterState({
    select: (state) => state.location.maskedLocation?.search.section,
  });
  useEffect(() => {
    if (carriesOverlay || !path) return;
    void navigate({
      to: path,
      search: typeof runtimeSection === "string" ? { section: runtimeSection } : {},
      replace: true,
    });
  }, [carriesOverlay, path, runtimeSection, navigate]);
  const Section = path ? SETTINGS_SECTIONS[path] : null;
  if (!carriesOverlay) return <>{children}</>;
  return (
    <SettingsOverlayContext.Provider value={overlay}>
      {children}
      {path && Section ? (
        <FaceMotionProvider anime={false}>
          <SettingsModal path={path} onClose={overlay.close}><Section /></SettingsModal>
        </FaceMotionProvider>
      ) : null}
    </SettingsOverlayContext.Provider>
  );
}
