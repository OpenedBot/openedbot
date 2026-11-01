/**
 * The read side of the product switches (`product_features`), in the core,
 * plus their boot defaults. The backoffice (`staff`) switches them; the core
 * reads them here, behind its entitlements (`./entitlements`), so nothing in
 * the core imports `staff` to know what a session may use.
 */
import type { Db } from "@openedbot/platform-db";
import type { AccessTier, ProductFeatureAudience, ResolvedProductFeatures } from "@openedbot/contracts-api";
import { readProductFeatureRows, seedProductFeatureDefault } from "../sql/product-features";

/**
 * The stored switch keys (`product_features.feature_key`) behind the fleet
 * capabilities. Rows written before step 11.2 keep their old keys; they are
 * read through this mapping, never migrated (dated debt, 2026-10-28: rename
 * the rows together with the staff backoffice once both run in pro).
 */
export const FLEET_FEATURE_KEYS = { fleetWorkspaces: "agency_workspaces", fleetBilling: "agency_billing" } as const;

export type ProductFeatures = {
  fleetWorkspaces: boolean;
  connectorOnlyEnrollment: boolean;
  /** Fleet organizations subscribe on their own (billing plug-in) instead of staying outside the paywall. */
  fleetBilling: boolean;
  /**
   * Signup waitlist gate. On, a new account needs staff approval.
   * Off, it is created as `classic`. Missing row fails closed (gate on).
   */
  waitlist: boolean;
};

export type FeatureViewer = { accessTier?: AccessTier | null; userId?: string; impersonatedByStaffUserId?: string | null };

/** Product rollout state is persisted in PostgreSQL, not process environment. */
export async function readProductFeatures(db: Db, viewer: FeatureViewer = {}): Promise<ProductFeatures> {
  const rows = await readProductFeatureRows(db);
  const enabled = new Map(rows.map((row) => [row.featureKey, row.featureKey === "waitlist" ? row.enabled : featureAudienceAllows(row.audience ?? (row.enabled ? "all" : "off"), viewer)]));
  return {
    fleetWorkspaces: enabled.get(FLEET_FEATURE_KEYS.fleetWorkspaces) === true,
    connectorOnlyEnrollment: enabled.get("connector_only_enrollment") === true,
    fleetBilling: enabled.get(FLEET_FEATURE_KEYS.fleetBilling) === true,
    waitlist: enabled.get("waitlist") !== false,
  };
}

export function featureAudienceAllows(audience: ProductFeatureAudience, viewer: FeatureViewer): boolean {
  if (audience === "all") return true;
  if (audience === "staff") return Boolean(viewer.impersonatedByStaffUserId);
  if (audience === "alpha") return viewer.accessTier === "alpha";
  if (audience === "beta") return viewer.accessTier === "alpha" || viewer.accessTier === "beta";
  return false;
}

export async function readResolvedProductFeatures(db: Db, viewer: FeatureViewer): Promise<ResolvedProductFeatures> {
  const resolvedViewer = await resolveViewer(db, viewer);
  return Object.fromEntries((await readProductFeatureRows(db)).map(row => [row.featureKey,
    row.featureKey === "waitlist" ? row.enabled : featureAudienceAllows(row.audience ?? (row.enabled ? "all" : "off"), resolvedViewer)]));
}

async function resolveViewer(db: Db, viewer: FeatureViewer): Promise<FeatureViewer> {
  if (!viewer.userId) return viewer;
  const rows = await db<Array<{ accessTier: AccessTier | null }>>`select access_tier as "accessTier" from users where id = ${viewer.userId}`;
  return { ...viewer, accessTier: rows[0]?.accessTier ?? null };
}

export type ProductFeatureReader = (viewer?: FeatureViewer) => Promise<ProductFeatures>;

const LIVE_FEATURES_TTL_MS = 15_000;
const readersByDb = new WeakMap<object, Set<() => void>>();

/**
 * Features switched from the backoffice are read at request time, never frozen
 * at boot. A short cache bounds the reads; a switch reaches every API instance
 * within `ttlMs`. A failed read is not cached.
 */
export function liveProductFeatures(db: Db, ttlMs = LIVE_FEATURES_TTL_MS, now = () => Date.now()): ProductFeatureReader {
  let cached: { at: number; value: Promise<ProductFeatures> } | null = null;
  const invalidate = () => { cached = null; };
  const key = db as object;
  const readers = readersByDb.get(key) ?? new Set<() => void>();
  readers.add(invalidate);
  readersByDb.set(key, readers);
  return async (viewer) => {
    if (viewer) return readProductFeatures(db, await resolveViewer(db, viewer));
    const at = now();
    if (!cached || at - cached.at >= ttlMs) {
      const value = readProductFeatures(db);
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
  return (env.OHB_ENV ?? env.NODE_ENV) === "development";
}

/**
 * Initialize the agency default without overriding a choice made by staff.
 * The caller supplies an environment-derived default so an implicit config
 * fallback to development cannot turn this feature on.
 */
export async function initializeProductFeatures(db: Db, agencyWorkspacesDefault: boolean): Promise<void> {
  await seedProductFeatureDefault(db, FLEET_FEATURE_KEYS.fleetWorkspaces, agencyWorkspacesDefault);
  // Development opens signup so Google SSO works on a seeded database.
  // Production keeps the waitlist gate on until staff turns it off.
  await seedProductFeatureDefault(db, "waitlist", !agencyWorkspacesDefault);
  invalidateProductFeatureReaders(db);
}
