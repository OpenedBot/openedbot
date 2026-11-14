/**
 * Sign out: one gesture, called by the operator menu and by
 * Réglages → Sécurité: revoke the session on the ISSUER side, clear everything the
 * window has read, then forget both secrets: the refresh token AND
 * the remembered token. Forgetting only one would leave the window open through
 * the other.
 *
 * An unconfirmed revocation (unreachable API, 5xx, timeout) does
 * NOT count as a sign-out: the HttpOnly cookie would stay valid and the
 * next `auth/me` would reopen the same account. Nothing is cleared then, and
 * the caller receives `SignOutNotConfirmedError` so it can offer another try.
 *
 * It is the gate in `route-tree.tsx` that returns to `/login`, not this module.
 */
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "@openedbot/browser-ui-kit";
import { useT } from "../i18n";
import { api, isUnauthorized } from "../api";
import { clearCloudSession } from "./cloud-session";
import { nativeBridge } from "../platform";
import { clearOnboardingDraft } from "./onboarding-draft";
import { clearPersistedQueries } from "../query-persister";
import { clearWorkspaceDrafts } from "../workspace/workspace-draft";
import { clearThreadGoals } from "../thread/thread-goal";
import { pendingMessageStore } from "../thread/pending-message-store";

/** The server did not confirm the revocation: the session stays open. */
export class SignOutNotConfirmedError extends Error {
  constructor(cause: unknown) {
    super("Sign-out was not confirmed by the server.", { cause });
    this.name = "SignOutNotConfirmedError";
  }
}

export async function signOut(queryClient: QueryClient): Promise<void> {
  try {
    await api.logout();
  } catch (error) {
    // A session 401 says the server already no longer knows it: there is
    // nothing to revoke, local cleanup is enough.
    if (!isUnauthorized(error)) throw new SignOutNotConfirmedError(error);
  }
  queryClient.clear();
  await clearPersistedQueries();
  // The welcome draft goes BEFORE the session: it is carried by
  // the active organization, and without it there would be nothing left to clear.
  clearOnboardingDraft();
  clearWorkspaceDrafts();
  await pendingMessageStore.clear().catch((error) => console.error("Could not clear pending messages on this device", error));
  clearThreadGoals();
  clearCloudSession();
  // Native shell: its tokens live outside the page. It clears them and
  // shows its own sign-in page; `/login` has no meaning here.
  await nativeBridge()?.signOut();
}

/**
 * The gesture of the « Se déconnecter » buttons: the same mutation everywhere, and a
 * revocation failure says so out loud, with its retry. The toast outlives the
 * menu that triggered it: its action calls `signOut` directly.
 */
export function useSignOut() {
  const queryClient = useQueryClient();
  const { t } = useT();
  return useMutation({
    mutationFn: () => signOut(queryClient),
    onError: function report() {
      toast.error(t("navUser.signOutNotConfirmed"), {
        id: SIGN_OUT_TOAST_ID,
        action: { label: t("navUser.signOutRetry"), onClick: () => void signOut(queryClient).catch(report) },
      });
    },
  });
}

const SIGN_OUT_TOAST_ID = "sign-out-not-confirmed";
