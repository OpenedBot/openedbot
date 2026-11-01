import type { AccessGrant } from "./auth";
import { log } from "./log";

// YOLO mode, seen from the shell: a badge and a countdown in the Dock menu
// (macOS) or the tray (Windows), and "Couper YOLO partout". The shell never
// grants a lease: granting stays in the console, behind its first-time
// confirmation. The API accepts a native session as human (the bearer this
// process holds), but any local process able to read that token (a bot
// running on the same machine, say) would then pass for the user; giving the
// shell no grant path keeps that door shut on our side.
//
// No electron import here: the main process injects net.fetch and the
// dialogs, `bun test` drives the rest. Contract shared with openedbot-notch:
// README.md, "YOLO mode".

export const YOLO_LEASES_PATH = "/api/organization/yolo/leases";
export const YOLO_KILL_PATH = "/api/organization/yolo/kill";
export const YOLO_POLL_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
// The label shows minutes: a tick each second notices a change within one.
const TICK_MS = 1_000;

/** Host states under which the host is NOT auto-approving: no badge for them. */
const HOST_STATES_OFF = new Set(["rejected", "expired", "revoked"]);

/** A lease as the shell needs it: a subset of the API's `YoloLeaseDto`. */
export type YoloLeaseView = {
  id: string;
  /** thread, bot or runtime; kept as a string so a future scope still counts. */
  scope: string;
  runtimeId: string;
  expiresAt: string;
  expiresAtMs: number;
  hostState: string;
};

export type YoloSnapshot = {
  /** The live lease that ends last: its countdown is the one shown. null: YOLO off. */
  displayed: YoloLeaseView | null;
  liveCount: number;
  /** false after a 403 on the kill (not owner or admin), until the session changes. */
  canKill: boolean;
  killing: boolean;
};

export type YoloKillOutcome =
  | { kind: "cancelled" }
  | { kind: "done"; revoked: number; runtimes: number }
  | { kind: "forbidden" }
  | { kind: "signed-out" }
  | { kind: "failed"; reason: string };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type YoloMonitorDeps = {
  apiOrigin: string;
  auth: { readAccess(options: { force: boolean; servedToken?: string | null }): Promise<AccessGrant | null> };
  /** net.fetch in the app, so the OS proxy settings apply. */
  fetch: FetchLike;
  /** The native confirmation box; true only on an explicit "Couper". */
  confirmKill(): Promise<boolean>;
  /** Something the tray shows changed: rebuild it. */
  onChange(): void;
  now?: () => number;
};

export type YoloMonitor = {
  /** Polls now, then every 30 s, until stop(). Idempotent. */
  start(): void;
  /** Stops polling and forgets every lease (signed out). Idempotent. */
  stop(): void;
  /** Polls now: after a resume from sleep, or a kill. */
  pollNow(): Promise<void>;
  snapshot(): YoloSnapshot;
  killEverywhere(): Promise<YoloKillOutcome>;
};

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);

function parseLease(value: Fields): YoloLeaseView | null {
  const { id, scope, runtimeId, expiresAt, hostState } = value;
  if (typeof id !== "string" || id === "" || typeof scope !== "string" || typeof runtimeId !== "string") return null;
  if (typeof expiresAt !== "string" || typeof hostState !== "string") return null;
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) return null;
  return { id, scope, runtimeId, expiresAt, expiresAtMs, hostState };
}

/**
 * The body of GET /leases, `{ leases: YoloLeaseDto[] }`. null when malformed
 * (the caller keeps what it knew): one unreadable lease rejects the lot, so a
 * half-read answer never hides a lease. A revoked one (the API leaves them
 * out already) is skipped.
 */
export function parseLeasesResponse(payload: unknown): YoloLeaseView[] | null {
  if (!isObject(payload) || !Array.isArray(payload.leases)) return null;
  const leases: YoloLeaseView[] = [];
  for (const item of payload.leases) {
    if (!isObject(item)) return null;
    const { revokedAt } = item;
    if (revokedAt !== null && revokedAt !== undefined && typeof revokedAt !== "string") return null;
    if (typeof revokedAt === "string") continue;
    const lease = parseLease(item);
    if (!lease) return null;
    leases.push(lease);
  }
  return leases;
}

/** Live: not expired against the server's `expiresAt`, and not refused or ended by its host. */
export function liveLeases(leases: readonly YoloLeaseView[], nowMs: number): YoloLeaseView[] {
  return leases.filter((lease) => lease.expiresAtMs > nowMs && !HOST_STATES_OFF.has(lease.hostState));
}

/** The live lease that ends last; ties go to the smallest id, so the choice is stable. */
export function pickDisplayedLease(leases: readonly YoloLeaseView[], nowMs: number): YoloLeaseView | null {
  let best: YoloLeaseView | null = null;
  for (const lease of liveLeases(leases, nowMs)) {
    if (!best || lease.expiresAtMs > best.expiresAtMs || (lease.expiresAtMs === best.expiresAtMs && lease.id < best.id)) best = lease;
  }
  return best;
}

/**
 * Time left, by the minute (a menu label is not redrawn every second):
 * "3 h 05", "42 min", "< 1 min". Rounded down, so it never promises time the
 * lease does not have.
 */
export function formatCountdown(remainingMs: number): string {
  if (remainingMs < 60_000) return "< 1 min";
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** The status line of the menu and the tooltip; null when YOLO is off. */
export function yoloStatusLabel(snapshot: Pick<YoloSnapshot, "displayed" | "liveCount">, nowMs: number): string | null {
  const lease = snapshot.displayed;
  if (!lease) return null;
  const count = snapshot.liveCount > 1 ? ` (${snapshot.liveCount} baux)` : "";
  return `YOLO actif${count} · encore ${formatCountdown(lease.expiresAtMs - nowMs)}`;
}

/** The message shown after a kill; null when there is nothing to say (cancelled). */
export function killOutcomeMessage(outcome: YoloKillOutcome): { type: "info" | "warning" | "error"; message: string; detail: string } | null {
  switch (outcome.kind) {
    case "cancelled":
      return null;
    case "done":
      return {
        type: "info",
        message: "YOLO coupé partout",
        detail:
          outcome.revoked === 0
            ? `Aucun bail en cours ; ${runtimesPhrase(outcome.runtimes)} prévenu(s) quand même.`
            : `${outcome.revoked} bail(s) révoqué(s), ${runtimesPhrase(outcome.runtimes)} prévenu(s).`,
      };
    case "forbidden":
      return {
        type: "warning",
        message: "Action réservée",
        detail: "Seuls le propriétaire et les administrateurs de l’organisation peuvent couper YOLO.",
      };
    case "signed-out":
      return { type: "warning", message: "Session terminée", detail: "Reconnectez-vous, puis réessayez." };
    case "failed":
      return {
        type: "error",
        message: "YOLO n’a pas pu être coupé",
        detail: `${outcome.reason} Réessayez, ou coupez-le depuis la console. Sur la machine hôte, « edge-setup yolo off » marche même hors ligne.`,
      };
  }
}

const runtimesPhrase = (count: number): string => `${count} runtime${count > 1 ? "s" : ""}`;

class HttpStatusError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`API ${status} ${code}`);
  }
}

class SignedOutError extends Error {}

export function createYoloMonitor(deps: YoloMonitorDeps): YoloMonitor {
  const now = deps.now ?? Date.now;
  let leases: YoloLeaseView[] = [];
  let canKill = true;
  let killing = false;
  let running = false;
  // Bumped by stop(): an answer for a previous session is dropped.
  let generation = 0;
  let pollInFlight: Promise<void> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let shownLabel: string | null = null;
  let lastFailure: string | null = null;

  function snapshot(): YoloSnapshot {
    const at = now();
    return { displayed: pickDisplayedLease(leases, at), liveCount: liveLeases(leases, at).length, canKill, killing };
  }

  // Calls onChange only when what the tray shows moves (a minute ticks by, a
  // lease starts or ends), not at each tick.
  function notifyIfChanged(force = false): void {
    const current = snapshot();
    const label = yoloStatusLabel(current, now());
    if (force || label !== shownLabel) {
      shownLabel = label;
      deps.onChange();
    }
    // The ticker only runs while a countdown is on screen.
    if (current.displayed && running && !tickTimer) {
      tickTimer = setInterval(() => notifyIfChanged(), TICK_MS);
      tickTimer.unref?.();
    } else if ((!current.displayed || !running) && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  // One retry after a 401, with a forced rotation (the token may have died
  // between the read and the request), like the popup does.
  async function request(method: "GET" | "POST", path: string): Promise<unknown> {
    let grant = await deps.auth.readAccess({ force: false });
    for (let attempt = 0; ; attempt += 1) {
      if (!grant) throw new SignedOutError();
      const response = await deps.fetch(`${deps.apiOrigin}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${grant.accessToken}`,
          "X-OHB-Organization": grant.organizationId,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 401 && attempt === 0) {
        grant = await deps.auth.readAccess({ force: true, servedToken: grant.accessToken });
        continue;
      }
      if (!response.ok) {
        const error = isObject(payload) && isObject(payload.error) ? payload.error : null;
        throw new HttpStatusError(response.status, typeof error?.code === "string" ? error.code : "API_ERROR");
      }
      return payload;
    }
  }

  async function performPoll(): Promise<void> {
    const started = generation;
    try {
      const parsed = parseLeasesResponse(await request("GET", YOLO_LEASES_PATH));
      if (started !== generation) return;
      if (!parsed) throw new Error("malformed leases response");
      leases = parsed;
      lastFailure = null;
    } catch (error) {
      if (started !== generation) return;
      if (error instanceof SignedOutError) {
        leases = [];
      } else {
        // Keep the last leases: their countdown still runs against expiresAt,
        // and a badge that stays up when in doubt beats one that vanishes.
        // Logged once per kind of failure, never with a token.
        const reason = error instanceof Error ? error.message : "error";
        if (reason !== lastFailure) log.warn(`yolo leases poll failed (${reason})`);
        lastFailure = reason;
      }
    }
    notifyIfChanged();
  }

  function pollNow(): Promise<void> {
    if (!running) return Promise.resolve();
    if (pollInFlight) return pollInFlight;
    const current: Promise<void> = performPoll().finally(() => {
      if (pollInFlight === current) pollInFlight = null;
    });
    pollInFlight = current;
    return current;
  }

  async function killEverywhere(): Promise<YoloKillOutcome> {
    if (killing) return { kind: "cancelled" };
    if (!(await deps.confirmKill())) return { kind: "cancelled" };
    const started = generation;
    killing = true;
    notifyIfChanged(true);
    try {
      const result = await request("POST", YOLO_KILL_PATH);
      const revoked = isObject(result) && typeof result.revoked === "number" ? result.revoked : 0;
      const runtimes = isObject(result) && typeof result.runtimes === "number" ? result.runtimes : 0;
      log.info(`yolo killed everywhere (${revoked} leases, ${runtimes} runtimes)`);
      return { kind: "done", revoked, runtimes };
    } catch (error) {
      if (error instanceof SignedOutError) return { kind: "signed-out" };
      if (error instanceof HttpStatusError && error.status === 403) {
        // The role is not known here: the first refusal hides the entry for this session.
        if (started === generation) canKill = false;
        return { kind: "forbidden" };
      }
      log.error("yolo kill failed", error);
      return {
        kind: "failed",
        reason: error instanceof HttpStatusError ? `Le serveur a répondu ${error.status} (${error.code}).` : "Le serveur est injoignable.",
      };
    } finally {
      killing = false;
      notifyIfChanged(true);
      // Whatever happened, read the truth back rather than guess it.
      void pollNow();
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      pollTimer = setInterval(() => void pollNow(), YOLO_POLL_INTERVAL_MS);
      pollTimer.unref?.();
      void pollNow();
    },
    stop(): void {
      generation += 1;
      running = false;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      // A poll still in flight belongs to the old session: the next start() must not wait on it.
      pollInFlight = null;
      leases = [];
      canKill = true;
      lastFailure = null;
      notifyIfChanged(true);
    },
    pollNow,
    snapshot,
    killEverywhere,
  };
}
