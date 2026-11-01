import { Outlet } from "@tanstack/react-router";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { BoardFrame } from "../boardui/board-frame";
import { SettingsModal, SettingsPage, SettingsPageSidebar } from "../boardui/settings-modal";
import { useFleetFrameContext } from "../../pro-console/slots";
import { FaceMotionProvider } from "../../lib/face-motion";
import { MobileFrame } from "./mobile-frame";
import { useSettingsDisplay } from "../../lib/settings-display";

/**
 * On mobile, settings stay in the conversation shell. The overview is a drawer
 * screen, and each section is pushed above it with a back action, like a native
 * stack (`mobileRouteDepth`).
 *
 * On desktop a workspace's settings are the modal, or a page of the frame when
 * the operator chose « Page » (Appearance, `settings-display.ts`). In the agency frame they are
 * a page of that frame instead (`SettingsPage`): the agency's team and profile,
 * and a client's sections opened by its agency, sit in the main card under the
 * client tabs, with the settings navigation beside them.
 */
export function SettingsFrame() {
  const isMobile = useIsMobile();
  const fleetFrame = useFleetFrameContext();
  const display = useSettingsDisplay();
  return (
    <FaceMotionProvider anime={false}>
      {isMobile ? (
        <MobileFrame />
      ) : fleetFrame ? (
        <BoardFrame><SettingsPage><Outlet /></SettingsPage></BoardFrame>
      ) : display === "page" ? (
        <BoardFrame sidebar={<SettingsPageSidebar />}><SettingsPage><Outlet /></SettingsPage></BoardFrame>
      ) : (
        <BoardFrame overlay={<SettingsModal><Outlet /></SettingsModal>}>
          {null}
        </BoardFrame>
      )}
    </FaceMotionProvider>
  );
}
