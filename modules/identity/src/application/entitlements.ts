/**
 * What an organization may use, in one place (`EntitlementSource`).
 *
 * - Core entitlements (`core.*`) are always held: solo mode has the whole core.
 * - Every other entitlement is `<plug-in id>.<feature>` and belongs to a
 *   plug-in. Without a plug-in that grants it, it is not held.
 * - Override layer: the staff product switches (`product_features`) still
 *   grant the capability entitlements `fleet.workspaces` and `fleet.billing`,
 *   where a loaded plug-in declares them.
 * - Compatibility aliases (step 11.2): an old key a plug-in declares under
 *   its own id (`pro.aliases`) is held exactly when its new key is. The core
 *   itself keeps no alias: without a plug-in, no old key is ever held.
 * - `billing.enforced` (open-core step 8d) is provided ONLY by the plug-in
 *   `billing` (the loader refuses a `billing.*` entitlement from any other
 *   id): held when that plug-in is loaded AND `BILLING_ENFORCED` is true.
 *   Solo, or pro without billing, never puts up a paywall, whatever
 *   `BILLING_ENFORCED` says.
 *
 * A failed read never grants anything (fails closed), except the waitlist,
 * which is a core switch and stays on when its row cannot be read.
 */
import type { FeatureViewer, ProductFeatureReader, ProductFeatures } from "./product-features";
import { BILLING_ENFORCED_ENTITLEMENT } from "../domain/entitlement";

export const PRO_ENTITLEMENTS = {
  /** Fleet organizations and the fleet context of a session (a capability: any plug-in may bring it). */
  fleetWorkspaces: "fleet.workspaces",
  /** Fleet organizations subscribe on their own instead of staying outside the paywall (a capability). */
  fleetBilling: "fleet.billing",
  /** Subscription checks (paywall, plan quotas) apply. Instance-wide. */
  billingEnforced: BILLING_ENFORCED_ENTITLEMENT,
  /** A failed external audit anchoring blocks the write (plug-in `audit`, per organization). */
  auditAnchor: "audit.anchor",
} as const;
export type ProEntitlement = (typeof PRO_ENTITLEMENTS)[keyof typeof PRO_ENTITLEMENTS];


export function isCoreEntitlement(entitlement: string): boolean {
  return entitlement.startsWith("core.");
}

export type EntitlementScope = FeatureViewer & { organizationId?: string | null };

/** A plug-in grant for one organization; it must not throw (a throw reads as `false`). */
export type ProEntitlementGrant = (organizationId: string, entitlement: string) => Promise<boolean>;

export type EntitlementSource = {
  readonly kind: "entitlements";
  has(entitlement: string, scope?: EntitlementScope): Promise<boolean>;
  /** The non-core entitlements held in this scope, sorted; core ones are implicit. */
  list(scope?: EntitlementScope): Promise<string[]>;
  /** Core product switches that are not entitlements (waitlist, connector-only enrollment). */
  features(viewer?: FeatureViewer): Promise<ProductFeatures>;
};

export type EntitlementSourceOptions = {
  /** The staff product switches, read live (`liveProductFeatures`). */
  features: ProductFeatureReader;
  /** `BILLING_ENFORCED` from the config; only read when the plug-in billing declares `billing.enforced`. */
  billingEnforced: boolean;
  /** Loaded plug-ins: what they declare and how they grant it. */
  pro?: { declared: Iterable<string>; grant: ProEntitlementGrant; aliases?: readonly { from: string; to: string }[] };
};

const CLOSED_FEATURES: ProductFeatures = { fleetWorkspaces: false, connectorOnlyEnrollment: false, fleetBilling: false, waitlist: true };

export function createEntitlementSource(options: EntitlementSourceOptions): EntitlementSource {
  const declared = new Set(options.pro?.declared ?? []);
  const grant = options.pro?.grant;
  // An alias only counts when both ends are declared (the loader checks it;
  // this keeps the source safe for a hand-built option too).
  const aliases = new Map((options.pro?.aliases ?? [])
    .filter((alias) => declared.has(alias.from) && declared.has(alias.to) && !isCoreEntitlement(alias.from))
    .map((alias) => [alias.from, alias.to] as const));
  const features = async (viewer?: FeatureViewer): Promise<ProductFeatures> => {
    try {
      return await options.features(viewer);
    } catch {
      return CLOSED_FEATURES;
    }
  };
  const override = async (entitlement: string, scope?: EntitlementScope): Promise<boolean> => {
    // Instance-wide, never per organization: the plug-in billing loaded and
    // BILLING_ENFORCED on. Without the plug-in, no paywall (solo).
    if (entitlement === PRO_ENTITLEMENTS.billingEnforced) return declared.has(entitlement) && options.billingEnforced;
    // Agency is a pro feature (plug-in `agency`, open-core step 8): the staff
    // switches only open it where a loaded plug-in declares the entitlement.
    if (entitlement === PRO_ENTITLEMENTS.fleetWorkspaces) return declared.has(entitlement) && (await features(viewerOf(scope))).fleetWorkspaces === true;
    if (entitlement === PRO_ENTITLEMENTS.fleetBilling) return declared.has(entitlement) && (await features(viewerOf(scope))).fleetBilling === true;
    return false;
  };
  const granted = async (entitlement: string, scope?: EntitlementScope): Promise<boolean> => {
    if (!declared.has(entitlement)) return false;
    // Decided by the override layer alone: a plug-in grant cannot turn it on.
    if (entitlement === PRO_ENTITLEMENTS.billingEnforced) return false;
    if (!grant || !scope?.organizationId) return false;
    try {
      return await grant(scope.organizationId, entitlement) === true;
    } catch {
      return false;
    }
  };
  const held = async (entitlement: string, scope?: EntitlementScope): Promise<boolean> => {
    if (isCoreEntitlement(entitlement)) return true;
    return await granted(entitlement, scope) || await override(entitlement, scope);
  };
  const has = async (entitlement: string, scope?: EntitlementScope): Promise<boolean> => {
    const target = aliases.get(entitlement);
    return held(target ?? entitlement, scope);
  };
  return {
    kind: "entitlements",
    has,
    async list(scope) {
      const candidates = [...new Set([...Object.values(PRO_ENTITLEMENTS), ...declared])].sort();
      const list = await Promise.all(candidates.map(async (entitlement) => (await has(entitlement, scope)) ? entitlement : null));
      return list.filter((entitlement): entitlement is string => entitlement !== null);
    },
    features,
  };
}

/** The core default with nothing configured: the whole core, nothing else. */
export const SOLO_ENTITLEMENTS: EntitlementSource = createEntitlementSource({
  features: async () => CLOSED_FEATURES,
  billingEnforced: false,
});

function viewerOf(scope?: EntitlementScope): FeatureViewer | undefined {
  if (!scope) return undefined;
  const viewer: FeatureViewer = {};
  if (scope.accessTier !== undefined) viewer.accessTier = scope.accessTier;
  if (scope.userId !== undefined) viewer.userId = scope.userId;
  if (scope.impersonatedByStaffUserId !== undefined) viewer.impersonatedByStaffUserId = scope.impersonatedByStaffUserId;
  return viewer;
}

/**
 * What a route gate accepts. Booleans and bare readers stay accepted for the
 * route tests and older callers; the API composition root passes an
 * `EntitlementSource`.
 */
export type ProductFeatureSource = boolean | ProductFeatureReader | EntitlementSource;

export function isEntitlementSource(source: unknown): source is EntitlementSource {
  return typeof source === "object" && source !== null && (source as { kind?: unknown }).kind === "entitlements";
}

/**
 * `fleet.workspaces` for this viewer. A missing, stale-schema, or
 * unavailable feature row closes the agency gate.
 */
export async function fleetWorkspacesEnabled(source: ProductFeatureSource, viewer?: EntitlementScope): Promise<boolean> {
  if (typeof source === "boolean") return source;
  try {
    if (isEntitlementSource(source)) return await source.has(PRO_ENTITLEMENTS.fleetWorkspaces, viewer);
    return (await source(viewer)).fleetWorkspaces === true;
  } catch {
    return false;
  }
}

/** `fleet.billing` for this viewer; fails closed. Without a source, off. */
export async function fleetBillingEnabled(source: ProductFeatureSource | undefined, viewer?: EntitlementScope): Promise<boolean> {
  if (source === undefined || typeof source === "boolean") return false;
  try {
    if (isEntitlementSource(source)) return await source.has(PRO_ENTITLEMENTS.fleetBilling, viewer);
    return (await source(viewer)).fleetBilling === true;
  } catch {
    return false;
  }
}

/**
 * Waitlist signup gate (a core switch, not an entitlement). A boolean source
 * is a legacy agency-only argument: the waitlist stays on. A missing or
 * failed read also keeps the gate on.
 */
export async function waitlistEnabled(source: ProductFeatureSource): Promise<boolean> {
  if (typeof source === "boolean") return true;
  try {
    const features = isEntitlementSource(source) ? await source.features() : await source();
    return features.waitlist !== false;
  } catch {
    return true;
  }
}

/** The non-core entitlements a session holds, for the console (`GET /api/auth/me`). */
export async function sessionEntitlements(source: ProductFeatureSource, scope: EntitlementScope): Promise<string[]> {
  if (isEntitlementSource(source)) {
    try {
      return await source.list(scope);
    } catch {
      return [];
    }
  }
  const held: string[] = [];
  if (await fleetBillingEnabled(source, scope)) held.push(PRO_ENTITLEMENTS.fleetBilling);
  if (await fleetWorkspacesEnabled(source, scope)) held.push(PRO_ENTITLEMENTS.fleetWorkspaces);
  return held;
}
