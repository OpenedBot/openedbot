import type { RuntimeModelCatalogDto, RuntimePublicDto } from "@openedbot/contracts-api";
import type { RuntimeHealthStatus } from "@openedbot/contracts-api";

/**
 * What the Models screen is allowed to offer, at this instant.
 *
 * Choosing a model makes sense only if the WHOLE chain holds: a runtime
 * declared, reachable, whose catalog Hermes returns, and that carries at least one
 * authenticated provider. Each missing link is repaired elsewhere: the
 * Runtime screen for the first ones, the provider directory for the last. Rendering
 * the selectors anyway promised a choice the server then refuses
 * (409 `RUNTIME_MODEL_PROVIDER_UNAUTHENTICATED`) or that no run would honor.
 */
export type RuntimeReadiness =
  /** No runtime is declared for the organization. */
  | { state: "missing" }
  /** No catalog, and the last known check had not succeeded. */
  | { state: "unproven"; status: RuntimeHealthStatus }
  /** No catalog, even though the last known check had succeeded. */
  | { state: "catalog_unreachable" }
  /** Catalog read, no authenticated provider: the choice is impossible, the repair is on the spot. */
  | { state: "no_provider" }
  /** Everything holds. `pinned`: a model is imposed, otherwise Hermes applies its default. */
  | { state: "ready"; pinned: boolean };

/**
 * The catalog wins over health: living proof against dated proof.
 *
 * `lastHealthStatus` is written only by an operator action (creation,
 * « Tester la connexion », activation, enrollment): there is no background
 * probe. A Hermes down for five minutes, tested during its outage then back,
 * therefore keeps `unreachable` in the database forever. Deciding on that closed
 * the screen of a runtime that has just answered. It is used only when the
 * catalog is missing: it then names the probable cause, instead of saying
 * « illisible » with nothing explained.
 *
 * `catalog` must be the catalog actually in hand: a failed refresh
 * that leaves data in cache is not an absence of catalog.
 */
export function runtimeReadiness(input: {
  runtime: RuntimePublicDto | null;
  catalog: RuntimeModelCatalogDto | null;
}): RuntimeReadiness {
  const { runtime, catalog } = input;
  if (!runtime) return { state: "missing" };
  if (!catalog) {
    return runtime.lastHealthStatus === "healthy"
      ? { state: "catalog_unreachable" }
      : { state: "unproven", status: runtime.lastHealthStatus };
  }
  if (!catalog.hasUsableProvider) return { state: "no_provider" };
  // What the screen can assert is read on the selection, not on a date:
  // every creation route sets `healthy` and `last_probed_at = now()`,
  // so a runtime's age is deduced from no timestamp. And an empty
  // selection does not prove « jamais réglé »: « laisser Hermes décider » is written
  // exactly the same. Only the present fact is therefore said: no model
  // imposed, it is Hermes's default that answers.
  return { state: "ready", pinned: runtime.selectedProvider !== null };
}
