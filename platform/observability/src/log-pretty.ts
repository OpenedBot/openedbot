import pinoPretty, { type PrettyOptions } from "pino-pretty";

/**
 * Transport pino-pretty de développement : une ligne lisible par entrée, sans
 * le bloc JSON que pino-pretty accole par défaut au message.
 *
 * - Une requête HTTP se lit `GET /api/bots 200 55ms`, le statut coloré selon
 *   sa classe (vert 2xx/3xx, jaune 4xx, rouge 5xx), puis les champs de
 *   corrélation en `clé=valeur` grisés : ils restent là pour un grep.
 * - Toute autre entrée se lit `message clé=valeur …` sur le même modèle.
 *
 * Le module vit dans son propre fichier parce que pino charge le transport
 * dans un worker : une fonction de format ne traverse pas la sérialisation
 * des options, le worker doit l'importer lui-même.
 */

/** Clés déjà rendues ailleurs sur la ligne, jamais répétées en `clé=valeur`. */
const RENDERED_KEYS = new Set(["level", "time", "pid", "hostname", "msg", "method", "path", "status", "durationMs"]);

type Colors = {
  green: (input: string) => string;
  yellow: (input: string) => string;
  red: (input: string) => string;
  gray: (input: string) => string;
  bold: (input: string) => string;
};

/** Couleurs neutres pour `NO_COLOR` et les tests. */
export const PLAIN_COLORS: Colors = {
  green: (input) => input,
  yellow: (input) => input,
  red: (input) => input,
  gray: (input) => input,
  bold: (input) => input,
};

function colorStatus(status: number, colors: Colors): string {
  const label = String(status);
  if (status >= 500) return colors.red(label);
  if (status >= 400) return colors.yellow(label);
  return colors.green(label);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatFields(log: Record<string, unknown>, colors: Colors): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(log)) {
    if (RENDERED_KEYS.has(key) || value === undefined) continue;
    if (key === "event" && value === log.msg) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.length > 0 ? colors.gray(parts.join(" ")) : "";
}

/**
 * Rend la ligne complète après le niveau. Exportée pour être testable sans
 * worker ni flux : c'est elle qui décide de ce qu'un humain lit.
 */
export function formatLogLine(log: Record<string, unknown>, messageKey = "msg", colors: Colors = PLAIN_COLORS): string {
  const message = typeof log[messageKey] === "string" ? (log[messageKey] as string) : "";
  const fields = formatFields(log, colors);
  if (message === "http request" && typeof log.status === "number") {
    const head = `${colors.bold(String(log.method ?? "?"))} ${String(log.path ?? "?")} ${colorStatus(log.status, colors)} ${String(log.durationMs ?? "?")}ms`;
    return fields ? `${head}  ${fields}` : head;
  }
  return fields ? `${message}  ${fields}` : message;
}

export default function transport(options: PrettyOptions) {
  return pinoPretty({
    ...options,
    // Le bloc JSON est remplacé par `formatLogLine`. Sans `singleLine`, pino-pretty
    // termine bien la ligne (avec, il compte sur le bloc JSON pour le faire).
    hideObject: true,
    singleLine: false,
    // Pas de cyan sur tout le message : les couleurs sont posées par champ.
    // Les niveaux sont redits en entier : dès que `customColors` est posé,
    // pino-pretty perd sa palette par défaut et passe tout en blanc.
    customColors: "fatal:bgRed,error:red,warn:yellow,info:green,debug:blue,trace:gray,message:reset",
    messageFormat: (log, messageKey, _levelLabel, { colors }) =>
      formatLogLine(log as Record<string, unknown>, messageKey, options.colorize === false ? PLAIN_COLORS : colors),
  });
}
