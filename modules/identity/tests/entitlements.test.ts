import { describe, expect, test } from "bun:test";
import {
  fleetBillingEnabled,
  fleetWorkspacesEnabled,
  createEntitlementSource,
  isCoreEntitlement,
  PRO_ENTITLEMENTS,
  sessionEntitlements,
  SOLO_ENTITLEMENTS,
  waitlistEnabled,
} from "../src/application/entitlements";
import type { FeatureViewer, ProductFeatures } from "../src/application/product-features";

const OFF: ProductFeatures = { fleetWorkspaces: false, connectorOnlyEnrollment: false, fleetBilling: false, waitlist: true };
const reader = (features: Partial<ProductFeatures>, seen: Array<FeatureViewer | undefined> = []) =>
  async (viewer?: FeatureViewer) => { seen.push(viewer); return { ...OFF, ...features }; };

describe("EntitlementSource, core default", () => {
  test("solo holds the whole core and nothing else", async () => {
    expect(isCoreEntitlement("core.chat")).toBe(true);
    expect(await SOLO_ENTITLEMENTS.has("core.chat")).toBe(true);
    expect(await SOLO_ENTITLEMENTS.has("core.anything", { organizationId: "org-1" })).toBe(true);
    for (const entitlement of Object.values(PRO_ENTITLEMENTS)) {
      expect(await SOLO_ENTITLEMENTS.has(entitlement, { organizationId: "org-1" })).toBe(false);
    }
    expect(await SOLO_ENTITLEMENTS.has("fixture.reports", { organizationId: "org-1" })).toBe(false);
    expect(await SOLO_ENTITLEMENTS.list({ organizationId: "org-1" })).toEqual([]);
    expect((await SOLO_ENTITLEMENTS.features()).waitlist).toBe(true);
  });

  test("override layer: without the plug-in billing, BILLING_ENFORCED holds nothing (solo never paywalls); the staff switches open agency only where the plug-in agency declares it", async () => {
    const seen: Array<FeatureViewer | undefined> = [];
    const solo = createEntitlementSource({ features: reader({ fleetWorkspaces: true, fleetBilling: true }, seen), billingEnforced: true });
    expect(await solo.has(PRO_ENTITLEMENTS.fleetWorkspaces, { userId: "u-1", organizationId: "org-1" })).toBe(false);
    expect(await solo.has(PRO_ENTITLEMENTS.fleetBilling)).toBe(false);
    expect(await solo.has(PRO_ENTITLEMENTS.billingEnforced)).toBe(false);
    expect(await solo.list()).toEqual([]);

    const source = createEntitlementSource({
      features: reader({ fleetWorkspaces: true, fleetBilling: false }, seen),
      billingEnforced: true,
      pro: { declared: ["fleet.workspaces", "fleet.billing"], grant: async () => false },
    });
    expect(await source.has(PRO_ENTITLEMENTS.fleetWorkspaces, { userId: "u-1", accessTier: "beta", organizationId: "org-1" })).toBe(true);
    expect(seen.at(-1)).toEqual({ userId: "u-1", accessTier: "beta" });
    expect(await source.has(PRO_ENTITLEMENTS.fleetBilling)).toBe(false);
    // Pro without billing: no paywall either.
    expect(await source.has(PRO_ENTITLEMENTS.billingEnforced)).toBe(false);
    expect(await source.list()).toEqual(["fleet.workspaces"]);
  });

  test("an unreadable switch row grants nothing, and keeps the waitlist on", async () => {
    const source = createEntitlementSource({ features: async () => { throw new Error("relation missing"); }, billingEnforced: false });
    expect(await source.has(PRO_ENTITLEMENTS.fleetWorkspaces)).toBe(false);
    expect(await source.has(PRO_ENTITLEMENTS.fleetBilling)).toBe(false);
    expect(await waitlistEnabled(source)).toBe(true);
  });
});

describe("EntitlementSource, plug-in layer", () => {
  const grants = new Map<string, string[]>([["org-1", ["fleet.workspaces", "fixture.reports", "fixture.undeclared"]]]);
  const source = createEntitlementSource({
    features: reader({}),
    billingEnforced: false,
    pro: {
      declared: ["fleet.workspaces", "fixture.reports", "billing.enforced"],
      grant: async (organizationId, entitlement) => grants.get(organizationId)?.includes(entitlement) ?? false,
    },
  });

  test("a plug-in grants per organization, and only what a loaded plug-in declares", async () => {
    expect(await source.has("fixture.reports", { organizationId: "org-1" })).toBe(true);
    expect(await source.has("fleet.workspaces", { organizationId: "org-1" })).toBe(true);
    expect(await source.has("fixture.reports", { organizationId: "org-2" })).toBe(false);
    expect(await source.has("fixture.reports")).toBe(false);
    expect(await source.has("fixture.undeclared", { organizationId: "org-1" })).toBe(false);
  });

  test("billing.enforced: declared by the plug-in billing, it still needs BILLING_ENFORCED", async () => {
    // `source` declares it but BILLING_ENFORCED is false (development default).
    expect(await source.has("billing.enforced")).toBe(false);
    expect(await source.has("billing.enforced", { organizationId: "org-1" })).toBe(false);
    const enforced = createEntitlementSource({
      features: reader({}),
      billingEnforced: true,
      // A grant cannot open it per organization, nor close it: instance-wide.
      pro: { declared: ["billing.enforced"], grant: async () => false },
    });
    expect(await enforced.has("billing.enforced")).toBe(true);
    expect(await enforced.has("billing.enforced", { organizationId: "org-9" })).toBe(true);
    const granting = createEntitlementSource({
      features: reader({}),
      billingEnforced: false,
      pro: { declared: ["billing.enforced"], grant: async () => true },
    });
    expect(await granting.has("billing.enforced", { organizationId: "org-1" })).toBe(false);
  });

  test("list is sorted and covers the declared entitlements", async () => {
    expect(await source.list({ organizationId: "org-1" })).toEqual(["fixture.reports", "fleet.workspaces"]);
    expect(await source.list({ organizationId: "org-2" })).toEqual([]);
  });

  test("a grant that throws grants nothing", async () => {
    const failing = createEntitlementSource({
      features: reader({}),
      billingEnforced: false,
      pro: { declared: ["fixture.reports"], grant: async () => { throw new Error("plug-in down"); } },
    });
    expect(await failing.has("fixture.reports", { organizationId: "org-1" })).toBe(false);
  });
});

describe("route gates", () => {
  test("booleans and bare readers stay accepted; an EntitlementSource is asked for its entitlement", async () => {
    expect(await fleetWorkspacesEnabled(true)).toBe(true);
    expect(await fleetWorkspacesEnabled(false)).toBe(false);
    expect(await fleetWorkspacesEnabled(reader({ fleetWorkspaces: true }))).toBe(true);
    expect(await fleetWorkspacesEnabled(async () => { throw new Error("down"); })).toBe(false);
    const asked: string[] = [];
    const source = { ...SOLO_ENTITLEMENTS, has: async (entitlement: string) => { asked.push(entitlement); return true; } };
    expect(await fleetWorkspacesEnabled(source, { organizationId: "org-1" })).toBe(true);
    expect(await fleetBillingEnabled(source)).toBe(true);
    expect(asked).toEqual(["fleet.workspaces", "fleet.billing"]);
    expect(await fleetBillingEnabled(undefined)).toBe(false);
    expect(await fleetBillingEnabled(true)).toBe(false);
  });

  test("the waitlist is a core switch: on for booleans, read from the source otherwise", async () => {
    expect(await waitlistEnabled(false)).toBe(true);
    expect(await waitlistEnabled(reader({ waitlist: false }))).toBe(false);
    expect(await waitlistEnabled(createEntitlementSource({ features: reader({ waitlist: false }), billingEnforced: false }))).toBe(false);
  });

  test("sessionEntitlements: what the console reads on GET /api/auth/me", async () => {
    expect(await sessionEntitlements(false, {})).toEqual([]);
    expect(await sessionEntitlements(true, {})).toEqual(["fleet.workspaces"]);
    const agency = { declared: ["fleet.workspaces", "fleet.billing"], grant: async () => false };
    expect(await sessionEntitlements(createEntitlementSource({ features: reader({ fleetBilling: true }), billingEnforced: false, pro: agency }), { organizationId: "org-1" }))
      .toEqual(["fleet.billing"]);
    expect(await sessionEntitlements(createEntitlementSource({ features: reader({ fleetBilling: true }), billingEnforced: false }), { organizationId: "org-1" }))
      .toEqual([]);
    const broken = { ...SOLO_ENTITLEMENTS, list: async () => { throw new Error("down"); } };
    expect(await sessionEntitlements(broken, {})).toEqual([]);
  });
});
