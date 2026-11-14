import { describe, expect, test } from "bun:test";
import type { Db } from "@openedbot/platform-db";
import {
  featureAudienceAllows,
  liveProductFeatures,
  productFeatureEnvironment,
  productFeatureOn,
  readProductFeatures,
  readResolvedProductFeatures,
} from "@openedbot/identity/application/product-features";

type Row = { featureKey: string; dev: boolean; prod: boolean; audience: string };

function dbWith(rows: Row[]): Db {
  return (async () => rows) as unknown as Db;
}

const row = (featureKey: string, dev: boolean, prod: boolean, audience = "all"): Row => ({ featureKey, dev, prod, audience });

describe("product flags switch per environment (plan 0005)", () => {
  test("production reads the prod switch, development the dev switch", async () => {
    const db = dbWith([row("connector_only_enrollment", false, true)]);
    expect(await readProductFeatures(db, {}, "prod")).toEqual({ connectorOnlyEnrollment: true });
    expect(await readProductFeatures(db, {}, "dev")).toEqual({ connectorOnlyEnrollment: false });
  });

  test("a missing row is off in both environments", async () => {
    for (const environment of ["dev", "prod"] as const) {
      expect(await readProductFeatures(dbWith([]), {}, environment)).toEqual({ connectorOnlyEnrollment: false });
    }
  });

  test("the audience applies in production only; development opens a dev flag to everyone", () => {
    const staffOnly = { featureKey: "connector_only_enrollment", dev: true, prod: true, audience: "assisted" as const };
    expect(productFeatureOn(staffOnly, {}, "prod")).toBe(false);
    expect(productFeatureOn(staffOnly, { assistedBy: "staff-1" }, "prod")).toBe(true);
    expect(productFeatureOn(staffOnly, {}, "dev")).toBe(true);
    expect(productFeatureOn({ ...staffOnly, audience: "off" }, { assistedBy: "staff-1" }, "prod")).toBe(false);
    expect(productFeatureOn({ ...staffOnly, prod: false, audience: "all" }, {}, "prod")).toBe(false);
  });

  test("an audience the core does not know reads as assisted-only, never as open", async () => {
    const db = dbWith([row("connector_only_enrollment", false, true, "vip"), row("thread_compact", false, true, "")]);
    expect(await readResolvedProductFeatures(db, {}, "prod")).toEqual({ connector_only_enrollment: false, thread_compact: false });
    expect(await readResolvedProductFeatures(db, { assistedBy: "staff-1" }, "prod"))
      .toEqual({ connector_only_enrollment: true, thread_compact: true });
  });

  test("the stored assisted-only value (`staff`, 0180) opens only to an assisted session", async () => {
    const db = dbWith([row("connector_only_enrollment", false, true, "staff")]);
    expect(await readResolvedProductFeatures(db, {}, "prod")).toEqual({ connector_only_enrollment: false });
    expect(await readResolvedProductFeatures(db, { assistedBy: "assistant-1" }, "prod")).toEqual({ connector_only_enrollment: true });
  });

  test("only an explicit development environment reads the dev switch", () => {
    expect(productFeatureEnvironment({ OPENEDBOT_ENV: "development" })).toBe("dev");
    expect(productFeatureEnvironment({ NODE_ENV: "development" })).toBe("dev");
    expect(productFeatureEnvironment({ OPENEDBOT_ENV: "production" })).toBe("prod");
    expect(productFeatureEnvironment({ OPENEDBOT_ENV: "preprod" })).toBe("prod");
    expect(productFeatureEnvironment({ NODE_ENV: "test" })).toBe("prod");
    expect(productFeatureEnvironment({})).toBe("prod");
  });

  test("a backoffice switch is read again once the short cache expires", async () => {
    let prod = false;
    let reads = 0;
    let clock = 0;
    const db = (async () => { reads++; return [row("connector_only_enrollment", false, prod)]; }) as unknown as Db;
    const features = liveProductFeatures(db, 15_000, () => clock, "prod");
    expect((await features()).connectorOnlyEnrollment).toBe(false);
    prod = true;
    clock = 14_999;
    expect((await features()).connectorOnlyEnrollment).toBe(false);
    clock = 15_000;
    expect((await features()).connectorOnlyEnrollment).toBe(true);
    expect(reads).toBe(2);
  });
});

describe("feature audiences", () => {
  test("all opens to everyone, off to nobody, assisted only to an assisted session", () => {
    expect(featureAudienceAllows("all", {})).toBe(true);
    expect(featureAudienceAllows("off", { assistedBy: "staff-session" })).toBe(false);
    expect(featureAudienceAllows("assisted", { userId: "u-1" })).toBe(false);
    expect(featureAudienceAllows("assisted", { assistedBy: "staff-session" })).toBe(true);
  });
});
