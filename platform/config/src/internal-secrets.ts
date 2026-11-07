import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The secrets the API, the worker and the link gateway share for their internal
 * calls: one per role (ADR 0001, section 4.7, S1b), instead of the single
 * `WORKER_INTERNAL_TOKEN` that used to be the bearer of every internal route and
 * the HMAC key of run keys.
 *
 *   events     worker -> API `/internal/events/publish`
 *   relay      worker, API, gateway -> the relay routes `/internal/runtime-links/*`
 *              (proxy, dial, control, probe, hops between instances)
 *   inventory  gateway -> API `/internal/runtime-inventory/changed`
 *   runKey     the HMAC master secret of the run keys of the MCP tools (never a bearer)
 *
 * A process holds only the roles it uses (`PROCESS_INTERNAL_ROLES`): the type of
 * its secrets has no field for the others, so the gateway cannot sign a run key
 * nor publish an event.
 *
 * Transition (self-hosting and the production cut-over): a role without its own
 * variable falls back to `WORKER_INTERNAL_TOKEN`, which keeps an unmigrated host
 * starting as before. While `WORKER_INTERNAL_TOKEN` is set every verifier still
 * accepts it, and `INTERNAL_TOKENS_EMIT=legacy` makes every emitter send it, so a
 * rolling update never meets a verifier that refuses what an older container
 * sends. `RUN_KEY_PREVIOUS_SECRET` reads (never signs) the run keys of runs
 * created before `RUN_KEY_PREVIOUS_CREATED_BEFORE`, the runs that were signed
 * with the former secret and may still be alive.
 */

export const INTERNAL_ROLES = ["events", "relay", "inventory", "runKey"] as const;
export type InternalRole = (typeof INTERNAL_ROLES)[number];

export const INTERNAL_ROLE_VARIABLES: Readonly<Record<InternalRole, string>> = {
  events: "EVENTS_INTERNAL_TOKEN",
  relay: "RELAY_INTERNAL_TOKEN",
  inventory: "INVENTORY_INTERNAL_TOKEN",
  runKey: "RUN_KEY_SECRET",
};
export const LEGACY_INTERNAL_VARIABLE = "WORKER_INTERNAL_TOKEN";
export const INTERNAL_EMIT_VARIABLE = "INTERNAL_TOKENS_EMIT";
export const RUN_KEY_PREVIOUS_SECRET_VARIABLE = "RUN_KEY_PREVIOUS_SECRET";
export const RUN_KEY_PREVIOUS_CREATED_BEFORE_VARIABLE = "RUN_KEY_PREVIOUS_CREATED_BEFORE";

export const PROCESS_INTERNAL_ROLES = {
  api: ["events", "relay", "inventory", "runKey"],
  worker: ["events", "relay", "runKey"],
  "link-gateway": ["relay", "inventory"],
} as const satisfies Record<string, readonly InternalRole[]>;
export type InternalProcess = keyof typeof PROCESS_INTERNAL_ROLES;
export type RolesOf<P extends InternalProcess> = (typeof PROCESS_INTERNAL_ROLES)[P][number];

/** Non-secret placeholders used outside production; every one is refused in production. */
export const DEV_LEGACY_INTERNAL_TOKEN = "openedbot-worker-dev-token";
export const DEV_INTERNAL_SECRETS: Readonly<Record<InternalRole, string>> = {
  events: "openedbot-events-dev-token",
  relay: "openedbot-relay-dev-token",
  inventory: "openedbot-inventory-dev-token",
  runKey: "openedbot-run-key-dev-secret",
};
const DEV_METRICS_INTERNAL_TOKEN = "openedbot-metrics-dev-token";
const DEV_VALUES = new Set<string>([DEV_LEGACY_INTERNAL_TOKEN, DEV_METRICS_INTERNAL_TOKEN, ...Object.values(DEV_INTERNAL_SECRETS)]);

export type InternalSecretSource = "explicit" | "legacy" | "development";
export type InternalSecret = { readonly value: string; readonly source: InternalSecretSource };
export type InternalEmit = "legacy" | "split";
export type RunKeyPrevious = { readonly secret: string; readonly createdBefore: Date };

/** The secrets of a process that holds at least the roles `R`. */
export type InternalSecretsWith<R extends InternalRole> = {
  readonly process: InternalProcess;
  readonly emit: InternalEmit;
  /** `WORKER_INTERNAL_TOKEN` while it is set: accepted by every verifier, sent under `emit: "legacy"`. */
  readonly legacy: string | null;
  readonly roles: { readonly [K in R]: InternalSecret };
  /** API only: the former run-key secret, for the cohort of runs created before the bound. */
  readonly runKeyPrevious: RunKeyPrevious | null;
};
export type InternalSecrets<P extends InternalProcess> = InternalSecretsWith<RolesOf<P>> & { readonly process: P };

type Environment = "development" | "test" | "production";
type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/**
 * Reads the internal secrets of `process`. Throws on any configuration that
 * could make two containers disagree or that weakens a secret in production.
 */
export function readInternalSecrets<P extends InternalProcess>(
  process: P,
  environment: Environment,
  env: Env = Bun.env,
): InternalSecrets<P> {
  const production = environment === "production";
  const legacy = read(env, LEGACY_INTERNAL_VARIABLE);
  const roles = {} as Record<InternalRole, InternalSecret>;
  const explicit: Array<[string, string]> = [];
  for (const role of PROCESS_INTERNAL_ROLES[process] as readonly InternalRole[]) {
    const name = INTERNAL_ROLE_VARIABLES[role];
    const own = read(env, name);
    if (own) {
      roles[role] = { value: own, source: "explicit" };
      explicit.push([name, own]);
    } else if (legacy) {
      roles[role] = { value: legacy, source: "legacy" };
    } else if (production) {
      throw new Error(`${name} is required in production (or ${LEGACY_INTERNAL_VARIABLE} while the internal secrets are not split).`);
    } else {
      roles[role] = { value: DEV_INTERNAL_SECRETS[role], source: "development" };
    }
  }

  const rawEmit = read(env, INTERNAL_EMIT_VARIABLE);
  if (rawEmit !== null && rawEmit !== "legacy" && rawEmit !== "split") {
    throw new Error(`${INTERNAL_EMIT_VARIABLE} must be legacy or split.`);
  }
  if (rawEmit === "legacy" && !legacy) {
    throw new Error(`${INTERNAL_EMIT_VARIABLE}=legacy requires ${LEGACY_INTERNAL_VARIABLE}.`);
  }
  if (production && rawEmit === null && legacy && explicit.length > 0) {
    // Both secrets are present: the cut-over is under way and the phase must be chosen,
    // never inferred, or a rolling update would send new secrets to old verifiers.
    throw new Error(`${INTERNAL_EMIT_VARIABLE} must be set (legacy or split) while ${LEGACY_INTERNAL_VARIABLE} and a per-role secret are both set.`);
  }
  const emit: InternalEmit = rawEmit ?? "split";

  let runKeyPrevious: RunKeyPrevious | null = null;
  if (process === "api") {
    const previous = read(env, RUN_KEY_PREVIOUS_SECRET_VARIABLE);
    const before = read(env, RUN_KEY_PREVIOUS_CREATED_BEFORE_VARIABLE);
    if ((previous === null) !== (before === null)) {
      throw new Error(`${RUN_KEY_PREVIOUS_SECRET_VARIABLE} and ${RUN_KEY_PREVIOUS_CREATED_BEFORE_VARIABLE} are set together or not at all.`);
    }
    if (previous && before) {
      const createdBefore = readUtcInstant(before);
      if (!createdBefore) {
        throw new Error(`${RUN_KEY_PREVIOUS_CREATED_BEFORE_VARIABLE} must be a valid UTC instant ending in Z (ISO 8601, e.g. 2026-11-07T12:00:00Z).`);
      }
      if (previous === roles.runKey.value) {
        throw new Error(`${RUN_KEY_PREVIOUS_SECRET_VARIABLE} must differ from the current run-key secret.`);
      }
      runKeyPrevious = { secret: previous, createdBefore };
    }
  }

  if (production) {
    const values: Array<[string, string]> = [...explicit];
    if (legacy) values.push([LEGACY_INTERNAL_VARIABLE, legacy]);
    if (runKeyPrevious) values.push([RUN_KEY_PREVIOUS_SECRET_VARIABLE, runKeyPrevious.secret]);
    for (const [name, value] of values) {
      if (DEV_VALUES.has(value)) throw new Error(`${name} must not be a development default in production.`);
    }
    for (let i = 0; i < explicit.length; i += 1) {
      for (let j = i + 1; j < explicit.length; j += 1) {
        if (explicit[i]![1] === explicit[j]![1]) throw new Error(`${explicit[i]![0]} and ${explicit[j]![0]} must be distinct production secrets.`);
      }
      if (legacy && explicit[i]![1] === legacy) throw new Error(`${explicit[i]![0]} must differ from ${LEGACY_INTERNAL_VARIABLE}.`);
    }
    const metrics = read(env, "METRICS_INTERNAL_TOKEN");
    if (metrics && values.some(([, value]) => value === metrics)) {
      throw new Error("METRICS_INTERNAL_TOKEN must be a distinct production secret.");
    }
  }

  return { process, emit, legacy, roles: roles as InternalSecrets<P>["roles"], runKeyPrevious } as InternalSecrets<P>;
}

/**
 * A UTC instant, explicit and real: `YYYY-MM-DDTHH:MM:SS[.fff]Z` only. No local
 * time (two containers in different time zones would bound the cohort apart),
 * and no date the parser silently normalizes (February 30 becomes March 2).
 */
function readUtcInstant(value: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19) === match[1] ? date : null;
}

/** The `Authorization` value an emitter sends for `role`. */
export function internalBearer<R extends InternalRole>(secrets: InternalSecretsWith<R>, role: R): string {
  if (secrets.emit === "legacy") {
    if (!secrets.legacy) throw new Error(`${INTERNAL_EMIT_VARIABLE}=legacy without ${LEGACY_INTERNAL_VARIABLE}.`);
    return `Bearer ${secrets.legacy}`;
  }
  return `Bearer ${secrets.roles[role].value}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  // Hash first: timingSafeEqual needs equal lengths, and the length of the secret must not leak.
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export type InternalBearerMatch = { ok: true; via: "role" | "legacy" } | { ok: false };

/** Whether an `Authorization` header carries the secret of `role` (or, during the transition, the former one). */
export function matchInternalBearer<R extends InternalRole>(
  secrets: InternalSecretsWith<R>,
  role: R,
  authorization: string | null | undefined,
): InternalBearerMatch {
  const header = authorization ?? "";
  const own = secrets.roles[role].value;
  const roleMatch = constantTimeEqual(header, `Bearer ${own}`);
  const legacyMatch = secrets.legacy !== null && secrets.legacy !== own && constantTimeEqual(header, `Bearer ${secrets.legacy}`);
  if (roleMatch) return { ok: true, via: "role" };
  if (legacyMatch) return { ok: true, via: "legacy" };
  return { ok: false };
}

/** The secret a run key is signed with now. */
export function runKeySigningSecret(secrets: InternalSecretsWith<"runKey">): string {
  if (secrets.emit === "legacy") {
    if (!secrets.legacy) throw new Error(`${INTERNAL_EMIT_VARIABLE}=legacy without ${LEGACY_INTERNAL_VARIABLE}.`);
    return secrets.legacy;
  }
  return secrets.roles.runKey.value;
}

export type RunKeyVerifier =
  | { secret: string; via: "role" | "legacy" }
  | { secret: string; via: "previous"; createdBefore: Date };

/**
 * The secrets a run key may verify against, in order. A key read through
 * `previous` is valid only for a run created before `createdBefore`: the caller
 * checks it against the run it loads (`runKeyCohortAllows`).
 */
export function runKeyVerifiers(secrets: InternalSecretsWith<"runKey">): RunKeyVerifier[] {
  const verifiers: RunKeyVerifier[] = [{ secret: secrets.roles.runKey.value, via: "role" }];
  if (secrets.legacy && secrets.legacy !== secrets.roles.runKey.value) verifiers.push({ secret: secrets.legacy, via: "legacy" });
  const previous = secrets.runKeyPrevious;
  if (previous && !verifiers.some((verifier) => verifier.secret === previous.secret)) {
    verifiers.push({ secret: previous.secret, via: "previous", createdBefore: previous.createdBefore });
  }
  return verifiers;
}

/** Whether a run key read through `verifier` is acceptable for a run created at `runCreatedAt`. */
export function runKeyCohortAllows(verifier: RunKeyVerifier, runCreatedAt: Date): boolean {
  return verifier.via !== "previous" || runCreatedAt.getTime() < verifier.createdBefore.getTime();
}

/** What a process logs at start: the mode, never a value nor a digest of one. */
export function describeInternalSecrets(secrets: InternalSecretsWith<never>): Record<string, unknown> {
  return {
    process: secrets.process,
    emit: secrets.emit,
    legacyAccepted: secrets.legacy !== null,
    roles: Object.fromEntries(Object.entries(secrets.roles as Record<string, InternalSecret>).map(([role, secret]) => [role, secret.source])),
    runKeyPreviousCreatedBefore: secrets.runKeyPrevious?.createdBefore.toISOString() ?? null,
  };
}

/** Internal secrets for tests: every role of `process` with its development value. */
export function testInternalSecrets<P extends InternalProcess>(process: P, overrides: Env = {}): InternalSecrets<P> {
  return readInternalSecrets(process, "test", overrides);
}
