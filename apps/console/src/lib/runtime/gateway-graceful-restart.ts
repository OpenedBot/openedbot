import { useQuery } from "@tanstack/react-query";
import { runtimesQueryOptions } from "../api";
import { RELAY_FEATURE_GATEWAY_GRACEFUL_RESTART } from "@openedbot/contracts-connector/features";

export function hasGatewayGracefulRestart(features: readonly string[] | null | undefined): boolean {
  return Boolean(features?.includes(RELAY_FEATURE_GATEWAY_GRACEFUL_RESTART));
}

/** `true` quand le runtime de l'espace annonce `gateway_graceful_restart`. Faux tant qu'il n'est pas lu. */
export function useGatewayGracefulRestart(): boolean {
  const runtimes = useQuery(runtimesQueryOptions());
  return hasGatewayGracefulRestart(runtimes.data?.runtimes[0]?.linkFeatures);
}
