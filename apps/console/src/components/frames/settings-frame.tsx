import { useEffect } from "react";
import { Outlet } from "@tanstack/react-router";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { BoardFrame } from "../boardui/board-frame";
import { SettingsPage, SettingsPageSidebar } from "../boardui/settings-modal";
import { useFleetFrameContext } from "../../pro-console/slots";
import { FaceMotionProvider } from "../../lib/faces/face-motion";
import { prefetchConnectors } from "../../lib/runtime/connectors-prefetch";
import { MobileFrame } from "./mobile-frame";

/**
 * On mobile, settings stay in the conversation shell. The overview is a drawer
 * screen, and each section is pushed above it with a back action, like a native
 * stack (`mobileRouteDepth`).
 *
 * On desktop a workspace's settings are a page of the frame (the window was
 * removed on 2026-11-02, operator decision). In the agency frame they are
 * a page of that frame instead (`SettingsPage`): the agency's team and profile,
 * and a client's sections opened by its agency, sit in the main card under the
 * client tabs, with the settings navigation beside them.
 */
export function SettingsFrame() {
  const isMobile = useIsMobile();
  const fleetFrame = useFleetFrameContext();
  // Connecteurs lit l'hôte (lectures froides de quelques secondes) : elles
  // partent dès l'entrée dans les réglages, pendant que l'on choisit la
  // rubrique. Les réglages d'une agence n'ont pas de Connecteurs.
  useEffect(() => {
    if (!fleetFrame) prefetchConnectors();
  }, [fleetFrame]);
  return (
    <FaceMotionProvider anime={false}>
      {isMobile ? (
        <MobileFrame />
      ) : fleetFrame ? (
        <BoardFrame><SettingsPage><Outlet /></SettingsPage></BoardFrame>
      ) : (
        <BoardFrame sidebar={<SettingsPageSidebar />}><SettingsPage><Outlet /></SettingsPage></BoardFrame>
      )}
    </FaceMotionProvider>
  );
}
