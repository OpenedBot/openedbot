import pino from "pino";
import type { LogChannel } from "./channels";
import { logMixin } from "./context";
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

/** Logger Pino dont chaque ligne aboutit dans `records`, mixin et redact inclus. */
export function createTestLogger(): { logger: pino.Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const destination = {
    write(chunk: string) {
      const line = chunk.trim();
      if (line) records.push(JSON.parse(line) as LogRecord);
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
