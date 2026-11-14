import type { TransactionDb } from "@openedbot/platform-db";

/** What other packages call here; the SQL file stays private to the module. */
export { consumeRuntimeEnrollment, purgeStaleRuntimeEnrollments } from "../sql/runtime-enrollments";

/**
 * Historical rows may still say `direct` while an old migration drains. No
 * route in this module can create or complete such a row anymore.
 */
export type EnrollmentRow = {
  id: string;
  reachability: "direct" | "connector";
  endpoint: string | null;
  runtimeName: string;
  verificationCode: string;
  organizationId: string | null;
  claimedAt: Date | null;
  consumedAt: Date | null;
  runtimeId: string | null;
  expiresAt: Date;
};

/** Migration-compatible reader used by the connector WebSocket handshake. */
export function readEnrollmentRow(tx: TransactionDb, secretHash: string) {
  return tx<EnrollmentRow[]>`
    select id, reachability, endpoint, runtime_name as "runtimeName", verification_code as "verificationCode",
           organization_id as "organizationId", claimed_at as "claimedAt", consumed_at as "consumedAt",
           runtime_id as "runtimeId", expires_at as "expiresAt"
      from runtime_enrollments
     where secret_hash = ${secretHash}
     limit 1
  `;
}

export type EnrollmentState = "pending" | "claimed" | "completed" | "expired";

export function enrollmentState(row: Pick<EnrollmentRow, "consumedAt" | "expiresAt" | "claimedAt">): EnrollmentState {
  if (row.consumedAt) return "completed";
  if (row.expiresAt.getTime() <= Date.now()) return "expired";
  return row.claimedAt ? "claimed" : "pending";
}
