import { useQuery } from "@tanstack/react-query";
import { runtimesQueryOptions } from "./api";

/**
 * La feature de lien d'un hôte dont le redémarrage du gateway ne coupe rien :
 * les runs en cours se terminent, les nouveaux attendent (le worker les remet
 * en file sur le 503 `gateway_draining`), puis le gateway se relance. Un hôte
 * plus ancien redémarre brutalement : la console le dit avant la confirmation.
 */
export const GATEWAY_GRACEFUL_RESTART_FEATURE = "gateway_graceful_restart";

export function hasGatewayGracefulRestart(features: readonly string[] | null | undefined): boolean {
  return Boolean(features?.includes(GATEWAY_GRACEFUL_RESTART_FEATURE));
}

/** `true` quand le runtime de l'espace annonce `gateway_graceful_restart`. Faux tant qu'il n'est pas lu. */
export function useGatewayGracefulRestart(): boolean {
  const runtimes = useQuery(runtimesQueryOptions());
  return hasGatewayGracefulRestart(runtimes.data?.runtimes[0]?.linkFeatures);
}
