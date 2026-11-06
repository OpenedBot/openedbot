import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@openedbot/browser-ui-kit";
import type { OpenedbotNativeBridge } from "../../src/lib/platform/native-bridge";
import type { NativeUpdatesBridge } from "../../src/lib/platform/native-updates";
import { offersMacSwitch } from "../../src/lib/platform/desktop-switch";
import { I18nProvider } from "../../src/lib/i18n";
import { ElectronMacSwitchPill } from "../../src/components/desktop-update/electron-switch";
import * as entry from "../../src/components/desktop-update/entry";

const MAC = { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Electron/44.7.0" };
const WINDOWS = { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/44.7.0" };
const LINUX = { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64) Electron/44.7.0" };

/** The Electron shell's bridge: a frozen contract that always says "windows", no update bridge. */
function electron(version: string): OpenedbotNativeBridge {
  return {
    readAccessToken: async () => "token",
    refresh: async () => "token",
    openExternal: async () => undefined,
    signOut: async () => undefined,
    shell: { platform: "windows", version },
  };
}

const originalOpen = window.open;
const originalPlatform = Object.getOwnPropertyDescriptor(window.navigator, "platform");

afterEach(() => {
  delete window.__OPENEDBOT_NATIVE__;
  window.open = originalOpen;
  if (originalPlatform) Object.defineProperty(window.navigator, "platform", originalPlatform);
  else delete (window.navigator as { platform?: string }).platform;
});

describe("passage d'Electron à l'app native sur Mac (D3)", () => {
  test("seule l'app Electron sur Mac, antérieure à 1.1.0, est invitée", () => {
    expect(offersMacSwitch(electron("1.0.3"), MAC)).toBe(true);
    expect(offersMacSwitch(electron("1.0.0"), MAC)).toBe(true);
    expect(offersMacSwitch(electron("1.1.0"), MAC)).toBe(false);
    expect(offersMacSwitch(electron("1.2.0"), MAC)).toBe(false);
    // Electron stays on Windows and Linux.
    expect(offersMacSwitch(electron("1.0.3"), WINDOWS)).toBe(false);
    expect(offersMacSwitch(electron("1.0.3"), LINUX)).toBe(false);
    // A browser, or a version it cannot read.
    expect(offersMacSwitch(null, MAC)).toBe(false);
    expect(offersMacSwitch(electron("dev"), MAC)).toBe(false);
    // The native app has an update bridge: it updates itself.
    const native = { ...electron("1.0.3"), shell: { platform: "macos" as const, version: "1.0.3" }, updates: {} as NativeUpdatesBridge };
    expect(offersMacSwitch(native, MAC)).toBe(false);
  });

  test("la pastille ouvre la page de téléchargement dans le navigateur", () => {
    window.__OPENEDBOT_NATIVE__ = electron("1.0.3");
    const opened: string[] = [];
    window.open = ((url: string) => {
      opened.push(url);
      return {} as Window;
    }) as typeof window.open;
    window.localStorage.setItem("openedbot:locale", "fr");
    // happy-dom reports its own platform: the pill reads `navigator`.
    Object.defineProperty(window.navigator, "platform", { value: MAC.platform, configurable: true });
    render(<I18nProvider><TooltipProvider><ElectronMacSwitchPill /></TooltipProvider></I18nProvider>);
    const pill = screen.getByRole("button", { name: /openedbot 1\.1\.0 pour Mac est disponible/ });
    expect(pill.textContent).toContain("Nouvelle app");
    fireEvent.click(pill);
    expect(opened).toEqual(["https://openedbot.app/fr/download"]);
  });

  test("tant que la 1.1.0 n'est pas publiée, rien n'est monté ni embarqué", () => {
    expect(entry.ELECTRON_MAC_SWITCH_LIVE).toBe(false);
    expect(entry.ElectronMacSwitchPill).toBeNull();
  });
});
