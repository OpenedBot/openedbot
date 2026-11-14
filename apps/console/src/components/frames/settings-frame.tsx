import { useEffect } from "react";
import { Outlet } from "@tanstack/react-router";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { BoardFrame } from "../boardui/board-frame";
import { SettingsPage, SettingsPageSidebar } from "../boardui/settings-modal";
import { FaceMotionProvider } from "../../lib/faces/face-motion";
import { prefetchConnectors } from "../../lib/runtime/connectors-prefetch";
import { MobileFrame } from "./mobile-frame";

/**
 * On mobile, settings stay in the conversation shell. The overview is a drawer
 * screen, and each section is pushed above it with a back action, like a native
 * stack (`mobileRouteDepth`).
 *
 * On desktop a workspace's settings are a page of the frame (the window was
 * removed on 2026-11-02, operator decision).
 */
export function SettingsFrame() {
  const isMobile = useIsMobile();
  // Connectors reads the host (cold reads of a few seconds): they
  // leave as soon as one enters settings, while one chooses the
  // section.
  useEffect(() => {
    prefetchConnectors();
  }, []);
  return (
    <FaceMotionProvider anime={false}>
      {isMobile ? (
        <MobileFrame />
      ) : (
        <BoardFrame sidebar={<SettingsPageSidebar />}><SettingsPage><Outlet /></SettingsPage></BoardFrame>
      )}
    </FaceMotionProvider>
  );
}
