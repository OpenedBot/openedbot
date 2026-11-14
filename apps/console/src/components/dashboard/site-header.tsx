import type { ReactNode } from "react";
import { MobileHeader } from "../mobile/mobile-header";
import { useMobileDrawer } from "../mobile/mobile-drawer-shell";
import { RuntimeHealthBadge } from "./runtime-health-badge";
import { BoardHeader } from "../boardui/board-chrome";

/**
 * The `dashboard-01` block's header.
 *
 * The title and the actions come from the screen on display rather than being written
 * in hard: it is the same banner for the overview, a conversation and
 * settings, and duplicating the bar per screen would make it diverge.
 */
export function SiteHeader({
  title,
  subtitle,
  avatar,
  actions,
  heading = true,
  align = "center",
  root = false,
  centered = false,
  floating = false,
}: {
  title: ReactNode;
  /**
   * The title's second line: on the phone only. A navigation
   * bar of 430 pt does not hold a name, a selector and three actions
   * on ONE line: the name ended up truncated to « H… ». The selector therefore drops
   * under the name, like the subtitle of an iOS bar.
   */
  subtitle?: ReactNode;
  /**
   * A conversation's face. On the phone it covers both lines of the
   * title (`MobileHeader`); on desktop it precedes the title, inline.
   */
  avatar?: ReactNode;
  actions?: ReactNode;
  /** `false`: the `h1` lives in the scene (home `/`). */
  heading?: boolean;
  /**
   * Phone only. `center` (default) = iOS navigation bar: title
   * at the optical centre between two columns of the same width. `start` for a
   * conversation, whose title carries a face and a name.
   */
  align?: "start" | "center";
  /** Desktop: the Salon itself, with no « Salon › » in front of its title. */
  root?: boolean;
  /** Desktop: the title alone, centred on the bar (`BoardHeader`), like a thread's header. */
  centered?: boolean;
  /** Desktop: the title as a pill floating over the thread (`BoardHeader`). */
  floating?: boolean;
}) {
  // In the mobile shell (`MobileDrawerShell`), the same header becomes the
  // navigation bar of a drawer screen: the panel button or
  // « Retour » on the left, with no `SidebarTrigger`: there is no bar to
  // collapse, there is a panel to reveal.
  const drawer = useMobileDrawer();
  // On a thread (`/bot/:id`, `/g/:id`), the runtime's state precedes the
  // screen's actions: knowing whether the host answers before writing.
  const headerActions = (
    <>
      <RuntimeHealthBadge />
      {actions}
    </>
  );
  if (drawer) {
    return <MobileHeader title={title} subtitle={subtitle} avatar={avatar} actions={headerActions} heading={heading} align={align} />;
  }
  // Desktop: the breadcrumb and the screen's actions, placed in the
  // frame's top bar (`board-chrome.tsx`). The subtitle is mobile only.
  return <BoardHeader title={title} avatar={avatar} actions={actions} heading={heading} root={root} centered={centered} floating={floating} />;
}
