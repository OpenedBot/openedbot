/**
 * Deployment tier named in every alert and shown to connectors. Several
 * deployments share one Discord channel and one VPS can serve a dev and a
 * prod openedbot at once: a line that does not say where it comes from is a line
 * nobody can act on.
 *
 * One setting says where a deployment runs: `OPENEDBOT_ENV`. `production`
 * means prod, `preprod` means preprod (production rules, preprod label),
 * anything else means dev.
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
