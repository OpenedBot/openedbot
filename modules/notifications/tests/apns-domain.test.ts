import { describe, expect, test } from "bun:test";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import {
  apnsCollapseId,
  apnsPayload,
  apnsPriority,
  apnsReasonCode,
  apnsRetryDelaySeconds,
  classifyApnsResponse,
  readApnsInstallationId,
  readApnsRegistrationInput,
} from "../src/domain/apns";
import { apnsTokenHash } from "../src/application/apns-devices";

const TOKEN = "a1".repeat(32);
const BUNDLES = ["app.openedbot.mobile"];

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof HttpError ? `${error.status} ${error.code}` : "not an HttpError";
  }
}

describe("readApnsRegistrationInput", () => {
  test("accepts the contract body and normalizes the token to lower-case hex", () => {
    expect(readApnsRegistrationInput(
      { token: TOKEN.toUpperCase(), bundleId: "app.openedbot.mobile", environment: "sandbox" },
      BUNDLES,
    )).toEqual({ token: TOKEN, bundleId: "app.openedbot.mobile", environment: "sandbox" });
  });

  test("refuses a malformed token, an unknown bundle and an unknown environment", () => {
    expect(codeOf(() => readApnsRegistrationInput({ token: "zz", bundleId: BUNDLES[0], environment: "sandbox" }, BUNDLES)))
      .toBe("400 APNS_TOKEN_INVALID");
    expect(codeOf(() => readApnsRegistrationInput({ token: "a1".repeat(31), bundleId: BUNDLES[0], environment: "sandbox" }, BUNDLES)))
      .toBe("400 APNS_TOKEN_INVALID");
    expect(codeOf(() => readApnsRegistrationInput({ token: `${TOKEN}a`, bundleId: BUNDLES[0], environment: "sandbox" }, BUNDLES)))
      .toBe("400 APNS_TOKEN_INVALID");
    expect(codeOf(() => readApnsRegistrationInput({ token: TOKEN, bundleId: "com.evil.app", environment: "sandbox" }, BUNDLES)))
      .toBe("400 APNS_BUNDLE_ID_NOT_ALLOWED");
    expect(codeOf(() => readApnsRegistrationInput({ token: TOKEN, bundleId: BUNDLES[0], environment: "development" }, BUNDLES)))
      .toBe("400 VALIDATION_ERROR");
  });

  test("an installation id is a bounded path class", () => {
    expect(readApnsInstallationId("6F1C2B9A-1D2E-4F00-9A11-2B3C4D5E6F70")).toBe("6F1C2B9A-1D2E-4F00-9A11-2B3C4D5E6F70");
    expect(codeOf(() => readApnsInstallationId("../etc"))).toBe("400 VALIDATION_ERROR");
    expect(codeOf(() => readApnsInstallationId("a".repeat(129)))).toBe("400 VALIDATION_ERROR");
    expect(codeOf(() => readApnsInstallationId(""))).toBe("400 VALIDATION_ERROR");
  });

  test("the hash ignores case, so one device never hashes two ways", () => {
    expect(apnsTokenHash(TOKEN)).toBe(apnsTokenHash(TOKEN.toUpperCase()));
    expect(apnsTokenHash(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("apnsPayload", () => {
  test("matches the client contract exactly, with public copy only", () => {
    expect(apnsPayload({
      eventType: "approval.requested",
      workflowKind: "routine",
      name: "SEO Geo",
      threadId: "thread-1",
      organizationId: "org-1",
    })).toEqual({
      aps: {
        alert: { title: "SEO Geo", body: "Approbation en attente" },
        sound: "default",
        "thread-id": "thread-1",
      },
      openedbot: { kind: "approval", threadId: "thread-1", organizationId: "org-1" },
    });
  });

  test("the body names the transition by workflow kind", () => {
    const body = (eventType: "run.completed" | "run.error", workflowKind: "dm" | "group" | "routine") =>
      apnsPayload({ eventType, workflowKind, name: "x", threadId: "t", organizationId: "o" }).aps.alert.body;
    expect(body("run.completed", "routine")).toBe("Routine terminée");
    expect(body("run.error", "routine")).toBe("Routine en échec");
    expect(body("run.completed", "group")).toBe("Salon terminé");
    expect(body("run.error", "group")).toBe("Échec dans le salon");
    expect(body("run.completed", "dm")).toBe("Workflow terminé");
    expect(body("run.error", "dm")).toBe("Échec du workflow");
    expect(apnsPayload({ eventType: "run.error", workflowKind: "dm", name: "x", threadId: "t", organizationId: "o" }).openedbot.kind)
      .toBe("workflow");
  });

  test("an empty or oversized name stays a bounded title", () => {
    expect(apnsPayload({ eventType: "run.completed", workflowKind: "dm", name: "  ", threadId: "t", organizationId: "o" }).aps.alert.title)
      .toBe("openedbot");
    expect(apnsPayload({ eventType: "run.completed", workflowKind: "dm", name: "n".repeat(500), threadId: "t", organizationId: "o" }).aps.alert.title)
      .toHaveLength(200);
  });
});

describe("delivery headers and outcomes", () => {
  test("approvals are priority 10 and collapse per transition; outcomes 5 and per workflow", () => {
    const workflowId = "7d4c1a52-1111-4222-8333-944455556666";
    expect(apnsPriority("approval.requested")).toBe(10);
    expect(apnsPriority("run.completed")).toBe(5);
    expect(apnsCollapseId({ eventType: "approval.requested", workflowId, notificationSequence: 3 }))
      .toBe(`approval:${workflowId}:3`);
    expect(apnsCollapseId({ eventType: "run.error", workflowId, notificationSequence: 4 })).toBe(`workflow:${workflowId}`);
    expect(Buffer.byteLength(apnsCollapseId({ eventType: "approval.requested", workflowId, notificationSequence: 2 ** 53 - 1 })))
      .toBeLessThanOrEqual(64);
  });

  test("Apple answers map to sent, revoke, retry or fail", () => {
    expect(classifyApnsResponse(200, null)).toEqual({ kind: "sent" });
    expect(classifyApnsResponse(410, "Unregistered")).toEqual({ kind: "revoke", reason: "unregistered" });
    expect(classifyApnsResponse(410, "ExpiredToken")).toEqual({ kind: "revoke", reason: "unregistered" });
    expect(classifyApnsResponse(400, "BadDeviceToken")).toEqual({ kind: "revoke", reason: "bad_device_token" });
    expect(classifyApnsResponse(400, "DeviceTokenNotForTopic")).toEqual({ kind: "revoke", reason: "device_token_not_for_topic" });
    expect(classifyApnsResponse(429, "TooManyRequests")).toEqual({ kind: "retry", refreshProviderToken: false });
    expect(classifyApnsResponse(500, "InternalServerError")).toEqual({ kind: "retry", refreshProviderToken: false });
    expect(classifyApnsResponse(503, "ServiceUnavailable")).toEqual({ kind: "retry", refreshProviderToken: false });
    expect(classifyApnsResponse(403, "ExpiredProviderToken")).toEqual({ kind: "retry", refreshProviderToken: true });
    expect(classifyApnsResponse(400, "BadCollapseId")).toEqual({ kind: "fail" });
    expect(classifyApnsResponse(413, "PayloadTooLarge")).toEqual({ kind: "fail" });
  });

  test("backoff is bounded", () => {
    expect([1, 2, 3, 4, 5, 9].map(apnsRetryDelaySeconds)).toEqual([30, 120, 480, 1_800, 1_800, 1_800]);
  });

  test("only single-word reasons are recorded", () => {
    expect(apnsReasonCode("BadDeviceToken")).toBe("BadDeviceToken");
    expect(apnsReasonCode("bad token <script>")).toBeNull();
    expect(apnsReasonCode(42)).toBeNull();
  });
});
