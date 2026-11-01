import pino from "pino";
import type { Context, MiddlewareHandler } from "hono";
import { channelOf, LOG_CHANNELS, type LogChannel } from "./log/channels";
import {
  currentLogger,
  currentRequestId,
  logMixin,
  runWithLogger,
  runWithRequest,
  setFallbackLogger,
} from "./log/context";
import { logFileStem, logFilesEnabled, logsDirectory, tryCreateLogFileStream } from "./log/files";
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS, logRedact } from "./log/redact";
import { createTestLogger, type LogRecord } from "./log/test-logger";

export {
  channelOf,
  createTestLogger,
  currentLogger,
  currentRequestId,
  LOG_CHANNELS,
  LOG_REDACT_CENSOR,
  LOG_REDACT_PATHS,
  logFileStem,
  logsDirectory,
  runWithLogger,
  runWithRequest,
};
export type { LogChannel, LogRecord };

/** En-tête de corrélation posé sur chaque réponse HTTP. */
export const REQUEST_ID_HEADER = "X-Request-Id";

/**
 * Logger singleton de l'API. Deux handlers, comme Monolog :
 *
 * - stdout : pino-pretty en développement, JSON en production (journald)
 * - fichiers : `apps/api/var/logs/{dev|prod}.log` plus un fichier par canal
 *
 * `OPENEDBOT_LOG_TO_FILES=0` coupe les fichiers. `OPENEDBOT_LOG_DIR` change le dossier.
 *
 * La couleur des niveaux est forcée : `make dev` pipe la sortie de l'API dans
 * son formateur de lignes, pino-pretty ne voit donc jamais un TTY et couperait
 * ses couleurs tout seul. `NO_COLOR` les éteint, comme dans le Makefile.
 *
 * Le mixin colle `requestId` (ALS) et `channel` (préfixe de l'événement) sur
 * la ligne sérialisée, sans les ajouter à l'objet du call site.
 *
 * Sans `OPENEDBOT_ENV` ni `NODE_ENV`, le logger se tient pour en production : JSON
 * sur stdout, niveau `info`. Le mode lisible (`log-pretty.ts`) ne se charge
 * que sur `development` explicite, ce que `.env.example` pose en local.
 */
const isDevelopment = (process.env.OPENEDBOT_ENV ?? process.env.NODE_ENV ?? "production") === "development";
const level = isDevelopment ? "debug" : "info";

const consoleStream = isDevelopment
  ? pino.transport({
      target: new URL("./log-pretty.ts", import.meta.url).href,
      options: {
        colorize: !process.env.NO_COLOR,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    })
  : pino.destination(1);

const fileStream = logFilesEnabled()
  ? tryCreateLogFileStream({ dir: logsDirectory(), env: logFileStem(), sync: false })
  : undefined;

const streams: pino.StreamEntry[] = [{ level, stream: consoleStream }];
if (fileStream) streams.push({ level, stream: fileStream });

export const logger = pino(
  { level, redact: logRedact, mixin: logMixin },
  pino.multistream(streams),
);

setFallbackLogger(logger);

const channelLoggers = new Map<LogChannel, pino.Logger>();

/** Child Pino nommé, équivalent `monolog.logger.<canal>`. */
export function channel(name: LogChannel): pino.Logger {
  const existing = channelLoggers.get(name);
  if (existing) return existing;
  const child = logger.child({ channel: name });
  channelLoggers.set(name, child);
  return child;
}

/**
 * Journalise un événement nommé (`runtime_link.connected`, `alerting.started`).
 * Le niveau se lit dans le nom : un suffixe d'anomalie passe en `warn`, le
 * reste en `info`. C'est le remplaçant du `console.info(JSON.stringify(...))`
 * historique : mêmes champs, mais horodatés, nivelés et rédigés.
 *
 * Passe par le logger actif (ALS) pour qu'un test puisse injecter un
 * TestHandler sans toucher stdout. Hors ALS, c'est le singleton.
 */
const WARN_EVENT_SUFFIX = /(failed|expired|suspected|unexpected|dropped_overrun|ignored|unreadable|refused)$/;

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  const log = currentLogger();
  if (WARN_EVENT_SUFFIX.test(event)) log.warn({ event, ...fields }, event);
  else log.info({ event, ...fields }, event);
}

/**
 * Identifiant de requête, attaché à la `Request` elle-même. On ne passe pas par
 * une variable de contexte Hono : le handler d'erreur et l'access-log doivent
 * lire LE MÊME identifiant sans que le type `Variables` de l'application ait à
 * le déclarer. La clé est la `Request` : la `WeakMap` se vide toute seule.
 */
const requestIds = new WeakMap<Request, string>();

/**
 * L'identifiant de la requête, créé à la première demande. Le handler d'erreur
 * 500 l'appelle après l'access-log : il retrouve alors la valeur déjà posée,
 * et la référence rendue à l'utilisateur désigne bien une ligne de log.
 */
export function requestIdOf(request: Request, newId: () => string = () => crypto.randomUUID()): string {
  const existing = requestIds.get(request);
  if (existing) return existing;
  const created = newId();
  requestIds.set(request, created);
  return created;
}

/**
 * Le code de refus d'une requête, posé par le handler d'erreur et relu par
 * l'access-log.
 *
 * Sans lui, la ligne de journal désignée par une référence dit `status 409` et
 * rien d'autre : l'utilisateur voit un code à l'écran (`SERVER_EXISTS`,
 * `RUNTIME_ADMIN_UNAVAILABLE`) qu'on ne retrouve nulle part côté serveur. Le
 * corps de la réponse n'est pas lisible ici sans le consommer : d'où la même
 * `WeakMap` clefée sur la `Request` que pour l'identifiant.
 */
const errorCodes = new WeakMap<Request, string>();

/** Enregistre le code rendu à l'appelant, pour la ligne d'access-log. */
export function recordErrorCode(request: Request, code: string): void {
  errorCodes.set(request, code);
}

/** Ce que l'access-log sait lire du contexte authentifié, et rien de plus. */
type AuthenticatedContext = Context<{
  Variables: { auth?: { organizationId?: string; userId?: string } };
}>;

export type AccessLogOptions = {
  /** Logger cible, injectable pour les tests. */
  log?: Pick<typeof logger, "info" | "warn" | "error">;
  /** Fabrique d'identifiants, injectable pour les tests. */
  newRequestId?: () => string;
};

/**
 * Access-log : une ligne par requête, posée avant toute autre logique pour que
 * la durée mesurée couvre CORS, l'auth, la limitation de débit et la route.
 *
 * - `route` est le motif Hono matché (`/api/bots/:botId`), pas l'URL : c'est
 *   lui qui s'agrège. `path` reste le chemin brut, dont les UUID rendent la
 *   cardinalité infinie.
 * - `requestId` est généré ICI, avant `next()`, posé en en-tête de réponse et
 *   réutilisé par le handler d'erreur 500 : la référence lue par l'utilisateur
 *   retrouve la ligne de log. La pile ALS s'ouvre autour de `next()` pour que
 *   les `logEvent` de la route portent le même identifiant.
 * - `organizationId` / `userId` sont lus APRÈS `next()`, une fois l'auth
 *   passée. Jamais d'email, jamais de contenu de message, jamais de jeton.
 */
export function accessLogMiddleware(options: AccessLogOptions = {}): MiddlewareHandler {
  const newRequestId = options.newRequestId ?? (() => crypto.randomUUID());
  return async (context, next) => {
    const startedAtMs = performance.now();
    const requestId = requestIdOf(context.req.raw, newRequestId);
    context.header(REQUEST_ID_HEADER, requestId);
    await runWithRequest(requestId, async () => {
      await next();
      // `context.header()` posé avant `next()` ne survit pas à une réponse
      // construite par un handler en aval : on le repose sur la réponse finale.
      context.res.headers.set(REQUEST_ID_HEADER, requestId);
      const durationMs = Math.round(performance.now() - startedAtMs);
      const auth = (context as unknown as AuthenticatedContext).get("auth");
      const fields = {
        requestId,
        method: context.req.method,
        path: context.req.path,
        route: context.req.routePath,
        status: context.res.status,
        durationMs,
        ...(errorCodes.get(context.req.raw) ? { errorCode: errorCodes.get(context.req.raw) } : {}),
        ...(auth?.organizationId ? { organizationId: auth.organizationId } : {}),
        ...(auth?.userId ? { userId: auth.userId } : {}),
      };
      const log = options.log ?? currentLogger().child({ channel: "http" });
      if (context.res.status >= 500) log.error(fields, "http request");
      else if (context.res.status >= 400) log.warn(fields, "http request");
      else log.info(fields, "http request");
    });
  };
}
