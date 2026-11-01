import { useQuery } from "@tanstack/react-query";
import { api, queryKeys } from "./api";

/**
 * Is a help desk served by this API? A plug-in brings it (core port
 * `supportDesk`, step 11.3); without one every `/api/support` path is a 404,
 * so the console shows no desk at all: no bubble, no `/support`, no menu
 * entry, and not a single desk request.
 *
 * Read from `/api/health`, not `/api/auth/me`: the bubble also serves
 * visitors without a session, who have no `/me`. Only an explicit `true`
 * opens the desk: while the read is pending, or against an API that predates
 * the field, it stays closed (the core and the pro plug-ins deploy together).
 */
export function supportDeskAvailable(health: { supportDesk?: boolean } | null | undefined): boolean {
  return health?.supportDesk === true;
}

/** Same read as `useDeployEnvironment`: one `GET /api/health` for the page. */
export function useSupportDeskAvailable(): boolean {
  const health = useQuery({ queryKey: queryKeys.health, queryFn: api.health, staleTime: Infinity });
  return supportDeskAvailable(health.data);
}

/** For a route guard: the same read, through the query cache. */
export async function readSupportDeskAvailable(
  fetch: (options: { queryKey: readonly unknown[]; queryFn: typeof api.health }) => Promise<{ supportDesk?: boolean }>,
): Promise<boolean> {
  return supportDeskAvailable(await fetch({ queryKey: queryKeys.health, queryFn: api.health }).catch(() => null));
}
