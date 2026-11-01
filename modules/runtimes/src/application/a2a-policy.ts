import { isStrictUuid } from "@openedbot/contracts-primitives";
import type { A2APolicyView, A2APolicyWriteStatus } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { assertClientMandate } from "./fleet";

export type A2APolicyScope = { userId: string; agencyId: string; clientId: string };
export type A2APolicyHostRead = () => Promise<A2APolicyView>;
export type A2APolicyHostWrite = () => Promise<A2APolicyWriteStatus>;

/**
 * Run one named host operation outside SQL, with the exact active runtime and
 * mandate checked both before and after the network call, including failures.
 */
export async function requestAgencyA2APolicyHost<T>(
  db: Db,
  scope: A2APolicyScope,
  runtimeId: string,
  request: () => Promise<T>,
): Promise<T> {
  requireScope(scope, runtimeId);
  await withTenant(db, scope.clientId, (tx) => authorizeRuntime(tx, scope, runtimeId));

  let result: T | undefined;
  let failed = false;
  try {
    result = await request();
  } catch {
    failed = true;
  }

  // This runs on both success and failure. A revocation masks host details.
  await withTenant(db, scope.clientId, (tx) => authorizeRuntime(tx, scope, runtimeId));
  if (failed) {
    throw new HttpError(502, "A2A_POLICY_UNAVAILABLE", "The runtime A2A policy operation could not be verified.");
  }
  return result as T;
}

export function readAgencyA2APolicy(
  db: Db,
  scope: A2APolicyScope,
  runtimeId: string,
  readHost: A2APolicyHostRead,
): Promise<A2APolicyView> {
  return requestAgencyA2APolicyHost(db, scope, runtimeId, readHost);
}

export function writeAgencyA2APolicy(
  db: Db,
  scope: A2APolicyScope,
  runtimeId: string,
  writeHost: A2APolicyHostWrite,
): Promise<A2APolicyWriteStatus> {
  return requestAgencyA2APolicyHost(db, scope, runtimeId, writeHost);
}

async function authorizeRuntime(tx: TransactionDb, scope: A2APolicyScope, runtimeId: string): Promise<void> {
  await assertClientMandate(tx, scope.userId, scope.clientId, scope.agencyId);
  const rows = await tx<Array<{ id: string }>>`
    select id from runtimes
    where organization_id = ${scope.clientId}::uuid and id = ${runtimeId}::uuid
      and is_active and revoked_at is null`;
  if (!rows[0]) {
    throw new HttpError(404, "A2A_POLICY_NO_RUNTIME", "This client has no active runtime.");
  }
  await assertClientMandate(tx, scope.userId, scope.clientId, scope.agencyId);
}

function requireScope(scope: A2APolicyScope, runtimeId: string): void {
  if (!isStrictUuid(scope.userId) || !isStrictUuid(scope.agencyId)
    || !isStrictUuid(scope.clientId) || !isStrictUuid(runtimeId)) {
    throw new HttpError(400, "A2A_POLICY_INPUT_INVALID", "The A2A policy scope is invalid.");
  }
}
