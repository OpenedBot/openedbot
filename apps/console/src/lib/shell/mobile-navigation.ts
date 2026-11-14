/**
 * The navigation geometry of the mobile shell: outside React, so that the
 * shell, the header and the tests share the same rule.
 *
 * The model is the `sidebar` / `assistant` mode of `template-mobile-rn`:
 * a drawer (the conversation panel) under a scene that slides, and a
 * stack for the detail screens. Here the stack only concerns settings:
 * `/settings` is a drawer screen, `/settings/<section>` is pushed
 * above it and returns via « Retour ». Conversations (`/bot/`, `/cs/`, `/g/`),
 * the overview and the « À traiter » box are drawer screens: one moves
 * from one to another through the panel, never through a stack. The decision
 * journal lives in settings (`/settings/decisions`).
 */

/** The breakpoint of `useIsMobile`: a phone or a narrow window. */
export const MOBILE_BREAKPOINT = 768;

/** Panel width, that of the template (310 pt), capped on small screens. */
export const DRAWER_WIDTH = 310;
export const DRAWER_MAX_VIEWPORT_RATIO = 0.84;

/**
 * Edge zone that opens the panel on a gesture (template: `swipeEdgeWidth: 48`).
 *
 * ONE value only, and it matters: the strip that receives the `pointerdown`
 * and the heuristic of the non-passive `touchmove` must speak of the same edge. As long as
 * they diverged (24 px for the strip, 40 px for the heuristic), the
 * fringe between the two stole the scroll, `preventDefault` ran there, without
 * any drag starting: the finger no longer scrolled AND opened nothing.
 */
export const DRAWER_EDGE_WIDTH = 40;
/** Below this threshold, the finger has not yet chosen between scroll and swipe. */
export const EDGE_GESTURE_SLOP = 8;
/** Speed (px/ms) that carries the decision when the travel is on the same side. */
export const FLING_VELOCITY = 0.35;

/**
 * The native `touchmove` listener (non-passive) must steal the gesture only
 * when it really is a horizontal swipe. A vertical scroll that
 * starts near the left edge, where the bubbles live, must stay a
 * scroll, otherwise the PWA thread is frozen.
 */
export function edgeSwipePreventsScroll(input: {
  fromEdge: boolean;
  captured: boolean;
  aborted: boolean;
  dx: number;
  dy: number;
}): boolean {
  if (input.aborted) return false;
  if (!input.fromEdge && !input.captured) return false;
  if (input.fromEdge && !input.captured) {
    if (Math.abs(input.dy) > EDGE_GESTURE_SLOP && Math.abs(input.dy) > Math.abs(input.dx)) {
      return false;
    }
    if (Math.abs(input.dx) < EDGE_GESTURE_SLOP) return false;
  }
  return true;
}

/**
 * Decides whether the drawer opens on pointerup. A lift jitter toward the
 * left no longer closes a travel already halfway: `flungClosed`
 * won on its own and snap-closed a swipe at 80%.
 */
export function decideDrawerOpen(input: {
  position: number;
  width: number;
  velocity: number;
}): boolean {
  if (input.velocity > FLING_VELOCITY) return true;
  if (input.velocity < -FLING_VELOCITY && input.position <= input.width / 2) {
    return false;
  }
  return input.position > input.width / 2;
}

export type DrawerPathChange = "restore" | "keep-open" | "close";

/**
 * What the drawer does when `pathname` changes.
 *
 * `held` is the path held since a touch on the edge strip; `popped`
 * says a `popstate` arrived while it was held: the signature of
 * Safari's « Retour » confiscating the gesture. A push (tapped link, hamburger
 * then roster) is never cancelled, held or not.
 */
export function drawerPathChange(input: {
  held: string | null;
  pathname: string;
  popped: boolean;
}): DrawerPathChange {
  if (input.held === null) return "close";
  if (input.held === input.pathname) return "keep-open";
  return input.popped ? "restore" : "close";
}

export function drawerWidthFor(viewportWidth: number): number {
  return Math.min(DRAWER_WIDTH, Math.round(viewportWidth * DRAWER_MAX_VIEWPORT_RATIO));
}

/** The routes that live OUTSIDE the mobile shell: they have their own full screen. */
export function isMobileShellPath(pathname: string): boolean {
  if (pathname === "/login" || pathname === "/onboarding") return false;
  if (pathname === "/legal" || pathname.startsWith("/legal/")) return false;
  return true;
}

/**
 * Depth in the mobile stack: 0 for a drawer screen, 1 for a
 * settings section pushed above it.
 */
/** `/settings` and its sections (`/settings/account`), excluding an already rewritten `/o/<slug>` prefix. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

export function mobileRouteDepth(pathname: string): number {
  return /^\/settings\/[^/]+/u.test(pathname) ? 1 : 0;
}

/** The destination of the « Retour » button, or `null` when the header carries the menu. */
export function mobileBackTarget(pathname: string): string | null {
  return mobileRouteDepth(pathname) > 0 ? "/settings" : null;
}

export type MobileTransition = "push" | "pop";

/**
 * The direction of the transition between two locations: `push` toward a
 * deeper screen, `pop` toward the surface, nothing between two drawer screens (the
 * panel closing is already the animation).
 */
export function mobileTransition(from: string | undefined, to: string): MobileTransition | null {
  if (from === undefined) return null;
  const delta = mobileRouteDepth(to) - mobileRouteDepth(from);
  if (delta > 0) return "push";
  if (delta < 0) return "pop";
  return null;
}
