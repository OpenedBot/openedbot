/**
 * The read side of the product switches (`product_features`), in the core,
 * plus their boot defaults. A backoffice plug-in may switch them; the core
 * reads them here, behind its entitlements (`./entitlements`).
 */
import type { Db } from "@openedbot/platform-db";
import type { ProductFeatureAudience, ResolvedProductFeatures } from "@openedbot/contracts-api";
import { readProductFeatureRows, type ProductFeatureRow } from "../sql/product-features";

/** The stored rows themselves, for the backoffice (plug-in) that switches them. */
export { readProductFeatureRows };

export type ProductFeatures = {
  connectorOnlyEnrollment: boolean;
};

export type FeatureViewer = { userId?: string; assistedBy?: string | null };

/**
 * Which switch of a flag this process reads (plan 0005): `dev` only when
 * development is explicitly selected, `prod` otherwise (production, preprod,
 * tests, or nothing set). Never readApiConfig's development fallback: a
 * process that forgot its environment reads the production switch.
 */
export type ProductFeatureEnvironment = "dev" | "prod";

export function productFeatureEnvironment(env: Record<string, string | undefined> = process.env): ProductFeatureEnvironment {
  return isExplicitDevelopmentEnvironment(env) ? "dev" : "prod";
}

/**
 * One flag, for one viewer. Development: the `dev` switch alone, for everyone
 * (a flag marked dev is on locally without the backoffice). Production: the
 * `prod` switch, then its audience.
 */
export function productFeatureOn(row: ProductFeatureRow, viewer: FeatureViewer, environment: ProductFeatureEnvironment): boolean {
  if (environment === "dev") return row.dev;
  return row.prod && featureAudienceAllows(row.audience, viewer);
}

/** Product rollout state is persisted in PostgreSQL, not process environment. A missing row is off. */
export async function readProductFeatures(
  db: Db,
  viewer: FeatureViewer = {},
  environment: ProductFeatureEnvironment = productFeatureEnvironment(),
): Promise<ProductFeatures> {
  const on = new Map((await readProductFeatureRows(db)).map((row) => [row.featureKey, productFeatureOn(row, viewer, environment)]));
  return { connectorOnlyEnrollment: on.get("connector_only_enrollment") === true };
}

export function featureAudienceAllows(audience: ProductFeatureAudience, viewer: FeatureViewer): boolean {
  if (audience === "all") return true;
  if (audience === "assisted") return Boolean(viewer.assistedBy);
  return false;
}

export async function readResolvedProductFeatures(
  db: Db,
  viewer: FeatureViewer,
  environment: ProductFeatureEnvironment = productFeatureEnvironment(),
): Promise<ResolvedProductFeatures> {
  return Object.fromEntries((await readProductFeatureRows(db)).map((row) => [row.featureKey, productFeatureOn(row, viewer, environment)]));
}

export type ProductFeatureReader = (viewer?: FeatureViewer) => Promise<ProductFeatures>;

const LIVE_FEATURES_TTL_MS = 15_000;
const readersByDb = new WeakMap<object, Set<() => void>>();

/**
 * Features switched from the backoffice are read at request time, never frozen
 * at boot. A short cache bounds the reads; a switch reaches every API instance
 * within `ttlMs`. A failed read is not cached.
 */
export function liveProductFeatures(
  db: Db,
  ttlMs = LIVE_FEATURES_TTL_MS,
  now = () => Date.now(),
  environment: ProductFeatureEnvironment = productFeatureEnvironment(),
): ProductFeatureReader {
  let cached: { at: number; value: Promise<ProductFeatures> } | null = null;
  const invalidate = () => { cached = null; };
  const key = db as object;
  const readers = readersByDb.get(key) ?? new Set<() => void>();
  readers.add(invalidate);
  readersByDb.set(key, readers);
  return async (viewer) => {
    if (viewer) return readProductFeatures(db, viewer, environment);
    const at = now();
    if (!cached || at - cached.at >= ttlMs) {
      const value = readProductFeatures(db, {}, environment);
      const entry = { at, value };
      cached = entry;
      value.catch(() => { if (cached === entry) cached = null; });
    }
    return cached.value;
  };
}

/** Drops the cached reads of this database, after a write by the backoffice. */
export function invalidateProductFeatureReaders(db: Db): void {
  for (const invalidate of readersByDb.get(db as object) ?? []) invalidate();
}

/** Use only the explicitly selected environment, never readApiConfig's dev fallback. */
export function isExplicitDevelopmentEnvironment(env: Record<string, string | undefined> = process.env): boolean {
  return (env.OPENEDBOT_ENV ?? env.NODE_ENV) === "development";
}
