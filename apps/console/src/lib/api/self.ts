import type { Api } from "../api";

/**
 * The assembled `api` object, for the few calls between its domain parts
 * (`runtime()` reads `runtimeConfiguration()`, …). Late-bound so that a
 * `spyOn(api, …)` in a test still intercepts them, and so that a domain file
 * never imports `lib/api.ts` (that would be an import cycle).
 */
let current: Api | null = null;

export function bindApi(api: Api): void {
  current = api;
}

export function apiSelf(): Api {
  if (!current) throw new Error("lib/api: the api object is not assembled yet.");
  return current;
}
