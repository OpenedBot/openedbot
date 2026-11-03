import { describe, expect, test } from "bun:test";
import {
  DRAWER_WIDTH,
  decideDrawerOpen,
  drawerPathChange,
  drawerWidthFor,
  edgeSwipePreventsScroll,
  isMobileShellPath,
  mobileBackTarget,
  mobileRouteDepth,
  mobileTransition,
} from "../../../src/lib/shell/mobile-navigation";

describe("mobile navigation geometry", () => {
  test("public and onboarding routes stay outside the shell", () => {
    expect(isMobileShellPath("/login")).toBe(false);
    expect(isMobileShellPath("/onboarding")).toBe(false);
    expect(isMobileShellPath("/legal/privacy")).toBe(false);
    expect(isMobileShellPath("/")).toBe(true);
    expect(isMobileShellPath("/bot")).toBe(true);
    expect(isMobileShellPath("/cs")).toBe(true);
    expect(isMobileShellPath("/c/neo")).toBe(true);
    expect(isMobileShellPath("/bot/550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isMobileShellPath("/cs/550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isMobileShellPath("/settings/runtime")).toBe(true);
  });

  test("only settings sections are pushed on the stack", () => {
    expect(mobileRouteDepth("/")).toBe(0);
    expect(mobileRouteDepth("/bot")).toBe(0);
    expect(mobileRouteDepth("/cs")).toBe(0);
    expect(mobileRouteDepth("/c/neo")).toBe(0);
    expect(mobileRouteDepth("/bot/550e8400-e29b-41d4-a716-446655440000")).toBe(0);
    expect(mobileRouteDepth("/cs/550e8400-e29b-41d4-a716-446655440000")).toBe(0);
    expect(mobileRouteDepth("/settings")).toBe(0);
    expect(mobileRouteDepth("/settings/runtime")).toBe(1);
    expect(mobileRouteDepth("/settings/decisions")).toBe(1);
    expect(mobileBackTarget("/settings/runtime")).toBe("/settings");
    expect(mobileBackTarget("/settings/decisions")).toBe("/settings");
    expect(mobileBackTarget("/settings")).toBeNull();
    expect(mobileBackTarget("/c/neo")).toBeNull();
    expect(mobileBackTarget("/bot/550e8400-e29b-41d4-a716-446655440000")).toBeNull();
  });

  test("transition direction follows depth, drawer screens do not animate", () => {
    expect(mobileTransition("/settings", "/settings/models")).toBe("push");
    expect(mobileTransition("/settings/models", "/settings")).toBe("pop");
    expect(mobileTransition("/", "/c/neo")).toBeNull();
    expect(mobileTransition("/settings/models", "/settings/runtime")).toBeNull();
    expect(mobileTransition(undefined, "/settings/models")).toBeNull();
  });

  test("drawer hugs 310 pt and never covers the whole phone", () => {
    expect(drawerWidthFor(430)).toBe(DRAWER_WIDTH);
    expect(drawerWidthFor(320)).toBe(Math.round(320 * 0.84));
  });

  test("un scroll vertical depuis le bord gauche n'est pas volé", () => {
    expect(edgeSwipePreventsScroll({ fromEdge: true, captured: false, aborted: false, dx: 2, dy: 24 })).toBe(false);
    expect(edgeSwipePreventsScroll({ fromEdge: true, captured: false, aborted: false, dx: 4, dy: 4 })).toBe(false);
    expect(edgeSwipePreventsScroll({ fromEdge: true, captured: false, aborted: false, dx: 20, dy: 4 })).toBe(true);
    expect(edgeSwipePreventsScroll({ fromEdge: false, captured: false, aborted: false, dx: 20, dy: 4 })).toBe(false);
    expect(edgeSwipePreventsScroll({ fromEdge: false, captured: true, aborted: false, dx: 20, dy: 4 })).toBe(true);
    expect(edgeSwipePreventsScroll({ fromEdge: true, captured: true, aborted: true, dx: 20, dy: 4 })).toBe(false);
  });

  test("un jitter de lift ne referme plus une course déjà à mi-chemin", () => {
    const width = 310;
    expect(decideDrawerOpen({ position: 160, width, velocity: 0 })).toBe(true);
    expect(decideDrawerOpen({ position: 248, width, velocity: -0.4 })).toBe(true);
    expect(decideDrawerOpen({ position: 62, width, velocity: -0.4 })).toBe(false);
    expect(decideDrawerOpen({ position: 93, width, velocity: 0.5 })).toBe(true);
  });

  test("le swipe-back Safari est annulé, un lien tapé jamais", () => {
    // Safari confisque le geste de bord pour son « Retour » : `touchcancel`
    // sans pointerup, puis `popstate` au lever du doigt. Le chemin tenu depuis
    // le touchstart est restauré. Un push (lien du panneau) ne l'est jamais.
    expect(drawerPathChange({ held: "/bot/abc", pathname: "/", popped: true })).toBe("restore");
    expect(drawerPathChange({ held: "/bot/abc", pathname: "/", popped: false })).toBe("close");
    expect(drawerPathChange({ held: "/bot/abc", pathname: "/bot/abc", popped: false })).toBe("keep-open");
    expect(drawerPathChange({ held: null, pathname: "/", popped: true })).toBe("close");
  });
});
