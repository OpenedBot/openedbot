/**
 * Le journal durable des erreurs non prévues (`api_errors`, 0161).
 *
 * La référence affichée à l'écran (« … (référence b98c6d00-…) ») ne désignait
 * qu'une ligne de stdout. Elle désigne maintenant aussi une ligne en base,
 * qu'un opérateur relit quand l'utilisateur la cite au support :
 *
 *   select * from api_errors where reference = '<référence>';
 *
 * Trois règles, parce que ce code tourne précisément quand quelque chose est
 * déjà cassé :
 *
 * - la réponse ne dépend JAMAIS de l'écriture : le 500 est construit d'abord,
 *   l'écriture part ensuite dans une microtâche, et son échec n'est qu'une
 *   ligne de journal ;
 * - une avalanche d'erreurs ne vide pas le pool : au-delà de `maxInFlight`
 *   écritures en vol, la ligne est abandonnée et comptée, sans file d'attente
 *   qui grossirait sans fin pendant une panne de base ;
 * - rien de ce que l'appelant a envoyé n'est recopié : ni corps, ni en-têtes,
 *   ni query string ; le chemin perd ses segments opaques, le message et la
 *   pile passent par `sanitizeDiagnosticText`.
 */
import type { Context } from "hono";
import { isUuid } from "@openedbot/contracts-primitives";
import { withTenant, type Db, type TransactionDb } from "@openedbot/platform-db";
import { logger, recordErrorCode, requestIdOf } from "@openedbot/platform-observability";
import { sanitizeDiagnosticText } from "@openedbot/runtime-link/domain/diagnostics";
import { unhandledErrorBody, unhandledErrorCause } from "./unhandled-error";

/** Les bornes des colonnes de 0161, refaites ici pour qu'aucune ligne ne soit refusée par la base. */
export const API_ERROR_BOUNDS = {
  method: 16,
  route: 512,
  path: 512,
  cause: 256,
  message: 1024,
  stack: 8192,
} as const;

/**
 * Au plus quatre écritures en vol, sur un pool de 32 connexions par défaut
 * (`API_DB_MAX`) : le journal ne prend jamais plus d'un huitième du pool.
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

/** Ce que le handler d'erreur sait de la requête, lu de façon synchrone. */
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

/** Un segment de chemin assez long pour être un jeton (`/api/member-invitations/:token`) et qui n'est pas un UUID. */
const OPAQUE_SEGMENT_MIN_CHARS = 24;

/**
 * Le chemin, sans query string (le `path` de Hono n'en porte pas) et sans ses
 * segments opaques : un UUID reste (c'est ce qui permet de retrouver le fil
 * ou le bot), un jeton d'invitation ou de connexion devient `[redacted]`.
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
 * Le texte est coupé à quatre fois sa borne AVANT la rédaction : une pile de
 * plusieurs mégaoctets ne doit pas coûter un balayage d'expressions
 * régulières complet dans le chemin d'erreur. `sanitizeDiagnosticText` borne
 * ensuite en octets, donc aussi en caractères (la contrainte SQL).
 */
function boundedText(text: string, maxChars: number): string {
  return sanitizeDiagnosticText(text.slice(0, maxChars * 4), maxChars);
}

function sqlState(error: unknown): string | null {
  const like = (error ?? {}) as ErrorLike;
  // Bun range le SQLSTATE dans `errno` (voir `isUniqueViolation`).
  for (const value of [like.errno, like.code]) {
    if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)) return value;
  }
  return null;
}

/**
 * La ligne à écrire. Le `detail` PostgreSQL n'y entre pas : il recopie les
 * valeurs de la ligne en cause (`Key (email)=(…)`) ; il reste dans le journal.
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
   * Programme l'écriture et rend la main tout de suite. `build` ne tourne
   * qu'une fois la place réservée, dans la microtâche : une rédaction qui
   * lève compte comme un échec d'écriture, jamais comme une erreur du handler.
   */
  record(reference: string, build: () => UnhandledErrorRecord): void;
  stats(): UnhandledErrorJournalStats;
  /** Attend la fin des écritures en vol (tests, arrêt). */
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
 * L'écriture sous la RLS de 0161 : une ligne d'organisation sous
 * `withTenant` (le `with check` compare `app.organization_id`), une ligne
 * sans organisation (requête anonyme, compte sans espace) sans réglage. Une
 * transaction par ligne, sans `returning` : openedbot_api n'a que `insert`.
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
 * `routePath` lit l'index du handler courant : hors d'une route matchée il
 * peut lever. Le chemin d'erreur ne doit pas lever à son tour ; sans motif,
 * la ligne garde le chemin rédigé.
 */
function matchedRoute(context: Context): string | null {
  try {
    return context.req.routePath || null;
  } catch {
    return null;
  }
}

/**
 * La branche « erreur non prévue » de `app.onError` : la ligne de journal, le
 * corps 500 (inchangé, unhandled-error.ts), puis la ligne durable, programmée
 * APRÈS la réponse construite.
 */
export function respondToUnhandledError(
  context: Context,
  error: unknown,
  options: { environment: string; journal: UnhandledErrorJournal; now?: () => Date; log?: Pick<typeof logger, "error"> },
): Response {
  // Le MÊME identifiant que la ligne d'access-log et que l'en-tête
  // `X-Request-Id` : la référence lue par l'utilisateur désigne une ligne
  // qu'un opérateur peut retrouver, dans le journal comme dans `api_errors`.
  const requestId = requestIdOf(context.req.raw);
  recordErrorCode(context.req.raw, "INTERNAL_ERROR");
  // `String(error)` seul rendait la référence inexploitable : une erreur
  // PostgreSQL se lit par son `code`, sa `constraint` et son `detail`.
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
  // Jamais « HTTP 500 » nu à l'écran : la cause, traduite, et la référence ;
  // le texte brut en plus hors production (unhandled-error.ts).
  const response = context.json({ error: unhandledErrorBody(error, requestId, options.environment) }, 500);
  // Lu maintenant (la requête est encore là), rédigé plus tard (dans `build`).
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
