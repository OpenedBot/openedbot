#!/usr/bin/env bun
import { SQL } from "bun";
import {
  assertDevResetAllowed,
  DEV_RESET_PRESERVED_TABLES,
  performDevDataReset,
} from "../src/application/dev-reset";

/**
 * Jumeau terminal de `POST /api/onboarding/reset {"scope":"full"}`, appelé par
 * `make db-reset-keep-users CONFIRM=yes`. Il n'a AUCUNE liste à lui : tout
 * vient de `src/application/dev-reset.ts`, comme la route.
 *
 * La DSN doit pouvoir `truncate` : `ohb_api` ne le peut pas (il ne possède pas
 * les tables et n'a pas `delete` sur les tables append-only). À défaut de
 * `DEV_RESET_DATABASE_URL`, on la reconstruit depuis le conteneur PostgreSQL
 * partagé, exactement comme `scripts/db.sh` qui s'y exécute en `$POSTGRES_USER`.
 */

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function resolveDatabaseUrl(): Promise<string> {
  const explicit = process.env.DEV_RESET_DATABASE_URL?.trim();
  if (explicit) return explicit;

  const container = process.env.OHB_POSTGRES_CONTAINER?.trim() || "infra-postgres";
  const database = process.env.OHB_DATABASE_NAME?.trim() || "ohb";
  const port = process.env.OHB_POSTGRES_PORT?.trim() || "5432";
  const probe = Bun.spawnSync([
    "docker",
    "exec",
    container,
    "sh",
    "-ceu",
    'printf "%s\n%s\n" "$POSTGRES_USER" "$POSTGRES_PASSWORD"',
  ]);
  if (probe.exitCode !== 0) {
    fail(
      `Impossible de lire les identifiants du conteneur ${container}. ` +
        "Démarrez-le (make db-up) ou fournissez DEV_RESET_DATABASE_URL.",
    );
  }
  const [user, password] = new TextDecoder().decode(probe.stdout).split("\n");
  if (!user || !password) {
    fail(`Le conteneur ${container} n'expose pas POSTGRES_USER/POSTGRES_PASSWORD ; fournissez DEV_RESET_DATABASE_URL.`);
  }
  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${credentials}@127.0.0.1:${port}/${database}`;
}

if (process.env.OHB_DEV_RESET_CONFIRM !== "yes") {
  fail(
    "Refus : le vidage supprime les données applicatives locales. " +
      "Relancez avec `make db-reset-keep-users CONFIRM=yes`.",
  );
}

const environment = (process.env.OHB_ENV ?? process.env.NODE_ENV ?? "development").trim();
const databaseUrl = await resolveDatabaseUrl();
try {
  assertDevResetAllowed({ environment, databaseUrl });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const sql = new SQL({ url: databaseUrl, max: 1 });
try {
  const report = await performDevDataReset(sql);
  process.stdout.write(
    `Vidées (${report.truncatedTables.length}) : ${report.truncatedTables.join(", ")}\n` +
      `Préservées (${DEV_RESET_PRESERVED_TABLES.length}) : ${report.preservedTables.join(", ")}\n` +
      `Accueil remis à zéro : ${report.organizationsReset} espace(s), ${report.usersReset} personne(s).\n`,
  );
} finally {
  await sql.close();
}
