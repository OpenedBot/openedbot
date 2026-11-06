import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen, once } from "@tauri-apps/api/event";
import { commands, events, installTauriRuntime, type BridgeError } from "@openedbot/contracts-native-bridge";
import type { NativeAuthBridge, NativeSigninState, OpenedbotNativeBridge } from "./native-bridge";

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
type TauriShellInfo = { platform: string; version: string; bridgeVersion: number };

declare global {
  interface Window {
    __OPENEDBOT_SHELL__?: TauriShellInfo;
    __TAURI_INTERNALS__?: unknown;
  }
}

/** La version du pont que cette console sait parler (`BRIDGE_VERSION` de `bridge.rs`). */
export const SUPPORTED_BRIDGE_VERSION = 1;

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
    readAccessToken: async () => unwrap(await commands.readAccessToken()),
    refresh: async () => unwrap(await commands.refresh()),
    openExternal: async (url) => {
      unwrap(await commands.openExternal(url));
    },
    signOut: async () => {
      unwrap(await commands.signOut());
    },
    // Le contrat du pont fige `platform` à "windows" (`native-titlebar.ts`
    // lit le système dans l'agent utilisateur) : la coque Tauri le garde.
    shell: { platform: "windows", version: shell.version },
    auth,
  };
}
