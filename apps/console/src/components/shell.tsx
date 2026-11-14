import { Suspense, useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "@tanstack/react-router";
import { cn, SidebarProvider, Toaster, TooltipProvider, useIsMobile } from "@openedbot/browser-ui-kit";
import { isMobileShellPath } from "../lib/shell/mobile-navigation";
import { isIosDevice, isStandaloneDisplay } from "../lib/platform/pwa-display";
import { useVisualViewportInset } from "../lib/platform/use-visual-viewport-height";
import { ClientUpdateGate } from "./client-update-required";
import { DesktopUpdateLayer } from "./desktop-update/entry";
import { DesktopNotchOnboarding } from "./desktop-notch/entry";

/**
 * The shell's providers, and nothing else.
 *
 * The sidebar and the inset are mounted by the layout routes
 * (`route-tree.tsx`): conversations and settings do not have the same
 * bar. Keeping them here would freeze them, and that is precisely what left the
 * bot list showing inside settings.
 *
 * In return, `SidebarProvider` stays above both modes: the
 * collapsed/expanded state survives the passage from one to the other instead of being reset.
 *
 * `TooltipProvider` is MANDATORY here. `SidebarMenuButton` renders a `Tooltip`
 * as soon as one passes it `tooltip`, and our `sidebar.tsx`, unlike
 * upstream shadcn's, does not carry the provider: it waits for the
 * application to provide it, as the block's root layout does.
 * Without it, the first render throws « Tooltip must be used within
 * TooltipProvider » and the whole application falls.
 *
 * `--header-height` is declared here and not in the global CSS because the
 * sidebar uses it to align its own header with the content's;
 * both must read the same value.
 *
 * `h-svh overflow-hidden` replaces shadcn's `min-h-svh`, and that is not
 * cosmetic: without a DEFINED height, the page bodies' `flex-1 overflow-y-auto`
 * never activates, the document overflows, and it is the window that scrolls.
 * The scrollbar wraps the `SiteHeader`, which disappears upward,
 * while the sidebar is `fixed h-svh` and stays in place. The
 * shell fits in the viewport, scrolling belongs to the page body.
 *
 * On a phone (`useIsMobile`, outside `/login`, `/onboarding`, `/legal`),
 * the mobile shell takes over: NO safe-area margins here. It is
 * the header (`MobileHeader`) and the composer that paint under the status
 * bar and the home indicator, with their own `env(safe-area-inset-*)`,
 * like a native navigation bar. The CSS sets `100dvh` on html in a
 * tab and `100vh` in an installed iOS PWA (WebKit #254868); the shell
 * is `height: 100%`. A parent `100%` that was too short clipped the composer on
 * the home indicator. `/login` and `/onboarding` (phone) no longer inherit
 * the desktop shell's safe-area padding: they set it themselves.
 * When the keyboard is up, the measured geometry of `visualViewport`
 * replaces both (`useVisualViewportInset`): height + `offsetTop`,
 * otherwise Safari leaves a hole between the composer and the keyboard.
 */
export function Shell({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  const mobileShell = isMobile && isMobileShellPath(pathname);
  // Stable for the session: standalone mode changes only after a
  // fresh opening, and freezing them avoids a divergence on the first paint.
  const [standalone] = useState(isStandaloneDisplay);
  const [ios] = useState(isIosDevice);
  const keyboardInset = useVisualViewportInset(mobileShell);
  useRootShellAttributes(mobileShell, standalone, ios);
  return (
    <TooltipProvider>
      {/* Keep the iOS scroll-edge backing outside the keyboard-transformed shell. */}
      {mobileShell && standalone && ios
        ? createPortal(<div aria-hidden data-mobile-status-edge="" />, document.body)
        : null}
      <SidebarProvider
        data-shell={mobileShell ? "mobile" : "desktop"}
        data-pwa-standalone={standalone ? "" : undefined}
        data-ios-device={ios ? "" : undefined}
        data-keyboard-open={mobileShell && keyboardInset !== null ? "" : undefined}
        className={cn(
          // Desktop: `clip`, not `hidden`. A hidden box is still a scroll
          // container: a `scrollIntoView` or a focus deep in the thread
          // scrolled the whole frame (Firefox, the desktop shell), the
          // sidebar cut on the left and the top bar out of view. A clipped
          // box cannot scroll at all.
          mobileShell || isMobile ? "overflow-hidden" : "overflow-clip",
          mobileShell
            ? "min-h-0 h-full bg-sidebar"
            : isMobile
              ? "min-h-0 h-full"
              : "h-svh pt-[var(--openedbot-safe-top)] pr-[var(--openedbot-safe-right)] pb-[var(--openedbot-safe-bottom)] pl-[var(--openedbot-safe-left)]",
        )}
        style={
          {
            // 260 px, the upstream rail's width: 288 px pushed the column
            // of reading off its axis on a laptop.
            "--sidebar-width": "260px",
            "--header-height": "calc(var(--spacing) * 12)",
            ...(keyboardInset !== null
              ? {
                  height: `${keyboardInset.height}px`,
                  minHeight: `${keyboardInset.height}px`,
                  transform:
                    keyboardInset.offsetTop !== 0
                      ? `translateY(${keyboardInset.offsetTop}px)`
                      : undefined,
                }
              : {}),
          } as CSSProperties
        }
      >
        {/* Tauri app only (`null` on the web): the runs in progress for the
            shell, the app menu and the restart dialog. */}
        {DesktopUpdateLayer ? <Suspense fallback={null}><DesktopUpdateLayer /></Suspense> : null}
        {/* Tauri app on Mac only (`null` on the web): the notch choice on the first connection. */}
        {DesktopNotchOnboarding ? <Suspense fallback={null}><DesktopNotchOnboarding /></Suspense> : null}
        <ClientUpdateGate>
          {children}
          {/* Everywhere at the bottom right, settings included: they are now a
              page of the frame, no longer a centred modal to sit under. */}
          <Toaster position="bottom-right" />
        </ClientUpdateGate>
      </SidebarProvider>
    </TooltipProvider>
  );
}

/**
 * Copies the shell's mode onto `<html>` (`data-openedbot-shell`,
 * `data-openedbot-pwa-standalone`, `data-openedbot-ios-device`) for `mobile.css`.
 *
 * The CSS read `html:has([data-shell="mobile"]) ...`: a `:has()` on the
 * root forces Chrome to revalidate the style of the whole document on EVERY
 * DOM mutation. Measured on 2026-10-05 on a long thread (3,100 nodes):
 * ~50 ms of style per mutation, and a Recharts chart that measures its
 * labels one by one climbed to several seconds. An attribute on the root
 * costs a simple selector. Names distinct from the shell's: the PWA
 * passes read `document.querySelector("[data-shell]")`.
 */
function useRootShellAttributes(mobileShell: boolean, standalone: boolean, ios: boolean): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-openedbot-shell", mobileShell ? "mobile" : "desktop");
    root.toggleAttribute("data-openedbot-pwa-standalone", standalone);
    root.toggleAttribute("data-openedbot-ios-device", ios);
    return () => {
      root.removeAttribute("data-openedbot-shell");
      root.removeAttribute("data-openedbot-pwa-standalone");
      root.removeAttribute("data-openedbot-ios-device");
    };
  }, [mobileShell, standalone, ios]);
}
