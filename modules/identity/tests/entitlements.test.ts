import { describe, expect, test } from "bun:test";
import {
  createEntitlementSource,
  isCoreEntitlement,
  PRO_ENTITLEMENTS,
  sessionEntitlements,
  SOLO_ENTITLEMENTS,
} from "../src/application/entitlements";
import type { ProductFeatures } from "../src/application/product-features";

const OFF: ProductFeatures = { connectorOnlyEnrollment: false };
const reader = (features: Partial<ProductFeatures>) => async () => ({ ...OFF, ...features });

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
    expect(await SOLO_ENTITLEMENTS.features()).toEqual(OFF);
  });

  test("override layer: without the plug-in billing, BILLING_ENFORCED holds nothing (solo never paywalls); no product switch grants an entitlement", async () => {
    const solo = createEntitlementSource({ features: reader({ connectorOnlyEnrollment: true }), billingEnforced: true });
    expect(await solo.has(PRO_ENTITLEMENTS.billingEnforced)).toBe(false);
    expect(await solo.list()).toEqual([]);

    const source = createEntitlementSource({
      features: reader({ connectorOnlyEnrollment: true }),
      billingEnforced: true,
      pro: { declared: ["fixture.reports"], grant: async () => false },
    });
    // Pro without billing: no paywall either.
    expect(await source.has(PRO_ENTITLEMENTS.billingEnforced)).toBe(false);
    expect(await source.list({ userId: "u-1", organizationId: "org-1" })).toEqual([]);
  });

  test("an unreadable switch row grants nothing, and closes nothing else (no signup gate left)", async () => {
    const source = createEntitlementSource({ features: async () => { throw new Error("relation missing"); }, billingEnforced: false });
    expect(await source.has(PRO_ENTITLEMENTS.auditAnchor, { organizationId: "org-1" })).toBe(false);
    expect(await source.features()).toEqual(OFF);
    expect(Object.keys(await source.features())).not.toContain("waitlist");
  });
});

describe("EntitlementSource, plug-in layer", () => {
  const grants = new Map<string, string[]>([["org-1", ["audit.anchor", "fixture.reports", "fixture.undeclared"]]]);
  const source = createEntitlementSource({
    features: reader({}),
    billingEnforced: false,
    pro: {
      declared: ["audit.anchor", "fixture.reports", "billing.enforced"],
      grant: async (organizationId, entitlement) => grants.get(organizationId)?.includes(entitlement) ?? false,
    },
  });

  test("a plug-in grants per organization, and only what a loaded plug-in declares", async () => {
    expect(await source.has("fixture.reports", { organizationId: "org-1" })).toBe(true);
    expect(await source.has("audit.anchor", { organizationId: "org-1" })).toBe(true);
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
    expect(await source.list({ organizationId: "org-1" })).toEqual(["audit.anchor", "fixture.reports"]);
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

describe("sessionEntitlements", () => {
  test("what the console reads on GET /api/auth/me; a failing list holds nothing", async () => {
    expect(await sessionEntitlements(SOLO_ENTITLEMENTS, {})).toEqual([]);
    const reports = createEntitlementSource({
      features: reader({}),
      billingEnforced: false,
      pro: { declared: ["fixture.reports"], grant: async () => true },
    });
    expect(await sessionEntitlements(reports, { organizationId: "org-1" })).toEqual(["fixture.reports"]);
    const broken = { ...SOLO_ENTITLEMENTS, list: async () => { throw new Error("down"); } };
    expect(await sessionEntitlements(broken, {})).toEqual([]);
  });
});
