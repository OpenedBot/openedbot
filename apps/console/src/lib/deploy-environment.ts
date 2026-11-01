import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "./api";

/**
 * The tier of THIS openedbot, as the API says it (`/api/health`, its
 * OHB_DEPLOY_ENV). One host can be linked to a dev, a preprod and a prod openedbot
 * at once, one connector instance each, and the desktop app can aim any of
 * them: without a badge a dev console looks exactly like production. `null`
 * while unknown, and for an API that predates the field.
 */
export type DeployEnvironment = "dev" | "preprod" | "prod";

export const DEPLOY_ENVIRONMENT_BADGE = {
  dev: { tone: "warning", label: "openedbot dev" },
  preprod: { tone: "info", label: "openedbot préprod" },
  prod: { tone: "neutral", label: "openedbot prod" },
} as const satisfies Record<DeployEnvironment, { tone: "warning" | "info" | "neutral"; label: string }>;

/**
 * What a connector link is, from the origin its host dials (`link.origin`):
 * a loopback origin is the dev workstation's SSH tunnel (`make link-dev-up`),
 * anything else is a host reaching this openedbot over the network, named after
 * this openedbot's tier. Several of them can sit on one LAN, even on one machine
 * (one connector instance per openedbot): the label keeps them apart.
 */
export type LinkKind = { tone: "warning" | "info" | "neutral"; label: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function linkKind(origin: string | null | undefined, environment: DeployEnvironment | null): LinkKind | null {
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (LOOPBACK.has(host)) return { tone: "warning", label: "Dev local · tunnel SSH" };
  // The host name answers when the tier is unknown (an API that predates the
  // `environment` field): a host with a `preprod` label is preprod whatever else is known.
  if (environment === "preprod" || /(^|[.-])preprod([.-]|$)/.test(host)) return { tone: "info", label: "Préprod" };
  if (environment === "dev") return { tone: "warning", label: "Dev" };
  return { tone: "neutral", label: "Distant" };
}

export function useDeployEnvironment(): DeployEnvironment | null {
  // Fixed for the life of the page: one read, never refetched.
  const health = useQuery({ queryKey: queryKeys.health, queryFn: api.health, staleTime: Infinity });
  return health.data?.environment ?? null;
}
