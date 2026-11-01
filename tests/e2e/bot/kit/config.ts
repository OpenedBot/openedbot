/**
 * Everything a bot e2e run reads from the environment and the command line,
 * read once. A scenario never reads `process.env` itself.
 */
import { parseArgs } from "node:util";

export type E2eConfig = {
  apiUrl: string;
  databaseUrl: string;
  scenarios: string[];
  label: string;
  samples: number;
  messages: number;
  keep: boolean;
  purgeEarly: boolean;
  /** Bench only: purge every bot at the end of the scenario, in parallel, instead of after each sample. */
  deferCleanup: boolean;
  locale: "fr" | "en";
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  runTimeoutMs: number;
  cleanupTimeoutMs: number;
  outDir: string;
};

export class ConfigError extends Error {}

const positive = (raw: string | undefined, fallback: number, name: string): number => {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${name} must be a positive integer, got "${raw}".`);
  return value;
};

export function readConfig(argv: string[], env: Record<string, string | undefined>, now = new Date()): E2eConfig {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      samples: { type: "string" },
      messages: { type: "string" },
      label: { type: "string" },
      out: { type: "string" },
      keep: { type: "boolean", default: false },
      "purge-early": { type: "boolean", default: false },
      "defer-cleanup": { type: "boolean", default: false },
      locale: { type: "string" },
    },
  });
  if (env.E2E_ALLOW_REAL_RUNS !== "1") {
    throw new ConfigError("These scenarios run a real model on the linked runtime: set E2E_ALLOW_REAL_RUNS=1.");
  }
  const databaseUrl = env.WORKER_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError("WORKER_DATABASE_URL must be set (make loads .env.local).");
  const apiUrl = (env.E2E_API_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
  const parsed = new URL(apiUrl);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigError("E2E_API_URL must not carry credentials, a query or a fragment.");
  }
  const label = (values.label ?? env.E2E_LABEL ?? "run").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "run";
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const locale = (values.locale ?? env.E2E_LOCALE) === "en" ? "en" : "fr";
  return {
    apiUrl,
    databaseUrl,
    scenarios: positionals.length ? positionals : ["lifecycle"],
    label,
    samples: positive(values.samples ?? env.E2E_SAMPLES, 3, "--samples"),
    messages: positive(values.messages ?? env.E2E_MESSAGES, 5, "--messages"),
    keep: values.keep === true || env.E2E_KEEP_BOT === "1",
    purgeEarly: values["purge-early"] === true,
    deferCleanup: values["defer-cleanup"] === true,
    locale,
    provider: env.E2E_PROVIDER || null,
    model: env.E2E_MODEL || null,
    reasoningEffort: env.E2E_REASONING_EFFORT || null,
    runTimeoutMs: positive(env.E2E_RUN_TIMEOUT_MS, 180_000, "E2E_RUN_TIMEOUT_MS"),
    // The host cleanup re-checks deleted sessions 60 s later, up to 5 times.
    cleanupTimeoutMs: positive(env.E2E_CLEANUP_TIMEOUT_MS, 420_000, "E2E_CLEANUP_TIMEOUT_MS"),
    outDir: values.out ?? `tmp/e2e-bot/${stamp}-${label}`,
  };
}
