import { describe, expect, test } from "bun:test";
import { assertEntitled, assertEntitledBy, isEntitled, isEntitledBy } from "../src/domain/entitlement";
import { createEntitlementSource, PRO_ENTITLEMENTS } from "../src/application/entitlements";
import { HttpError } from "@openedbot/contracts-errors/http-error";

describe("isEntitled", () => {
  test("billing désactivé (phase test): tout est habilité, même sans abonnement", () => {
    expect(isEntitled(false, null)).toBe(true);
    expect(isEntitled(false, { status: "past_due" })).toBe(true);
    expect(isEntitled(false, undefined)).toBe(true);
  });

  test("billing appliqué: seuls active/trialing passent", () => {
    expect(isEntitled(true, { status: "active" })).toBe(true);
    expect(isEntitled(true, { status: "trialing" })).toBe(true);
    expect(isEntitled(true, { status: "past_due" })).toBe(false);
    expect(isEntitled(true, { status: "canceled" })).toBe(false);
    expect(isEntitled(true, null)).toBe(false);
  });
});

describe("assertEntitled", () => {
  test("ne lève rien quand habilité", () => {
    expect(() => assertEntitled(false, null)).not.toThrow();
    expect(() => assertEntitled(true, { status: "active" })).not.toThrow();
  });

  test("past_due → 402 SUBSCRIPTION_PAST_DUE, inactif → 403 SUBSCRIPTION_INACTIVE", () => {
    try {
      assertEntitled(true, { status: "past_due" });
      throw new Error("attendu: lève");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(402);
      expect((error as HttpError).code).toBe("SUBSCRIPTION_PAST_DUE");
    }
    try {
      assertEntitled(true, null);
      throw new Error("attendu: lève");
    } catch (error) {
      expect((error as HttpError).status).toBe(403);
      expect((error as HttpError).code).toBe("SUBSCRIPTION_INACTIVE");
    }
  });
});

describe("facade over EntitlementSource", () => {
  const closed = async () => ({ connectorOnlyEnrollment: false });
  const source = (billingEnforced: boolean, declared: string[] = []) =>
    createEntitlementSource({ features: closed, billingEnforced, pro: { declared, grant: async () => false } });

  test("billing.enforced is resolved by the source: the plug-in billing declaring it AND BILLING_ENFORCED", async () => {
    const billing = ["billing.enforced"];
    expect(PRO_ENTITLEMENTS.billingEnforced).toBe("billing.enforced");
    expect(await isEntitledBy(source(false), null)).toBe(true);
    // Solo (no plug-in billing): BILLING_ENFORCED alone puts up no paywall.
    expect(await isEntitledBy(source(true), null)).toBe(true);
    expect(await isEntitledBy(source(false, billing), null)).toBe(true);
    expect(await isEntitledBy(source(true, billing), null)).toBe(false);
    expect(await isEntitledBy(source(true, billing), { status: "trialing" })).toBe(true);
  });

  test("assertEntitledBy throws like assertEntitled", async () => {
    await expect(assertEntitledBy(source(true, ["billing.enforced"]), { status: "past_due" })).rejects.toMatchObject({ status: 402, code: "SUBSCRIPTION_PAST_DUE" });
    await assertEntitledBy(source(true), { status: "past_due" });
    await assertEntitledBy(source(false), null);
  });
});
