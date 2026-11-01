import { describe, expect, test } from "bun:test";
import { HermesClientError } from "@openedbot/hermes";
import { attemptPatienceMinutes, failureCode, NamedRunError, retryDelaySeconds, shouldRetryHermesRun } from "../../src/application/runner/failure";

describe("failureCode", () => {
  test("un 400 dont le diagnostic dit « Model is unavailable » porte MODEL_UNAVAILABLE", () => {
    const error = new HermesClientError(
      "Hermes a refusé la requête (HTTP 400). Le détail technique est dans le journal du worker.",
      400,
      "HERMES_RESPONSE_INVALID",
      { requestDelivery: "response_received", diagnostic: "Upstream request failed: Model is unavailable." },
    );

    expect(failureCode(error)).toBe("MODEL_UNAVAILABLE");
  });

  test("les autres échecs gardent leur code", () => {
    const opaque = new HermesClientError("Hermes a refusé la requête (HTTP 400).", 400, "HERMES_RESPONSE_INVALID", {
      diagnostic: "Upstream request failed: bad request",
    });
    const quota = new HermesClientError("limite", 429, "HERMES_LIMIT_REACHED", { diagnostic: "Model is unavailable" });
    const down = new HermesClientError("injoignable", 0, "HERMES_UNREACHABLE");

    expect(failureCode(opaque)).toBe("HERMES_RESPONSE_INVALID");
    expect(failureCode(quota)).toBe("HERMES_LIMIT_REACHED");
    expect(failureCode(down)).toBe("HERMES_UNREACHABLE");
    expect(failureCode(new NamedRunError("SERVICE_STEP_RETIRED", "x"))).toBe("SERVICE_STEP_RETIRED");
    expect(failureCode(new Error("boom"))).toBe("WORKER_RUN_FAILED");
  });
});

describe("the gateway's concurrent-run cap (DEV-OHB-244)", () => {
  const cap = new HermesClientError("Hermes a atteint sa limite de runs simultanés.", 429, "HERMES_LIMIT_REACHED", { requestDelivery: "response_received" });

  test("requeues the run while attempts remain, then gives up", () => {
    expect(shouldRetryHermesRun(cap, 1)).toBe(true);
    expect(shouldRetryHermesRun(cap, 5)).toBe(false);
  });

  test("waits at least 10 seconds before the next try", () => {
    expect(retryDelaySeconds(cap, 0)).toBeGreaterThanOrEqual(10);
  });
});

describe("a gateway restarting gracefully (503 gateway_draining)", () => {
  const draining = new HermesClientError(
    "Le gateway Hermes redémarre : il finit ses runs en cours avant d'en accepter de nouveaux.",
    503,
    "HERMES_GATEWAY_DRAINING",
    { requestDelivery: "response_received", retryAfterMs: 1_000 },
  );

  test("requeues the run: the gateway refused it before creating anything", () => {
    expect(shouldRetryHermesRun(draining, 1)).toBe(true);
    expect(failureCode(draining)).toBe("HERMES_GATEWAY_DRAINING");
  });

  test("comes back every few seconds, without the exponential backoff", () => {
    for (const attempts of [0, 3, 4]) {
      const delay = retryDelaySeconds(draining, attempts);
      expect(delay).toBeGreaterThanOrEqual(3);
      expect(delay).toBeLessThan(4);
    }
  });

  test("an ambiguous delivery is never retried as a drain", () => {
    const ambiguous = new HermesClientError("x", 503, "HERMES_GATEWAY_DRAINING", { requestDelivery: "ambiguous" });
    expect(shouldRetryHermesRun(ambiguous, 1)).toBe(false);
  });
});

describe("attempts a gateway restart does not spend", () => {
  test("a drain and a relaunch (nothing sent) hand the attempt back, for a bounded time", () => {
    const draining = new HermesClientError("x", 503, "HERMES_GATEWAY_DRAINING", { requestDelivery: "response_received" });
    const refused = new HermesClientError("x", 503, "HERMES_UNREACHABLE", { requestDelivery: "not_sent" });
    expect(attemptPatienceMinutes(draining)).toBe(35);
    expect(attemptPatienceMinutes(refused)).toBe(2);
  });

  test("anything that may have reached the gateway spends its attempt", () => {
    const maybeSent = new HermesClientError("x", 502, "HERMES_UNREACHABLE", { requestDelivery: "ambiguous" });
    const cap = new HermesClientError("x", 429, "HERMES_LIMIT_REACHED", { requestDelivery: "response_received" });
    expect(attemptPatienceMinutes(maybeSent)).toBe(0);
    expect(attemptPatienceMinutes(cap)).toBe(0);
  });
});
