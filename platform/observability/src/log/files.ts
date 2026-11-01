import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { LOG_CHANNELS } from "./channels";

const CHANNEL_SET = new Set<string>(LOG_CHANNELS);

/**
 * Répertoire Monolog de l'API : `apps/api/var/logs`.
 * Surcharge : `OPENEDBOT_LOG_DIR` (tests, autre disque).
 *
 * Le chemin part de ce fichier (platform/observability/src/log) et remonte à
 * la racine du dépôt : le dossier par défaut reste celui de l'API, dans le
 * dépôt comme dans l'image, où les deux arbres sont copiés côte à côte.
 */
export function logsDirectory(): string {
  const override = process.env.OPENEDBOT_LOG_DIR?.trim();
  if (override) return override;
  return join(import.meta.dir, "../../../../apps/api/var/logs");
}

/**
 * Nom du fichier d'environnement, comme Symfony `dev.log` / `prod.log`.
 */
export function logFileStem(env = process.env.OPENEDBOT_ENV ?? process.env.NODE_ENV ?? "development"): string {
  if (env === "development") return "dev";
  if (env === "production") return "prod";
  const stem = env.replace(/[^a-z0-9_-]/gi, "");
  return stem.length > 0 ? stem : "dev";
}

function safeChannel(name: string): string {
  return CHANNEL_SET.has(name) ? name : "api";
}

function channelFromLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as { channel?: unknown };
    if (typeof parsed.channel === "string") return safeChannel(parsed.channel);
  } catch {
    // Ligne non JSON : elle va dans le fichier d'environnement et dans api.log.
  }
  return "api";
}

export type LogFileStreamOptions = {
  dir: string;
  env: string;
  /** `true` dans les tests : l'écriture est visible tout de suite. */
  sync?: boolean;
  /**
   * Couture de test, et rien d'autre : elle sert à rendre une destination qui
   * LÈVE à l'écriture, l'état que Bun 1.4.0 produit pendant les secondes qui
   * suivent un redémarrage. En production ce champ reste absent.
   */
  createDestination?: (path: string, opts: { mkdir: true; sync: boolean }) => pino.DestinationStream;
};

/**
 * Handler fichier : chaque ligne JSON part dans `{env}.log` ET dans `{channel}.log`.
 * stdout / journald restent un autre handler, branché à part.
 */
export function createLogFileStream(options: LogFileStreamOptions): pino.DestinationStream {
  mkdirSync(options.dir, { recursive: true });
  const destOpts = { mkdir: true as const, sync: options.sync ?? false };
  // The descriptor is opened HERE, synchronously, in append mode; only the
  // writes stay asynchronous. Given a path, sonic-boom opens it later: a
  // process that exits before that (a script that stops early, measured on
  // `tests/integration/agency-workspaces.ts`) made pino's exit flush throw
  // « sonic boom is not ready yet » and turned a clean exit 0 into a crash.
  const open = options.createDestination
    ?? ((path: string, opts: { mkdir: true; sync: boolean }) => pino.destination({ dest: openSync(path, "a"), sync: opts.sync }));
  const main = open(join(options.dir, `${options.env}.log`), destOpts);
  const byChannel = new Map<string, pino.DestinationStream>();

  const onError = (error: Error) => {
    process.stderr.write(`logger: écriture fichier: ${error.message}\n`);
  };
  if ("on" in main && typeof main.on === "function") main.on("error", onError);

  function destFor(channel: string): pino.DestinationStream {
    const existing = byChannel.get(channel);
    if (existing) return existing;
    const dest = open(join(options.dir, `${channel}.log`), destOpts);
    if ("on" in dest && typeof dest.on === "function") dest.on("error", onError);
    byChannel.set(channel, dest);
    return dest;
  }

  return {
    write(msg: string) {
      // Un log qui ne s'écrit pas ne doit JAMAIS casser la requête qui l'a
      // produit. Bun 1.4.0 l'a prouvé en production : pendant les secondes qui
      // suivent un redémarrage, sonic-boom n'a pas encore son descripteur
      // (`fd` à -1) et son `write` LÈVE, là où Node met en attente. L'exception
      // traversait pino, remontait le middleware de journalisation et sortait
      // en 500 sur des routes publiques, dont les pages légales liées depuis
      // les e-mails. Le repli est celui de `onError` : stderr, donc journald.
      try {
        main.write(msg);
        destFor(channelFromLine(msg.trim())).write(msg);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

/** Ouvre les fichiers, ou `undefined` si le disque refuse (stdout continue). */
export function tryCreateLogFileStream(options: LogFileStreamOptions): pino.DestinationStream | undefined {
  try {
    return createLogFileStream(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`logger: fichiers de log indisponibles: ${message}\n`);
    return undefined;
  }
}

export function logFilesEnabled(): boolean {
  if (process.env.OPENEDBOT_LOG_TO_FILES === "0") return false;
  if (process.env.OPENEDBOT_LOG_TO_FILES === "1") return true;
  return true;
}
