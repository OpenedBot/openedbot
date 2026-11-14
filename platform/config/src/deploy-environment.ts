/**
 * Deployment tier named in every alert and shown to connectors. Several
 * deployments share one Discord channel and one VPS can serve a dev and a
 * prod openedbot at once: a line that does not say where it comes from is a line
 * nobody can act on.
 *
 * One setting says where a deployment runs: `OPENEDBOT_ENV`. `production`
 * means prod, `preprod` means preprod (production rules, preprod label),
 * `development` and `test` mean dev. Processes validate it at startup with
 * `readRuntimeEnvironment`, so by the time a label is derived the value is
 * one of those four (or absent).
 */
export type DeployEnvironment = "dev" | "preprod" | "prod";

export function deployEnvironment(openedbotEnv: string | undefined): DeployEnvironment {
  const value = openedbotEnv?.trim();
  if (value === "production") return "prod";
  if (value === "preprod") return "preprod";
  return "dev";
}

/** `preprod` runs on production rules: every production guard applies. */
export function isProductionEnvironment(openedbotEnv: string | undefined): boolean {
  const value = openedbotEnv?.trim();
  return value === "production" || value === "preprod";
}

/** Execution rules a process runs on; `preprod` runs on `production` rules. */
export type RuntimeEnvironment = "development" | "test" | "production";

const ENVIRONMENT_VALUES = ["development", "test", "production", "preprod"] as const;

/**
 * Reads `OPENEDBOT_ENV` (or the fallback a process allows) at startup. Absent
 * or empty means development. Any other value refuses to start: a typo such
 * as `prod` must not silently drop every production guard.
 */
export function readRuntimeEnvironment(value: string | undefined, name = "OPENEDBOT_ENV"): RuntimeEnvironment {
  const trimmed = value?.trim();
  if (!trimmed) return "development";
  if (!(ENVIRONMENT_VALUES as readonly string[]).includes(trimmed)) {
    throw new Error(`${name} must be one of ${ENVIRONMENT_VALUES.join(", ")} (got "${trimmed}").`);
  }
  return isProductionEnvironment(trimmed) ? "production" : (trimmed as "development" | "test");
}
