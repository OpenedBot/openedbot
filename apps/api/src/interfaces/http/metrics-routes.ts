import { isoInstant } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import { totalmem } from "node:os";
import type { ApiConfig } from "../../infrastructure/config";
import { constantTimeEqual } from "../../infrastructure/crypto";
import type { Db } from "@openedbot/platform-db";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { HttpError } from "./http-error";
import type { BlobStore } from "../../infrastructure/blob-store";

export class ApiRuntimeMetrics {
  readonly startedAt = new Date();
  #requestsTotal = 0;
  #serverErrorsTotal = 0;

  recordRequest(): void { this.#requestsTotal += 1; }
  recordServerError(): void { this.#serverErrorsTotal += 1; }
  snapshot(): { startedAt: string; requestsTotal: number; serverErrorsTotal: number } {
    return {
      startedAt: this.startedAt.toISOString(),
      requestsTotal: this.#requestsTotal,
      serverErrorsTotal: this.#serverErrorsTotal,
    };
  }
}

export function internalMetricsRoutes(
  config: ApiConfig,
  db: Db,
  hub: EventHub,
  blobs: BlobStore,
  runtimeMetrics: ApiRuntimeMetrics,
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
    const blobMetrics = blobs.metrics.snapshot();
    const report = {
      generatedAt: new Date().toISOString(),
      totalRssBytes,
      totalHeapUsedBytes,
      hostTotalMemoryBytes: totalmem(),
      sseConnections: hub.subscriberCount(),
      activeRuns,
      api: runtimeMetrics.snapshot(),
      attachments: {
        activeBytes: Number(attachmentRows[0]?.activeBytes ?? 0),
        orphaned: Number(attachmentRows[0]?.orphaned ?? 0),
        ...blobMetrics,
      },
      operations: normalizeOperationalMetrics(operationalRows[0]),
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
  instances: Array<{ service: string; activeWork: number; rssBytes: number }>;
};

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

function prometheus(report: MetricsReport): string {
  const lines = [
    "# TYPE ohb_process_rss_bytes gauge",
    `ohb_process_rss_bytes ${report.totalRssBytes}`,
    "# TYPE ohb_process_heap_used_bytes gauge",
    `ohb_process_heap_used_bytes ${report.totalHeapUsedBytes}`,
    "# TYPE ohb_host_total_memory_bytes gauge",
    `ohb_host_total_memory_bytes ${report.hostTotalMemoryBytes}`,
    "# TYPE ohb_sse_connections gauge",
    `ohb_sse_connections ${report.sseConnections}`,
    "# TYPE ohb_active_runs gauge",
    `ohb_active_runs ${report.activeRuns}`,
    "# TYPE ohb_api_requests_total counter",
    `ohb_api_requests_total ${report.api.requestsTotal}`,
    "# TYPE ohb_api_server_errors_total counter",
    `ohb_api_server_errors_total ${report.api.serverErrorsTotal}`,
    `ohb_attachment_active_bytes ${report.attachments.activeBytes}`,
    `ohb_attachment_orphaned ${report.attachments.orphaned}`,
    `ohb_blob_writes_total ${report.attachments.writes}`,
    `ohb_blob_deletes_total ${report.attachments.deletes}`,
    `ohb_blob_bytes_written_total ${report.attachments.bytesWritten}`,
    `ohb_blob_bytes_deleted_total ${report.attachments.bytesDeleted}`,
    `ohb_blob_errors_total ${report.attachments.errors}`,
    "# TYPE ohb_queue_runs gauge",
    `ohb_queue_runs ${report.operations.queue.depth}`,
    "# TYPE ohb_queue_oldest_age_seconds gauge",
    `ohb_queue_oldest_age_seconds ${report.operations.queue.oldestAgeSeconds}`,
    "# TYPE ohb_runs_unknown gauge",
    `ohb_runs_unknown ${report.operations.runs.unknown}`,
    "# TYPE ohb_runs_oldest_unknown_age_seconds gauge",
    `ohb_runs_oldest_unknown_age_seconds ${report.operations.runs.oldestUnknownAgeSeconds}`,
    "# TYPE ohb_workflows_active gauge",
    `ohb_workflows_active ${report.operations.workflows.active}`,
    "# TYPE ohb_workflows_unknown gauge",
    `ohb_workflows_unknown ${report.operations.workflows.unknown}`,
    "# TYPE ohb_workflows_overdue gauge",
    `ohb_workflows_overdue ${report.operations.workflows.overdue}`,
    "# TYPE ohb_approvals_pending gauge",
    `ohb_approvals_pending ${report.operations.approvals.pending}`,
    "# TYPE ohb_approvals_expired_pending gauge",
    `ohb_approvals_expired_pending ${report.operations.approvals.expiredPending}`,
    "# TYPE ohb_approvals_oldest_pending_age_seconds gauge",
    `ohb_approvals_oldest_pending_age_seconds ${report.operations.approvals.oldestPendingAgeSeconds}`,
    "# TYPE ohb_handoffs_relaying gauge",
    `ohb_handoffs_relaying ${report.operations.handoffs.relaying}`,
    "# TYPE ohb_handoffs_oldest_relaying_age_seconds gauge",
    `ohb_handoffs_oldest_relaying_age_seconds ${report.operations.handoffs.oldestRelayingAgeSeconds}`,
    "# TYPE ohb_run_leases_active gauge",
    `ohb_run_leases_active ${report.operations.leases.active}`,
    "# TYPE ohb_run_leases_expired gauge",
    `ohb_run_leases_expired ${report.operations.leases.expired}`,
    "# TYPE ohb_run_leases_missing gauge",
    `ohb_run_leases_missing ${report.operations.leases.missing}`,
    "# TYPE ohb_runs_by_status gauge",
    "# TYPE ohb_runs_by_external_state gauge",
    "# TYPE ohb_workflows_by_status gauge",
  ];
  for (const [status, total] of Object.entries(report.operations.runs.byStatus)) {
    lines.push(`ohb_runs_by_status{status="${status}"} ${total}`);
  }
  for (const [state, total] of Object.entries(report.operations.runs.byExternalState)) {
    lines.push(`ohb_runs_by_external_state{state="${state}"} ${total}`);
  }
  for (const [status, total] of Object.entries(report.operations.workflows.byStatus)) {
    lines.push(`ohb_workflows_by_status{status="${status}"} ${total}`);
  }
  for (const instance of report.instances) {
    lines.push(`ohb_instance_rss_bytes{service="${instance.service}"} ${instance.rssBytes}`);
  }
  return `${lines.join("\n")}\n`;
}

function metricCount(value: string | number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid operational metric ${name}.`);
  return parsed;
}

function metricDuration(value: string | number, name: string): number {
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
