import { ApiError, api, isApiUnavailable } from "../../lib/api";
import type { NativeAuthBridge, NativeSigninState } from "../../lib/platform";

/**
 * Where the `/login` screen's sign-in goes. One screen, two transports:
 * - **web**: the API directly, the session becomes a cookie;
 * - **native**: the desktop shell (`__OPENEDBOT_NATIVE__.auth`), which keeps the PKCE
 *   and its tokens in its main process. It answers with states
 *   (`onState`); this module turns them back into promises so the screen has
 *   only one way to wait.
 */

/** A refusal named by its code (`login.failed.<code>`), like an `ApiError`. */
export class LoginFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LoginFailure";
  }
}

/** A transport failure must never look like a credential refusal. */
export function loginFailureCode(error: unknown, fallback: string): string {
  if (error instanceof LoginFailure) return error.code;
  if (isApiUnavailable(error) || (error instanceof ApiError && error.status >= 500)) return "SERVICE_UNAVAILABLE";
  return error instanceof ApiError && error.code ? error.code : fallback;
}

type BusyStatus = "sending" | "verifying" | "waiting";

/** The shell answers in 15 s per request, two requests at most to verify a code. */
const NATIVE_STEP_TIMEOUT_MS = 45_000;

/**
 * Starts a shell action and waits for its outcome. `onState` first replays
 * the last known state: until THIS action's « en cours » state has
 * passed, an older state (an earlier error) does not count.
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
    // A synchronous replay cannot be terminal (the « en cours » state
    // would have to come first); the guard stays so a closed action is never started.
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
  /**
   * `onAccepted` fires as soon as the code is accepted, before the page
   * leaves. Web: the session is saved `CODE_ACCEPTED_HOLD_MS` later, then the
   * root guard navigates. Shell: the tokens are stored, the shell holds as long
   * (`CODE_ACCEPTED_HOLD` in `auth.rs`) and loads the connected console.
   */
  verifyCode(email: string, code: string, onAccepted: () => void): Promise<void>;
};

/** How long `/login` shows an accepted code before the workspace replaces it. */
export const CODE_ACCEPTED_HOLD_MS = 600;

export function loginTransport(native: NativeAuthBridge | null): LoginTransport {
  if (!native) {
    return {
      native: null,
      requestCode: async (email, locale) => {
        await api.authEmailCode(email, locale);
      },
      verifyCode: async (email, code, onAccepted) => {
        await api.authEmailLogin(email, code, async () => {
          onAccepted();
          await new Promise((resolve) => setTimeout(resolve, CODE_ACCEPTED_HOLD_MS));
        });
      },
    };
  }
  return {
    native,
    requestCode: async (email, locale) => {
      await runNativeStep(native, () => native.requestEmailCode(email, locale), "sending", (state) => state.status === "code_sent");
    },
    verifyCode: async (email, code, onAccepted) => {
      // Success has no state of its own: `idle` once the tokens are stored, and
      // the shell replaces the page after its hold. An attempt the shell cancels
      // also returns to `idle`, but the screen offers no cancel while a code is
      // checked.
      await runNativeStep(native, () => native.verifyEmailCode(email, code), "verifying", (state) => state.status === "idle");
      onAccepted();
    },
  };
}
