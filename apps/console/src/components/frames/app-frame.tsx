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
 * On desktop, settings are a page of the frame (`SettingsFrame`) since
 * 02-11-2026: no more overlay above the current screen.
 */
export function DesktopAppFrame() {
  // Stable element: the frame and the sidebar do not re-render on navigation.
  const frame = useMemo(() => <BoardFrame><Outlet /></BoardFrame>, []);
  return <SettingsOverlayHost>{frame}</SettingsOverlayHost>;
}

/**
 * A history entry written when settings opened in a window
 * still carries the section in its state, while the real place is
 * the screen behind: the address says the section, the screen showed something
 * else. We open the section's real route (its runtime tab
 * search included). Kept exported: the modules API publishes it
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
