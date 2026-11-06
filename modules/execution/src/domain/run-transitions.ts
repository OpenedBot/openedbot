/**
 * The legal moves of `runs.status`, `runs.external_state` and
 * `runs.remote_stop_state` (ADR 0001 section 4.5, S2d; inventory 0002
 * section 7). The SQL primitive (`sql/run-transitions.ts`) is the only writer
 * of these three columns: it refuses a transition whose declared origins are
 * not all legal before writing, and its `where` keeps the row's actual state
 * among those legal origins, so that an illegal move never reaches the table.
 *
 * Each table lists, for an origin, the states it may move to. The tables say
 * what the code does today (0002 section 7), nothing wider: a new move is a
 * reviewed change of this file and of its test (every pair is checked).
 */

export const RUN_STATUSES = [
  "queued", "starting", "running", "awaiting_approval", "relaying", "unknown", "completed", "failed", "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** A run the worker executes under its lease. */
export const ACTIVE_RUN_STATUSES = ["starting", "running", "awaiting_approval"] as const satisfies readonly RunStatus[];
/** No column of the three ever changes again (trigger 0081 refuses a new status). */
export const FINAL_RUN_STATUSES = ["completed", "failed"] as const satisfies readonly RunStatus[];

export const EXTERNAL_STATES = ["not_started", "creating", "streaming", "polling", "stopping", "settled", "ambiguous"] as const;
export type ExternalState = (typeof EXTERNAL_STATES)[number];

export const REMOTE_STOP_STATES = [null, "requested", "confirmed", "ambiguous", "failed"] as const;
export type RemoteStopState = (typeof REMOTE_STOP_STATES)[number];

const ACTIVE_EXITS = ["completed", "failed", "cancelled", "queued", "unknown"] as const satisfies readonly RunStatus[];

/**
 * Statuses. `queued` is claimed (`starting`), or settled before it starts.
 * An active run moves between its active states, or leaves them: done,
 * failed, cancelled, requeued (lease lost, retry, stop to transmit) or
 * `unknown` (outcome uncertain). A courier is delivered or cancelled.
 * `unknown` leaves only through review (reconcile, abandon, retry) or the
 * maintenance cancellation. `cancelled` is not final: a steered follow-up is
 * replayed (edge condition below), and a gate decision Hermes received after
 * the cancellation makes it uncertain.
 */
export const STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["queued", "starting", "cancelled", "failed", "unknown"],
  starting: ["running", "awaiting_approval", ...ACTIVE_EXITS],
  running: ["running", "awaiting_approval", ...ACTIVE_EXITS],
  awaiting_approval: ["running", "awaiting_approval", ...ACTIVE_EXITS],
  relaying: ["completed", "cancelled"],
  unknown: ["unknown", "queued", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: ["queued", "unknown"],
};

/**
 * Status edges legal only under a condition on the row, which the primitive
 * adds to its `where`: a cancelled run comes back to the queue only when it
 * was folded into an active run (`steered_into_active`) whose terminal says
 * the agent never read it.
 */
export const STATUS_EDGE_CONDITIONS = {
  "cancelled>queued": "steered_into_active",
} as const satisfies Partial<Record<`${RunStatus}>${RunStatus}`, string>>;
export type StatusEdgeCondition = (typeof STATUS_EDGE_CONDITIONS)[keyof typeof STATUS_EDGE_CONDITIONS];

/**
 * External state of the Hermes run. Staying put is always legal. `ambiguous`
 * is reachable from anywhere (marking an outcome uncertain is always safe).
 * Back to `not_started` only when no Hermes run can exist: from `creating`
 * when the create was refused or never sent, from `settled` when a steered
 * follow-up that never reached Hermes is replayed. Nothing but uncertainty
 * follows `settled`. `ambiguous` is resolved by reconciliation (`polling`)
 * or by an abandon (`settled`).
 */
export const EXTERNAL_STATE_TRANSITIONS: Readonly<Record<ExternalState, readonly ExternalState[]>> = {
  not_started: ["not_started", "creating", "settled", "ambiguous"],
  creating: ["creating", "not_started", "streaming", "polling", "stopping", "settled", "ambiguous"],
  streaming: ["streaming", "creating", "polling", "stopping", "settled", "ambiguous"],
  polling: ["polling", "creating", "streaming", "stopping", "settled", "ambiguous"],
  stopping: ["stopping", "polling", "settled", "ambiguous"],
  settled: ["settled", "not_started", "ambiguous"],
  ambiguous: ["ambiguous", "polling", "settled"],
};

type RemoteStopKey = "none" | Exclude<RemoteStopState, null>;
const remoteKey = (state: RemoteStopState): RemoteStopKey => state ?? "none";

/**
 * Stop of the Hermes run. A stop request is never forgotten: nothing goes
 * back to `null`. A confirmed or uncertain stop may be requested again (a new
 * cancellation, a workflow deadline); any stop may become uncertain.
 */
export const REMOTE_STOP_TRANSITIONS: Readonly<Record<RemoteStopKey, readonly RemoteStopState[]>> = {
  none: [null, "requested", "confirmed", "ambiguous"],
  requested: ["requested", "confirmed", "ambiguous"],
  confirmed: ["confirmed", "requested", "ambiguous"],
  ambiguous: ["ambiguous", "requested", "confirmed"],
  failed: ["failed", "requested", "ambiguous"],
};

export function statusTransitionAllowed(from: RunStatus, to: RunStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function externalStateTransitionAllowed(from: ExternalState, to: ExternalState): boolean {
  return EXTERNAL_STATE_TRANSITIONS[from].includes(to);
}

export function remoteStopTransitionAllowed(from: RemoteStopState, to: RemoteStopState): boolean {
  return REMOTE_STOP_TRANSITIONS[remoteKey(from)].includes(to);
}

export function statusEdgeCondition(from: RunStatus, to: RunStatus): StatusEdgeCondition | null {
  return (STATUS_EDGE_CONDITIONS as Partial<Record<string, StatusEdgeCondition>>)[`${from}>${to}`] ?? null;
}

/** The origins from which `to` is legal: the primitive's `where` keeps the row among them. */
export function externalStateOrigins(to: ExternalState): ExternalState[] {
  return EXTERNAL_STATES.filter((from) => externalStateTransitionAllowed(from, to));
}

export function remoteStopOrigins(to: RemoteStopState): RemoteStopState[] {
  return REMOTE_STOP_STATES.filter((from) => remoteStopTransitionAllowed(from, to));
}

/**
 * The target of `external_state`: one state, a map from origin to target
 * (an origin left out keeps its state), or a choice on the Hermes run id
 * (with one, the run may exist on Hermes; without one, it never started).
 */
export type ExternalStateTarget =
  | ExternalState
  | { readonly map: Partial<Readonly<Record<ExternalState, ExternalState>>> }
  | { readonly withHermesRun: ExternalState; readonly withoutHermesRun: ExternalState };

/** The target of `remote_stop_state`: one state, or a map from origin to target. */
export type RemoteStopTarget =
  | RemoteStopState
  | { readonly map: Partial<Readonly<Record<RemoteStopKey, RemoteStopState>>> };

/**
 * One write of the three columns. `from` names the statuses the write
 * accepts (its guard); the other origins narrow the write further. A column
 * left out of `to` keeps its value.
 */
export type RunTransition = {
  readonly from: readonly RunStatus[];
  readonly fromExternalState?: readonly ExternalState[];
  readonly fromRemoteStopState?: readonly RemoteStopState[];
  readonly to: {
    readonly status?: RunStatus;
    readonly externalState?: ExternalStateTarget;
    readonly remoteStopState?: RemoteStopTarget;
  };
};

const isExternalState = (value: unknown): value is ExternalState =>
  typeof value === "string" && (EXTERNAL_STATES as readonly string[]).includes(value);
const isRemoteStopState = (value: unknown): value is RemoteStopState =>
  value === null || (typeof value === "string" && (REMOTE_STOP_STATES as readonly unknown[]).includes(value));
const fromRemoteKey = (key: string): RemoteStopState => key === "none" ? null : key as RemoteStopState;

function externalViolation(declared: readonly ExternalState[] | undefined, target: ExternalStateTarget): string | null {
  if (typeof target === "string") {
    if (!isExternalState(target)) return "unknown external state";
    const illegal = declared?.find((origin) => !externalStateTransitionAllowed(origin, target));
    return illegal ? `external_state ${illegal} -> ${target}` : null;
  }
  if ("map" in target) {
    const pairs = Object.entries(target.map);
    if (pairs.length === 0) return "empty external_state map";
    if (!pairs.every(([origin, to]) => isExternalState(origin) && isExternalState(to))) return "unknown external state";
    const illegal = pairs.find(([origin, to]) =>
      (!declared || declared.includes(origin as ExternalState)) && !externalStateTransitionAllowed(origin as ExternalState, to!));
    return illegal ? `external_state ${illegal[0]} -> ${illegal[1]}` : null;
  }
  const { withHermesRun, withoutHermesRun } = target;
  if (!isExternalState(withHermesRun) || !isExternalState(withoutHermesRun)) return "unknown external state";
  // Each declared origin must reach one of the two, or the write could never match it.
  const illegal = declared?.find((origin) =>
    !externalStateTransitionAllowed(origin, withHermesRun) && !externalStateTransitionAllowed(origin, withoutHermesRun));
  return illegal ? `external_state ${illegal} -> ${withHermesRun} | ${withoutHermesRun}` : null;
}

function remoteViolation(declared: readonly RemoteStopState[] | undefined, target: RemoteStopTarget): string | null {
  const mapped = target !== null && typeof target === "object";
  if (!mapped && !isRemoteStopState(target)) return "unknown remote stop state";
  const pairs: Array<[RemoteStopState, RemoteStopState]> = mapped
    ? Object.entries(target.map).map(([origin, to]) => [fromRemoteKey(origin), to as RemoteStopState])
    : (declared ?? []).map((origin) => [origin, target]);
  if (mapped && pairs.length === 0) return "empty remote_stop_state map";
  if (!pairs.every(([origin, to]) => isRemoteStopState(origin) && isRemoteStopState(to))) return "unknown remote stop state";
  const illegal = pairs.find(([origin, to]) => (!declared || declared.includes(origin)) && !remoteStopTransitionAllowed(origin, to));
  return illegal ? `remote_stop_state ${illegal[0] ?? "null"} -> ${illegal[1] ?? "null"}` : null;
}

/**
 * Why a transition may not be written, or null. A violation is a programming
 * error (the code names a move the tables do not allow), never a race: a row
 * whose state changed meanwhile is simply not matched by the `where`.
 *
 * A single target with no declared origin is checked on the row instead: the
 * primitive's `where` keeps it among the target's legal origins.
 */
export function runTransitionViolation(transition: RunTransition): string | null {
  const { from, to } = transition;
  if (from.length === 0) return "no origin status";
  const unknownStatus = [...from, ...(to.status !== undefined ? [to.status] : [])]
    .find((status) => !(RUN_STATUSES as readonly string[]).includes(status));
  if (unknownStatus !== undefined) return `unknown status ${String(unknownStatus)}`;
  if (to.status === undefined && to.externalState === undefined && to.remoteStopState === undefined) {
    return "nothing to write: status, external_state and remote_stop_state all kept";
  }
  const final = from.find((status) => (FINAL_RUN_STATUSES as readonly string[]).includes(status));
  if (final) return `${final} is final`;
  if (to.status !== undefined) {
    const illegal = from.find((status) => !statusTransitionAllowed(status, to.status!));
    if (illegal) return `status ${illegal} -> ${to.status}`;
  }
  if (transition.fromExternalState?.length === 0 || transition.fromRemoteStopState?.length === 0) return "empty origin set";
  if (transition.fromExternalState && !transition.fromExternalState.every(isExternalState)) return "unknown external state";
  if (transition.fromRemoteStopState && !transition.fromRemoteStopState.every(isRemoteStopState)) return "unknown remote stop state";
  if (to.externalState !== undefined) {
    const violation = externalViolation(transition.fromExternalState, to.externalState);
    if (violation) return violation;
  }
  if (to.remoteStopState !== undefined) {
    const violation = remoteViolation(transition.fromRemoteStopState, to.remoteStopState);
    if (violation) return violation;
  }
  return null;
}
