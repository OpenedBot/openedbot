import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

/**
 * Corrélation de bout en bout d'un run (W3C Trace Context, en-tête
 * `traceparent` version `00`), sans dépendance : le worker, l'API et le relais
 * du lien la chargent sans tirer pino.
 *
 * Le trace-id d'un run se DÉDUIT de son identifiant : les 32 chiffres
 * hexadécimaux de l'UUID du run, sans les tirets. Il naît donc avec le run, à
 * l'admission, sans colonne ni migration, et chaque processus qui connaît le
 * run retrouve le même : `run.admission` (API), les étapes du worker, le relais
 * (gateway) et le connecteur (edge-setup) journalisent tous ce trace-id. Un
 * span-id neuf désigne chaque prise du run par un worker, puis chaque requête
 * envoyée à l'hôte.
 *
 * Ce n'est pas un secret : l'hôte connaît déjà l'identifiant du run (clé de
 * routine, clé d'idempotence d'un steer).
 */

export const TRACEPARENT_HEADER = "traceparent";

export type TraceContext = {
  /** 32 chiffres hexadécimaux minuscules, jamais tous nuls. */
  traceId: string;
  /** 16 chiffres hexadécimaux minuscules, jamais tous nuls. */
  spanId: string;
  /** Le span parent quand ce contexte en est un enfant (journal seulement, jamais sur le fil). */
  parentSpanId?: string;
  sampled: boolean;
};

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `version-traceid-parentid-flags`, sur 55 caractères pour la version 00. */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})/;

/**
 * Lit un `traceparent`. Rend `null` pour toute valeur invalide (W3C : un
 * participant ignore un en-tête qu'il ne sait pas lire, sans échouer).
 *
 * Version `00` : exactement 55 caractères. Version future (ni `00` ni `ff`) :
 * les 55 premiers caractères suivent la forme 00 et, s'il y en a d'autres, le
 * suivant est un `-`.
 */
export function parseTraceparent(value: string | null | undefined): TraceContext | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = TRACEPARENT.exec(text);
  if (!match) return null;
  const [, version, traceId, spanId, flags] = match as unknown as [string, string, string, string, string];
  if (version === "ff") return null;
  if (version === "00" ? text.length !== 55 : text.length > 55 && text[55] !== "-") return null;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/** L'en-tête `traceparent` (version 00) d'un contexte. */
export function formatTraceparent(context: Pick<TraceContext, "traceId" | "spanId" | "sampled">): string {
  if (!TRACE_ID.test(context.traceId) || context.traceId === ZERO_TRACE_ID) throw new Error("invalid trace id");
  if (!SPAN_ID.test(context.spanId) || context.spanId === ZERO_SPAN_ID) throw new Error("invalid span id");
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

/** Un span-id aléatoire, jamais tout à zéro. */
export function newSpanId(random: (size: number) => Uint8Array = randomBytes): string {
  for (;;) {
    const id = Buffer.from(random(8)).toString("hex");
    if (id !== ZERO_SPAN_ID) return id;
  }
}

/**
 * Le trace-id d'un run : son UUID sans tirets, en minuscules. Un identifiant
 * qui n'est pas un UUID (fixture de test) donne un condensé stable de lui-même,
 * pour que tous les processus retombent quand même sur la même valeur.
 */
export function traceIdOfRun(runId: string): string {
  if (UUID.test(runId)) {
    const hex = runId.replaceAll("-", "").toLowerCase();
    if (hex !== ZERO_TRACE_ID) return hex;
  }
  return createHash("sha256").update(`openedbot-run:${runId}`).digest("hex").slice(0, 32);
}

/** Le contexte d'une prise du run par un worker : le trace-id du run, un span neuf. */
export function runTraceContext(runId: string): TraceContext {
  return { traceId: traceIdOfRun(runId), spanId: newSpanId(), sampled: true };
}

/** Un span enfant du même trace, pour une requête sortante. */
export function childTraceContext(parent: TraceContext): TraceContext {
  return { traceId: parent.traceId, spanId: newSpanId(), parentSpanId: parent.spanId, sampled: parent.sampled };
}

const traceAls = new AsyncLocalStorage<TraceContext>();

/** Ouvre le contexte de trace pour `fn` et tout ce qu'elle attend (`await`, timers, flux). */
export function runWithTrace<T>(context: TraceContext, fn: () => T): T {
  return traceAls.run(context, fn);
}

/** Le contexte de trace en cours, absent hors d'un run. */
export function currentTrace(): TraceContext | undefined {
  return traceAls.getStore();
}
