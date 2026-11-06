import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpenedbotNativeBridge } from "../../src/lib/platform/native-bridge";
import { resetNativeNotch, type NativeNotchBridge, type NativeNotchMode, type NativeNotchState } from "../../src/lib/platform/native-notch";
import { I18nProvider } from "../../src/lib/i18n";
import { NotchOnboarding } from "../../src/components/desktop-notch/notch-onboarding";
import { NotchSettings } from "../../src/screens/settings/general/notch";
import * as entry from "../../src/components/desktop-notch/entry";
import { asDesktopBuild } from "../support/desktop-build";

asDesktopBuild();

function notchState(extra: Partial<NativeNotchState> = {}): NativeNotchState {
  return { supported: true, available: true, mode: "window", choicePending: true, demoSupported: true, onboarding: true, cameraHousing: true, ...extra };
}

/** The shell's notch, driven by the test: a choice ends the onboarding, as the shell does. */
function fakeNotch(initial: NativeNotchState) {
  let current = initial;
  const listeners = new Set<(state: NativeNotchState) => void>();
  const calls = { modes: [] as NativeNotchMode[], demos: 0 };
  let refuse = false;
  const notch: NativeNotchBridge = {
    onState: (listener) => {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    setMode: async (mode) => {
      calls.modes.push(mode);
      if (refuse) throw Object.assign(new Error("NOTCH_UNAVAILABLE"), { code: "NOTCH_UNAVAILABLE" });
      current = { ...current, mode, choicePending: false, onboarding: false };
      for (const listener of listeners) listener(current);
      return current;
    },
    playDemo: async () => {
      calls.demos += 1;
      return current;
    },
  };
  return {
    notch,
    calls,
    emit: (next: NativeNotchState) => {
      current = next;
      act(() => {
        for (const listener of listeners) listener(next);
      });
    },
    refuse: () => {
      refuse = true;
    },
  };
}

function install(notch: NativeNotchBridge) {
  const bridge: OpenedbotNativeBridge = {
    readAccessToken: async () => "token",
    refresh: async () => "token",
    openExternal: async () => undefined,
    signOut: async () => undefined,
    shell: { platform: "macos", version: "1.1.4" },
    notch,
  };
  window.__OPENEDBOT_NATIVE__ = bridge;
}

function wrap(children: ReactNode) {
  window.localStorage.setItem("openedbot:locale", "fr");
  return render(<I18nProvider>{children}</I18nProvider>);
}

afterEach(() => {
  // Explicite : le nettoyage automatique de Testing Library ne vaut que pour le premier fichier
  // qui l'importe dans un lot de `bun test`.
  cleanup();
  delete window.__OPENEDBOT_NATIVE__;
  resetNativeNotch();
});

describe("le choix de l'encoche à la première connexion", () => {
  test("ne s'ouvre que quand la coque le demande", async () => {
    const shell = fakeNotch(notchState({ onboarding: false }));
    install(shell.notch);
    wrap(<NotchOnboarding />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByText("openedbot vit aussi dans l’encoche")).toBeNull();
    shell.emit(notchState());
    expect(await screen.findByText("openedbot vit aussi dans l’encoche")).toBeDefined();
  });

  test("la démonstration se joue en haut de l'écran, autour de la caméra ; « Garder l'encoche » est le choix par défaut", async () => {
    const shell = fakeNotch(notchState());
    install(shell.notch);
    wrap(<NotchOnboarding />);
    await screen.findByText("Regardez en haut de votre écran : voici une démonstration.");
    expect(screen.getByText(/autour de la caméra/)).toBeDefined();
    expect(document.querySelector("[data-notch-preview]")).toBeNull();
    expect(screen.getByText(/Réglages › Encoche, ou depuis le menu du Dock/)).toBeDefined();
    const keep = screen.getByText("Garder l’encoche");
    await waitFor(() => expect(document.activeElement).toBe(keep));
    fireEvent.click(keep);
    await waitFor(() => expect(shell.calls.modes).toEqual(["both"]));
    await waitFor(() => expect(screen.queryByText("openedbot vit aussi dans l’encoche")).toBeNull());
  });

  test("sans démonstration possible, un aperçu ; sans encoche de caméra, sous la barre des menus", async () => {
    const shell = fakeNotch(notchState({ demoSupported: false, cameraHousing: false }));
    install(shell.notch);
    wrap(<NotchOnboarding />);
    await screen.findByText("Aperçu ci-dessous.");
    expect(document.querySelector("[data-notch-preview]")).not.toBeNull();
    expect(screen.getByText(/sous la barre des menus/)).toBeDefined();
    expect(screen.queryByText(/autour de la caméra/)).toBeNull();
  });

  test("« Pas maintenant » et Échap gardent la fenêtre ; un clic à côté ne répond rien", async () => {
    const shell = fakeNotch(notchState());
    install(shell.notch);
    wrap(<NotchOnboarding />);
    const dialog = await screen.findByRole("dialog");
    // Le fond de la boîte (son parent, qui appelle `onClose` au clic) : un clic à côté de la feuille.
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shell.calls.modes).toEqual([]);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(shell.calls.modes).toEqual(["window"]));
  });

  test("« Pas maintenant » garde la fenêtre seule", async () => {
    const shell = fakeNotch(notchState());
    install(shell.notch);
    wrap(<NotchOnboarding />);
    fireEvent.click(await screen.findByText("Pas maintenant"));
    await waitFor(() => expect(shell.calls.modes).toEqual(["window"]));
  });

  test("un choix refusé le dit et laisse la feuille ouverte", async () => {
    const shell = fakeNotch(notchState());
    shell.refuse();
    install(shell.notch);
    wrap(<NotchOnboarding />);
    fireEvent.click(await screen.findByText("Garder l’encoche"));
    expect(await screen.findByText("Votre choix n’a pas pu être enregistré. Réessayez.")).toBeDefined();
    expect(screen.getByText("openedbot vit aussi dans l’encoche")).toBeDefined();
  });

  test("le build web n'embarque pas la feuille", () => {
    expect(entry.DesktopNotchOnboarding).toBeNull();
  });
});

describe("Réglages › Encoche", () => {
  test("afficher l'encoche garde la fenêtre et l'encoche ; masquer la fenêtre, l'encoche seule", async () => {
    const shell = fakeNotch(notchState({ choicePending: false, onboarding: false }));
    install(shell.notch);
    wrap(<NotchSettings />);
    const show = await screen.findByRole("switch", { name: "Afficher openedbot dans l’encoche" });
    const hide = screen.getByRole("switch", { name: "Masquer la fenêtre quand l’encoche est active" });
    expect(show.getAttribute("aria-checked")).toBe("false");
    expect((hide as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(show);
    await waitFor(() => expect(shell.calls.modes).toEqual(["both"]));
    await waitFor(() => expect((hide as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(hide);
    await waitFor(() => expect(shell.calls.modes).toEqual(["both", "popup"]));
    fireEvent.click(show);
    await waitFor(() => expect(shell.calls.modes).toEqual(["both", "popup", "window"]));
  });

  test("revoir la démonstration ne change pas le choix", async () => {
    const shell = fakeNotch(notchState({ choicePending: false, onboarding: false, mode: "both" }));
    install(shell.notch);
    wrap(<NotchSettings />);
    fireEvent.click(await screen.findByText("Revoir la démonstration", { selector: "button" }));
    await waitFor(() => expect(shell.calls.demos).toBe(1));
    expect(await screen.findByText("Regardez en haut de votre écran.")).toBeDefined();
    expect(shell.calls.modes).toEqual([]);
  });

  test("sans encoche dans cette version : la ligne d'état, et rien d'activable", async () => {
    const shell = fakeNotch(notchState({ available: false, demoSupported: false, choicePending: false, onboarding: false }));
    install(shell.notch);
    wrap(<NotchSettings />);
    expect(await screen.findByText("L’encoche n’est pas disponible dans cette version.")).toBeDefined();
    expect((screen.getByRole("switch", { name: "Afficher openedbot dans l’encoche" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Revoir la démonstration", { selector: "button" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
