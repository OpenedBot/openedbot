import { SQL } from "bun";
import { isUuid } from "@openedbot/contracts-primitives";
import { logger } from "@openedbot/platform-observability";

/** Channel of the `run_events_notify` trigger (0005): payload `<organization>:<cursor>`. */
export const EVENTS_CHANNEL = "openedbot_events";
/** Cadence of the liveness ping, and how long one may stay unanswered. */
export const EVENT_LINK_LIVENESS_MS = 5_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const PING_PREFIX = "ping:";

type ListenerClient = {
  listen: (...args: Parameters<SQL["listen"]>) => Promise<unknown>;
  close: SQL["close"];
};

export type EventLinkState = "connecting" | "listening" | "unavailable" | "stopped";

export type EventLinkStatus = {
  state: EventLinkState;
  /** Listening AND the last liveness ping came back: notifications do reach this process. */
  connected: boolean;
  /** LISTEN acknowledgements: the first one, then every resubscription. */
  subscriptions: number;
  resubscriptions: number;
  /** Failed subscription attempts (connection refused, Bun without `listen`…). */
  failures: number;
  /** Liveness pings left unanswered while listening. */
  stalls: number;
  notifications: number;
  /** Payloads that are neither an event nor a ping: ignored, never fatal. */
  ignored: number;
  /** Round trip of the last answered ping: commit-to-wake lag of the link. */
  lagMs: number | null;
  maxLagMs: number | null;
  listeningSince: string | null;
};

export type EventLink = {
  start(): void;
  stop(): Promise<void>;
  status(): EventLinkStatus;
  /** `true` while notifications are known to reach this process. */
  connected(): boolean;
};

export type EventLinkHandlers = {
  /** A commit of `run_events` for this organization: wake its ordered read. */
  notify(organizationId: string): void;
  /** Every LISTEN acknowledgement: what committed while unsubscribed is read back from the durable cursor. */
  subscribed(): void;
};

export type EventLinkOptions = {
  clientFactory?: () => ListenerClient;
  /**
   * Sends `payload` on the channel through ANOTHER connection. Bun reconnects
   * a lost LISTEN on its own and reports nothing until the next ACK: only a
   * ping that comes back proves the link, and its round trip is the lag.
   */
  ping?: (payload: string) => Promise<unknown>;
  livenessMs?: number;
  retryMs?: number;
  maxRetryMs?: number;
  /** Defaults to the process logger; tests read the lines back. */
  log?: Pick<typeof logger, "info" | "warn" | "error">;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The process's one LISTEN connection on `openedbot_events` (ADR 0001, S6).
 * A notification carries no data: it only wakes a read from the durable
 * cursor, which stays the source of truth. Unavailable at start or lost
 * later, the process keeps serving through its fallback poll, says so, and
 * retries; it never crashes for it.
 */
export function createEventNotifications(
  databaseUrl: string,
  handlers: EventLinkHandlers,
  options: EventLinkOptions = {},
): EventLink {
  const livenessMs = options.livenessMs ?? EVENT_LINK_LIVENESS_MS;
  const retryMs = options.retryMs ?? RETRY_MIN_MS;
  const maxRetryMs = options.maxRetryMs ?? RETRY_MAX_MS;
  const log = options.log ?? logger;
  const token = crypto.randomUUID();
  let started = false;
  let stopped = false;
  let client: ListenerClient | null = null;
  let connecting: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let liveness: ReturnType<typeof setInterval> | null = null;
  let attempt = 0;
  let pingSequence = 0;
  let pendingPing: { sequence: number; sentAt: number } | null = null;
  let pingInFlight = false;
  let stalled = false;
  const status: EventLinkStatus = {
    state: "connecting", connected: false, subscriptions: 0, resubscriptions: 0, failures: 0, stalls: 0,
    notifications: 0, ignored: 0, lagMs: null, maxLagMs: null, listeningSince: null,
  };

  const markStalled = (detail: Record<string, unknown>) => {
    if (stalled) return;
    stalled = true;
    status.stalls += 1;
    log.warn({ event: "api.events_listener_stalled", channel: EVENTS_CHANNEL, fallback: "poll", ...detail },
      "events LISTEN link unconfirmed, falling back to commit hints and polling");
  };

  const onPing = (payload: string) => {
    const [owner, sequence] = payload.slice(PING_PREFIX.length).split(":");
    if (owner !== token) return; // Another replica's ping.
    if (!pendingPing || Number(sequence) !== pendingPing.sequence) return;
    const lag = Math.round(performance.now() - pendingPing.sentAt);
    pendingPing = null;
    status.lagMs = lag;
    status.maxLagMs = Math.max(status.maxLagMs ?? 0, lag);
    if (stalled) {
      stalled = false;
      log.info({ event: "api.events_listener_recovered", channel: EVENTS_CHANNEL, lagMs: lag }, "events LISTEN link confirmed again");
    }
  };

  const onNotify = (payload: string) => {
    if (stopped) return;
    if (payload.startsWith(PING_PREFIX)) return onPing(payload);
    const separator = payload.lastIndexOf(":");
    const organizationId = separator > 0 ? payload.slice(0, separator) : "";
    if (!isUuid(organizationId)) {
      status.ignored += 1;
      return;
    }
    status.notifications += 1;
    handlers.notify(organizationId);
  };

  const onListen = () => {
    if (stopped) return;
    status.subscriptions += 1;
    const resubscribed = status.subscriptions > 1;
    if (resubscribed) status.resubscriptions += 1;
    status.state = "listening";
    status.listeningSince = new Date().toISOString();
    stalled = false;
    pendingPing = null;
    log.info({
      event: "api.events_listener_ready", channel: EVENTS_CHANNEL, resubscribed, subscriptions: status.subscriptions,
    }, resubscribed ? "events LISTEN resubscribed, catching up from the durable cursor" : "events LISTEN ready");
    handlers.subscribed();
  };

  const scheduleRetry = () => {
    attempt += 1;
    const delay = Math.min(maxRetryMs, retryMs * 2 ** Math.min(attempt - 1, 16));
    retry = setTimeout(() => { retry = null; connecting = subscribe(); }, delay);
    return delay;
  };

  const subscribe = async (): Promise<void> => {
    if (stopped) return;
    let current: ListenerClient | null = null;
    try {
      current = options.clientFactory?.() ?? new SQL({ url: databaseUrl, max: 1, idleTimeout: 0, connectionTimeout: 2 });
      client = current;
      if (typeof current.listen !== "function") {
        status.failures += 1;
        status.state = "unavailable";
        log.error({ event: "api.events_listener_unsupported", code: "BUN_SQL_LISTEN_UNAVAILABLE", fallback: "poll" },
          "this Bun has no SQL LISTEN: live events fall back to commit hints and polling");
        await current.close({ timeout: 1 }).catch(() => undefined);
        client = null;
        return;
      }
      await current.listen(EVENTS_CHANNEL, onNotify, onListen);
      attempt = 0;
    } catch (error) {
      await current?.close({ timeout: 1 }).catch(() => undefined);
      if (client === current) client = null;
      if (stopped) return;
      status.failures += 1;
      status.state = "unavailable";
      const retryInMs = scheduleRetry();
      log.warn({
        event: "api.events_listener_failed", channel: EVENTS_CHANNEL, attempt, retryInMs, fallback: "poll", error: describe(error),
      }, "events LISTEN unavailable, falling back to commit hints and polling");
    }
  };

  const checkLiveness = () => {
    if (stopped || status.state !== "listening" || !options.ping) return;
    if (pendingPing) markStalled({ waitedMs: Math.round(performance.now() - pendingPing.sentAt) });
    // At most one ping query in the shared pool: a stalled pool must not
    // accumulate one more per period. Its echo, if it ever comes, still counts.
    if (pingInFlight) return;
    pingSequence += 1;
    const sent = { sequence: pingSequence, sentAt: performance.now() };
    pendingPing = sent;
    pingInFlight = true;
    options.ping(`${PING_PREFIX}${token}:${sent.sequence}`).catch((error: unknown) => {
      if (!stopped && pendingPing === sent) markStalled({ error: describe(error) });
    }).finally(() => { pingInFlight = false; });
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      connecting = subscribe();
      if (options.ping) {
        liveness = setInterval(checkLiveness, livenessMs);
        liveness.unref?.();
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      status.state = "stopped";
      if (retry) clearTimeout(retry);
      if (liveness) clearInterval(liveness);
      retry = null;
      liveness = null;
      // Closing the dedicated client drops its subscription, even one still
      // connecting. Never wait for an UNLISTEN acknowledgement.
      await client?.close({ timeout: 1 }).catch(() => undefined);
      await connecting;
      client = null;
    },
    status() {
      return { ...status, connected: status.state === "listening" && !stalled };
    },
    connected() {
      return status.state === "listening" && !stalled;
    },
  };
}
