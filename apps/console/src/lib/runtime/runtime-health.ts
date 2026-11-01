import type { RuntimePublicDto } from "@openedbot/contracts-api";
import type { RuntimeHealthStatus } from "@openedbot/contracts-api";
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "@openedbot/browser-i18n";
import { isApiUnavailable, isUnauthorized } from "../api";

const LABEL_KEY: Record<RuntimeHealthStatus, MessageKey> = {
  healthy: "runtimeHealth.healthy",
  unreachable: "runtimeHealth.unreachable",
  unauthorized: "runtimeHealth.unauthorized",
  missing_feature: "runtimeHealth.missingFeature",
  // Joignable et authentifié, et pourtant aucun bot ne répondra. Le dire
  // « prêt » ici serait le même mensonge que celui du bouton « Tester ».
  no_provider: "runtimeHealth.noProvider",
  // Runtime joint par le connecteur dont l'hôte n'a pas ouvert son lien.
  disconnected: "runtimeHealth.disconnected",
  unknown: "runtimeHealth.unknown",
};

/**
 * Le seul état, sans le runtime autour.
 *
 * Un appelant qui tient déjà un statut (un verdict de préparation, une ligne
 * de journal) n'a pas à fabriquer un faux `RuntimePublicDto` pour obtenir son
 * libellé. Même table que `runtimeHealthLabel` : deux endroits qui montrent le
 * même état ne peuvent pas le nommer différemment.
 */
export function runtimeHealthStatusLabel(
  status: RuntimeHealthStatus,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return t(locale, LABEL_KEY[status]);
}

/**
 * L'état à afficher, pas seulement `lastHealthStatus`.
 *
 * Sur un runtime `connector`, le socket ouvert (`link.connected`) est le
 * fait le plus frais du même DTO : le broker pose `disconnected` en même
 * temps qu'il ferme le lien, mais un statut de sonde plus ancien ne doit
 * pas afficher « prêt » sur un hôte qui n'est plus là.
 *
 * L'inverse aussi : un `disconnected` en base alors que `link.connected`
 * est vrai est une vitalité en retard (bye d'enrôlement, balayage avant
 * le hello suivant). Le fil ouvert gagne, sinon l'écran Runtime reste KO
 * jusqu'à « Vérifier le lien ».
 */
export function displayedRuntimeHealth(
  runtime: RuntimePublicDto | null | undefined,
  error?: unknown,
): RuntimeHealthStatus | "not_configured" {
  if (isApiUnavailable(error)) return "unreachable";
  // Un 401 ici ne parle pas du runtime Hermes mais du cloud API lui-même : la
  // fenêtre n'a pas (ou plus) d'identité auprès de lui. Le routeur la ramène
  // à l'étape « Se connecter » ; ici, le dire plutôt que renvoyer
  // l'utilisateur vers un formulaire qui n'y peut rien.
  if (isUnauthorized(error)) return "unauthorized";
  if (!runtime?.configured) return "not_configured";
  if (runtime.reachability === "connector" && runtime.link) {
    if (!runtime.link.connected) return "disconnected";
    if (runtime.lastHealthStatus === "disconnected" || runtime.lastHealthStatus === "unknown") {
      return "healthy";
    }
  }
  return runtime.lastHealthStatus;
}

/**
 * A conversation may remain readable while its runtime is down, but it must
 * not offer a composer that can only fail. During the initial runtime query,
 * keep the decision pending so the screen does not flash an error before the
 * health response arrives.
 */
export function runtimeBlocksConversation(
  runtime: RuntimePublicDto | null | undefined,
  querySettled: boolean,
): boolean {
  if (!querySettled) return false;
  const status = displayedRuntimeHealth(runtime);
  return !runtime || status !== "healthy" && status !== "unknown";
}

/**
 * L'état du runtime en une ligne, tel qu'il s'affiche partout dans l'app.
 *
 * Partagé entre le pied de la barre latérale et la page d'aide : deux endroits
 * qui montrent le même état ne doivent pas pouvoir le nommer différemment.
 *
 * L'erreur compte autant que la donnée. Sans elle, une API cloud indisponible
 * et ses relances épuisées se lisaient « runtime à configurer », parce que la
 * requête échoue et qu'`undefined` ressemble à « pas encore configuré ». Le
 * message envoyait alors l'utilisateur remplir un formulaire déjà rempli, dans
 * une application dont plus aucune API ne répond.
 *
 * `locale` par défaut à `DEFAULT_LOCALE` (pas de paramètre obligatoire) : les
 * appelants qui n'ont pas encore de contexte i18n (aucun aujourd'hui, mais la
 * signature reste rétrocompatible) continuent de recevoir le français.
 */
export function runtimeHealthLabel(
  runtime: RuntimePublicDto | null | undefined,
  error?: unknown,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const status = displayedRuntimeHealth(runtime, error);
  if (status === "not_configured") return t(locale, "runtimeHealth.notConfigured");
  return t(locale, LABEL_KEY[status]);
}
