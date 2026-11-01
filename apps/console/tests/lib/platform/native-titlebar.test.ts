import { afterEach, describe, expect, test } from "bun:test";
import type { OhbNativeBridge } from "../../../src/lib/platform/native-bridge";
import {
  applyNativeTitlebar,
  NATIVE_TITLEBAR_ATTRIBUTE,
  NATIVE_TITLEBAR_BAND_ATTRIBUTE,
  nativeTitlebarFor,
} from "../../../src/lib/platform/native-titlebar";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) openedbot/0.1.0 Chrome/140.0.0.0 Electron/44.7.0 Safari/537.36";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) openedbot/0.1.0 Chrome/140.0.0.0 Electron/44.7.0 Safari/537.36";

// Le contrat figé : `shell.platform` vaut "windows" même sous macOS.
const bridge: OhbNativeBridge = {
  readAccessToken: async () => "token",
  refresh: async () => "token",
  openExternal: async () => undefined,
  signOut: async () => undefined,
  shell: { platform: "windows", version: "0.1.0" },
};

const originalUa = navigator.userAgent;
const originalPlatform = navigator.platform;

function setNavigator(userAgent: string, platform: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
}

afterEach(() => {
  setNavigator(originalUa, originalPlatform);
  delete window.__OHB_NATIVE__;
  document.documentElement.removeAttribute(NATIVE_TITLEBAR_ATTRIBUTE);
  for (const band of document.querySelectorAll(`[${NATIVE_TITLEBAR_BAND_ATTRIBUTE}]`)) band.remove();
});

describe("nativeTitlebarFor", () => {
  test("coque native sur Mac : la barre de titre est celle de la console", () => {
    expect(nativeTitlebarFor(bridge, { platform: "MacIntel", userAgent: MAC_UA })).toBe("mac");
  });

  test("lit l'UA quand `navigator.platform` est vide", () => {
    expect(nativeTitlebarFor(bridge, { platform: "", userAgent: MAC_UA })).toBe("mac");
  });

  test("coque Windows : la barre de titre est aussi celle de la console", () => {
    expect(nativeTitlebarFor(bridge, { platform: "Win32", userAgent: WINDOWS_UA })).toBe("windows");
  });

  test("Windows : lit l'UA quand `navigator.platform` est vide", () => {
    expect(nativeTitlebarFor(bridge, { platform: "", userAgent: WINDOWS_UA })).toBe("windows");
  });

  test("ni Mac ni Windows : rien à faire", () => {
    expect(nativeTitlebarFor(bridge, { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBeNull();
  });

  test("Edge ou PWA sur Windows, sans le pont : rien à faire", () => {
    expect(nativeTitlebarFor(null, { platform: "Win32", userAgent: WINDOWS_UA })).toBeNull();
  });

  test("Safari ou PWA sur Mac, sans le pont : rien à faire", () => {
    expect(nativeTitlebarFor(null, { platform: "MacIntel", userAgent: MAC_UA })).toBeNull();
  });
});

describe("applyNativeTitlebar", () => {
  test("sans le pont, le document reste intact", () => {
    setNavigator(MAC_UA, "MacIntel");
    expect(applyNativeTitlebar()).toBeNull();
    expect(document.documentElement.hasAttribute(NATIVE_TITLEBAR_ATTRIBUTE)).toBe(false);
    expect(document.querySelector(`[${NATIVE_TITLEBAR_BAND_ATTRIBUTE}]`)).toBeNull();
  });

  test("coque macOS : marque <html> et pose une seule bande, en tête de <body>", () => {
    setNavigator(MAC_UA, "MacIntel");
    window.__OHB_NATIVE__ = bridge;
    const existing = document.createElement("div");
    document.body.prepend(existing);

    expect(applyNativeTitlebar()).toBe("mac");
    applyNativeTitlebar();

    expect(document.documentElement.getAttribute(NATIVE_TITLEBAR_ATTRIBUTE)).toBe("mac");
    const bands = document.querySelectorAll(`[${NATIVE_TITLEBAR_BAND_ATTRIBUTE}]`);
    expect(bands.length).toBe(1);
    expect(document.body.firstElementChild).toBe(bands[0] ?? null);
    expect(bands[0]?.getAttribute("aria-hidden")).toBe("true");
    existing.remove();
  });

  test("coque Windows : marque <html> et pose la bande", () => {
    setNavigator(WINDOWS_UA, "Win32");
    window.__OHB_NATIVE__ = bridge;
    expect(applyNativeTitlebar()).toBe("windows");
    expect(document.documentElement.getAttribute(NATIVE_TITLEBAR_ATTRIBUTE)).toBe("windows");
    expect(document.querySelectorAll(`[${NATIVE_TITLEBAR_BAND_ATTRIBUTE}]`).length).toBe(1);
  });
});
