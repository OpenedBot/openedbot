import pino from "pino";
import type { LogChannel } from "./channels";
import { logMixin, runWithLogger } from "./context";
import { logRedact } from "./redact";

/**
 * Ligne JSON telle que journald la verrait, capturée en mémoire. Pas de
 * worker pretty, pas de stdout : c'est le TestHandler de Monolog.
 */
export type LogRecord = {
  level: number;
  time: number;
  pid?: number;
  hostname?: string;
  msg?: string;
  event?: string;
  channel?: LogChannel | string;
  requestId?: string;
  [key: string]: unknown;
};

/**
 * Logger Pino dont chaque ligne aboutit dans `records`, mixin et redact inclus.
 * `onRecord` voit chaque ligne au moment où elle est écrite.
 */
export function createTestLogger(options: { onRecord?: (record: LogRecord) => void } = {}): { logger: pino.Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const destination = {
    write(chunk: string) {
      const line = chunk.trim();
      if (!line) return;
      const record = JSON.parse(line) as LogRecord;
      records.push(record);
      options.onRecord?.(record);
    },
  };
  const logger = pino(
    {
      level: "trace",
      redact: logRedact,
      mixin: logMixin,
    },
    destination,
  );
  return { logger, records };
}

/** Champs que pino et le mixin ajoutent à une ligne ; le reste est celui du call site. */
const LINE_METADATA = new Set(["level", "time", "pid", "hostname", "msg", "channel", "requestId", "traceId", "spanId"]);

/** Une ligne capturée réduite à `{ event, ...champs }`, comme l'ancien `console.info(JSON.stringify(...))`. */
export function eventFields(record: LogRecord): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !LINE_METADATA.has(key)));
}

/**
 * Exécute `work` avec un TestHandler comme logger actif (ALS) et rend ses
 * lignes : `records` brutes (niveau, trace…), `events` réduites aux champs du
 * call site. Pour les tests du worker, qui lisaient `console.info`.
 */
export async function captureLogEvents<T>(
  work: () => Promise<T> | T,
): Promise<{ result: T; records: LogRecord[]; events: Array<Record<string, unknown>> }> {
  const { logger, records } = createTestLogger();
  const result = await runWithLogger(logger, work);
  return { result, records, events: records.map(eventFields) };
}

export { runWithLogger };
