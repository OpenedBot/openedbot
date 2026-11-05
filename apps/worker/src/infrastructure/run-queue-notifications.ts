import { SQL } from "bun";
import type { RunQueueNotifications } from "../application/claim-wakeup";

export const RUN_QUEUE_CHANNEL = "openedbot_run_queue_v1";
/** Probe cadence while no LISTEN is acknowledged. */
export const QUEUE_PROBE_MS = 25;
type ListenerClient = {
  listen: (...args: Parameters<SQL["listen"]>) => Promise<unknown>;
  close: SQL["close"];
};
type ListenerOptions = {
  clientFactory?: () => ListenerClient;
  retryMs?: number;
  /**
   * Fingerprint of the queued set. While LISTEN is unsupported (Bun 1.3),
   * still connecting, or disconnected, a changed value wakes the claim loop.
   */
  probe?: () => Promise<string>;
  probeMs?: number;
};

/** A dedicated connection only delivers wake-up hints; the claim loop reads durable rows. */
export function createRunQueueNotifications(databaseUrl: string, options: ListenerOptions = {}): RunQueueNotifications {
  let started = false;
  let stopped = false;
  let client: ListenerClient | null = null;
  let connecting: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closing: Promise<void> | null = null;
  // Hints flow only between a LISTEN ACK and a reported disconnect. Outside
  // that window the probe stands in; the claim loop's poll stays the floor.
  let listening = false;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let probing: Promise<void> | null = null;
  let lastSignature: string | null = null;
  let probeFailing = false;

  const probeQueue = (wake: () => void) => {
    const probe = options.probe;
    if (!probe || stopped || listening || probeTimer || probing) return;
    // The first read only sets a baseline, so take it at once.
    probeTimer = setTimeout(() => {
      probeTimer = null;
      if (stopped || listening) return;
      probing = (async () => {
        try {
          const signature = await probe();
          probeFailing = false;
          if (!stopped && !listening && lastSignature !== null && signature !== lastSignature) wake();
          lastSignature = signature;
        } catch {
          if (!probeFailing) console.warn(JSON.stringify({ event: "worker.queue_probe_failed" }));
          probeFailing = true;
        }
      })().finally(() => {
        probing = null;
        probeQueue(wake);
      });
    }, lastSignature === null ? 0 : options.probeMs ?? QUEUE_PROBE_MS);
  };

  const listenerLost = (wake: () => void) => {
    if (stopped || !listening) return;
    listening = false;
    lastSignature = null;
    wake(); // A hint may have been lost while the connection was down.
    probeQueue(wake);
  };

  const subscribe = async (wake: () => void) => {
    let current: ListenerClient | null = null;
    try {
      current = options.clientFactory?.() ?? new SQL({
        url: databaseUrl, max: 1, idleTimeout: 0, connectionTimeout: 2,
        onclose: (error) => {
          if (stopped || !error) return;
          console.warn(JSON.stringify({ event: "worker.queue_listener_disconnected" }));
          listenerLost(wake);
        },
      });
      client = current;
      if (typeof current.listen !== "function") {
        console.error(JSON.stringify({
          event: "worker.queue_listener_unsupported",
          code: "BUN_SQL_LISTEN_UNAVAILABLE",
          fallback: options.probe ? "probe" : "poll",
        }));
        await current.close({ timeout: 1 });
        client = null;
        return;
      }
      await current.listen(RUN_QUEUE_CHANNEL, () => { if (!stopped) wake(); }, () => {
        if (stopped) return;
        console.info(JSON.stringify({ event: "worker.queue_listener_ready", channel: RUN_QUEUE_CHANNEL }));
        listening = true;
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = null;
        wake(); // Initial subscription and every resubscription require durable catch-up.
      });
    } catch {
      await current?.close({ timeout: 1 }).catch(() => undefined);
      if (client === current) client = null;
      if (!stopped) {
        console.warn(JSON.stringify({ event: "worker.queue_listener_failed" }));
        listenerLost(wake);
        retry = setTimeout(() => { retry = null; connecting = subscribe(wake); }, options.retryMs ?? 1_000);
      }
    }
  };

  return {
    start: (wake) => {
      if (started || stopped) return;
      started = true;
      probeQueue(wake);
      connecting = subscribe(wake);
    },
    stop: () => {
      if (closing) return closing;
      stopped = true;
      if (retry) clearTimeout(retry);
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = null;
      // Closing this dedicated client also removes all its LISTEN subscriptions,
      // including one still connecting. Never wait for an offline UNLISTEN ACK.
      closing = (async () => {
        await client?.close({ timeout: 1 });
        await connecting;
        await probing;
        client = null;
      })();
      return closing;
    },
  };
}
