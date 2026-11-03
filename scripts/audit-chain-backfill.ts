/**
 * Chains, in `audit_chain`, the creation-audit rows recorded before the
 * local hash chain existed (verdicts in arrival order, then the current
 * anchor). Append-only and idempotent: an already chained object key is
 * skipped, so a second run appends nothing.
 *
 *   DATABASE_URL=… bun scripts/audit-chain-backfill.ts <organization-id>:<runtime-id> […]
 *
 * Runs under the tenant context (`withTenant`), with the API role.
 */
import { createDatabase, withTenant } from "../platform/db/src/db";
import { backfillLocalChain } from "../modules/runtime-link/src/application/audit-chain";

const targets = process.argv.slice(2).map((argument) => {
  const [organizationId, runtimeId, extra] = argument.split(":");
  if (!organizationId || !runtimeId || extra !== undefined) throw new Error(`expected <organization-id>:<runtime-id>, got ${argument}`);
  return { organizationId, runtimeId };
});
if (targets.length === 0) {
  console.error("usage: bun scripts/audit-chain-backfill.ts <organization-id>:<runtime-id> […]");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDatabase(url, 1);
try {
  for (const { organizationId, runtimeId } of targets) {
    const appended = await withTenant(db, organizationId, (tx) => backfillLocalChain(tx, organizationId, runtimeId));
    console.log(JSON.stringify({ event: "audit_chain.backfill", organizationId, runtimeId, appended }));
  }
} finally {
  await db.close();
}
