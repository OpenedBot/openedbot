import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "pino";
import { channelOf } from "./channels";

/**
 * Pile de requête, équivalent du RequestStack Symfony. La WeakMap sur
 * `Request` reste la source de `X-Request-Id` ; l'ALS est seulement ce qui
 * permet à `logEvent` de lire l'identifiant sans le `Request`.
 */
const requestAls = new AsyncLocalStorage<{ requestId: string }>();

/**
 * Logger actif pour la durée d'un test (TestHandler) ou d'un sous-arbre.
 * Hors de ce store, on retombe sur le singleton de l'API.
 */
const loggerAls = new AsyncLocalStorage<Logger>();

let fallbackLogger: Logger | undefined;

/** Branche le singleton une fois, au chargement de `logger.ts`. */
export function setFallbackLogger(log: Logger): void {
  fallbackLogger = log;
}

/** Logger de l'ALS, ou le singleton. */
export function currentLogger(): Logger {
  const active = loggerAls.getStore() ?? fallbackLogger;
  if (!active) throw new Error("logger: fallback logger is not bound");
  return active;
}

/** Identifiant de la requête en cours, absent hors HTTP (démarrage, timer, WS). */
export function currentRequestId(): string | undefined {
  return requestAls.getStore()?.requestId;
}

/** Ouvre la pile de requête. L'ALS traverse les `await` de `fn`. */
export function runWithRequest<T>(requestId: string, fn: () => T): T {
  return requestAls.run({ requestId }, fn);
}

/** Redirige `logEvent` (et l'access-log par défaut) vers un logger donné. */
export function runWithLogger<T>(log: Logger, fn: () => T): T {
  return loggerAls.run(log, fn);
}

/**
 * Processor Pino : colle `requestId` et `channel` sur la ligne sérialisée,
 * sans les écrire dans l'objet passé à `logger.info`. Les spies des tests
 * voient donc toujours exactement les champs du call site.
 *
 * N'écrase jamais un `requestId` / `channel` déjà posé par l'appelant
 * (`onError` passe `requestId` à la main).
 */
export function logMixin(mergeObject: object, _level: number, _logger: Logger): object {
  const requestId = requestAls.getStore()?.requestId;
  const eventValue = "event" in mergeObject ? (mergeObject as { event?: unknown }).event : undefined;
  const event = typeof eventValue === "string" ? eventValue : "";
  const extra: Record<string, unknown> = {};
  if (requestId && !("requestId" in mergeObject)) extra.requestId = requestId;
  if (event && !("channel" in mergeObject)) extra.channel = channelOf(event);
  return extra;
}
