import type { useQueryClient } from "@tanstack/react-query";
import type { RuntimeHealthStatus } from "@openedbot/contracts-api";
import { queryKeys } from "../../../lib/api";
import type { MessageKey } from "../../../lib/i18n";

/**
 * Les sections de l'écran runtime. Elles vivent dans l'URL (`?section=`) quand
 * la route les porte, et en état local quand l'écran est monté dans un
 * dialogue ou un test : le composant ne connaît pas le routeur.
 */
export type RuntimeSection = "status" | "alerts" | "runtimes";
const RUNTIME_SECTIONS: readonly RuntimeSection[] = ["status", "alerts", "runtimes"];
export function isRuntimeSection(value: unknown): value is RuntimeSection {
  return typeof value === "string" && (RUNTIME_SECTIONS as readonly string[]).includes(value);
}

/** Le libellé de chaque état de santé : un seul vocabulaire, hero et registre. */
export const HEALTH_LABEL: Record<RuntimeHealthStatus, MessageKey> = {
  healthy: "runtimeHealth.healthy",
  unreachable: "runtimeHealth.unreachable",
  unauthorized: "runtimeHealth.unauthorized",
  missing_feature: "runtimeHealth.missingFeature",
  no_provider: "runtimeHealth.noProvider",
  disconnected: "runtimeHealth.disconnected",
  unknown: "runtimeHealth.unknown",
};

/**
 * L'écran runtime relit ses faits toutes les 5 secondes, comme le fil.
 *
 * Un lien connecteur s'ouvre et se ferme SANS que l'opérateur touche à quoi que
 * ce soit : l'hôte redémarre, un tunnel tombe, `make link-dev-up` le rouvre.
 * Sans relecture, l'écran gardait l'instantané de son chargement et affirmait
 * « lien connecteur fermé » sur un lien rouvert depuis, ce qui est pire que ne
 * rien dire.
 *
 * Ce n'est pas un pis-aller en attendant le flux : l'API sert bien `/api/events`,
 * mais aucun client ne l'ouvre (aucun `EventSource` dans `apps/console/src`), et le
 * fil de conversation se tient déjà à jour de cette façon
 * (`use-thread-stream.ts`, `refetchInterval: 5_000`). Le jour où la PWA
 * s'abonnera vraiment au flux, c'est cette constante qui disparaîtra.
 */
export const RUNTIME_REFETCH_MS = 5_000;
// Lien fermé : assez vif pour voir `make link-dev-up` rouvrir le lien, sans
// une relecture par seconde pendant toute une panne qui dure.
export const RUNTIME_DISCONNECTED_REFETCH_MS = 3_000;

/** Tout ce que le registre, le mode et la carte du runtime actif lisent. */
export async function invalidateRuntimeQueries(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.runtimes }),
    queryClient.invalidateQueries({ queryKey: queryKeys.runtimeList }),
    queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration }),
    queryClient.invalidateQueries({ queryKey: queryKeys.runtime }),
  ]);
}
