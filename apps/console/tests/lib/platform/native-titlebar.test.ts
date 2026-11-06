import { afterEach, describe, expect, test } from "bun:test";
import type { OpenedbotNativeBridge } from "../../../src/lib/platform/native-bridge";
import {
  applyNativeTitlebar,
  NATIVE_TITLEBAR_ATTRIBUTE,
  NATIVE_TITLEBAR_BAND_ATTRIBUTE,
  nativeTitlebarFor,
} from "../../../src/lib/platform/native-titlebar";
import { asDesktopBuild } from "../../support/desktop-build";

function bridge(platform: OpenedbotNativeBridge["shell"]["platform"]): OpenedbotNativeBridge {
  return {
    readAccessToken: async () => "token",
    refresh: async () => "token",
    openExternal: async () => undefined,
    signOut: async () => undefined,
    shell: { platform, version: "1.1.0" },
  };
}

afterEach(() => {
  delete window.__OPENEDBOT_NATIVE__;
  document.documentElement.removeAttribute(NATIVE_TITLEBAR_ATTRIBUTE);
  for (const band of document.querySelectorAll(`[${NATIVE_TITLEBAR_BAND_ATTRIBUTE}]`)) band.remove();
});

describe("nativeTitlebarFor", () => {
  test("app sur Mac : la barre de titre est celle de la console", () => {
    expect(nativeTitlebarFor(bridge("macos"))).toBe("mac");
  });

  test("app sur Windows : la barre de titre est aussi celle de la console", () => {
    expect(nativeTitlebarFor(bridge("windows"))).toBe("windows");
  });

  test("app sous Linux : la fenêtre garde la barre du système", () => {
    expect(nativeTitlebarFor(bridge("linux"))).toBeNull();
  });

  test("navigateur ou PWA, sans le pont : rien à faire", () => {
    expect(nativeTitlebarFor(null)).toBeNull();
  });
});

describe("applyNativeTitlebar, build web", () => {
  test("un pont posé par la page hôte est ignoré : le document reste intact", () => {
    window.__OPENEDBOT_NATIVE__ = bridge("macos");
    expect(applyNativeTitlebar()).toBeNull();
    expect(document.documentElement.hasAttribute(NATIVE_TITLEBAR_ATTRIBUTE)).toBe(false);
    expect(document.querySelector(`[${NATIVE_TITLEBAR_BAND_ATTRIBUTE}]`)).toBeNull();
  });
});

describe("applyNativeTitlebar, build desktop", () => {
  asDesktopBuild();

  test("sans le pont, le document reste intact", () => {
    expect(applyNativeTitlebar()).toBeNull();
    expect(document.documentElement.hasAttribute(NATIVE_TITLEBAR_ATTRIBUTE)).toBe(false);
    expect(document.querySelector(`[${NATIVE_TITLEBAR_BAND_ATTRIBUTE}]`)).toBeNull();
  });

  test("macOS : marque <html> et pose une seule bande, en tête de <body>", () => {
    window.__OPENEDBOT_NATIVE__ = bridge("macos");
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

  test("Windows : marque <html> et pose la bande", () => {
    window.__OPENEDBOT_NATIVE__ = bridge("windows");
    expect(applyNativeTitlebar()).toBe("windows");
    expect(document.documentElement.getAttribute(NATIVE_TITLEBAR_ATTRIBUTE)).toBe("windows");
    expect(document.querySelectorAll(`[${NATIVE_TITLEBAR_BAND_ATTRIBUTE}]`).length).toBe(1);
  });
});
