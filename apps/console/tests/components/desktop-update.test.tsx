import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@openedbot/browser-ui-kit";
import type { RosterDto } from "@openedbot/contracts-api";
import type { OpenedbotNativeBridge } from "../../src/lib/platform/native-bridge";
import type { NativeUpdateState, NativeUpdatesBridge } from "../../src/lib/platform/native-updates";
import { resetNativeUpdates } from "../../src/lib/platform/native-updates";
import { reportClientUpdateRequired, resetClientUpdateRequired } from "../../src/lib/platform/client-update";
import { I18nProvider } from "../../src/lib/i18n";
import { queryKeys } from "../../src/lib/api";
import { useRunInProgress } from "../../src/lib/run/run-in-progress";
import { UpdateMenuRow, UpdatePill } from "../../src/components/desktop-update/update-pill";
import { UpdateDialog } from "../../src/components/desktop-update/update-dialog";
import { DesktopUpdateRequired } from "../../src/components/desktop-update/update-required";
import { RUNS_UNKNOWN_AFTER_MS, useRunsInProgress, useUpdateDialog } from "../../src/components/desktop-update/update-hooks";
import { menuRowVersion, pillView, runsInProgress, seenVersion } from "../../src/components/desktop-update/update-model";
import * as entry from "../../src/components/desktop-update/entry";
import { ClientUpdateGate } from "../../src/components/client-update-required";

type Phase = NativeUpdateState["phase"];

function state(phase: Phase, extra: Partial<NativeUpdateState> = {}): NativeUpdateState {
  return { phase, required: null, lastError: null, autoInstall: true, lastCheck: null, ...extra };
}

const ready = (version = "0.0.17") => state({ status: "ready", version });

/** A shell's update bridge driven by the test. */
function fakeUpdates(initial: NativeUpdateState) {
  let current = initial;
  const listeners = new Set<(state: NativeUpdateState) => void>();
  const calls = { install: [] as string[], check: 0, required: [] as (string | null)[], runs: [] as (number | null)[] };
  let refuse: string | null = null;
  const updates: NativeUpdatesBridge = {
    onState: (listener) => {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    check: async () => { calls.check += 1; },
    install: async (version) => {
      calls.install.push(version);
      if (refuse) throw Object.assign(new Error(refuse), { code: refuse });
      await new Promise(() => undefined); // the shell restarts: never resolves
    },
    reportRequired: async (minimum) => { calls.required.push(minimum); },
    reportRuns: async (count) => { calls.runs.push(count); },
    setAutoInstall: async () => undefined,
    onMenu: () => () => undefined,
  };
  return {
    updates,
    calls,
    emit: (next: NativeUpdateState) => {
      current = next;
      act(() => { for (const listener of listeners) listener(next); });
    },
    refuseWith: (code: string) => { refuse = code; },
  };
}

function install(updates: NativeUpdatesBridge) {
  const bridge: OpenedbotNativeBridge = {
    readAccessToken: async () => "token",
    refresh: async () => "token",
    openExternal: async () => undefined,
    signOut: async () => undefined,
    shell: { platform: "macos", version: "0.0.16" },
    updates,
  };
  window.__OPENEDBOT_NATIVE__ = bridge;
}

function roster(running: number): RosterDto {
  const bot = (id: string, isRunning: boolean) => ({ id, running: isRunning, archivedAt: null, deletedAt: null });
  return { sections: [], bots: Array.from({ length: 3 }, (_, index) => bot(`b${index}`, index < running)) } as unknown as RosterDto;
}

function wrap(children: ReactNode, client = new QueryClient()) {
  window.localStorage.setItem("openedbot:locale", "fr");
  window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: "native" }));
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider><TooltipProvider>{children}</TooltipProvider></I18nProvider>
    </QueryClientProvider>,
  );
}

/** A cache the test fills itself: no refetch on mount races the data it sets. */
const cachedOnly = () => new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });

// The roster key depends on the active organization: the session is in place before any key is read.
const signIn = () => window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: "native" }));

// Stores shared with the other test files of the run: start from a clean slate.
beforeEach(() => {
  useRunInProgress.getState().setRunning(false);
  useUpdateDialog.getState().close();
});

afterEach(() => {
  delete window.__OPENEDBOT_NATIVE__;
  resetNativeUpdates();
  resetClientUpdateRequired();
  useUpdateDialog.getState().close();
  useRunInProgress.getState().setRunning(false);
});

describe("état → pastille", () => {
  test("cachée au repos, pendant la recherche, une version annoncée, une erreur, une installation et quand c'est requis", () => {
    for (const phase of [
      { status: "idle" },
      { status: "checking" },
      { status: "available", version: "0.0.17" },
      { status: "error", code: "FEED_UNREACHABLE" },
      { status: "installing", version: "0.0.17" },
    ] as Phase[]) {
      expect(pillView(state(phase))).toEqual({ kind: "hidden" });
    }
    expect(pillView(null)).toEqual({ kind: "hidden" });
    expect(pillView(state({ status: "ready", version: "0.0.17" }, { required: { reason: "api", minimum: null } }))).toEqual({ kind: "hidden" });
  });

  test("un anneau pendant le téléchargement, avec le pourcentage quand le total est connu", () => {
    expect(pillView(state({ status: "downloading", version: "0.0.17", downloaded: 42, total: 100 }))).toEqual({ kind: "downloading", version: "0.0.17", percent: 42 });
    expect(pillView(state({ status: "downloading", version: "0.0.17", downloaded: 42, total: null }))).toEqual({ kind: "downloading", version: "0.0.17", percent: null });
  });

  test("la pastille bleue une fois prête, et la ligne du menu du compte", () => {
    expect(pillView(ready())).toEqual({ kind: "ready", version: "0.0.17" });
    expect(menuRowVersion(ready())).toBe("0.0.17");
    expect(menuRowVersion(state({ status: "downloading", version: "0.0.17", downloaded: 1, total: 2 }))).toBeNull();
  });

  test("la version vue : la même, remplacée (prête ou en route) ou retirée", () => {
    expect(seenVersion("0.0.17", ready())).toEqual({ kind: "same" });
    expect(seenVersion("0.0.17", ready("0.0.18"))).toEqual({ kind: "replaced", version: "0.0.18", ready: true, percent: null });
    expect(seenVersion("0.0.17", state({ status: "downloading", version: "0.0.18", downloaded: 1, total: 4 }))).toEqual({ kind: "replaced", version: "0.0.18", ready: false, percent: 25 });
    expect(seenVersion("0.0.17", state({ status: "idle" }))).toEqual({ kind: "gone" });
  });

  test("les runs en cours : le roster, et au moins un si le fil ouvert en a un", () => {
    expect(runsInProgress(undefined, false)).toBe(0);
    expect(runsInProgress(roster(2), false)).toBe(2);
    expect(runsInProgress(roster(0), true)).toBe(1);
    const archived = { sections: [], bots: [{ id: "a", running: true, archivedAt: "2026-01-01", deletedAt: null }] } as unknown as RosterDto;
    expect(runsInProgress(archived, false)).toBe(0);
  });
});

describe("runs en cours lus par la mise à jour", () => {
  function Runs() {
    const runs = useRunsInProgress();
    return <p data-runs="">{runs === null ? "unknown" : String(runs)}</p>;
  }
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("sans session : zéro ; session sans roster lisible : inconnu ; roster lu : son compte", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    const signedOut = render(<QueryClientProvider client={new QueryClient()}><Runs /></QueryClientProvider>);
    expect(signedOut.container.textContent).toBe("0");
    signedOut.unmount();
    signIn();
    const unknown = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Runs /></QueryClientProvider>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(unknown.container.textContent).toBe("unknown");
    unknown.unmount();
    const client = cachedOnly();
    client.setQueryData(queryKeys.roster, roster(2));
    const known = render(<QueryClientProvider client={client}><Runs /></QueryClientProvider>);
    expect(known.container.textContent).toBe("2");
    known.unmount();
  });

  test("un compte en cache expire seul quand le roster n'est plus relu (panne, hors ligne)", async () => {
    signIn();
    const client = cachedOnly();
    client.setQueryData(queryKeys.roster, roster(0), { updatedAt: Date.now() - RUNS_UNKNOWN_AFTER_MS + 60 });
    const view = render(<QueryClientProvider client={client}><Runs /></QueryClientProvider>);
    expect(view.container.textContent).toBe("0");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    expect(view.container.textContent).toBe("unknown");
    view.unmount();
  });
});

describe("pastille rendue", () => {
  test("rien sans état, puis l'anneau, puis « Mettre à jour » qui ouvre le dialogue sans redémarrer", () => {
    const shell = fakeUpdates(state({ status: "idle" }));
    install(shell.updates);
    const view = wrap(<UpdatePill />);
    expect(view.container.querySelector("[data-desktop-update-pill]")).toBeNull();
    shell.emit(state({ status: "downloading", version: "0.0.17", downloaded: 42, total: 100 }));
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Téléchargement de la mise à jour… 42 %");
    shell.emit(ready());
    const pill = screen.getByRole("button", { name: /Mettre à jour/ });
    expect(pill.className).toContain("bg-info-soft");
    expect(pill.className).toContain("text-info-700");
    expect(pill.className).not.toMatch(/\bprimary\b/);
    fireEvent.click(pill);
    expect(useUpdateDialog.getState().version).toBe("0.0.17");
    expect(shell.calls.install).toEqual([]);
    view.unmount();
  });

  test("la ligne « Nouvelle mise à jour disponible » ferme le menu et ouvre le dialogue", () => {
    const shell = fakeUpdates(ready());
    install(shell.updates);
    let closed = false;
    const view = wrap(<UpdateMenuRow mobileDrawer={false} onSelect={() => { closed = true; }} />);
    expect(screen.getByText("Nouvelle mise à jour disponible")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Installer" }));
    expect(closed).toBe(true);
    expect(useUpdateDialog.getState().version).toBe("0.0.17");
    view.unmount();
  });
});

describe("dialogue « Mise à jour prête » : rien sans consentement", () => {
  test("« Plus tard » ferme sans rien installer", () => {
    const shell = fakeUpdates(ready());
    install(shell.updates);
    const view = wrap(<UpdateDialog />);
    act(() => useUpdateDialog.getState().open("0.0.17"));
    expect(screen.getByText(/Redémarrer pour installer openedbot 0\.0\.17\. Vos bots et votre travail seront là où vous les avez laissés\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Plus tard" }));
    expect(useUpdateDialog.getState().version).toBeNull();
    expect(shell.calls.install).toEqual([]);
    view.unmount();
  });

  test("« Redémarrer » attend la fin des runs, puis installe la version vue", async () => {
    const shell = fakeUpdates(ready());
    install(shell.updates);
    signIn();
    const client = cachedOnly();
    client.setQueryData(queryKeys.roster, roster(2));
    const view = wrap(<UpdateDialog />, client);
    act(() => useUpdateDialog.getState().open("0.0.17"));
    fireEvent.click(screen.getByRole("button", { name: "Redémarrer" }));
    expect(screen.getByText("En attente de la fin de 2 runs…")).toBeTruthy();
    expect(shell.calls.install).toEqual([]);
    // React Query tells its observers on the next tick: wait for the dialog to see the runs end.
    act(() => { client.setQueryData(queryKeys.roster, roster(0)); });
    await waitFor(() => expect(shell.calls.install).toEqual(["0.0.17"]));
    expect(screen.getByText("Redémarrage…")).toBeTruthy();
    view.unmount();
  });

  test("« Redémarrer quand même » n'attend pas", () => {
    const shell = fakeUpdates(ready());
    install(shell.updates);
    signIn();
    const client = cachedOnly();
    client.setQueryData(queryKeys.roster, roster(1));
    const view = wrap(<UpdateDialog />, client);
    act(() => useUpdateDialog.getState().open("0.0.17"));
    fireEvent.click(screen.getByRole("button", { name: "Redémarrer" }));
    expect(screen.getByText("En attente de la fin de 1 run…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Redémarrer quand même" }));
    expect(shell.calls.install).toEqual(["0.0.17"]);
    view.unmount();
  });

  test("une version plus récente arrivée entre-temps est nommée, et c'est elle qui s'installe", () => {
    const shell = fakeUpdates(ready());
    install(shell.updates);
    const view = wrap(<UpdateDialog />);
    act(() => useUpdateDialog.getState().open("0.0.17"));
    shell.emit(state({ status: "downloading", version: "0.0.18", downloaded: 1, total: 2 }));
    expect(screen.getByRole("button", { name: "Redémarrer" }).hasAttribute("disabled")).toBe(true);
    shell.emit(ready("0.0.18"));
    expect(screen.getByText(/c’est openedbot 0\.0\.18 qui s’installera/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Redémarrer" }));
    expect(shell.calls.install).toEqual(["0.0.18"]);
    view.unmount();
  });

  test("la coque refuse une version dépassée : le dialogue le dit, rien n'est installé", async () => {
    const shell = fakeUpdates(ready());
    shell.refuseWith("UPDATE_SUPERSEDED");
    install(shell.updates);
    const view = wrap(<UpdateDialog />);
    act(() => useUpdateDialog.getState().open("0.0.17"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Redémarrer" })); });
    expect(screen.getByText(/Une version plus récente est sortie entre-temps : elle se télécharge, et rien n’a été installé/)).toBeTruthy();
    view.unmount();
  });
});

describe("mise à jour requise (app Tauri)", () => {
  test("le plancher du manifeste : l'écran, puis l'installation au clic une fois prête", () => {
    const shell = fakeUpdates(state({ status: "downloading", version: "0.0.18", downloaded: 50, total: 100 }, { required: { reason: "minimumVersion", minimum: "0.0.17" } }));
    install(shell.updates);
    const view = wrap(<DesktopUpdateRequired api={null} />);
    expect(screen.getByText("Mise à jour requise")).toBeTruthy();
    expect(screen.getByText("openedbot 0.0.17 ou plus récent est nécessaire pour continuer.")).toBeTruthy();
    expect(screen.getByText("Version installée : 0.0.16.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mettre à jour maintenant" }));
    expect(screen.getByRole("button", { name: /Téléchargement… 50 %/ })).toBeTruthy();
    expect(shell.calls.install).toEqual([]);
    shell.emit(ready("0.0.18"));
    expect(shell.calls.install).toEqual(["0.0.18"]);
    view.unmount();
  });

  test("des runs en cours : un avertissement d'abord, puis « Mettre à jour quand même »", () => {
    const shell = fakeUpdates(ready("0.0.18"));
    shell.emit(state({ status: "ready", version: "0.0.18" }, { required: { reason: "buildAge", minimum: null } }));
    install(shell.updates);
    signIn();
    const client = cachedOnly();
    client.setQueryData(queryKeys.roster, roster(1));
    const view = wrap(<DesktopUpdateRequired api={null} />, client);
    expect(screen.getByText(/trop ancienne/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mettre à jour maintenant" }));
    expect(screen.getByText(/1 run est en cours/)).toBeTruthy();
    expect(shell.calls.install).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Mettre à jour quand même" }));
    expect(shell.calls.install).toEqual(["0.0.18"]);
    view.unmount();
  });

  test("rien de téléchargé : le clic lance la recherche ; une erreur montre le lien de téléchargement", () => {
    const shell = fakeUpdates(state({ status: "idle" }, { required: { reason: "api", minimum: "0.0.17" } }));
    install(shell.updates);
    const view = wrap(<DesktopUpdateRequired api={{ minVersion: "0.0.17", version: "0.0.16" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Mettre à jour maintenant" }));
    expect(shell.calls.check).toBe(1);
    shell.emit(state({ status: "error", code: "FEED_UNREACHABLE" }, { required: { reason: "api", minimum: "0.0.17" }, lastError: "FEED_UNREACHABLE" }));
    expect(screen.getByRole("button", { name: "Télécharger la dernière version" })).toBeTruthy();
    view.unmount();
  });

  test("déjà en erreur au clic (pas de flux, deb) : la même erreur, republiée, rend le bouton", () => {
    const failed = () => state({ status: "error", code: "FEED_UNREACHABLE" }, { required: { reason: "api", minimum: "0.0.17" }, lastError: "FEED_UNREACHABLE" });
    const shell = fakeUpdates(failed());
    install(shell.updates);
    const view = wrap(<DesktopUpdateRequired api={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Mettre à jour maintenant" }));
    expect(shell.calls.check).toBe(1);
    expect(screen.getByRole("button", { name: /Préparation/ }).hasAttribute("disabled")).toBe(true);
    shell.emit(failed());
    expect(screen.getByRole("button", { name: "Mettre à jour maintenant" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Télécharger la dernière version" })).toBeTruthy();
    view.unmount();
  });

  test("une recherche déjà en cours au clic, qui ne trouve rien, rend aussi le bouton", () => {
    const shell = fakeUpdates(state({ status: "checking" }, { required: { reason: "api", minimum: "0.0.17" } }));
    install(shell.updates);
    const view = wrap(<DesktopUpdateRequired api={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Mettre à jour maintenant" }));
    expect(shell.calls.check).toBe(0);
    shell.emit(state({ status: "idle" }, { required: { reason: "api", minimum: "0.0.17" } }));
    expect(screen.getByRole("button", { name: "Mettre à jour maintenant" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/Aucune version plus récente n’est proposée/)).toBeTruthy();
    view.unmount();
  });

  test("une recherche qui ne trouve rien rend le bouton et propose le site", () => {
    const shell = fakeUpdates(state({ status: "idle" }, { required: { reason: "api", minimum: "0.0.17" } }));
    install(shell.updates);
    const view = wrap(<DesktopUpdateRequired api={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Mettre à jour maintenant" }));
    expect(screen.getByRole("button", { name: /Préparation/ }).hasAttribute("disabled")).toBe(true);
    shell.emit(state({ status: "checking" }, { required: { reason: "api", minimum: "0.0.17" } }));
    shell.emit(state({ status: "idle" }, { required: { reason: "api", minimum: "0.0.17" }, lastCheck: "2027-01-15T08:00:00.5Z" }));
    expect(screen.getByRole("button", { name: "Mettre à jour maintenant" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/Aucune version plus récente n’est proposée/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Télécharger la dernière version" })).toBeTruthy();
    view.unmount();
  });

  test("le dialogue de redémarrage se ferme quand l'écran requis prend la place", () => {
    const shell = fakeUpdates(ready());
    install(shell.updates);
    const view = wrap(<UpdateDialog />);
    act(() => useUpdateDialog.getState().open("0.0.17"));
    expect(screen.getByText("Mise à jour prête")).toBeTruthy();
    shell.emit(state({ status: "ready", version: "0.0.17" }, { required: { reason: "buildAge", minimum: null } }));
    expect(screen.queryByText("Mise à jour prête")).toBeNull();
    expect(useUpdateDialog.getState().version).toBeNull();
    view.unmount();
  });

  test("le 426 de l'API est transmis à la coque, version minimale comprise", () => {
    const shell = fakeUpdates(state({ status: "idle" }));
    install(shell.updates);
    reportClientUpdateRequired({ minVersion: "0.0.17", version: "0.0.16" });
    expect(shell.calls.required).toEqual(["0.0.17"]);
  });
});

describe("le build web ne rend rien de tout cela", () => {
  test("hors build desktop, les points de montage valent null", () => {
    expect(entry.DesktopUpdatePill).toBeNull();
    expect(entry.DesktopUpdateMenuRow).toBeNull();
    expect(entry.DesktopUpdateLayer).toBeNull();
    expect(entry.DesktopUpdateRequired).toBeNull();
  });

  test("une coque qui se dirait « requise » ne remplace pas l'app web : seul le 426 compte", () => {
    const shell = fakeUpdates(state({ status: "idle" }, { required: { reason: "minimumVersion", minimum: "9.0.0" } }));
    install(shell.updates);
    const view = wrap(<ClientUpdateGate><p>console</p></ClientUpdateGate>);
    expect(screen.getByText("console")).toBeTruthy();
    expect(view.queryByRole("alertdialog")).toBeNull();
    view.unmount();
  });

  test("sans pont de mise à jour, la pastille et la ligne du menu ne rendent rien", () => {
    const view = wrap(<><UpdatePill /><UpdateMenuRow mobileDrawer={false} onSelect={() => undefined} /></>);
    expect(view.container.innerHTML).toBe("");
    view.unmount();
  });
});
