import { describe, expect, test } from "bun:test";
import type { Db } from "@openedbot/platform-db";
import { featureAudienceAllows, liveProductFeatures, readProductFeatures } from "@openedbot/identity/application/product-features";

function dbWith(rows: Array<{ featureKey: string; enabled: boolean }>): Db {
  return (async () => rows) as unknown as Db;
}

describe("product feature defaults", () => {
  test("reads agency and connector enrollment independently from PostgreSQL", async () => {
    const features = await readProductFeatures(dbWith([
      { featureKey: "agency_workspaces", enabled: true },
      { featureKey: "connector_only_enrollment", enabled: false },
      { featureKey: "agency_billing", enabled: true },
    ]));

    expect(features).toEqual({
      fleetWorkspaces: true,
      connectorOnlyEnrollment: false,
      fleetBilling: true,
      waitlist: true,
    });
  });

  test("fails closed when a feature row is missing", async () => {
    expect(await readProductFeatures(dbWith([]))).toEqual({
      fleetWorkspaces: false,
      connectorOnlyEnrollment: false,
      fleetBilling: false,
      waitlist: true,
    });
  });

  test("waitlist gate is off only when the row is explicitly false", async () => {
    expect(await readProductFeatures(dbWith([{ featureKey: "waitlist", enabled: false }]))).toEqual({
      fleetWorkspaces: false,
      connectorOnlyEnrollment: false,
      fleetBilling: false,
      waitlist: false,
    });
  });

  test("a backoffice switch is read again once the short cache expires", async () => {
    let enabled = false;
    let reads = 0;
    let clock = 0;
    const db = (async () => { reads++; return [{ featureKey: "agency_billing", enabled }]; }) as unknown as Db;
    const features = liveProductFeatures(db, 15_000, () => clock);
    expect((await features()).fleetBilling).toBe(false);
    enabled = true;
    clock = 14_999;
    expect((await features()).fleetBilling).toBe(false);
    clock = 15_000;
    expect((await features()).fleetBilling).toBe(true);
    expect(reads).toBe(2);
  });
});


describe("feature audiences", () => {
  test("alpha includes beta, classic only includes all, and staff requires impersonation", () => {
    for (const accessTier of ["alpha", "beta", "classic"] as const) {
      expect(featureAudienceAllows("all", { accessTier })).toBe(true);
      expect(featureAudienceAllows("off", { accessTier })).toBe(false);
      expect(featureAudienceAllows("alpha", { accessTier })).toBe(accessTier === "alpha");
      expect(featureAudienceAllows("beta", { accessTier })).toBe(accessTier !== "classic");
      expect(featureAudienceAllows("staff", { accessTier })).toBe(false);
    }
    expect(featureAudienceAllows("staff", { impersonatedByStaffUserId: "staff-session" })).toBe(true);
  });
});

describe("product feature boot defaults (core, solo included)", () => {
  async function seeded(agencyDefault: boolean) {
    const { initializeProductFeatures } = await import("@openedbot/identity/application/product-features");
    const writes: Array<{ sql: string; values: unknown[] }> = [];
    const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      writes.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
      return [];
    }) as unknown as Db;
    await initializeProductFeatures(db, agencyDefault);
    return writes;
  }

  test("seeds agency and waitlist without overriding a staff choice", async () => {
    for (const agencyDefault of [true, false]) {
      const writes = await seeded(agencyDefault);
      expect(writes.map((write) => write.values)).toEqual([["agency_workspaces", agencyDefault], ["waitlist", !agencyDefault]]);
      for (const write of writes) {
        expect(write.sql).toContain("insert into product_features");
        expect(write.sql).toContain("where product_features.staff_override = false");
      }
    }
  });
});
