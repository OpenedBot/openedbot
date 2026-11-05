import { asRecord } from "@openedbot/contracts-primitives";
import { deployEnvironment, type DeployEnvironment } from "@openedbot/platform-config/deploy-environment";
export type MetricsSnapshot = {
  apiStartedAt: string;
  requestsTotal: number;
  serverErrorsTotal: number;
  workerPresent: boolean;
  operations: {
    queueDepth: number;
    oldestQueuedSeconds: number;
    unknownRuns: number;
    oldestUnknownSeconds: number;
    activeWorkflows: number;
    unknownWorkflows: number;
    overdueWorkflows: number;
    pendingApprovals: number;
    expiredPendingApprovals: number;
    oldestPendingApprovalSeconds: number;
    relayingRuns: number;
    oldestRelayingSeconds: number;
    activeRunLeases: number;
    expiredRunLeases: number;
    missingRunLeases: number;
  };
};

export type ProbeSample = {
  reasons: string[];
  metrics: MetricsSnapshot | null;
};

export type MonitorState = {
  phase: "unknown" | "healthy" | "firing";
  consecutiveFailures: number;
  consecutiveHealthy: number;
  apiStartedAt: string | null;
  requestsTotal: number;
  serverErrorsTotal: number;
  lastNotificationAt: number | null;
};

export type AlertNotification = {
  status: "firing" | "resolved";
  reasons: string[];
  occurredAt: string;
};

export type MonitorOptions = {
  failuresBeforeAlert: number;
  healthyBeforeResolve: number;
  repeatMs: number;
  maxQueueAgeSeconds: number;
  maxRelayingAgeSeconds: number;
};

export function initialMonitorState(): MonitorState {
  return {
    phase: "unknown", consecutiveFailures: 0, consecutiveHealthy: 0, apiStartedAt: null,
    requestsTotal: 0, serverErrorsTotal: 0, lastNotificationAt: null,
  };
}

export function parseMetrics(value: unknown): MetricsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const api = asRecord(item.api);
  const operations = asRecord(item.operations);
  const queue = asRecord(operations?.queue);
  const runs = asRecord(operations?.runs);
  const workflows = asRecord(operations?.workflows);
  const approvals = asRecord(operations?.approvals);
  const handoffs = asRecord(operations?.handoffs);
  const leases = asRecord(operations?.leases);
  if (!api || typeof api.startedAt !== "string" || !Number.isFinite(Date.parse(api.startedAt)) ||
    count(api.requestsTotal) === null || count(api.serverErrorsTotal) === null ||
    !Array.isArray(item.instances) || !queue || !runs || !workflows || !approvals || !handoffs || !leases) return null;
  const parsedOperations = {
    queueDepth: count(queue.depth),
    oldestQueuedSeconds: duration(queue.oldestAgeSeconds),
    unknownRuns: count(runs.unknown),
    oldestUnknownSeconds: duration(runs.oldestUnknownAgeSeconds),
    activeWorkflows: count(workflows.active),
    unknownWorkflows: count(workflows.unknown),
    overdueWorkflows: count(workflows.overdue),
    pendingApprovals: count(approvals.pending),
    expiredPendingApprovals: count(approvals.expiredPending),
    oldestPendingApprovalSeconds: duration(approvals.oldestPendingAgeSeconds),
    relayingRuns: count(handoffs.relaying),
    oldestRelayingSeconds: duration(handoffs.oldestRelayingAgeSeconds),
    activeRunLeases: count(leases.active),
    expiredRunLeases: count(leases.expired),
    missingRunLeases: count(leases.missing),
  };
  if (Object.values(parsedOperations).some((metric) => metric === null)) return null;
  return {
    apiStartedAt: api.startedAt,
    requestsTotal: Number(api.requestsTotal),
    serverErrorsTotal: Number(api.serverErrorsTotal),
    workerPresent: item.instances.some((instance) => instance && typeof instance === "object" &&
      !Array.isArray(instance) && (instance as Record<string, unknown>).service === "worker"),
    operations: parsedOperations as MetricsSnapshot["operations"],
  };
}

export function evaluateSample(
  previous: MonitorState,
  sample: ProbeSample,
  now: number,
  options: MonitorOptions,
): { state: MonitorState; notification: AlertNotification | null } {
  const reasons = [...sample.reasons];
  const metrics = sample.metrics;
  if (metrics && previous.apiStartedAt === metrics.apiStartedAt &&
    metrics.serverErrorsTotal > previous.serverErrorsTotal) {
    reasons.push(`${metrics.serverErrorsTotal - previous.serverErrorsTotal} nouvelle(s) réponse(s) HTTP 5xx`);
  }
  if (metrics && !metrics.workerPresent) reasons.push("heartbeat worker absent");
  if (metrics) reasons.push(...operationalReasons(metrics, options));

  const next: MonitorState = {
    ...previous,
    apiStartedAt: metrics?.apiStartedAt ?? previous.apiStartedAt,
    requestsTotal: metrics?.requestsTotal ?? previous.requestsTotal,
    serverErrorsTotal: metrics?.serverErrorsTotal ?? previous.serverErrorsTotal,
  };
  if (reasons.length > 0) {
    next.consecutiveFailures += 1;
    next.consecutiveHealthy = 0;
    const first = previous.phase !== "firing" && next.consecutiveFailures >= options.failuresBeforeAlert;
    const repeat = previous.phase === "firing" && previous.lastNotificationAt !== null &&
      now - previous.lastNotificationAt >= options.repeatMs;
    if (first || repeat) {
      next.phase = "firing";
      next.lastNotificationAt = now;
      return { state: next, notification: { status: "firing", reasons, occurredAt: new Date(now).toISOString() } };
    }
    return { state: next, notification: null };
  }

  next.consecutiveFailures = 0;
  next.consecutiveHealthy += 1;
  if (previous.phase === "firing" && next.consecutiveHealthy >= options.healthyBeforeResolve) {
    next.phase = "healthy";
    next.lastNotificationAt = now;
    return { state: next, notification: { status: "resolved", reasons: [], occurredAt: new Date(now).toISOString() } };
  }
  if (previous.phase === "unknown") next.phase = "healthy";
  return { state: next, notification: null };
}

function operationalReasons(metrics: MetricsSnapshot, options: MonitorOptions): string[] {
  const operations = metrics.operations;
  const reasons: string[] = [];
  if (operations.queueDepth > 0 && operations.oldestQueuedSeconds > options.maxQueueAgeSeconds) {
    reasons.push(`${operations.queueDepth} run(s) en file, plus ancien depuis ${Math.floor(operations.oldestQueuedSeconds)} s`);
  }
  if (operations.unknownRuns > 0) {
    reasons.push(`${operations.unknownRuns} run(s) à réconcilier (unknown ou effet ambigu), plus ancien depuis ${Math.floor(operations.oldestUnknownSeconds)} s`);
  }
  if (operations.unknownWorkflows > 0) reasons.push(`${operations.unknownWorkflows} workflow(s) au statut unknown`);
  if (operations.overdueWorkflows > 0) reasons.push(`${operations.overdueWorkflows} workflow(s) hors délai`);
  if (operations.expiredPendingApprovals > 0) {
    reasons.push(`${operations.expiredPendingApprovals} approbation(s) expirée(s) encore pending`);
  }
  if (operations.relayingRuns > 0 && operations.oldestRelayingSeconds > options.maxRelayingAgeSeconds) {
    reasons.push(`${operations.relayingRuns} handoff(s) relaying, plus ancien depuis ${Math.floor(operations.oldestRelayingSeconds)} s`);
  }
  if (operations.expiredRunLeases > 0) reasons.push(`${operations.expiredRunLeases} lease(s) de run expiré(s)`);
  if (operations.missingRunLeases > 0) reasons.push(`${operations.missingRunLeases} run(s) actif(s) sans lease`);
  return reasons;
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function duration(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Corps du webhook : les champs structurés (`event`, `status`, `reasons`,
 * `occurredAt`) pour un récepteur maison, plus `content`, la ligne lisible
 * qu'un webhook Discord exige (il refuse 400 un message sans `content` ni
 * `embeds`) et que tout autre récepteur peut ignorer. Aucune donnée tenant.
 */
export type AlertContext = {
  environment: DeployEnvironment;
  /** Public host of the deployment (API_PUBLIC_URL), the thing an operator recognises. */
  host: string;
};

export function alertWebhookBody(notification: AlertNotification, context: AlertContext): Record<string, unknown> {
  const marker = notification.status === "firing" ? "🔴 openedbot alerte" : "🟢 openedbot rétablie";
  const reasons = notification.reasons.length > 0 ? notification.reasons.join(" ; ") : "aucune raison";
  const where = `[${context.environment} · ${context.host}]`;
  return {
    event: "openedbot.alert",
    environment: context.environment,
    host: context.host,
    ...notification,
    content: `${marker} ${where} : ${reasons} (${notification.occurredAt})`.slice(0, 2000),
  };
}

export { deployEnvironment, type DeployEnvironment };
