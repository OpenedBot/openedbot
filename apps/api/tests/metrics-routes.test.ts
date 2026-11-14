import { describe, expect, test } from "bun:test";
import { BlobMetrics, type BlobStore } from "../src/infrastructure/blob-store";
import type { ApiConfig } from "../src/infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { ApiRuntimeMetrics, internalMetricsRoutes, normalizeOperationalMetrics, normalizeEmailDeliveryMetrics } from "../src/routes/platform/metrics-routes";

const aggregateRow = {
  runStatusCounts: { queued: 3, unknown: 1 },
  runExternalStateCounts: { not_started: 3, ambiguous: 1 },
  workflowStatusCounts: { running: 2 },
  queuedRuns: "3",
  oldestQueuedSeconds: "12.5",
  needsReviewRuns: 1,
  oldestUnknownSeconds: "42.5",
  activeWorkflows: "2",
  unknownWorkflows: 0,
  overdueWorkflows: "1",
  pendingApprovals: 4,
  expiredPendingApprovals: "1",
  oldestPendingApprovalSeconds: 27,
  relayingRuns: "2",
  oldestRelayingSeconds: "601.2",
  activeRunLeases: 3,
  expiredRunLeases: "1",
  missingRunLeases: 0,
};

describe("API runtime metrics", () => {
  test("counts requests and 5xx independently from tenant data", () => {
    const metrics = new ApiRuntimeMetrics();
    metrics.recordRequest();
    metrics.recordRequest();
    metrics.recordServerError();
    const snapshot = metrics.snapshot();
    expect(snapshot.requestsTotal).toBe(2);
    expect(snapshot.serverErrorsTotal).toBe(1);
    expect(Number.isFinite(Date.parse(snapshot.startedAt))).toBe(true);
  });

  test("normalizes database aggregates without tenant identifiers", () => {
    expect(normalizeOperationalMetrics(aggregateRow)).toEqual({
      queue: { depth: 3, oldestAgeSeconds: 12.5 },
      runs: {
        unknown: 1,
        oldestUnknownAgeSeconds: 42.5,
        byStatus: {
          queued: 3, starting: 0, running: 0, awaiting_approval: 0, relaying: 0,
          unknown: 1, completed: 0, failed: 0, cancelled: 0,
        },
        byExternalState: {
          not_started: 3, creating: 0, streaming: 0, polling: 0, stopping: 0, settled: 0, ambiguous: 1,
        },
      },
      workflows: {
        active: 2,
        unknown: 0,
        overdue: 1,
        byStatus: {
          queued: 0, running: 2, awaiting_approval: 0, reconciling: 0,
          completed: 0, failed: 0, cancelled: 0, expired: 0, unknown: 0,
        },
      },
      approvals: { pending: 4, expiredPending: 1, oldestPendingAgeSeconds: 27 },
      handoffs: { relaying: 2, oldestRelayingAgeSeconds: 601.2 },
      leases: { active: 3, expired: 1, missing: 0 },
    });
  });

  test("rejects missing, negative, or non-numeric aggregates", () => {
    expect(() => normalizeOperationalMetrics(undefined)).toThrow(/no row/);
    const valid = {
      runStatusCounts: {},
      runExternalStateCounts: {},
      workflowStatusCounts: {},
      queuedRuns: 0,
      oldestQueuedSeconds: 0,
      needsReviewRuns: 0,
      oldestUnknownSeconds: 0,
      activeWorkflows: 0,
      unknownWorkflows: 0,
      overdueWorkflows: 0,
      pendingApprovals: 0,
      expiredPendingApprovals: 0,
      oldestPendingApprovalSeconds: 0,
      relayingRuns: 0,
      oldestRelayingSeconds: 0,
      activeRunLeases: 0,
      expiredRunLeases: 0,
      missingRunLeases: 0,
    };
    expect(() => normalizeOperationalMetrics({ ...valid, queuedRuns: -1 })).toThrow(/queuedRuns/);
    expect(() => normalizeOperationalMetrics({ ...valid, oldestQueuedSeconds: "never" })).toThrow(/oldestQueuedSeconds/);
    expect(() => normalizeOperationalMetrics({ ...valid, runStatusCounts: { invented: 1 } })).toThrow(/runStatusCounts/);
  });

  test("serves the RLS-safe aggregate as JSON and bounded Prometheus labels", async () => {
    const statements: string[] = [];
    const db = ((strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      statements.push(sql);
      if (sql.includes("from service_instances")) {
        return Promise.resolve([{
          id: "worker-1", service: "worker", processId: 7, rssBytes: "1024", heapUsedBytes: "512",
          activeWork: 2, startedAt: "2026-08-25T00:00:00.000Z", heartbeatAt: "2026-08-25T00:00:01.000Z",
        }]);
      }
      if (sql.includes("from internal_email_delivery_metrics()")) return Promise.resolve([{ pendingLoginCodes: "2", oldestLoginCodeAgeSeconds: "150.5", recentLoginCodeFailures: "3" }]);
      if (sql.includes("from attachments")) return Promise.resolve([{ orphaned: 0, activeBytes: 64 }]);
      if (sql.includes("from internal_operational_metrics()")) return Promise.resolve([aggregateRow]);
      throw new Error(`Unexpected metrics query: ${sql}`);
    }) as unknown as Db;
    const blobs = { metrics: new BlobMetrics() } as BlobStore;
    const app = internalMetricsRoutes(
      { metricsInternalToken: "metrics-secret" } as ApiConfig,
      db,
      new EventHub(),
      blobs,
      new ApiRuntimeMetrics(),
      () => ({
        state: "listening", connected: true, subscriptions: 3, resubscriptions: 2, failures: 1, stalls: 1,
        notifications: 40, runtimeNotifications: 2, ignored: 0, lagMs: 4, maxLagMs: 9, listeningSince: "2026-11-06T00:00:00.000Z",
      }),
    );

    const jsonResponse = await app.request("/", { headers: { Authorization: "Bearer metrics-secret" } });
    expect(jsonResponse.status).toBe(200);
    const json = await jsonResponse.json() as {
      operations: ReturnType<typeof normalizeOperationalMetrics>;
      emailDelivery: ReturnType<typeof normalizeEmailDeliveryMetrics>;
      eventLink: { connected: boolean; resubscriptions: number };
    };
    expect(json.emailDelivery).toEqual({ pendingLoginCodes: 2, oldestLoginCodeAgeSeconds: 150.5, recentLoginCodeFailures: 3 });
    expect(json.eventLink).toMatchObject({ connected: true, resubscriptions: 2 });
    expect(json.operations.queue).toEqual({ depth: 3, oldestAgeSeconds: 12.5 });
    expect(json.operations.runs.byStatus.unknown).toBe(1);

    const textResponse = await app.request("/", {
      headers: { Authorization: "Bearer metrics-secret", Accept: "text/plain" },
    });
    const text = await textResponse.text();
    expect(text).toContain('openedbot_runs_by_status{status="unknown"} 1');
    expect(text).toContain("openedbot_run_leases_expired 1");
    expect(text).toContain("openedbot_email_login_codes_pending 2");
    expect(text).toContain("openedbot_email_login_code_oldest_age_seconds 150.5");
    expect(text).toContain("openedbot_email_login_code_failures_recent 3");
    expect(statements.some((sql) => /from email_outbox\b/.test(sql))).toBe(false);
    expect(text).toContain("openedbot_api_events_listen_connected 1");
    expect(text).toContain("openedbot_api_events_listen_resubscriptions_total 2");
    expect(text).toContain("openedbot_api_events_listen_lag_ms 4");
    expect(statements.some((sql) => sql.includes("internal_operational_metrics()"))).toBe(true);
  });
});


describe("email delivery metrics", () => {
  const zero = { pendingLoginCodes: 0, oldestLoginCodeAgeSeconds: 0, recentLoginCodeFailures: 0 };
  test("reports explicit zeros, rejects absent or malformed aggregates", () => {
    expect(normalizeEmailDeliveryMetrics(zero)).toEqual(zero);
    expect(() => normalizeEmailDeliveryMetrics(undefined)).toThrow(/0184/);
    for (const field of Object.keys(zero)) {
      for (const value of [undefined, null, true, "", " ", -1, NaN, Infinity, "invalid"]) {
        expect(() => normalizeEmailDeliveryMetrics({ ...zero, [field]: value })).toThrow(field);
      }
    }
    expect(() => normalizeEmailDeliveryMetrics({ ...zero, pendingLoginCodes: 1.5 })).toThrow();
    expect(() => normalizeEmailDeliveryMetrics({ ...zero, recentLoginCodeFailures: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
});
