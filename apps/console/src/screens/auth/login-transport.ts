import { ApiError, api, isApiUnavailable } from "../../lib/api";
import type { NativeAuthBridge, NativeSigninState } from "../../lib/platform/native-bridge";

/**
 * Où part la connexion de l'écran `/login`. Un seul écran, deux transports :
 * - **web** : l'API directement, la session devient un cookie ;
 * - **native** : la coque desktop (`__OPENEDBOT_NATIVE__.auth`), qui garde le PKCE
 *   et ses jetons dans son processus principal. Elle répond par des états
 *   (`onState`) ; ce module les remet en promesses pour que l'écran n'ait
 *   qu'une seule façon d'attendre.
 */

/** Un refus nommé par son code (`login.failed.<code>`), comme une `ApiError`. */
export class LoginFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LoginFailure";
  }
}

/** Une panne de transport ne doit jamais ressembler à un refus d'identifiants. */
export function loginFailureCode(error: unknown, fallback: string): string {
  if (error instanceof LoginFailure) return error.code;
  if (isApiUnavailable(error) || (error instanceof ApiError && error.status >= 500)) return "SERVICE_UNAVAILABLE";
  return error instanceof ApiError && error.code ? error.code : fallback;
}

type BusyStatus = "sending" | "verifying" | "waiting";

/** La coque répond en 15 s par requête, deux requêtes au plus pour vérifier un code. */
const NATIVE_STEP_TIMEOUT_MS = 45_000;

/**
 * Lance une action de la coque et attend son issue. `onState` rejoue d'abord
 * le dernier état connu : tant que l'état « en cours » de CETTE action n'est
 * pas passé, un état plus ancien (une erreur d'avant) ne compte pas.
 */
export function runNativeStep(
  auth: NativeAuthBridge,
  start: () => Promise<void>,
  busy: BusyStatus,
  settled: (state: NativeSigninState) => boolean,
  timeoutMs: number | null = NATIVE_STEP_TIMEOUT_MS,
): Promise<NativeSigninState> {
  return new Promise((resolve, reject) => {
    let started = false;
    let done = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      outcome();
    };
    unsubscribe = auth.onState((state) => {
      if (state.status === busy) {
        started = true;
        return;
      }
      if (!started) return;
      if (state.status === "error") finish(() => reject(new LoginFailure(state.code)));
      else if (settled(state)) finish(() => resolve(state));
    });
    // Un rejeu synchrone ne peut pas être terminal (il faudrait d'abord l'état
    // « en cours ») ; la garde reste pour ne jamais lancer une action close.
    if (done) {
      unsubscribe();
      return;
    }
    if (timeoutMs !== null) timer = setTimeout(() => finish(() => reject(new LoginFailure("SERVICE_UNAVAILABLE"))), timeoutMs);
    start().catch((error: unknown) => finish(() => reject(error)));
  });
}

export type LoginTransport = {
  native: NativeAuthBridge | null;
  requestCode(email: string, locale: "fr" | "en"): Promise<void>;
  /** Web : la session est posée au retour. Coque : elle charge la console connectée, la page part. */
  verifyCode(email: string, code: string): Promise<void>;
};

export function loginTransport(native: NativeAuthBridge | null): LoginTransport {
  if (!native) {
    return {
      native: null,
      requestCode: async (email, locale) => {
        await api.authEmailCode(email, locale);
      },
      verifyCode: async (email, code) => {
        await api.authEmailLogin(email, code);
      },
    };
  }
  return {
    native,
    requestCode: async (email, locale) => {
      await runNativeStep(native, () => native.requestEmailCode(email, locale), "sending", (state) => state.status === "code_sent");
    },
    verifyCode: async (email, code) => {
      // Le succès n'a pas d'état : la coque remplace la page. Un retour à
      // `idle` (tentative annulée par la coque) rend simplement la main.
      await runNativeStep(native, () => native.verifyEmailCode(email, code), "verifying", (state) => state.status === "idle");
    },
  };
}
