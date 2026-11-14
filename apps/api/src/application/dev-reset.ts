import type { SQL } from "bun";

/**
 * Replay the empty welcome, in development ONLY: the local database loses
 * its application data, but keeps the « partie utilisateur »: one stays
 * signed in without signing in again.
 *
 * Two paths call it, and this list is the only one that exists:
 * `POST /api/onboarding/reset` with `{"scope":"full"}`
 * (`routes/overview/misc-routes.ts`) and `make db-reset-keep-users`
 * (`apps/api/scripts/dev-reset-data.ts`).
 */

/**
 * What the wipe does NOT touch. Each line is a reason, not a
 * preference:
 *
 * - `users`, `memberships`, `sessions`: the current session lives there.
 *   `sessions` carries an FK `(organization_id, user_id)` toward `memberships`,
 *   and authentication resolves the organization through that join: emptying
 *   `memberships` or `organizations` signs the person out, which the request
 *   explicitly forbids.
 * - `organizations`: the ROW stays (the sessions depend on it); only
 *   `onboarding` and `onboarded_at` are set back to NULL, further down.
 * - `staff_users`, `staff_sessions`: tables of the core schema that only a
 *   plug-in writes; `sessions.impersonated_by_staff_user_id` references
 *   `staff_users`, so truncating it would cascade into the kept sessions.
 * - `schema_migrations`: emptying it would replay every migration.
 * - `subscriptions`: the subscription is the ACCOUNT's state, not a product of
 *   the welcome. In development `BILLING_ENFORCED` is false by default and
 *   the absence of a subscription degrades to « illimité » (`@openedbot/identity/domain/entitlement`,
 *   `member-routes.ts`, `conversation-routes.ts`): but with
 *   `BILLING_ENFORCED=true` in dev, losing the row returns 402/403 across the whole
 *   workspace and makes the new welcome unplayable, precisely. Recreating it here
 *   would duplicate the plan values of `apps/api/scripts/seed.ts`; it is
 *   kept, and it survives intact next to the preserved `organizations` row.
 * - `runtimes` and what attaches a runtime to its link (`runtime_audit_keys`,
 *   `runtime_audit_anchors`, `runtime_direct_exposures`,
 *   `runtime_review_profiles`): the dev machine stays linked. The VPS's
 *   connector keeps its link token; without the `runtimes` row, every
 *   reconnection would be refused until a new pairing, and the welcome's
 *   Configuration step thus finds the machine ready. These tables
 *   reference only `organizations`, `runtimes` and `users`, all kept:
 *   the cascade guard below checks it. The bots, profiles, routines and
 *   runs that reference them, for their part, are wiped.
 * - `api_instances`, `service_instances`: registries of the live PROCESSES
 *   (heartbeat, `runtimes.link_instance_id`), declared « tables
 *   d'exploitation, hors RLS tenant, aucun identifiant de client » by
 *   `migrations/0040_api_instances.sql`. Emptying them while `make dev`
 *   is running breaks connector-link routing until the next heartbeat.
 */
export const DEV_RESET_PRESERVED_TABLES: readonly string[] = [
  "users",
  "organizations",
  "memberships",
  "sessions",
  "staff_users",
  "staff_sessions",
  "schema_migrations",
  "subscriptions",
  "api_instances",
  "service_instances",
  "runtimes",
  "runtime_audit_keys",
  "runtime_audit_anchors",
  "runtime_direct_exposures",
  "runtime_review_profiles",
];

export const DEV_RESET_SCHEMA = "public";

/** Bare SQL identifier: nothing else is interpolated into a `truncate`. */
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Bun serializes a JS array as "a,b,c": Postgres refuses that literal for
 * a `text[]`. The literal is therefore built here, from bare identifiers
 * already validated: never a quote or a comma to escape.
 */
function pgTextArray(values: readonly string[]): string {
  const suspicious = values.filter((value) => !PLAIN_IDENTIFIER.test(value));
  if (suspicious.length > 0) {
    throw new Error(`Table au nom non citable, vidage refusé : ${suspicious.join(", ")}.`);
  }
  return `{${values.join(",")}}`;
}

const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1", "[::1]"];

export type DevResetReport = {
  truncatedTables: string[];
  preservedTables: string[];
  organizationsReset: number;
  usersReset: number;
};

/**
 * Guardrail. Two conditions, both necessary: the environment is
 * `development`, and the targeted database is local (local loopback). The
 * locality test is on the DSN's host, not on its name: a preprod DSN
 * named "openedbot" is refused, and `localhost` stays accepted.
 */
export function assertDevResetAllowed(input: { environment: string; databaseUrl: string }): void {
  if (input.environment !== "development") {
    throw new Error(`Le vidage de développement est refusé hors development (OPENEDBOT_ENV=${input.environment}).`);
  }
  let host: string;
  let database: string;
  try {
    const url = new URL(input.databaseUrl);
    host = url.hostname;
    database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("La DSN du vidage de développement est illisible.");
  }
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new Error(`Le vidage de développement est refusé hors base locale (hôte ${host}).`);
  }
  if (database === "" || !PLAIN_IDENTIFIER.test(database)) {
    throw new Error(`Le vidage de développement refuse le nom de base « ${database} ».`);
  }
  if (["postgres", "template0", "template1"].includes(database)) {
    throw new Error(`Le vidage de développement refuse la base système « ${database} ».`);
  }
}

/**
 * The list of tables to wipe is DERIVED from the real schema, never frozen: the
 * next migration that adds a table is wiped without anyone thinking about it, and
 * a renamed table does not leave a dead entry behind it.
 */
export async function resolveDevResetTables(sql: SQL): Promise<string[]> {
  const rows = await sql<Array<{ name: string }>>`
    select table_name as name from information_schema.tables
     where table_schema = ${DEV_RESET_SCHEMA}
       and table_type = 'BASE TABLE'
       and table_name <> all(${pgTextArray(DEV_RESET_PRESERVED_TABLES)}::text[])
     order by table_name
  `;
  const names = rows.map((row) => row.name);
  const suspicious = names.filter((name) => !PLAIN_IDENTIFIER.test(name));
  if (suspicious.length > 0) {
    throw new Error(`Table au nom non citable, vidage refusé : ${suspicious.join(", ")}.`);
  }
  return names;
}

/**
 * `truncate ... cascade` climbs toward the tables that REFERENCE a wiped
 * table. If a preserved table referenced a wiped table, the cascade would
 * wipe it in silence: the session would be lost without a word. It is checked
 * instead of hoped for.
 */
async function assertCascadeStaysAwayFromPreserved(sql: SQL, truncated: readonly string[]): Promise<void> {
  const rows = await sql<Array<{ child: string; parent: string }>>`
    select distinct c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
      from pg_constraint c
     where c.contype = 'f'
       and c.conrelid::regclass::text = any(${pgTextArray(DEV_RESET_PRESERVED_TABLES)}::text[])
       and c.confrelid::regclass::text = any(${pgTextArray(truncated)}::text[])
  `;
  if (rows.length > 0) {
    const pairs = rows.map((row) => `${row.child} -> ${row.parent}`).join(", ");
    throw new Error(`Une table préservée référence une table vidée, la cascade l'emporterait : ${pairs}.`);
  }
}

/**
 * The wipe itself, in one transaction. It takes NEITHER a user NOR an
 * organization: it is the entire local database that starts over from zero, exactly
 * like the `make` target. The welcome flag therefore falls back for every person
 * signed in, which `apps/console/src/lib/session/onboarding-gate.ts` reads as the only
 * trigger of the journey.
 */
export async function performDevDataReset(sql: SQL): Promise<DevResetReport> {
  const tables = await resolveDevResetTables(sql);
  await assertCascadeStaysAwayFromPreserved(sql, tables);
  return (await sql.begin(async (tx) => {
    if (tables.length > 0) {
      const list = tables.map((name) => `"${name}"`).join(", ");
      await tx.unsafe(`truncate table ${list} restart identity cascade`);
    }
    const organizations = await tx<Array<{ id: string }>>`
      update organizations set onboarding = null, onboarded_at = null, updated_at = now()
       where onboarding is not null or onboarded_at is not null
       returning id
    `;
    const users = await tx<Array<{ id: string }>>`
      update users set onboarding_completed = false, updated_at = now()
       where onboarding_completed returning id
    `;
    return {
      truncatedTables: tables,
      preservedTables: [...DEV_RESET_PRESERVED_TABLES],
      organizationsReset: organizations.length,
      usersReset: users.length,
    };
  })) as DevResetReport;
}
