import { createHash } from "node:crypto";
import { isUuid } from "@openedbot/contracts-primitives";
import type { RoutineRunAcceptedDto } from "@openedbot/contracts-api";
import type { TransactionDb } from "@openedbot/platform-db";
import { HttpError } from "../../interfaces/http/http-error";

/**
 * The idempotent manual run of a routine (`POST /api/routines/:routineId/runs`): its
 * request hash, its ingress row in `message_ingress`, and the replay of an
 * accepted run under the same key.
 */
type RoutineRunIngressRow = {
  id: string;
  requestHash: string;
  state: "reserved" | "completed" | "abandoned";
  messageId: string;
  runId: string;
  workflowId: string;
  responseStatus: number | null;
  responseBody: unknown;
};

export function canonicalRoutineRunHash(routineId: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ operation: "routine.run.create", routineId }))
    .digest("hex");
}

export function readRoutineRunRoutineId(value: string): string {
  if (!isUuid(value)) {
    throw new HttpError(400, "ROUTINE_ID_INVALID", "L’identifiant de routine est invalide.");
  }
  return value.toLowerCase();
}

export function readRoutineRunIngress(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  key: string,
  lock: boolean,
): Promise<RoutineRunIngressRow | null> {
  const query = lock
    ? tx<RoutineRunIngressRow[]>`
        select id, request_hash as "requestHash", state, message_id as "messageId",
               run_id as "runId", workflow_id as "workflowId",
               response_status as "responseStatus", response_body as "responseBody"
          from message_ingress
         where organization_id = ${organizationId} and user_id = ${userId}
           and operation = 'routine.run.create' and idempotency_key = ${key}
         for update
      `
    : tx<RoutineRunIngressRow[]>`
        select id, request_hash as "requestHash", state, message_id as "messageId",
               run_id as "runId", workflow_id as "workflowId",
               response_status as "responseStatus", response_body as "responseBody"
          from message_ingress
         where organization_id = ${organizationId} and user_id = ${userId}
           and operation = 'routine.run.create' and idempotency_key = ${key}
      `;
  return query.then((rows) => rows[0] ?? null);
}

export function replayRoutineRun(
  row: RoutineRunIngressRow | null,
  requestHash: string,
): RoutineRunAcceptedDto | null {
  if (!row) return null;
  if (row.requestHash !== requestHash) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé a déjà lancé une autre routine.");
  }
  if (row.state !== "completed") return null;
  if (row.responseStatus !== 202 || !isRoutineRunAccepted(row.responseBody)) {
    throw new HttpError(409, "IDEMPOTENCY_RESPONSE_INVALID", "L’accusé mémorisé est incomplet.");
  }
  return { ...row.responseBody, duplicate: true };
}

export function routineRunInProgress(state: RoutineRunIngressRow["state"]): HttpError {
  return new HttpError(
    409,
    state === "abandoned" ? "IDEMPOTENCY_KEY_EXPIRED" : "IDEMPOTENCY_IN_PROGRESS",
    state === "abandoned"
      ? "Ce lancement a expiré; utilisez une nouvelle clé."
      : "Cette routine est déjà en cours de lancement.",
    state === "reserved" ? { "Retry-After": "2" } : {},
  );
}

function isRoutineRunAccepted(value: unknown): value is RoutineRunAcceptedDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Partial<RoutineRunAcceptedDto>;
  return body.accepted === true && typeof body.duplicate === "boolean" &&
    typeof body.routineId === "string" && typeof body.workflowId === "string" &&
    typeof body.runId === "string" && typeof body.threadId === "string" &&
    body.status === "queued" && typeof body.notificationEligible === "boolean" &&
    typeof body.workflowUpdatedAt === "string";
}
