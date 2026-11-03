import { useEffect, useMemo, type ReactNode } from "react";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { BoardFrame } from "../boardui/board-frame";
import { settingsOverlayPath } from "../../lib/shell/settings-overlay";
import { MobileFrame } from "./mobile-frame";
import { ConnectorUpdateAnnouncement } from "../connector-update-dialog";

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
 * Au bureau, les réglages sont une page du cadre (`SettingsFrame`) depuis le
 * 02-11-2026 : plus de surcouche au-dessus de l'écran courant.
 */
export function DesktopAppFrame() {
  // Élément stable : le cadre et la barre latérale ne se re-rendent pas à la navigation.
  const frame = useMemo(() => <BoardFrame><Outlet /></BoardFrame>, []);
  return <SettingsOverlayHost>{frame}</SettingsOverlayHost>;
}

/**
 * Une entrée d'historique écrite quand les réglages s'ouvraient en fenêtre
 * porte encore la rubrique dans son état, alors que l'emplacement réel est
 * l'écran de derrière : l'adresse dit la rubrique, l'écran montrait autre
 * chose. On ouvre la vraie route de la rubrique (sa recherche d'onglet du
 * runtime comprise). Gardé exporté : l'API des modules le publie
 * (`pro-console/host.ts`).
 */
export function SettingsOverlayHost({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => settingsOverlayPath(state.location.state) });
  const runtimeSection = useRouterState({
    select: (state) => state.location.maskedLocation?.search.section,
  });
  useEffect(() => {
    if (!path) return;
    void navigate({
      to: path,
      search: typeof runtimeSection === "string" ? { section: runtimeSection } : {},
      replace: true,
    });
  }, [path, runtimeSection, navigate]);
  return <>{children}</>;
}
