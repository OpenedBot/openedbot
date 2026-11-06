import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen, once } from "@tauri-apps/api/event";
import { commands, events, installTauriRuntime, type BridgeError, type Platform } from "@openedbot/contracts-native-bridge";
import type { NativeAuthBridge, NativeSigninState, OpenedbotNativeBridge } from "./native-bridge";
import type { NativeUpdateState, NativeUpdatesBridge } from "./native-updates";
import { installTauriShell } from "./tauri-shell";

/**
 * Le pont natif de l'app de bureau Tauri (`apps/desktop-tauri`), construit sur
 * les commandes Rust typées (`@openedbot/contracts-native-bridge`, généré par
 * tauri-specta). Il prend la forme du pont Electron (`OpenedbotNativeBridge`) :
 * le reste de la console ne voit pas la différence.
 *
 * N'entre que dans le build desktop (`VITE_OPENEDBOT_SHELL=tauri`,
 * `native-bridge.ts`) : le build web n'embarque ni ce module ni `@tauri-apps/api`.
 */

/** Ce que la coque pose avant le premier script de la page (`initialization_script`, `src-tauri/src/lib.rs`). */
type TauriShellInfo = { platform: Platform; version: string; bridgeVersion: number };

declare global {
  interface Window {
    __OPENEDBOT_SHELL__?: TauriShellInfo;
    __TAURI_INTERNALS__?: unknown;
    __OPENEDBOT_API_ORIGIN__?: string;
  }
}

/** La version du pont que cette console sait parler (`BRIDGE_VERSION` de `bridge.rs`). */
export const SUPPORTED_BRIDGE_VERSION = 2;

/** Un refus nommé de la coque (`BridgeError` côté Rust) : jamais un jeton, jamais un corps. */
export class NativeBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeBridgeError";
  }
}

type Outcome<T> = { status: "ok"; data: T } | { status: "error"; error: BridgeError };

function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.status === "ok") return outcome.data;
  throw new NativeBridgeError(outcome.error.code, outcome.error.message);
}

/**
 * Le pont, ou `null` hors de l'app Tauri (navigateur, tests) et devant une
 * coque d'une autre version : une méthode absente donnerait sinon un
 * plantage au hasard (ADR 0001, 4.3 « Pont natif »).
 */
export function createTauriBridge(): OpenedbotNativeBridge | null {
  const shell = globalThis.window?.__OPENEDBOT_SHELL__;
  if (!shell || !globalThis.window.__TAURI_INTERNALS__) return null;
  if (shell.bridgeVersion !== SUPPORTED_BRIDGE_VERSION) {
    console.error(`[openedbot] native bridge ${shell.bridgeVersion} is not supported (expected ${SUPPORTED_BRIDGE_VERSION})`);
    return null;
  }
  installTauriRuntime({
    invoke: (command, args) => invoke(command, args),
    event: {
      listen: (event, handler) => listen(event, handler),
      once: (event, handler) => once(event, handler),
      emit: (event, payload) => emit(event, payload),
      emitTo: (target, event, payload) => emitTo(target as Parameters<typeof emitTo>[0], event, payload),
    },
  });
  installTauriShell(globalThis.window, globalThis.window.__OPENEDBOT_API_ORIGIN__ ?? "");

  // Un seul abonnement pour la vie de la page : la coque pousse chaque état,
  // et `onState` doit rejouer le dernier aussitôt (contrat d'Electron).
  let last: NativeSigninState | null = null;
  const listeners = new Set<(state: NativeSigninState) => void>();
  const deliver = (state: NativeSigninState) => {
    last = state;
    for (const listener of listeners) listener(state);
  };
  const subscribed = events.signinStateChanged
    .listen((event) => deliver(event.payload as NativeSigninState))
    .then(async () => {
      const current = await commands.signinState();
      if (last === null) deliver(current as NativeSigninState);
    });
  // Une action ne part qu'une fois l'écoute posée : son état « en cours » ne
  // peut pas se perdre avant l'abonnement.
  const afterSubscribe = <T>(action: () => Promise<Outcome<T>>) => subscribed.then(action).then(unwrap);

  const auth: NativeAuthBridge = {
    requestEmailCode: async (email, locale) => {
      await afterSubscribe(() => commands.requestEmailCode(email, locale));
    },
    verifyEmailCode: async (email, code) => {
      await afterSubscribe(() => commands.verifyEmailCode(email, code));
    },
    startGoogle: async () => {
      await afterSubscribe(() => commands.startGoogle());
    },
    cancel: async () => {
      await commands.cancelSignIn();
    },
    onState: (listener) => {
      listeners.add(listener);
      if (last) listener(last);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    updates: createUpdatesBridge(),
    readAccessToken: async () => unwrap(await commands.readAccessToken()),
    refresh: async () => unwrap(await commands.refresh()),
    openExternal: async (url) => {
      unwrap(await commands.openExternal(url));
    },
    signOut: async () => {
      unwrap(await commands.signOut());
    },
    // La coque Tauri dit son vrai système ; celle d'Electron dit toujours "windows".
    shell: { platform: shell.platform, version: shell.version },
    auth,
  };
}

/**
 * Les mises à jour : comme la connexion, un seul abonnement pour la vie de la
 * page, et `onState` rejoue le dernier état aussitôt. Le premier état vient
 * de `update_state` une fois l'écoute posée, pour ne rien perdre entre les deux.
 */
function createUpdatesBridge(): NativeUpdatesBridge {
  let last: NativeUpdateState | null = null;
  const listeners = new Set<(state: NativeUpdateState) => void>();
  const deliver = (state: NativeUpdateState) => {
    last = state;
    for (const listener of listeners) listener(state);
  };
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    void events.updateStateChanged
      .listen((event) => deliver(event.payload as NativeUpdateState))
      .then(async () => {
        const current = await commands.updateState();
        if (last === null) deliver(current as NativeUpdateState);
      })
      .catch((error: unknown) => console.warn("[openedbot] update state unavailable", error));
  };
  return {
    onState: (listener) => {
      listeners.add(listener);
      start();
      if (last) listener(last);
      return () => {
        listeners.delete(listener);
      };
    },
    check: () => commands.checkForUpdates(),
    install: async (version) => {
      unwrap(await commands.installUpdate(version));
    },
    reportRequired: async (minimum) => {
      unwrap(await commands.reportUpdateRequired(minimum));
    },
    reportRuns: async (count) => {
      unwrap(await commands.reportRunsInProgress(count));
    },
    setAutoInstall: (enabled) => commands.setUpdateAutoInstall(enabled),
    onMenu: (listener) => {
      const unlisten = events.updateMenuChosen.listen((event) => listener(event.payload.action));
      return () => {
        void unlisten.then((stop) => stop());
      };
    },
  };
}
