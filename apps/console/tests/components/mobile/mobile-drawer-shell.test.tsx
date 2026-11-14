import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DRAWER_EDGE_WIDTH } from "../../../src/lib/shell/mobile-navigation";

const SHELL = readFileSync(new URL("../../../src/components/mobile/mobile-drawer-shell.tsx", import.meta.url), "utf8");
const ACCOUNT_MENU = readFileSync(new URL("../../../src/components/boardui/account-menu.tsx", import.meta.url), "utf8");

/**
 * The drawer closed itself, and the edge swallowed scroll without
 * opening anything. The four causes are structural: they are locked to the
 * shape of the code, because none of them is observable without a real touch
 * engine, and the repo contract forbids an unrequested browser pass.
 */
describe("coque du tiroir mobile", () => {
  test("un item de menu qui ne navigue pas ne ferme plus le tiroir", () => {
    // `[role="menuitem"]` caught pin, hide, toggle the theme,
    // open « Nouveau groupe »: as many closes as nobody
    // asked for. Only marked items close now.
    expect(SHELL).toContain('closest("[data-closes-drawer]")');
    expect(SHELL).not.toContain('closest(\'[role="menuitem"]\')');
  });

  test("les entrées du menu du compte portent la marque, pas les bascules de thème et de langue", () => {
    const item = ACCOUNT_MENU.slice(ACCOUNT_MENU.indexOf("function MenuItem("), ACCOUNT_MENU.indexOf("export const AccountMenu"));
    expect(item).toContain('data-closes-drawer=""');
    const toggles = ACCOUNT_MENU.slice(ACCOUNT_MENU.indexOf("theme.setMode"), ACCOUNT_MENU.indexOf("setLocale(candidate)"));
    expect(toggles).not.toContain("data-closes-drawer");
  });

  test("le garde anti clic fantôme vérifie la cible avant de se consommer", () => {
    // Consuming the guard on a click outside the panel disarmed it for the real
    // ghost click that followed: the row under the finger navigated anyway.
    // The scrim (`data-drawer-scrim`) is a target too: it is what
    // received the delayed iOS click and snap-closed the opening swipe.
    const guard = SHELL.slice(SHELL.indexOf("const blockGhostClick"), SHELL.indexOf("document.addEventListener(\"click\", blockGhostClick"));
    expect(guard.indexOf('closest("[data-mobile-drawer]")')).toBeLessThan(guard.indexOf("ignoreClick.current = false"));
    expect(guard.indexOf('closest("[data-drawer-scrim]")')).toBeLessThan(guard.indexOf("ignoreClick.current = false"));
    expect(guard.indexOf('closest("[data-mobile-scene]")')).toBeLessThan(guard.indexOf("ignoreClick.current = false"));
  });

  test("le voile n'est vivant que quand le tiroir est au repos", () => {
    // Mounted as soon as `progress > 0`, the scrim received the delayed iOS click
    // (~300 ms) and closed ~90% of opening swipes.
    expect(SHELL).toContain('data-drawer-scrim=""');
    expect(SHELL).toContain("const scrimLive = shown && !dragging && !panelLocked;");
    expect(SHELL).toContain("!scrimLive && \"pointer-events-none\"");
    expect(SHELL).toContain("if (!scrimLive || ignoreClick.current) return;");
    expect(SHELL).not.toContain("onClick={() => setOpen(false)}");
    expect(SHELL).toContain("decideDrawerOpen({ position, width, velocity: current.velocity })");
  });

  test("la fermeture sur navigation ne se déclenche que sur un chemin neuf", () => {
    // Without this guard, any new identity of `navigate`, and the mount,
    // replayed the effect and closed a panel nobody had touched.
    expect(SHELL).toContain("if (lastPath.current === pathname) return;");
    expect(SHELL).toContain("lastPath.current = pathname;");
  });

  test("le geste de bord part de la scène sans recouvrir le hamburger", () => {
    // A transparent 40 px layer above the stage intercepted
    // almost all of the hamburger (44 px). pointerdown now bubbles
    // from the real control up to the stage: a tap stays a tap, while
    // a horizontal move can still capture the gesture.
    expect(SHELL).toContain("startX <= DRAWER_EDGE_WIDTH;");
    expect(SHELL).not.toContain("DRAWER_EDGE_WIDTH + 16");
    expect(SHELL).toContain("event.clientX > DRAWER_EDGE_WIDTH");
    expect(SHELL).toContain("onPointerDown={!open ? beginDrag(false) : undefined}");
    expect(SHELL).not.toContain('className="absolute inset-y-0 left-0 z-10 touch-none"');
    expect(DRAWER_EDGE_WIDTH).toBeGreaterThanOrEqual(40);
  });

  test("le chemin est tenu dès le touchstart de bord, pas au pointerup", () => {
    // When Safari takes the gesture for its « Retour », the sequence ends in
    // `touchcancel`: no drag captured, so nothing armed at pointerup, and the
    // `popstate` landed on `/`. The guard starts at touchstart and reacts
    // only to a popstate: a push stays an intended navigation.
    expect(SHELL).toContain("if (atEdge) holdCurrentPath();");
    expect(SHELL).toContain('shell.addEventListener("touchcancel", onCancel');
    expect(SHELL).toContain("releaseHeldPath(SWIPE_BACK_HOLD_MS)");
    expect(SHELL).toContain('window.addEventListener("popstate", onPop)');
    expect(SHELL).toContain("drawerPathChange({ held, pathname, popped: popped.current })");
    expect(SHELL).not.toContain("armSwipeGuard(pathname)");
  });
});
