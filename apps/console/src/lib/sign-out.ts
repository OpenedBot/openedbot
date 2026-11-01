/**
 * Se déconnecter : un seul geste, appelé par le menu opérateur et par
 * Réglages → Sécurité : révoquer la session côté ÉMETTEUR si c'en est une (un
 * échec n'empêche pas d'oublier côté fenêtre), vider tout ce que la fenêtre a
 * lu, puis oublier les deux secrets : le jeton de rafraîchissement ET le jeton
 * mémorisé. En oublier un seul laisserait la fenêtre ouverte par l'autre.
 *
 * C'est le gate de `route-tree.tsx` qui ramène à `/login`, pas ce module.
 */
import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { clearCloudSession } from "./cloud-session";
import { nativeBridge } from "./native-bridge";
import { clearOnboardingDraft } from "./onboarding-draft";
import { clearPersistedQueries } from "./query-persister";
import { clearWorkspaceDrafts } from "./workspace-draft";

export async function signOut(queryClient: QueryClient): Promise<void> {
  await api.logout().catch(() => undefined);
  queryClient.clear();
  await clearPersistedQueries();
  // Le brouillon d'accueil part AVANT la session : il est porté par
  // l'organisation active, et sans elle il n'y aurait plus rien à effacer.
  clearOnboardingDraft();
  clearWorkspaceDrafts();
  clearCloudSession();
  // Coque native : ses jetons vivent hors de la page. Elle les efface et
  // montre sa propre page de connexion ; `/login` n'a pas de sens ici.
  await nativeBridge()?.signOut();
}
