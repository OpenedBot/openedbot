import { isoInstant } from "@openedbot/contracts-primitives";
import { internalAuthMetrics } from "@openedbot/platform-observability/internal-auth";
import { Hono } from "hono";
import { HostCallMetrics, TrafficCounters, type TrafficCounter } from "@openedbot/runtime-link/application/host-call-metrics";
import { totalmem } from "node:os";
import type { ApiConfig } from "../../infrastructure/config";
import { constantTimeEqual } from "../../infrastructure/crypto";
import type { Db } from "@openedbot/platform-db";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { HttpError } from "../../interfaces/http/http-error";
import type { BlobStore } from "../../infrastructure/blob-store";
import type { EventLinkStatus } from "../../infrastructure/event-notifications";

/**
 * This process's request counters (rework-flux-api, step 0). Per process and
 * reset at restart, like any counter: `startedAt` dates them, and a
 * deployment total is the sum over the replicas scraped one by one.
 */
export { TrafficCounters, type TrafficCounter };

export class ApiRuntimeMetrics {
  readonly startedAt = new Date();
  #requestsTotal = 0;
  #serverErrorsTotal = 0;
  readonly routes = new TrafficCounters();
  readonly hostCalls = new HostCallMetrics();

  recordRequest(): void { this.#requestsTotal += 1; }
  recordServerError(): void { this.#serverErrorsTotal += 1; }
  /** `GET /api/runtime 2xx`: method, Hono route pattern, status class. */
  recordRoute(method: string, route: string, status: number, durationMs: number): void {
    this.routes.record(`${method} ${route} ${Math.floor(status / 100)}xx`, durationMs);
  }
  /**
   * A request sent to a host over a socket THIS process holds (broker
   * `onDispatch`): counted once whichever route or replica asked for it.
   */
  recordHostCall(dispatch: Parameters<HostCallMetrics["record"]>[0]): void {
    this.hostCalls.record(dispatch);
  }
  snapshot(): {
    startedAt: string;
    requestsTotal: number;
    serverErrorsTotal: number;
    routes: TrafficCounter[];
    hostCalls: TrafficCounter[];
  } {
    return {
      startedAt: this.startedAt.toISOString(),
      requestsTotal: this.#requestsTotal,
      serverErrorsTotal: this.#serverErrorsTotal,
      routes: this.routes.snapshot(),
      hostCalls: this.hostCalls.snapshot(),
    };
  }
}

export function internalMetricsRoutes(
  config: ApiConfig,
  db: Db,
  hub: EventHub,
  blobs: BlobStore,
  runtimeMetrics: ApiRuntimeMetrics,
  /** THIS process's LISTEN link (S6); absent: not reported. */
  eventLink: () => EventLinkStatus | null = () => null,
): Hono {
  const routes = new Hono();
  routes.get("/", async (context) => {
    const authorization = context.req.header("Authorization") ?? "";
    if (!constantTimeEqual(authorization, `Bearer ${config.metricsInternalToken}`)) {
      throw new HttpError(401, "METRICS_AUTH_INVALID", "Authentification métriques invalide.");
    }
    const instances = await db<Array<{
      id: string;
      service: "api" | "worker";
      processId: number;
      rssBytes: string | number;
      heapUsedBytes: string | number;
      activeWork: number;
      startedAt: Date | string;
      heartbeatAt: Date | string;
    }>>`
      select id, service, process_id as "processId", rss_bytes as "rssBytes",
             heap_used_bytes as "heapUsedBytes", active_work as "activeWork",
             started_at as "startedAt", heartbeat_at as "heartbeatAt"
        from service_instances
       where heartbeat_at > now() - interval '15 seconds'
       order by service, id
    `;
    const normalized = instances.map((instance) => ({
      ...instance,
      rssBytes: Number(instance.rssBytes),
      heapUsedBytes: Number(instance.heapUsedBytes),
      startedAt: isoInstant(instance.startedAt),
      heartbeatAt: isoInstant(instance.heartbeatAt),
    }));
    const totalRssBytes = normalized.reduce((sum, instance) => sum + instance.rssBytes, 0);
    const totalHeapUsedBytes = normalized.reduce((sum, instance) => sum + instance.heapUsedBytes, 0);
    const activeRuns = normalized
      .filter((instance) => instance.service === "worker")
      .reduce((sum, instance) => sum + instance.activeWork, 0);
    const attachmentRows = await db<Array<{ orphaned: string | number; activeBytes: string | number }>>`
      select
        count(*) filter (where deleted_at is not null) as orphaned,
        coalesce(sum(bytes) filter (where deleted_at is null), 0) as "activeBytes"
        from attachments
    `;
    const operationalRows = await db<OperationalMetricsRow[]>`
      select run_status_counts as "runStatusCounts",
             run_external_state_counts as "runExternalStateCounts",
             workflow_status_counts as "workflowStatusCounts",
             queued_runs as "queuedRuns",
             oldest_queued_seconds as "oldestQueuedSeconds",
             needs_review_runs as "needsReviewRuns",
             oldest_unknown_seconds as "oldestUnknownSeconds",
             active_workflows as "activeWorkflows",
             unknown_workflows as "unknownWorkflows",
             overdue_workflows as "overdueWorkflows",
             pending_approvals as "pendingApprovals",
             expired_pending_approvals as "expiredPendingApprovals",
             oldest_pending_approval_seconds as "oldestPendingApprovalSeconds",
             relaying_runs as "relayingRuns",
             oldest_relaying_seconds as "oldestRelayingSeconds",
             active_run_leases as "activeRunLeases",
             expired_run_leases as "expiredRunLeases",
             missing_run_leases as "missingRunLeases"
        from internal_operational_metrics()
    `;
    const emailRows = await db<EmailDeliveryMetricsRow[]>`
      select pending_login_codes as "pendingLoginCodes",
             oldest_login_code_age_seconds as "oldestLoginCodeAgeSeconds",
             recent_login_code_failures as "recentLoginCodeFailures"
        from internal_email_delivery_metrics()
    `;
    const blobMetrics = blobs.metrics.snapshot();
    const report = {
      generatedAt: new Date().toISOString(),
      totalRssBytes,
      totalHeapUsedBytes,
      hostTotalMemoryBytes: totalmem(),
      sseConnections: hub.subscriberCount(),
      activeRuns,
      api: runtimeMetrics.snapshot(),
      // This API process only: the gateway and the worker log theirs (`internal_auth.*`).
      internalAuth: internalAuthMetrics.snapshot(),
      eventLink: eventLink(),
      attachments: {
        activeBytes: Number(attachmentRows[0]?.activeBytes ?? 0),
        orphaned: Number(attachmentRows[0]?.orphaned ?? 0),
        ...blobMetrics,
      },
      operations: normalizeOperationalMetrics(operationalRows[0]),
      emailDelivery: normalizeEmailDeliveryMetrics(emailRows[0]),
      instances: normalized,
    };
    if (context.req.header("Accept")?.includes("text/plain")) {
      return context.text(prometheus(report), 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    }
    return context.json(report);
  });
  return routes;
}

export async function recordApiHeartbeat(db: Db, instanceId: string, activeSse: number, startedAt: Date): Promise<void> {
  const memory = process.memoryUsage();
  await db`
    insert into service_instances (
      id, service, process_id, rss_bytes, heap_used_bytes, active_work, started_at, heartbeat_at
    ) values (
      ${instanceId}, 'api', ${process.pid}, ${memory.rss}, ${memory.heapUsed}, ${activeSse}, ${startedAt}, now()
    )
    on conflict (id) do update set process_id = excluded.process_id, rss_bytes = excluded.rss_bytes,
      heap_used_bytes = excluded.heap_used_bytes, active_work = excluded.active_work,
      started_at = excluded.started_at, heartbeat_at = now()
  `;
}

type MetricsReport = {
  totalRssBytes: number;
  totalHeapUsedBytes: number;
  hostTotalMemoryBytes: number;
  sseConnections: number;
  activeRuns: number;
  api: { startedAt: string; requestsTotal: number; serverErrorsTotal: number };
  internalAuth: { bearers: Record<string, number>; runKeys: Record<string, number> };
  eventLink: EventLinkStatus | null;
  attachments: {
    activeBytes: number;
    orphaned: number;
    writes: number;
    deletes: number;
    bytesWritten: number;
    bytesDeleted: number;
    errors: number;
  };
  operations: OperationalMetrics;
  emailDelivery: EmailDeliveryMetrics;
  instances: Array<{ service: string; activeWork: number; rssBytes: number }>;
};

type EmailDeliveryMetricsRow = {
  pendingLoginCodes: unknown;
  oldestLoginCodeAgeSeconds: unknown;
  recentLoginCodeFailures: unknown;
};

export type EmailDeliveryMetrics = {
  pendingLoginCodes: number;
  oldestLoginCodeAgeSeconds: number;
  /** Messages with a retry or terminal failure in the last ten minutes, counted once. */
  recentLoginCodeFailures: number;
};

export function normalizeEmailDeliveryMetrics(row: EmailDeliveryMetricsRow | undefined): EmailDeliveryMetrics {
  if (!row) throw new Error("Email delivery metrics query returned no row; apply migration 0184.");
  return {
    pendingLoginCodes: metricCount(row.pendingLoginCodes, "pendingLoginCodes"),
    oldestLoginCodeAgeSeconds: metricDuration(row.oldestLoginCodeAgeSeconds, "oldestLoginCodeAgeSeconds"),
    recentLoginCodeFailures: metricCount(row.recentLoginCodeFailures, "recentLoginCodeFailures"),
  };
}

type OperationalMetricsRow = {
  runStatusCounts: unknown;
  runExternalStateCounts: unknown;
  workflowStatusCounts: unknown;
  queuedRuns: string | number;
  oldestQueuedSeconds: string | number;
  needsReviewRuns: string | number;
  oldestUnknownSeconds: string | number;
  activeWorkflows: string | number;
  unknownWorkflows: string | number;
  overdueWorkflows: string | number;
  pendingApprovals: string | number;
  expiredPendingApprovals: string | number;
  oldestPendingApprovalSeconds: string | number;
  relayingRuns: string | number;
  oldestRelayingSeconds: string | number;
  activeRunLeases: string | number;
  expiredRunLeases: string | number;
  missingRunLeases: string | number;
};

export type OperationalMetrics = {
  queue: { depth: number; oldestAgeSeconds: number };
  runs: {
    unknown: number;
    oldestUnknownAgeSeconds: number;
    byStatus: Record<string, number>;
    byExternalState: Record<string, number>;
  };
  workflows: { active: number; unknown: number; overdue: number; byStatus: Record<string, number> };
  approvals: { pending: number; expiredPending: number; oldestPendingAgeSeconds: number };
  handoffs: { relaying: number; oldestRelayingAgeSeconds: number };
  leases: { active: number; expired: number; missing: number };
};

export function normalizeOperationalMetrics(row: OperationalMetricsRow | undefined): OperationalMetrics {
  if (!row) throw new Error("Operational metrics query returned no row.");
  return {
    queue: {
      depth: metricCount(row.queuedRuns, "queuedRuns"),
      oldestAgeSeconds: metricDuration(row.oldestQueuedSeconds, "oldestQueuedSeconds"),
    },
    runs: {
      unknown: metricCount(row.needsReviewRuns, "needsReviewRuns"),
      oldestUnknownAgeSeconds: metricDuration(row.oldestUnknownSeconds, "oldestUnknownSeconds"),
      byStatus: metricBreakdown(row.runStatusCounts, RUN_STATUSES, "runStatusCounts"),
      byExternalState: metricBreakdown(row.runExternalStateCounts, RUN_EXTERNAL_STATES, "runExternalStateCounts"),
    },
    workflows: {
      active: metricCount(row.activeWorkflows, "activeWorkflows"),
      unknown: metricCount(row.unknownWorkflows, "unknownWorkflows"),
      overdue: metricCount(row.overdueWorkflows, "overdueWorkflows"),
      byStatus: metricBreakdown(row.workflowStatusCounts, WORKFLOW_STATUSES, "workflowStatusCounts"),
    },
    approvals: {
      pending: metricCount(row.pendingApprovals, "pendingApprovals"),
      expiredPending: metricCount(row.expiredPendingApprovals, "expiredPendingApprovals"),
      oldestPendingAgeSeconds: metricDuration(row.oldestPendingApprovalSeconds, "oldestPendingApprovalSeconds"),
    },
    handoffs: {
      relaying: metricCount(row.relayingRuns, "relayingRuns"),
      oldestRelayingAgeSeconds: metricDuration(row.oldestRelayingSeconds, "oldestRelayingSeconds"),
    },
    leases: {
      active: metricCount(row.activeRunLeases, "activeRunLeases"),
      expired: metricCount(row.expiredRunLeases, "expiredRunLeases"),
      missing: metricCount(row.missingRunLeases, "missingRunLeases"),
    },
  };
}

/** `role.outcome` counts of the internal verifiers of this process (S1b). */
function internalAuthLines(counts: MetricsReport["internalAuth"]): string[] {
  const lines: string[] = [];
  for (const [kind, entries] of [["bearer", counts.bearers], ["run_key", counts.runKeys]] as const) {
    const metric = `openedbot_internal_auth_${kind}_total`;
    lines.push(`# TYPE ${metric} counter`);
    for (const [key, value] of Object.entries(entries)) {
      const [subject, outcome] = key.split(".");
      lines.push(`${metric}{${kind === "bearer" ? "role" : "label"}="${subject}",outcome="${outcome}"} ${value}`);
    }
  }
  return lines;
}

function prometheus(report: MetricsReport): string {
  const lines = [
    "# TYPE openedbot_process_rss_bytes gauge",
    `openedbot_process_rss_bytes ${report.totalRssBytes}`,
    "# TYPE openedbot_process_heap_used_bytes gauge",
    `openedbot_process_heap_used_bytes ${report.totalHeapUsedBytes}`,
    "# TYPE openedbot_host_total_memory_bytes gauge",
    `openedbot_host_total_memory_bytes ${report.hostTotalMemoryBytes}`,
    "# TYPE openedbot_sse_connections gauge",
    `openedbot_sse_connections ${report.sseConnections}`,
    "# TYPE openedbot_active_runs gauge",
    `openedbot_active_runs ${report.activeRuns}`,
    "# TYPE openedbot_api_requests_total counter",
    `openedbot_api_requests_total ${report.api.requestsTotal}`,
    "# TYPE openedbot_api_server_errors_total counter",
    `openedbot_api_server_errors_total ${report.api.serverErrorsTotal}`,
    ...internalAuthLines(report.internalAuth),
    ...eventLinkLines(report.eventLink),
    `openedbot_attachment_active_bytes ${report.attachments.activeBytes}`,
    `openedbot_attachment_orphaned ${report.attachments.orphaned}`,
    `openedbot_blob_writes_total ${report.attachments.writes}`,
    `openedbot_blob_deletes_total ${report.attachments.deletes}`,
    `openedbot_blob_bytes_written_total ${report.attachments.bytesWritten}`,
    `openedbot_blob_bytes_deleted_total ${report.attachments.bytesDeleted}`,
    `openedbot_blob_errors_total ${report.attachments.errors}`,
    "# TYPE openedbot_email_login_codes_pending gauge",
    `openedbot_email_login_codes_pending ${report.emailDelivery.pendingLoginCodes}`,
    "# TYPE openedbot_email_login_code_oldest_age_seconds gauge",
    `openedbot_email_login_code_oldest_age_seconds ${report.emailDelivery.oldestLoginCodeAgeSeconds}`,
    "# TYPE openedbot_email_login_code_failures_recent gauge",
    `openedbot_email_login_code_failures_recent ${report.emailDelivery.recentLoginCodeFailures}`,
    "# TYPE openedbot_queue_runs gauge",
    `openedbot_queue_runs ${report.operations.queue.depth}`,
    "# TYPE openedbot_queue_oldest_age_seconds gauge",
    `openedbot_queue_oldest_age_seconds ${report.operations.queue.oldestAgeSeconds}`,
    "# TYPE openedbot_runs_unknown gauge",
    `openedbot_runs_unknown ${report.operations.runs.unknown}`,
    "# TYPE openedbot_runs_oldest_unknown_age_seconds gauge",
    `openedbot_runs_oldest_unknown_age_seconds ${report.operations.runs.oldestUnknownAgeSeconds}`,
    "# TYPE openedbot_workflows_active gauge",
    `openedbot_workflows_active ${report.operations.workflows.active}`,
    "# TYPE openedbot_workflows_unknown gauge",
    `openedbot_workflows_unknown ${report.operations.workflows.unknown}`,
    "# TYPE openedbot_workflows_overdue gauge",
    `openedbot_workflows_overdue ${report.operations.workflows.overdue}`,
    "# TYPE openedbot_approvals_pending gauge",
    `openedbot_approvals_pending ${report.operations.approvals.pending}`,
    "# TYPE openedbot_approvals_expired_pending gauge",
    `openedbot_approvals_expired_pending ${report.operations.approvals.expiredPending}`,
    "# TYPE openedbot_approvals_oldest_pending_age_seconds gauge",
    `openedbot_approvals_oldest_pending_age_seconds ${report.operations.approvals.oldestPendingAgeSeconds}`,
    "# TYPE openedbot_handoffs_relaying gauge",
    `openedbot_handoffs_relaying ${report.operations.handoffs.relaying}`,
    "# TYPE openedbot_handoffs_oldest_relaying_age_seconds gauge",
    `openedbot_handoffs_oldest_relaying_age_seconds ${report.operations.handoffs.oldestRelayingAgeSeconds}`,
    "# TYPE openedbot_run_leases_active gauge",
    `openedbot_run_leases_active ${report.operations.leases.active}`,
    "# TYPE openedbot_run_leases_expired gauge",
    `openedbot_run_leases_expired ${report.operations.leases.expired}`,
    "# TYPE openedbot_run_leases_missing gauge",
    `openedbot_run_leases_missing ${report.operations.leases.missing}`,
    "# TYPE openedbot_runs_by_status gauge",
    "# TYPE openedbot_runs_by_external_state gauge",
    "# TYPE openedbot_workflows_by_status gauge",
  ];
  for (const [status, total] of Object.entries(report.operations.runs.byStatus)) {
    lines.push(`openedbot_runs_by_status{status="${status}"} ${total}`);
  }
  for (const [state, total] of Object.entries(report.operations.runs.byExternalState)) {
    lines.push(`openedbot_runs_by_external_state{state="${state}"} ${total}`);
  }
  for (const [status, total] of Object.entries(report.operations.workflows.byStatus)) {
    lines.push(`openedbot_workflows_by_status{status="${status}"} ${total}`);
  }
  for (const instance of report.instances) {
    lines.push(`openedbot_instance_rss_bytes{service="${instance.service}"} ${instance.rssBytes}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The LISTEN link of the process that answers: one replica, not all of them. */
function eventLinkLines(link: EventLinkStatus | null): string[] {
  if (!link) return [];
  return [
    "# TYPE openedbot_api_events_listen_connected gauge",
    `openedbot_api_events_listen_connected ${link.connected ? 1 : 0}`,
    "# TYPE openedbot_api_events_listen_resubscriptions_total counter",
    `openedbot_api_events_listen_resubscriptions_total ${link.resubscriptions}`,
    "# TYPE openedbot_api_events_listen_failures_total counter",
    `openedbot_api_events_listen_failures_total ${link.failures}`,
    "# TYPE openedbot_api_events_listen_stalls_total counter",
    `openedbot_api_events_listen_stalls_total ${link.stalls}`,
    "# TYPE openedbot_api_events_listen_notifications_total counter",
    `openedbot_api_events_listen_notifications_total ${link.notifications}`,
    ...(link.lagMs === null ? [] : [
      "# TYPE openedbot_api_events_listen_lag_ms gauge",
      `openedbot_api_events_listen_lag_ms ${link.lagMs}`,
    ]),
  ];
}

function metricCount(value: unknown, name: string): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) {
    throw new Error(`Invalid operational metric ${name}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid operational metric ${name}.`);
  return parsed;
}

function metricDuration(value: unknown, name: string): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) {
    throw new Error(`Invalid operational metric ${name}.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid operational metric ${name}.`);
  return parsed;
}

const RUN_STATUSES = [
  "queued", "starting", "running", "awaiting_approval", "relaying", "unknown", "completed", "failed", "cancelled",
] as const;
const RUN_EXTERNAL_STATES = [
  "not_started", "creating", "streaming", "polling", "stopping", "settled", "ambiguous",
] as const;
const WORKFLOW_STATUSES = [
  "queued", "running", "awaiting_approval", "reconciling", "completed", "failed", "cancelled", "expired", "unknown",
] as const;

function metricBreakdown(
  value: unknown,
  allowed: readonly string[],
  name: string,
): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid operational metric ${name}.`);
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !allowed.includes(key))) {
    throw new Error(`Invalid operational metric ${name}.`);
  }
  return Object.fromEntries(allowed.map((key) => [key, metricCount((source[key] ?? 0) as string | number, name)]));
}
