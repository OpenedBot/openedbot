/**
 * Se déconnecter : un seul geste, appelé par le menu opérateur et par
 * Réglages → Sécurité : révoquer la session côté ÉMETTEUR, vider tout ce que la
 * fenêtre a lu, puis oublier les deux secrets : le jeton de rafraîchissement ET
 * le jeton mémorisé. En oublier un seul laisserait la fenêtre ouverte par
 * l'autre.
 *
 * Une révocation non confirmée (API injoignable, 5xx, délai dépassé) ne passe
 * PAS pour une déconnexion : le cookie HttpOnly resterait valide et le
 * prochain `auth/me` rouvrirait le même compte. Rien n'est alors effacé, et
 * l'appelant reçoit `SignOutNotConfirmedError` pour proposer un nouvel essai.
 *
 * C'est le gate de `route-tree.tsx` qui ramène à `/login`, pas ce module.
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

/** Le serveur n'a pas confirmé la révocation : la session reste ouverte. */
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
    // Un 401 de session dit que le serveur ne la connaît déjà plus : il n'y a
    // rien à révoquer, le nettoyage local suffit.
    if (!isUnauthorized(error)) throw new SignOutNotConfirmedError(error);
  }
  queryClient.clear();
  await clearPersistedQueries();
  // Le brouillon d'accueil part AVANT la session : il est porté par
  // l'organisation active, et sans elle il n'y aurait plus rien à effacer.
  clearOnboardingDraft();
  clearWorkspaceDrafts();
  clearThreadGoals();
  clearCloudSession();
  // Coque native : ses jetons vivent hors de la page. Elle les efface et
  // montre sa propre page de connexion ; `/login` n'a pas de sens ici.
  await nativeBridge()?.signOut();
}

/**
 * Le geste des boutons « Se déconnecter » : la même mutation partout, et un
 * échec de révocation dit tout haut, avec son nouvel essai. Le toast survit au
 * menu qui l'a déclenché : son action relance `signOut` directement.
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
