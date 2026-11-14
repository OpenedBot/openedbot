/**
 * Everything a bot e2e run reads from the environment and the command line,
 * read once. A scenario never reads `process.env` itself.
 */
import { parseArgs } from "node:util";

export type E2eConfig = {
  apiUrl: string;
  databaseUrl: string;
  auditDatabaseUrl: string | null;
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
  /** Manual diagnostics only; bounded pause before failed-case profile cleanup. */
  failureInspectionMs: number;
  cleanupTimeoutMs: number;
  outDir: string;
  expectedRuntimeId: string | null;
  strict: boolean;
  fixtureOrigin: string | null;
  fixturePort: number;
  fixtureBind: string;
  recoveryCommand: string[] | null;
  mcpFixtureCommand: string[] | null;
  browserFixtureCommand: string[] | null;
  browserTarget: "runtime" | "computer";
  exclusiveRuntime: boolean;
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
      strict: { type: "boolean", default: false },
    },
  });
  if (env.E2E_ALLOW_REAL_RUNS !== "1") {
    throw new ConfigError("These scenarios run a real model on the linked runtime: set E2E_ALLOW_REAL_RUNS=1.");
  }
  const databaseUrl = env.WORKER_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError("WORKER_DATABASE_URL must be set (make loads .env.local).");
  const apiUrl = (env.E2E_API_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
  const parsed = new URL(apiUrl);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/"
    || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))) {
    throw new ConfigError("E2E_API_URL must be an HTTPS or loopback HTTP origin without credentials.");
  }
  const fixtureOrigin = env.E2E_FIXTURE_ORIGIN?.trim() || null;
  if (fixtureOrigin) {
    const origin = new URL(fixtureOrigin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
      throw new ConfigError("E2E_FIXTURE_ORIGIN must be an explicit HTTP(S) origin without credentials.");
    }
  }
  const fixturePort = positive(env.E2E_FIXTURE_PORT, 18871, "E2E_FIXTURE_PORT");
  if (fixturePort > 65535) throw new ConfigError("E2E_FIXTURE_PORT must be <= 65535.");
  const browserTarget = env.E2E_BROWSER_TARGET ?? "runtime";
  if (browserTarget !== "runtime" && browserTarget !== "computer") throw new ConfigError("E2E_BROWSER_TARGET must be runtime or computer.");
  let recoveryCommand: string[] | null = null;
  if (env.E2E_RECOVERY_ARGV) {
    const argv: unknown = JSON.parse(env.E2E_RECOVERY_ARGV);
    if (env.E2E_ALLOW_RUNTIME_FAULTS !== "1" || !Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== "string" || !arg)) {
      throw new ConfigError("E2E_RECOVERY_ARGV requires a nonempty string array and E2E_ALLOW_RUNTIME_FAULTS=1.");
    }
    recoveryCommand = argv;
  }
  let mcpFixtureCommand: string[] | null = null;
  if (env.E2E_MCP_FIXTURE_ARGV) {
    let argv: unknown;
    try { argv = JSON.parse(env.E2E_MCP_FIXTURE_ARGV); } catch {
      throw new ConfigError("E2E_MCP_FIXTURE_ARGV must be an explicit JSON argv array.");
    }
    if (env.E2E_ALLOW_LAB_FIXTURES !== "1" || !Array.isArray(argv) || !argv.length
      || argv.some((arg) => typeof arg !== "string" || !arg)) {
      throw new ConfigError("E2E_MCP_FIXTURE_ARGV requires a nonempty string array and E2E_ALLOW_LAB_FIXTURES=1.");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(env.E2E_RUNTIME_ID ?? "")) {
      throw new ConfigError("E2E_MCP_FIXTURE_ARGV requires an explicit canonical E2E_RUNTIME_ID UUID.");
    }
    mcpFixtureCommand = argv;
  }
  let browserFixtureCommand: string[] | null = null;
  if (env.E2E_BROWSER_FIXTURE_ARGV) {
    let argv: unknown;
    try { argv = JSON.parse(env.E2E_BROWSER_FIXTURE_ARGV); } catch {
      throw new ConfigError("E2E_BROWSER_FIXTURE_ARGV must be an explicit JSON argv array.");
    }
    if (env.E2E_ALLOW_LAB_FIXTURES !== "1" || !Array.isArray(argv) || !argv.length
      || argv.some((arg) => typeof arg !== "string" || !arg)) {
      throw new ConfigError("E2E_BROWSER_FIXTURE_ARGV requires a nonempty string array and E2E_ALLOW_LAB_FIXTURES=1.");
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(env.E2E_RUNTIME_ID ?? "")) {
      throw new ConfigError("E2E_BROWSER_FIXTURE_ARGV requires an explicit canonical E2E_RUNTIME_ID UUID.");
    }
    browserFixtureCommand = argv;
  }
  const failureInspectionMs = Number(env.E2E_FAILURE_INSPECTION_MS ?? 0);
  if (!Number.isInteger(failureInspectionMs) || failureInspectionMs < 0 || failureInspectionMs > 120_000) {
    throw new ConfigError("E2E_FAILURE_INSPECTION_MS must be an integer from 0 through 120000.");
  }
  const label = (values.label ?? env.E2E_LABEL ?? "run").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "run";
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const locale = (values.locale ?? env.E2E_LOCALE) === "en" ? "en" : "fr";
  return {
    apiUrl,
    databaseUrl,
    auditDatabaseUrl: env.E2E_AUDIT_DATABASE_URL ?? env.API_DATABASE_URL ?? null,
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
    failureInspectionMs,
    runTimeoutMs: positive(env.E2E_RUN_TIMEOUT_MS, 180_000, "E2E_RUN_TIMEOUT_MS"),
    // The host cleanup re-checks deleted sessions 60 s later, up to 5 times.
    cleanupTimeoutMs: positive(env.E2E_CLEANUP_TIMEOUT_MS, 420_000, "E2E_CLEANUP_TIMEOUT_MS"),
    outDir: values.out ?? `tmp/e2e-bot/${stamp}-${label}`,
    expectedRuntimeId: env.E2E_RUNTIME_ID || null,
    strict: values.strict === true || env.E2E_STRICT === "1",
    fixtureOrigin: fixtureOrigin?.replace(/\/$/, "") ?? null,
    fixturePort,
    fixtureBind: env.E2E_FIXTURE_BIND?.trim() || "127.0.0.1",
    recoveryCommand,
    mcpFixtureCommand,
    browserFixtureCommand,
    browserTarget,
    exclusiveRuntime: env.E2E_LAB_EXCLUSIVE === "1",
  };
}
