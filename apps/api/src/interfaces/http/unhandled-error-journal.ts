/**
 * The durable journal of unexpected errors (`api_errors`, 0161).
 *
 * The reference displayed on screen (« … (référence b98c6d00-…) ») designated
 * only a stdout line. It now also designates a row in the database,
 * which an operator rereads when the user cites it to support:
 *
 *   select * from api_errors where reference = '<reference>';
 *
 * Three rules, because this code runs precisely when something is
 * already broken:
 *
 * - the response NEVER depends on the write: the 500 is built first,
 *   the write leaves afterwards in a microtask, and its failure is only a
 *   log line;
 * - an avalanche of errors does not empty the pool: beyond `maxInFlight`
 *   writes in flight, the row is dropped and counted, with no queue
 *   that would grow without end during a database outage;
 * - nothing the caller sent is copied: neither body, nor headers,
 *   nor query string; the path loses its opaque segments, the message and the
 *   stack go through `sanitizeDiagnosticText`.
 */
import type { Context } from "hono";
import { isUuid } from "@openedbot/contracts-primitives";
import { withTenant, type Db, type TransactionDb } from "@openedbot/platform-db";
import { logger, recordErrorCode, requestIdOf } from "@openedbot/platform-observability";
import { sanitizeDiagnosticText } from "@openedbot/runtime-link/domain/diagnostics";
import { unhandledErrorBody, unhandledErrorCause } from "./unhandled-error";

/** The bounds of the 0161 columns, redone here so that no row is refused by the database. */
export const API_ERROR_BOUNDS = {
  method: 16,
  route: 512,
  path: 512,
  cause: 256,
  message: 1024,
  stack: 8192,
} as const;

/**
 * At most four writes in flight, on a pool of 32 connections by default
 * (`API_DB_MAX`): the journal never takes more than an eighth of the pool.
 */
export const API_ERROR_JOURNAL_MAX_IN_FLIGHT = 4;

export type UnhandledErrorRecord = {
  reference: string;
  occurredAt: Date;
  organizationId: string | null;
  userId: string | null;
  method: string;
  route: string | null;
  path: string;
  errorCode: "INTERNAL_ERROR";
  pgCode: string | null;
  cause: string;
  message: string;
  stack: string | null;
};

/** What the error handler knows of the request, read synchronously. */
export type UnhandledErrorRequest = {
  reference: string;
  occurredAt: Date;
  method: string;
  path: string;
  route: string | null;
  organizationId?: string | null;
  userId?: string | null;
};

type ErrorLike = Partial<{ code: unknown; errno: unknown; constraint: unknown; stack: unknown }>;

/** A path segment long enough to be a token (a one-shot link or connection token) and that is not a UUID. */
const OPAQUE_SEGMENT_MIN_CHARS = 24;

/**
 * The path, without a query string (Hono's `path` carries none) and without its
 * opaque segments: a UUID stays (that is what makes it possible to find the thread
 * or the bot), an invitation or connection token becomes `[redacted]`.
 */
export function redactRequestPath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
  const redacted = withoutQuery
    .split("/")
    .map((segment) => segment.length >= OPAQUE_SEGMENT_MIN_CHARS && !isUuid(segment) ? "[redacted]" : segment)
    .join("/");
  return boundedText(redacted, API_ERROR_BOUNDS.path);
}

/**
 * The text is cut at four times its bound BEFORE redaction: a stack of
 * several megabytes must not cost a complete regular-expression
 * scan on the error path. `sanitizeDiagnosticText` then bounds
 * in bytes, therefore also in characters (the SQL constraint).
 */
function boundedText(text: string, maxChars: number): string {
  return sanitizeDiagnosticText(text.slice(0, maxChars * 4), maxChars);
}

function sqlState(error: unknown): string | null {
  const like = (error ?? {}) as ErrorLike;
  // Bun files the SQLSTATE in `errno` (see `isUniqueViolation`).
  for (const value of [like.errno, like.code]) {
    if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)) return value;
  }
  return null;
}

/**
 * The row to write. The PostgreSQL `detail` does not enter it: it copies the
 * values of the row at fault (`Key (email)=(…)`); it stays in the log.
 */
export function unhandledErrorRecord(error: unknown, request: UnhandledErrorRequest): UnhandledErrorRecord {
  const like = (error ?? {}) as ErrorLike;
  const constraint = typeof like.constraint === "string" ? ` ; constraint ${like.constraint}` : "";
  const stack = typeof like.stack === "string" ? boundedText(like.stack, API_ERROR_BOUNDS.stack) : "";
  const organizationId = request.organizationId && isUuid(request.organizationId) ? request.organizationId : null;
  const userId = request.userId && isUuid(request.userId) ? request.userId : null;
  return {
    reference: request.reference,
    occurredAt: request.occurredAt,
    organizationId,
    userId,
    method: boundedText(request.method.toUpperCase(), API_ERROR_BOUNDS.method),
    route: request.route ? boundedText(request.route, API_ERROR_BOUNDS.route) : null,
    path: redactRequestPath(request.path),
    errorCode: "INTERNAL_ERROR",
    pgCode: sqlState(error),
    cause: boundedText(unhandledErrorCause(error), API_ERROR_BOUNDS.cause),
    message: boundedText(`${String(error)}${constraint}`, API_ERROR_BOUNDS.message) || "(sans message)",
    stack: stack || null,
  };
}

export type UnhandledErrorJournalStats = { inFlight: number; written: number; failed: number; dropped: number };

export type UnhandledErrorJournal = {
  /**
   * Schedules the write and returns immediately. `build` runs
   * only once the slot is reserved, in the microtask: a redaction that
   * throws counts as a write failure, never as a handler error.
   */
  record(reference: string, build: () => UnhandledErrorRecord): void;
  stats(): UnhandledErrorJournalStats;
  /** Waits for the writes in flight to finish (tests, shutdown). */
  idle(): Promise<void>;
};

export type UnhandledErrorJournalOptions = {
  maxInFlight?: number;
  log?: Pick<typeof logger, "warn">;
};

export function createUnhandledErrorJournal(
  write: (record: UnhandledErrorRecord) => Promise<void>,
  options: UnhandledErrorJournalOptions = {},
): UnhandledErrorJournal {
  const maxInFlight = options.maxInFlight ?? API_ERROR_JOURNAL_MAX_IN_FLIGHT;
  const log = options.log ?? logger;
  const pending = new Set<Promise<void>>();
  const counters = { written: 0, failed: 0, dropped: 0 };

  return {
    record(reference, build) {
      if (pending.size >= maxInFlight) {
        counters.dropped += 1;
        log.warn({
          event: "api.unhandled_error_journal_dropped",
          reference,
          inFlight: pending.size,
          dropped: counters.dropped,
        }, "unhandled error journal dropped");
        return;
      }
      const task: Promise<void> = Promise.resolve()
        .then(() => write(build()))
        .then(
          () => { counters.written += 1; },
          (error: unknown) => {
            counters.failed += 1;
            log.warn({
              event: "api.unhandled_error_journal_failed",
              reference,
              error: String(error),
              failed: counters.failed,
            }, "unhandled error journal failed");
          },
        )
        .finally(() => { pending.delete(task); });
      pending.add(task);
    },
    stats: () => ({ inFlight: pending.size, ...counters }),
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}

async function insertUnhandledError(sql: Db | TransactionDb, record: UnhandledErrorRecord): Promise<void> {
  await sql`
    insert into api_errors (
      reference, occurred_at, organization_id, user_id, method, route, path,
      error_code, pg_code, cause, message, stack
    ) values (
      ${record.reference}, ${record.occurredAt}, ${record.organizationId}, ${record.userId},
      ${record.method}, ${record.route}, ${record.path}, ${record.errorCode}, ${record.pgCode},
      ${record.cause}, ${record.message}, ${record.stack}
    )
  `;
}

/**
 * The write under the RLS of 0161: an organization row under
 * `withTenant` (the `with check` compares `app.organization_id`), a row
 * without an organization (anonymous request, account without a workspace) with no setting. One
 * transaction per row, without `returning`: openedbot_api has only `insert`.
 */
export function unhandledErrorJournalWriter(db: Db): (record: UnhandledErrorRecord) => Promise<void> {
  return async (record) => {
    if (record.organizationId) {
      await withTenant(db, record.organizationId, (tx) => insertUnhandledError(tx, record));
    } else {
      await insertUnhandledError(db, record);
    }
  };
}

type AuthVariables = { auth?: { organizationId?: string; userId?: string } };

/**
 * `routePath` reads the current handler's index: outside a matched route it
 * can throw. The error path must not throw in turn; without a pattern,
 * the row keeps the redacted path.
 */
function matchedRoute(context: Context): string | null {
  try {
    return context.req.routePath || null;
  } catch {
    return null;
  }
}

/**
 * The "unexpected error" branch of `app.onError`: the log line, the
 * 500 body (unchanged, unhandled-error.ts), then the durable row, scheduled
 * AFTER the response is built.
 */
export function respondToUnhandledError(
  context: Context,
  error: unknown,
  options: { environment: string; journal: UnhandledErrorJournal; now?: () => Date; log?: Pick<typeof logger, "error"> },
): Response {
  // The SAME identifier as the access-log line and as the
  // `X-Request-Id` header: the reference the user reads designates a row
  // an operator can find, in the log as in `api_errors`.
  const requestId = requestIdOf(context.req.raw);
  recordErrorCode(context.req.raw, "INTERNAL_ERROR");
  // `String(error)` alone made the reference unusable: a PostgreSQL
  // error is read by its `code`, its `constraint` and its `detail`.
  const pg = error as Partial<{ code: string; constraint: string; detail: string; stack: string }>;
  (options.log ?? logger).error({
    event: "api.unhandled_error",
    requestId,
    error: String(error),
    stack: typeof pg.stack === "string" ? pg.stack : undefined,
    pgCode: typeof pg.code === "string" ? pg.code : undefined,
    constraint: typeof pg.constraint === "string" ? pg.constraint : undefined,
    detail: typeof pg.detail === "string" ? pg.detail : undefined,
  }, "unhandled error");
  // Never a bare « HTTP 500 » on screen: the cause, translated, and the reference;
  // the raw text in addition outside production (unhandled-error.ts).
  const response = context.json({ error: unhandledErrorBody(error, requestId, options.environment) }, 500);
  // Read now (the request is still there), redacted later (in `build`).
  const auth = (context.var as AuthVariables).auth;
  const request: UnhandledErrorRequest = {
    reference: requestId,
    occurredAt: (options.now ?? (() => new Date()))(),
    method: context.req.method,
    path: context.req.path,
    route: matchedRoute(context),
    organizationId: auth?.organizationId ?? null,
    userId: auth?.userId ?? null,
  };
  options.journal.record(requestId, () => unhandledErrorRecord(error, request));
  return response;
}
