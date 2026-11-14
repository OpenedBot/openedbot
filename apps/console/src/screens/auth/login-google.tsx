import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AuthClaimDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../lib/api";
import { leaveTo } from "../../lib/platform/open-external";
import type { NativeAuthBridge } from "../../lib/platform";
import { APP_HOME_HREF } from "../../lib/session/public-landing-gate";
import { loginFailureCode, runNativeStep } from "./login-transport";

/**
 * « Continuer avec Google », on both transports of the `/login` screen.
 *
 * - **Browser**: the window leaves for Google in the SAME tab
 *   (`leaveTo`) with `returnTo = here`, after remembering its attempt in
 *   `sessionStorage`; on return, the screen resumes it (spinner, `authClaim`,
 *   redirect). The session token never travels through a URL.
 * - **Desktop shell**: the shell opens the system browser and polls the
 *   attempt itself; the screen only waits for its outcome (`waiting`, then an error,
 *   a return to `idle` if one cancels, or the connected console).
 */

/** The attempt in progress, remembered for the round trip to Google (web mode, same tab). */
export const PENDING_ATTEMPT_KEY = "openedbot:auth-attempt";

function readPendingAttempt(): string | null {
  try {
    return globalThis.window?.sessionStorage.getItem(PENDING_ATTEMPT_KEY) ?? null;
  } catch {
    return null;
  }
}

function writePendingAttempt(id: string | null) {
  try {
    if (id === null) globalThis.window?.sessionStorage.removeItem(PENDING_ATTEMPT_KEY);
    else globalThis.window?.sessionStorage.setItem(PENDING_ATTEMPT_KEY, id);
  } catch {
    // Without sessionStorage, resume on return will not happen; the in-place poll stays possible.
  }
}

export function clearPendingAttempt(): void {
  writePendingAttempt(null);
}

export type GoogleSignIn = {
  /** An attempt is open: the screen shows the wait and « Annuler ». */
  waiting: boolean;
  starting: boolean;
  start(): void;
  cancel(): void;
};

export function useGoogleSignIn(native: NativeAuthBridge | null, onFailure: (code: string | null) => void): GoogleSignIn {
  // On mount (web): an attempt left by the trip to Google? That is
  // the same tab coming back, we resume it until the token.
  const [attempt, setAttempt] = useState<string | null>(() => (native ? null : readPendingAttempt()));
  const [nativeWaiting, setNativeWaiting] = useState(false);

  const start = useMutation({
    mutationFn: async () => {
      if (native) {
        setNativeWaiting(true);
        // No timeout here: the shell gives up on its own after 5 minutes.
        await runNativeStep(native, () => native.startGoogle(), "waiting", (state) => state.status === "idle", null);
        return null;
      }
      const started = await api.authStart(globalThis.window?.location.href);
      writePendingAttempt(started.attemptId);
      leaveTo(started.authorizeUrl);
      // The window leaves: the spinner holds until it is replaced.
      return started.attemptId;
    },
    onMutate: () => onFailure(null),
    onSuccess: (attemptId) => {
      if (attemptId) setAttempt(attemptId);
    },
    onError: (error) => onFailure(loginFailureCode(error, "AUTH_EXCHANGE_FAILED")),
    onSettled: () => setNativeWaiting(false),
  });

  // Web poll: active while an attempt is open and `pending`.
  const claim = useQuery<AuthClaimDto>({
    queryKey: queryKeys.authClaim(attempt ?? ""),
    queryFn: () => api.authClaim(attempt!),
    enabled: attempt !== null,
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 1_500 : false),
  });

  useEffect(() => {
    if (!attempt) return;
    const outcome = claim.data;
    if (outcome?.status === "done") {
      clearPendingAttempt();
      setAttempt(null);
      const window = globalThis.window;
      // The workspace table survives the reload: `/home` becomes `/o/<slug>/`.
      if (window) void api.primeWorkspaceDirectory().then(() => window.location.assign(new URL(APP_HOME_HREF, window.location.href).href));
    } else if (outcome?.status === "failed") {
      clearPendingAttempt();
      onFailure(outcome.code);
      setAttempt(null);
    } else if (claim.error) {
      clearPendingAttempt();
      onFailure(loginFailureCode(claim.error, "AUTH_EXCHANGE_FAILED"));
      setAttempt(null);
    }
  }, [attempt, claim.data, claim.error, onFailure]);

  return {
    waiting: attempt !== null || nativeWaiting,
    starting: start.isPending && !nativeWaiting,
    start: () => start.mutate(),
    cancel: () => {
      if (native) {
        void native.cancel();
        return;
      }
      clearPendingAttempt();
      setAttempt(null);
    },
  };
}

/** Google's "G": the official logo as SVG, as the brand guide asks, to the left of the label. */
export function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
