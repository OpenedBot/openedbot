import "@openedbot/platform-config/env-aliases-apply"; // first: OHB_* -> OPENEDBOT_* fallback before any module reads the environment
import { alertWebhookBody, deployEnvironment, evaluateSample, initialMonitorState, parseMetrics, type AlertContext, type AlertNotification, type ProbeSample } from "./monitor";
import { logger } from "@openedbot/platform-observability";

const apiOrigin = required("API_INTERNAL_URL").replace(/\/+$/, "");
const metricsToken = required("METRICS_INTERNAL_TOKEN");
const webhookUrl = validatedWebhook(required("ALERT_WEBHOOK_URL"));
const context: AlertContext = {
  environment: deployEnvironment(process.env.OPENEDBOT_ENV),
  host: new URL(process.env.API_PUBLIC_URL?.trim() || apiOrigin).host,
};
const intervalMs = positiveInteger("ALERT_INTERVAL_SECONDS", 30) * 1_000;
const timeoutMs = positiveInteger("ALERT_TIMEOUT_SECONDS", 5) * 1_000;
const failuresBeforeAlert = positiveInteger("ALERT_FAILURE_THRESHOLD", 2);
const healthyBeforeResolve = positiveInteger("ALERT_RECOVERY_THRESHOLD", 2);
const repeatMs = positiveInteger("ALERT_REPEAT_MINUTES", 30) * 60_000;
const maxQueueAgeSeconds = positiveInteger("ALERT_MAX_QUEUE_AGE_SECONDS", 120);
const maxRelayingAgeSeconds = positiveInteger("ALERT_MAX_RELAYING_AGE_SECONDS", 600);
const shutdown = new AbortController();
let state = initialMonitorState();

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

logger.info({ event: "alerting.started", intervalMs, environment: context.environment, host: context.host }, "alerting started");
while (!shutdown.signal.aborted) {
  const sample = await probe();
  const evaluated = evaluateSample(state, sample, Date.now(), {
    failuresBeforeAlert,
    healthyBeforeResolve,
    repeatMs,
    maxQueueAgeSeconds,
    maxRelayingAgeSeconds,
  });
  if (evaluated.notification) {
    try {
      await notify(evaluated.notification);
      state = evaluated.state;
      logger.info({ event: "alerting.transition", status: evaluated.notification.status }, "alerting transition");
    } catch (error) {
      logger.error({ event: "alerting.webhook_failed", error: describe(error) }, "alerting webhook failed");
    }
  } else {
    state = evaluated.state;
  }
  await wait(intervalMs, shutdown.signal);
}

function stop(signal: string): void {
  logger.info({ event: "alerting.stopping", signal }, "alerting stopping");
  shutdown.abort(signal);
}

async function probe(): Promise<ProbeSample> {
  const reasons: string[] = [];
  let metrics = null;
  const health = await safeFetch(`${apiOrigin}/api/health`, {});
  if (!health?.ok) reasons.push("healthcheck API en échec");
  const response = await safeFetch(`${apiOrigin}/internal/metrics`, {
    headers: { Authorization: `Bearer ${metricsToken}` },
  });
  if (!response?.ok) {
    reasons.push("métriques internes indisponibles");
  } else {
    metrics = parseMetrics(await response.json().catch(() => null));
    if (!metrics) reasons.push("réponse de métriques invalide");
  }
  return { reasons, metrics };
}

async function safeFetch(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

async function notify(notification: AlertNotification): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(alertWebhookBody(notification, context)),
  });
  if (!response.ok) throw new Error(`Alert webhook returned HTTP ${response.status}.`);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function validatedWebhook(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("ALERT_WEBHOOK_URL must use HTTPS without embedded credentials.");
  }
  return url.toString();
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { signal.removeEventListener("abort", onAbort); resolve(); };
    const timeout = setTimeout(finish, ms);
    const onAbort = () => { clearTimeout(timeout); finish(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
