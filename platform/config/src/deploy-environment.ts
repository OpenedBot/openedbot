/**
 * Deployment tier named in every alert and shown to connectors. Several
 * deployments share one Discord channel and one VPS can serve a dev and a
 * prod openedbot at once: a line that does not say where it comes from is a line
 * nobody can act on.
 *
 * Explicit `OPENEDBOT_DEPLOY_ENV` wins; otherwise `OPENEDBOT_ENV=production` means prod
 * and anything else means dev. An unknown value fails loudly at startup.
 */
export type DeployEnvironment = "dev" | "preprod" | "prod";

export function deployEnvironment(explicit: string | undefined, ohbEnv: string | undefined): DeployEnvironment {
  const value = explicit?.trim().toLowerCase();
  if (value === "dev" || value === "preprod" || value === "prod") return value;
  if (value) throw new Error(`OPENEDBOT_DEPLOY_ENV must be dev, preprod or prod, got ${explicit}.`);
  return ohbEnv?.trim() === "production" ? "prod" : "dev";
}
