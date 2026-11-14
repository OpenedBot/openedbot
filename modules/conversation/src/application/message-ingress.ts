import { isRecord, isStrictUuid } from "@openedbot/contracts-primitives";
import { createHash } from "node:crypto";
import { attachmentPayload, type MessageAttachmentInput } from "../domain/attachments";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "@openedbot/contracts-errors/http-error";

// Seules l'organisation et l'utilisateur de la session servent ici : le module
// ne lit pas le type AuthContext de l'API, qu'il ne peut pas importer.
type IngressAuth = { organizationId: string; userId: string };

const RESERVATION_SECONDS = 120;

export type IngressAttachment = {
  id: string;
  key: string;
  name: string;
  contentType: string;
  kind: MessageAttachmentInput["kind"];
  bytes: number;
  sha256: string;
};

export type MessageIngressReservation = {
  id: string;
  owner: string;
  epoch: number;
  messageId: string;
  runId: string;
  workflowId: string;
  attachments: IngressAttachment[];
};

export type MessageIngressResult =
  | { kind: "reserved"; reservation: MessageIngressReservation }
  | { kind: "replay"; status: number; body: Record<string, unknown> };

type IngressRow = {
  id: string;
  requestHash: string;
  state: "reserved" | "completed" | "abandoned";
  reservationOwner: string | null;
  reservationEpoch: string | number;
  reservationLeaseExpiresAt: Date | string | null;
  expiresAt: Date | string;
  messageId: string;
  runId: string;
  workflowId: string;
  attachmentManifest: unknown;
  responseStatus: number | null;
  responseBody: unknown;
};

export function readIdempotencyKey(value: string | undefined): string | null {
  const key = value?.trim();
  if (!key) return null;
  if (!isStrictUuid(key)) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key doit être un UUID.");
  }
  return key.toLowerCase();
}

export function canonicalMessageHash(
  input: string,
  attachments: readonly MessageAttachmentInput[],
  options: { replyToId?: string | null; planOnly?: boolean } = {},
): string {
  const normalized = {
    input: input.trim(),
    replyToId: options.replyToId ?? null,
    // Only when asked: the hash of an ordinary message stays what it was.
    ...(options.planOnly ? { planOnly: true } : {}),
    attachments: attachments.map((attachment) => {
      const payload = attachmentPayload(attachment);
      return {
        name: attachment.name,
        contentType: attachment.contentType.toLowerCase(),
        kind: attachment.kind,
        bytes: payload.data.byteLength,
        sha256: createHash("sha256").update(payload.data).digest("hex"),
      };
    }),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export async function reserveMessageIngress(input: {
  db: Db;
  auth: IngressAuth;
  threadId: string;
  key: string;
  requestHash: string;
  attachments: readonly MessageAttachmentInput[];
  objectKey: (attachmentId: string) => string;
}): Promise<MessageIngressResult> {
  const owner = `api:${crypto.randomUUID()}`;
  const ingressId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();
  const manifest = input.attachments.map<IngressAttachment>((attachment) => {
    const payload = attachmentPayload(attachment);
    const id = crypto.randomUUID();
    return {
      id,
      key: input.objectKey(id),
      name: attachment.name,
      contentType: attachment.contentType,
      kind: attachment.kind,
      bytes: payload.data.byteLength,
      sha256: createHash("sha256").update(payload.data).digest("hex"),
    };
  });

  return withTenant(input.db, input.auth.organizationId, async (tx) => {
    // Validate the tenant-scoped parent before the insert so a malformed or
    // cross-tenant thread id returns the public 404 contract instead of leaking
    // a raw composite-FK failure. The short key-share lock also closes the
    // deletion race for the duration of this reservation transaction.
    const threads = await tx<Array<{ id: string }>>`
      select id from threads
       where organization_id = ${input.auth.organizationId} and id = ${input.threadId}
       for key share
    `;
    if (!threads[0]) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");

    const inserted = await tx<Array<{ id: string }>>`
      insert into message_ingress (
        id, organization_id, user_id, thread_id, operation, idempotency_key, request_hash,
        message_id, run_id, workflow_id, attachment_manifest, state,
        reservation_owner, reservation_lease_expires_at, expires_at
      ) values (
        ${ingressId}, ${input.auth.organizationId}, ${input.auth.userId}, ${input.threadId},
        'thread.message.create', ${input.key}, ${input.requestHash},
        ${messageId}, ${runId}, ${workflowId}, ${manifest}, 'reserved',
        ${owner}, now() + (${RESERVATION_SECONDS} * interval '1 second'), now() + interval '24 hours'
      )
      on conflict (organization_id, user_id, operation, idempotency_key) do nothing
      returning id
    `;
    let row = (await readIngress(tx, input.auth, input.threadId, input.key, true))[0];
    if (!row) throw new HttpError(404, "THREAD_NOT_FOUND", "Conversation introuvable.");
    if (row.requestHash !== input.requestHash) {
      throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé a déjà été utilisée avec un autre message.");
    }
    if (row.state === "completed") {
      if (!isRecord(row.responseBody) || !row.responseStatus) {
        throw new HttpError(409, "IDEMPOTENCY_RESPONSE_INVALID", "La réponse mémorisée est incomplète.");
      }
      return { kind: "replay", status: row.responseStatus, body: row.responseBody };
    }
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      throw new HttpError(409, "IDEMPOTENCY_KEY_EXPIRED", "Cette soumission a expiré; utilisez une nouvelle clé.");
    }

    if (!inserted[0]) {
      const leaseExpired = !row.reservationLeaseExpiresAt ||
        new Date(row.reservationLeaseExpiresAt).getTime() <= Date.now();
      if (!leaseExpired && row.reservationOwner !== owner) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_IN_PROGRESS",
          "Cette soumission est déjà en cours de traitement.",
          { "Retry-After": "2" },
        );
      }
      const claimed = await tx<IngressRow[]>`
        update message_ingress set state = 'reserved', reservation_owner = ${owner},
          reservation_epoch = reservation_epoch + 1,
          reservation_lease_expires_at = now() + (${RESERVATION_SECONDS} * interval '1 second'), updated_at = now()
         where id = ${row.id} and organization_id = ${input.auth.organizationId}
           and state in ('reserved','abandoned')
           and (reservation_owner = ${owner} or reservation_lease_expires_at is null or reservation_lease_expires_at <= now())
         returning request_hash as "requestHash", state, reservation_owner as "reservationOwner",
           reservation_epoch as "reservationEpoch", reservation_lease_expires_at as "reservationLeaseExpiresAt", expires_at as "expiresAt",
           id, message_id as "messageId", run_id as "runId", workflow_id as "workflowId",
           attachment_manifest as "attachmentManifest", response_status as "responseStatus", response_body as "responseBody"
      `;
      row = claimed[0];
      if (!row) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_IN_PROGRESS",
          "Cette soumission est déjà en cours de traitement.",
          { "Retry-After": "2" },
        );
      }
    }
    const savedManifest = parseManifest(row.attachmentManifest);
    if (savedManifest.length !== input.attachments.length) {
      throw new HttpError(409, "IDEMPOTENCY_MANIFEST_INVALID", "Le manifeste de la soumission est incohérent.");
    }
    return {
      kind: "reserved",
      reservation: {
        id: row.id,
        owner,
        epoch: Number(row.reservationEpoch),
        messageId: row.messageId,
        runId: row.runId,
        workflowId: row.workflowId,
        attachments: savedManifest,
      },
    };
  });
}

export async function completeMessageIngressTx(
  tx: TransactionDb,
  organizationId: string,
  reservation: MessageIngressReservation,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  const rows = await tx<Array<{ id: string }>>`
    update message_ingress set state = 'completed', response_status = ${status}, response_body = ${body},
      completed_at = now(), reservation_owner = null, reservation_lease_expires_at = null,
      expires_at = now() + interval '7 days', updated_at = now()
     where id = ${reservation.id} and organization_id = ${organizationId}
       and state = 'reserved' and reservation_owner = ${reservation.owner}
       and reservation_epoch = ${reservation.epoch} and reservation_lease_expires_at > now()
     returning id
  `;
  if (!rows[0]) throw new HttpError(409, "IDEMPOTENCY_LEASE_LOST", "La réservation a expiré avant la validation.");
}

export async function readMessageIngressStatus(input: {
  db: Db;
  auth: IngressAuth;
  threadId: string;
  key: string;
}): Promise<Record<string, unknown>> {
  return withTenant(input.db, input.auth.organizationId, async (tx) => {
    const row = (await readIngress(tx, input.auth, input.threadId, input.key, false))[0];
    if (!row) throw new HttpError(404, "SUBMISSION_NOT_FOUND", "Soumission introuvable.");
    // L'id réservé n'est qu'une option : un DM simple ne crée aucun workflow,
    // et une réponse validée fait foi.
    const completed = row.state === "completed" && isRecord(row.responseBody) ? row.responseBody : null;
    return {
      state: row.state,
      runId: row.runId,
      workflowId: completed ? completed.workflowId ?? null : row.workflowId,
      response: row.state === "completed" ? row.responseBody : null,
      expiresAt: new Date(row.expiresAt).toISOString(),
    };
  });
}

function readIngress(
  tx: TransactionDb,
  auth: IngressAuth,
  threadId: string,
  key: string,
  lock: boolean,
): Promise<IngressRow[]> {
  return lock
    ? tx<IngressRow[]>`
        select id, request_hash as "requestHash", state, reservation_owner as "reservationOwner",
          reservation_epoch as "reservationEpoch", reservation_lease_expires_at as "reservationLeaseExpiresAt", expires_at as "expiresAt",
          message_id as "messageId", run_id as "runId", workflow_id as "workflowId",
          attachment_manifest as "attachmentManifest", response_status as "responseStatus", response_body as "responseBody"
          from message_ingress
         where organization_id = ${auth.organizationId} and user_id = ${auth.userId}
           and thread_id = ${threadId} and operation = 'thread.message.create' and idempotency_key = ${key}
         for update
      `
    : tx<IngressRow[]>`
        select id, request_hash as "requestHash", state, reservation_owner as "reservationOwner",
          reservation_epoch as "reservationEpoch", reservation_lease_expires_at as "reservationLeaseExpiresAt", expires_at as "expiresAt",
          message_id as "messageId", run_id as "runId", workflow_id as "workflowId",
          attachment_manifest as "attachmentManifest", response_status as "responseStatus", response_body as "responseBody"
          from message_ingress
         where organization_id = ${auth.organizationId} and user_id = ${auth.userId}
           and thread_id = ${threadId} and operation = 'thread.message.create' and idempotency_key = ${key}
      `;
}

function parseManifest(value: unknown): IngressAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is IngressAttachment =>
    isRecord(item) && typeof item.id === "string" && typeof item.key === "string" &&
    typeof item.name === "string" && typeof item.contentType === "string" &&
    (item.kind === "image" || item.kind === "document") && typeof item.bytes === "number" &&
    typeof item.sha256 === "string");
}
