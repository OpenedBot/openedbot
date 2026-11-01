import { afterEach, describe, expect, test } from "bun:test";
import { isIosDevice, isStandaloneDisplay } from "../../src/lib/pwa-display";

const originalUa = navigator.userAgent;
const originalPlatform = navigator.platform;
const originalTouch = navigator.maxTouchPoints;

function setNavigator(input: { userAgent?: string; platform?: string; maxTouchPoints?: number }) {
  if (input.userAgent !== undefined) {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: input.userAgent });
  }
  if (input.platform !== undefined) {
    Object.defineProperty(navigator, "platform", { configurable: true, value: input.platform });
  }
  if (input.maxTouchPoints !== undefined) {
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: input.maxTouchPoints });
  }
}

afterEach(() => {
  setNavigator({
    userAgent: originalUa,
    platform: originalPlatform,
    maxTouchPoints: originalTouch,
  });
});

describe("isIosDevice", () => {
  test("reconnaît iPhone", () => {
    setNavigator({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    });
    expect(isIosDevice()).toBe(true);
  });

  test("reconnaît iPadOS 13+ (Macintosh + touch)", () => {
    setNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    expect(isIosDevice()).toBe(true);
  });

  test("ignore un Mac desktop", () => {
    setNavigator({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });
    expect(isIosDevice()).toBe(false);
  });
});

function stubMatchMedia(matching: string | null) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      matches: matching !== null && query.includes(matching),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

describe("isStandaloneDisplay", () => {
  test("lit display-mode: standalone", () => {
    const restore = stubMatchMedia("display-mode: standalone");
    expect(isStandaloneDisplay()).toBe(true);
    restore();
  });

  test("lit display-mode: fullscreen et minimal-ui", () => {
    const restoreFull = stubMatchMedia("display-mode: fullscreen");
    expect(isStandaloneDisplay()).toBe(true);
    restoreFull();
    const restoreMinimal = stubMatchMedia("display-mode: minimal-ui");
    expect(isStandaloneDisplay()).toBe(true);
    restoreMinimal();
  });

  test("lit navigator.standalone (Safari iOS)", () => {
    const restore = stubMatchMedia(null);
    const nav = navigator as Navigator & { standalone?: boolean };
    const previous = nav.standalone;
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    expect(isStandaloneDisplay()).toBe(true);
    Object.defineProperty(navigator, "standalone", { configurable: true, value: previous });
    restore();
  });
});
