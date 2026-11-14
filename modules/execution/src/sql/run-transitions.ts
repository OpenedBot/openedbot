import type { SQL } from "bun";
import {
  ACTIVE_RUN_STATUSES,
  EXTERNAL_STATES,
  externalStateOrigins,
  REMOTE_STOP_STATES,
  remoteStopOrigins,
  runTransitionViolation,
  statusEdgeCondition,
  type ExternalState,
  type RemoteStopState,
  type RunTransition,
  type StatusEdgeCondition,
} from "../domain/run-transitions";

/**
 * The only writer of `runs.status`, `runs.external_state` and
 * `runs.remote_stop_state` (`tests/scripts/run-writes-contract.ts` refuses
 * any other). One `update`
 * per call, in the caller's transaction (or alone): the transition is checked
 * against the tables of `domain/run-transitions.ts` before writing, and the
 * `where` keeps the row in a legal origin, under the caller's fence. The rows
 * that moved come back: an empty answer means the run was not in an accepted
 * state (another writer won, the lease was lost), never an error.
 *
 * The statement is assembled as one template, with the states inlined as
 * literals (each is checked against its closed set first) and every other
 * value bound, so a reader of the PostgreSQL log sees the plain transition.
 */

const EXPRESSION = Symbol("run-sql-expression");

/** A piece of SQL with its bound values, for the columns that take an expression (`now()`…). */
export type SqlExpr = { readonly [EXPRESSION]: true; readonly strings: readonly string[]; readonly values: readonly unknown[] };

export function sqlExpr(strings: TemplateStringsArray, ...values: unknown[]): SqlExpr {
  return { [EXPRESSION]: true, strings: [...strings], values };
}

const isExpr = (value: unknown): value is SqlExpr =>
  typeof value === "object" && value !== null && (value as Partial<SqlExpr>)[EXPRESSION] === true;

export const NOW = sqlExpr`now()`;

/**
 * A template object built at run time, shaped like the one a tagged literal
 * gets: frozen, with a non-enumerable frozen `raw`. Bun 1.4.4's `sql` refuses
 * an array whose `raw` is enumerable (ERR_INVALID_ARG_VALUE).
 */
export function templateStrings(parts: readonly string[]): TemplateStringsArray {
  const strings = [...parts];
  Object.defineProperty(strings, "raw", { value: Object.freeze([...parts]) });
  return Object.freeze(strings) as unknown as TemplateStringsArray;
}

/** One statement, built in pieces and sent as a single tagged template. */
export class SqlStatement {
  private readonly parts: string[] = [""];
  private readonly bound: unknown[] = [];

  text(text: string): this {
    this.parts[this.parts.length - 1] += text;
    return this;
  }

  value(value: unknown): this {
    if (isExpr(value)) return this.expr(value);
    this.bound.push(value);
    this.parts.push("");
    return this;
  }

  expr(expression: SqlExpr): this {
    expression.strings.forEach((text, index) => {
      this.text(text);
      if (index < expression.values.length) this.value(expression.values[index]);
    });
    return this;
  }

  run<T>(sql: SQL): Promise<T> {
    return sql(templateStrings(this.parts), ...this.bound) as unknown as Promise<T>;
  }
}

/** Which rows a transition looks at, before its guards. */
export type RunTarget =
  | { readonly organizationId: string; readonly id: string }
  | { readonly organizationId: string; readonly ids: readonly string[] }
  | { readonly organizationId: string; readonly workflowId: string }
  /** Every organization's runs: the worker's sweeps, narrowed by `where`. */
  | { readonly sweep: true };

/**
 * Who may write. `lease`: the worker that holds the run, and only while its
 * lease is unexpired; a lease that lapsed or was taken over (a new
 * generation) is refused, before or after the sweep requeues it.
 * `lease_expired`: a sweep taking over a lapsed or absent lease. `unleased`:
 * no lease involved, for the API on rows it holds locked, a queued run, or a
 * worker writing an outcome after its lease is gone by definition (an orphan
 * Hermes create, a gate decision Hermes received).
 */
export type LeaseFence = { readonly lease: { readonly owner: string; readonly generation: number } };
export type RunFence = LeaseFence | "lease_expired" | "unleased";

export const leaseFence = (owner: string, generation: number): LeaseFence => ({ lease: { owner, generation } });

/** The other columns a transition may carry. Each is written as given (an expression or a bound value). */
export type RunColumnValues = {
  readonly hermesRunId?: string | null | SqlExpr;
  readonly model?: string | null;
  readonly input?: string;
  readonly output?: string | null;
  readonly usage?: unknown;
  readonly completionKind?: string | null;
  readonly errorCode?: string | null | SqlExpr;
  readonly errorMessage?: string | null | SqlExpr;
  readonly startedAt?: SqlExpr;
  readonly endedAt?: SqlExpr | null;
  readonly eventsComplete?: boolean | SqlExpr;
  readonly lastHermesSequence?: number;
  readonly leaseOwner?: string | null;
  readonly leaseExpiresAt?: SqlExpr | null;
  readonly leaseGeneration?: SqlExpr;
  readonly heartbeatAt?: SqlExpr;
  readonly attempts?: SqlExpr;
  readonly nextAttemptAt?: SqlExpr | null;
};

const COLUMNS: Readonly<Record<keyof RunColumnValues, string>> = {
  hermesRunId: "hermes_run_id",
  model: "model",
  input: "input",
  output: "output",
  usage: "usage",
  completionKind: "completion_kind",
  errorCode: "error_code",
  errorMessage: "error_message",
  startedAt: "started_at",
  endedAt: "ended_at",
  eventsComplete: "events_complete",
  lastHermesSequence: "last_hermes_sequence",
  leaseOwner: "lease_owner",
  leaseExpiresAt: "lease_expires_at",
  leaseGeneration: "lease_generation",
  heartbeatAt: "heartbeat_at",
  attempts: "attempts",
  nextAttemptAt: "next_attempt_at",
};

/** Lease released with the run: what every write that leaves the active states carries. */
export const RELEASE_LEASE = { leaseOwner: null, leaseExpiresAt: null } as const satisfies RunColumnValues;

export type RunTransitionChange = {
  readonly target: RunTarget;
  readonly fence: RunFence;
  readonly transition: RunTransition;
  readonly set?: RunColumnValues;
  /** Narrows the target further (a sweep's own predicate); it never widens the guards. */
  readonly where?: SqlExpr;
};

export type TransitionedRun = {
  id: string;
  organizationId: string;
  threadId: string;
  workflowId: string | null;
  leaseGeneration: number;
};

const STATE = /^[a-z_]+$/u;
function literal(state: string): string {
  // Every state was checked against its closed set; this keeps the inlining honest.
  if (!STATE.test(state)) throw new Error(`run transition: refusing to inline ${JSON.stringify(state)}`);
  return `'${state}'`;
}
const list = (states: readonly string[]) => `(${states.map(literal).join(", ")})`;

function remoteGuard(states: readonly RemoteStopState[]): string | null {
  if (REMOTE_STOP_STATES.every((state) => states.includes(state))) return null;
  const named = states.filter((state): state is Exclude<RemoteStopState, null> => state !== null);
  const parts = [...(named.length ? [`remote_stop_state in ${list(named)}`] : []), ...(states.includes(null) ? ["remote_stop_state is null"] : [])];
  return parts.length === 1 ? parts[0]! : `(${parts.join(" or ")})`;
}

function externalGuard(states: readonly ExternalState[]): string | null {
  return EXTERNAL_STATES.every((state) => states.includes(state)) ? null : `external_state in ${list(states)}`;
}

const intersect = <T>(states: readonly T[], declared: readonly T[] | undefined): T[] =>
  declared ? states.filter((state) => declared.includes(state)) : [...states];

const EDGE_CONDITIONS: Readonly<Record<StatusEdgeCondition, string>> = {
  steered_into_active: "completion_kind = 'steered_into_active'",
};

function appendFence(statement: SqlStatement, fence: RunFence): void {
  if (fence === "unleased") return;
  if (fence === "lease_expired") {
    statement.text(" and (lease_expires_at < now() or lease_owner is null or lease_expires_at is null)");
    return;
  }
  statement.text(" and lease_owner = ").value(fence.lease.owner)
    .text(" and lease_generation = ").value(fence.lease.generation)
    .text(" and lease_expires_at > now()");
}

function appendTarget(statement: SqlStatement, target: RunTarget): void {
  if ("sweep" in target) {
    statement.text(" where true");
    return;
  }
  statement.text(" where organization_id = ").value(target.organizationId);
  if ("id" in target) statement.text(" and id = ").value(target.id);
  else if ("workflowId" in target) statement.text(" and workflow_id = ").value(target.workflowId);
  else {
    statement.text(" and id in (");
    target.ids.forEach((id, index) => { if (index) statement.text(", "); statement.value(id); });
    statement.text(")");
  }
}

/**
 * Applies one transition and returns the rows it moved. Throws before writing
 * when the transition is not in the tables (a programming error).
 */
export async function transitionRuns(sql: SQL, change: RunTransitionChange): Promise<TransitionedRun[]> {
  const { transition, target } = change;
  const violation = runTransitionViolation(transition);
  if (violation) throw new Error(`run transition refused before writing: ${violation}`);
  if ("ids" in target && target.ids.length === 0) return [];
  const { to } = transition;
  const statement = new SqlStatement().text("update runs set ");
  const assignments: Array<() => void> = [];
  if (to.status !== undefined) assignments.push(() => statement.text(`status = ${literal(to.status!)}`));
  const external = to.externalState;
  if (external !== undefined) {
    assignments.push(() => {
      if (typeof external === "string") statement.text(`external_state = ${literal(external)}`);
      else if ("map" in external) {
        statement.text("external_state = case external_state");
        for (const [origin, next] of Object.entries(external.map)) statement.text(` when ${literal(origin)} then ${literal(next!)}`);
        statement.text(" else external_state end");
      } else {
        statement.text(`external_state = case when hermes_run_id is null then ${literal(external.withoutHermesRun)} else ${literal(external.withHermesRun)} end`);
      }
    });
  }
  const remote = to.remoteStopState;
  if (remote !== undefined) {
    assignments.push(() => {
      if (remote === null) statement.text("remote_stop_state = null");
      else if (typeof remote === "string") statement.text(`remote_stop_state = ${literal(remote)}`);
      else {
        statement.text("remote_stop_state = case");
        for (const [origin, next] of Object.entries(remote.map)) {
          statement.text(origin === "none" ? " when remote_stop_state is null" : ` when remote_stop_state = ${literal(origin)}`)
            .text(` then ${next === null || next === undefined ? "null" : literal(next)}`);
        }
        statement.text(" else remote_stop_state end");
      }
    });
  }
  for (const [key, value] of Object.entries(change.set ?? {})) {
    if (value === undefined) continue;
    const column = COLUMNS[key as keyof RunColumnValues];
    if (!column) throw new Error(`run transition: unknown column ${key}`);
    // A null is written as such, so that a released lease reads `lease_owner = null` in the log.
    assignments.push(() => (value === null ? statement.text(`${column} = null`) : statement.text(`${column} = `).value(value)));
  }
  assignments.push(() => statement.text("updated_at = now()"));
  assignments.forEach((assign, index) => { if (index) statement.text(", "); assign(); });

  appendTarget(statement, target);
  statement.text(` and status in ${list(transition.from)}`);
  if (to.status !== undefined) {
    for (const origin of transition.from) {
      const condition = statusEdgeCondition(origin, to.status);
      if (condition) statement.text(` and (status <> ${literal(origin)} or ${EDGE_CONDITIONS[condition]})`);
    }
  }
  if (typeof external === "string") {
    const guard = externalGuard(intersect(externalStateOrigins(external), transition.fromExternalState));
    if (guard) statement.text(` and ${guard}`);
  } else if (external !== undefined && "withHermesRun" in external) {
    const withRun = externalGuard(intersect(externalStateOrigins(external.withHermesRun), transition.fromExternalState));
    const withoutRun = externalGuard(intersect(externalStateOrigins(external.withoutHermesRun), transition.fromExternalState));
    if (withRun || withoutRun) {
      statement.text(` and ((hermes_run_id is not null and ${withRun ?? "true"}) or (hermes_run_id is null and ${withoutRun ?? "true"}))`);
    }
  } else if (transition.fromExternalState) {
    const guard = externalGuard(transition.fromExternalState);
    if (guard) statement.text(` and ${guard}`);
  }
  const remoteOrigins = remote === undefined || (remote !== null && typeof remote === "object")
    ? transition.fromRemoteStopState
    : intersect(remoteStopOrigins(remote), transition.fromRemoteStopState);
  const remoteCheck = remoteOrigins ? remoteGuard(remoteOrigins) : null;
  if (remoteCheck) statement.text(` and ${remoteCheck}`);
  appendFence(statement, change.fence);
  if (change.where) statement.text(" and (").expr(change.where).text(")");
  statement.text(` returning id, organization_id as "organizationId", thread_id as "threadId", workflow_id as "workflowId", lease_generation as "leaseGeneration"`);
  const rows = await statement.run<TransitionedRun[]>(sql);
  return [...rows].map((row) => ({ ...row, leaseGeneration: Number(row.leaseGeneration) }));
}

/**
 * Locks the run the worker holds, for a transaction that writes on its
 * behalf (`persistEvents`): active, under an unexpired lease of this
 * generation, its stop not requested. Null when the lease is gone.
 */
export async function lockLeasedRunTx(
  tx: SQL,
  run: { organizationId: string; id: string },
  fence: LeaseFence,
): Promise<{ id: string } | null> {
  const statement = new SqlStatement().text("select id from runs");
  appendTarget(statement, run);
  statement.text(` and status in ${list(ACTIVE_RUN_STATUSES)}`);
  appendFence(statement, fence);
  statement.text(" and remote_stop_state is distinct from 'requested' for update");
  const rows = await statement.run<Array<{ id: string }>>(tx);
  return rows[0] ?? null;
}

/** Appends the lease fence of the worker to a statement of `sql/run-columns.ts`. */
export function appendLeaseFence(statement: SqlStatement, fence: RunFence): SqlStatement {
  appendFence(statement, fence);
  return statement;
}
