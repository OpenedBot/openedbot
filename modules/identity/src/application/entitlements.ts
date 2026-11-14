/**
 * What an organization may use, in one place (`EntitlementSource`).
 *
 * - Core entitlements (`core.*`) are always held: solo mode has the whole core.
 * - Every other entitlement is `<plug-in id>.<feature>` and belongs to a
 *   plug-in. Without a plug-in that grants it, it is not held.
 * - `billing.enforced` (open-core step 8d) is provided ONLY by the plug-in
 *   `billing` (the loader refuses a `billing.*` entitlement from any other
 *   id): held when that plug-in is loaded AND `BILLING_ENFORCED` is true.
 *   Solo, or pro without billing, never puts up a paywall, whatever
 *   `BILLING_ENFORCED` says.
 *
 * A failed read never grants anything (fails closed). No product switch
 * can close signup: there is no signup gate any more (plan 0005).
 */
import type { FeatureViewer, ProductFeatureReader, ProductFeatures } from "./product-features";
import { BILLING_ENFORCED_ENTITLEMENT } from "../domain/entitlement";

export const PRO_ENTITLEMENTS = {
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
  /** Core product switches that are not entitlements (connector-only enrollment). */
  features(viewer?: FeatureViewer): Promise<ProductFeatures>;
};

export type EntitlementSourceOptions = {
  /** The product switches, read live (`liveProductFeatures`). */
  features: ProductFeatureReader;
  /** `BILLING_ENFORCED` from the config; only read when the plug-in billing declares `billing.enforced`. */
  billingEnforced: boolean;
  /** Loaded plug-ins: what they declare and how they grant it. */
  pro?: { declared: Iterable<string>; grant: ProEntitlementGrant };
};

const CLOSED_FEATURES: ProductFeatures = { connectorOnlyEnrollment: false };

export function createEntitlementSource(options: EntitlementSourceOptions): EntitlementSource {
  const declared = new Set(options.pro?.declared ?? []);
  const grant = options.pro?.grant;
  const features = async (viewer?: FeatureViewer): Promise<ProductFeatures> => {
    try {
      return await options.features(viewer);
    } catch {
      return CLOSED_FEATURES;
    }
  };
  // Instance-wide, never per organization: the plug-in billing loaded and
  // BILLING_ENFORCED on. Without the plug-in, no paywall (solo).
  const override = (entitlement: string): boolean =>
    entitlement === PRO_ENTITLEMENTS.billingEnforced && declared.has(entitlement) && options.billingEnforced;
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
    return await granted(entitlement, scope) || override(entitlement);
  };
  return {
    kind: "entitlements",
    has: held,
    async list(scope) {
      const candidates = [...new Set([...Object.values(PRO_ENTITLEMENTS), ...declared])].sort();
      const list = await Promise.all(candidates.map(async (entitlement) => (await held(entitlement, scope)) ? entitlement : null));
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

/** The non-core entitlements a session holds, for the console (`GET /api/auth/me`); fails closed. */
export async function sessionEntitlements(source: EntitlementSource, scope: EntitlementScope): Promise<string[]> {
  try {
    return await source.list(scope);
  } catch {
    return [];
  }
}
