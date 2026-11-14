import { describe, expect, test } from "bun:test";
import { evaluateSample, initialMonitorState, parseMetrics } from "../src/alerting/monitor";

const options = { failuresBeforeAlert: 2, healthyBeforeResolve: 2, repeatMs: 1_800_000, maxQueueAgeSeconds: 120, maxRelayingAgeSeconds: 600 };
function report() {
  return {
    api: { startedAt: "2026-11-11T00:00:00Z", requestsTotal: 0, serverErrorsTotal: 0 },
    instances: [{ service: "api" }, { service: "worker" }],
    emailDelivery: { pendingLoginCodes: 0, oldestLoginCodeAgeSeconds: 0, recentLoginCodeFailures: 0 },
    operations: {
      queue: { depth: 0, oldestAgeSeconds: 0 },
      runs: { unknown: 0, oldestUnknownAgeSeconds: 0 },
      workflows: { active: 0, unknown: 0, overdue: 0 },
      approvals: { pending: 0, expiredPending: 0, oldestPendingAgeSeconds: 0 },
      handoffs: { relaying: 0, oldestRelayingAgeSeconds: 0 },
      leases: { active: 0, expired: 0, missing: 0 },
    },
  };
}

describe("login email monitoring", () => {
  test("requires email metrics and rejects invalid values instead of silently reporting health", () => {
    const healthy = report();
    expect(parseMetrics(healthy)?.emailDelivery).toEqual(healthy.emailDelivery);
    expect(parseMetrics({ ...healthy, emailDelivery: undefined })).toBeNull();
    for (const field of Object.keys(healthy.emailDelivery)) {
      for (const value of [undefined, null, true, "0", -1, NaN, Infinity]) {
        expect(parseMetrics({ ...healthy, emailDelivery: { ...healthy.emailDelivery, [field]: value } })).toBeNull();
      }
    }
    expect(parseMetrics({ ...healthy, emailDelivery: { ...healthy.emailDelivery, pendingLoginCodes: 0.5 } })).toBeNull();
  });

  test("provider failures fire despite healthy API and worker, then resolve after the failure window clears", () => {
    const failed = report();
    failed.emailDelivery = { pendingLoginCodes: 1, oldestLoginCodeAgeSeconds: 30, recentLoginCodeFailures: 1 };
    const sample = { reasons: [], metrics: parseMetrics(failed) };
    const first = evaluateSample(initialMonitorState(), sample, 0, options);
    expect(first.notification).toBeNull();
    const second = evaluateSample(first.state, sample, 30_000, options);
    expect(second.notification?.status).toBe("firing");
    expect(second.notification?.reasons).toEqual(["1 code(s) de connexion avec échec de livraison sur 10 min"]);
    const recovered = { reasons: [], metrics: parseMetrics(report()) };
    const third = evaluateSample(second.state, recovered, 660_000, options);
    expect(third.notification).toBeNull();
    expect(evaluateSample(third.state, recovered, 690_000, options).notification?.status).toBe("resolved");
  });

  test("stalled pending or sending codes alert at two minutes before expiry even without failure events", () => {
    const stalled = report();
    stalled.emailDelivery = { pendingLoginCodes: 2, oldestLoginCodeAgeSeconds: 119, recentLoginCodeFailures: 0 };
    const sample = () => ({ reasons: [], metrics: parseMetrics(stalled) });
    const healthy = evaluateSample(initialMonitorState(), sample(), 119_000, options);
    expect(healthy.state.phase).toBe("healthy");
    stalled.emailDelivery.oldestLoginCodeAgeSeconds = 120;
    const first = evaluateSample(healthy.state, sample(), 120_000, options);
    const second = evaluateSample(first.state, sample(), 150_000, options);
    expect(second.notification?.status).toBe("firing");
    expect(second.notification?.reasons).toEqual(["2 code(s) de connexion en attente, plus ancien depuis 120 s"]);
  });
});
