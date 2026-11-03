import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import { createEntitlementSource, SOLO_ENTITLEMENTS, type EntitlementSource } from "@openedbot/identity/application/entitlements";
import type { ProductFeatures } from "@openedbot/identity/application/product-features";
import { protectedAuthRoutes, type AppVariables, type AuthContext } from "../src/routes/identity/auth";

const ORG = "10000000-0000-4000-8000-000000000001";
const OTHER_ORG = "10000000-0000-4000-8000-000000000002";

function session(organizationId = ORG): AuthContext {
  return {
    sessionId: "session-1",
    organizationId,
    userId: "20000000-0000-4000-8000-000000000001",
    role: "owner",
    kind: "web",
    credentialHash: "credential",
  };
}

/** Every query answers no rows: /me then reports a session without profile, which is enough here. */
function emptyDb(): SQL {
  const tx = (() => Promise.resolve([])) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: SQL) => unknown) => callback(tx);
  return tx;
}

async function me(entitlements: EntitlementSource, auth: AuthContext = session()): Promise<{ status: number; body: { entitlements?: string[] } }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", auth);
    await next();
  });
  app.route("/api/auth", protectedAuthRoutes(emptyDb(), entitlements));
  const response = await app.request("/api/auth/me");
  return { status: response.status, body: await response.json() as { entitlements?: string[] } };
}

const OFF: ProductFeatures = { fleetWorkspaces: false, connectorOnlyEnrollment: false, fleetBilling: false, waitlist: true };

describe("GET /api/auth/me entitlements", () => {
  test("solo: the session holds no plug-in entitlement (core ones are implicit)", async () => {
    const response = await me(SOLO_ENTITLEMENTS);
    expect(response.status).toBe(200);
    expect(response.body.entitlements).toEqual([]);
  });

  test("overrides: BILLING_ENFORCED shows only with the plug-in billing; the staff agency switches only with the plug-in agency, sorted", async () => {
    const features = async () => ({ ...OFF, fleetWorkspaces: true, fleetBilling: true });
    expect((await me(createEntitlementSource({ features, billingEnforced: true }))).body.entitlements).toEqual([]);
    const source = createEntitlementSource({
      features,
      billingEnforced: true,
      pro: { declared: ["fleet.workspaces", "fleet.billing"], grant: async () => false },
    });
    expect((await me(source)).body.entitlements).toEqual(["fleet.billing", "fleet.workspaces"]);
    const billing = createEntitlementSource({
      features,
      billingEnforced: true,
      pro: { declared: ["fleet.workspaces", "fleet.billing", "billing.enforced"], grant: async () => false },
    });
    expect((await me(billing)).body.entitlements).toEqual(["billing.enforced", "fleet.billing", "fleet.workspaces"]);
  });

  test("a plug-in grant is per organization: the session's organization decides", async () => {
    const granted: Array<[string, string]> = [];
    const source = createEntitlementSource({
      features: async () => OFF,
      billingEnforced: false,
      pro: {
        declared: ["reports.export", "billing.enforced"],
        grant: async (organizationId, entitlement) => {
          granted.push([organizationId, entitlement]);
          return organizationId === ORG && entitlement === "reports.export";
        },
      },
    });
    // billing.enforced declared, BILLING_ENFORCED off: not held, and never asked of the grant.
    expect((await me(source)).body.entitlements).toEqual(["reports.export"]);
    expect(granted.every(([organizationId]) => organizationId === ORG)).toBe(true);
    expect((await me(source, session(OTHER_ORG))).body.entitlements).toEqual([]);
  });

  test("a failing source answers no entitlement, never a 500", async () => {
    const broken: EntitlementSource = {
      kind: "entitlements",
      has: async () => { throw new Error("boom"); },
      list: async () => { throw new Error("boom"); },
      features: async () => OFF,
    };
    const response = await me(broken);
    expect(response.status).toBe(200);
    expect(response.body.entitlements).toEqual([]);
  });
});
