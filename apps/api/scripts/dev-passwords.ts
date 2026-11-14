import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Development passwords are never versioned. `make setup` writes them to the
 * env file; when one is still missing, the seed generates it here, stores it
 * in the same private file (chmod 600) and only ever prints WHERE it is.
 */
export const DEV_PASSWORD_VARIABLES = ["E2E_PASSWORD"] as const;
export type DevPasswordVariable = (typeof DEV_PASSWORD_VARIABLES)[number];

/** 24 random bytes, base64url: 32 characters, no shell-hostile symbols. */
export function generateDevPassword(): string {
  return randomBytes(24).toString("base64url");
}

/** The env file `make` loaded: ENV_FILE when set, else the repository's .env.local. */
export function devEnvFilePath(env: Record<string, string | undefined>, repoRoot: string): string {
  return resolve(repoRoot, env.ENV_FILE?.trim() || ".env.local");
}

/** Sets NAME=value in an env-file body, replacing an existing (even empty) line. */
export function upsertEnvLine(body: string, name: string, value: string): string {
  const lines = body.length ? body.replace(/\n$/u, "").split("\n") : [];
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (index >= 0) lines[index] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Fills every missing development password in `env` (mutated) and persists the
 * generated ones to `envFile`. Returns the names that were generated.
 */
export function ensureDevPasswords(
  env: Record<string, string | undefined>,
  envFile: string,
  generate: () => string = generateDevPassword,
): DevPasswordVariable[] {
  const generated: DevPasswordVariable[] = [];
  let body = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  for (const name of DEV_PASSWORD_VARIABLES) {
    if (env[name]) continue;
    const value = generate();
    env[name] = value;
    body = upsertEnvLine(body, name, value);
    generated.push(name);
  }
  if (generated.length > 0) {
    writeFileSync(envFile, body, { mode: 0o600 });
    chmodSync(envFile, 0o600);
  }
  return generated;
}
