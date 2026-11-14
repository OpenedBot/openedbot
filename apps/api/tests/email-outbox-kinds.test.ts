import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSACTIONAL_EMAIL_KINDS } from "@openedbot/contracts-api";

const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "db", "migrations");

/**
 * `email_outbox_kind_check` is the SQL TWIN of `TRANSACTIONAL_EMAIL_KINDS`,
 * and the two are costly when they diverge:
 *
 * - a kind added in TypeScript without its constraint NEVER enters the
 *   queue: the insert fails at the very moment of the fact that justifies it, and depending on
 *   the transaction the whole action falls;
 * - a kind left in the constraint without its template goes out as a render failure
 *   at the worker, for every recipient, until retries are exhausted.
 *
 * This test reads the LATEST migration that redefines the constraint: that is the one
 * that is authoritative on an up-to-date database, the earlier ones having been replaced.
 */
function lastKindConstraint(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  let latest: string | null = null;
  for (const name of files) {
    const sql = readFileSync(join(MIGRATIONS, name), "utf8");
    const match = /add constraint email_outbox_kind_check\s*check\s*\(kind in \(([^)]*)\)\)/i.exec(sql);
    if (match?.[1]) latest = match[1];
  }
  if (latest === null) throw new Error("aucune migration ne définit email_outbox_kind_check");
  return [...latest.matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1] as string);
}

/**
 * Kinds the constraint still allows although the core renders and enqueues
 * none of them: the staff back office and the support desk left the open
 * core, and dropping a kind from the constraint needs a migration (rows may
 * still sit in the outbox). The core never inserts them; a leftover row fails
 * at render with its reason. Shrink this list only with that migration.
 */
const PLUGIN_KINDS_LEFT_IN_CONSTRAINT = ["staff_account_created", "staff_login_code", "staff_password_reset", "support_new_conversation"];

describe("contrainte de genre d’email_outbox", () => {
  test("porte exactement les genres déclarés en TypeScript, plus ceux des plug-ins partis", () => {
    expect(lastKindConstraint().sort()).toEqual([...TRANSACTIONAL_EMAIL_KINDS, ...PLUGIN_KINDS_LEFT_IN_CONSTRAINT].sort());
  });

  test("aucun genre des plug-ins partis n’est un genre du cœur", () => {
    for (const kind of PLUGIN_KINDS_LEFT_IN_CONSTRAINT) expect((TRANSACTIONAL_EMAIL_KINDS as readonly string[]).includes(kind)).toBe(false);
  });
});
