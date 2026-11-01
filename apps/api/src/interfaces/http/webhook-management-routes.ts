import { createHash } from "node:crypto";
import { Hono } from "hono";
import type {
  WebhookDeliveryReceiptDto,
  WebhookEndpointCreatedDto,
  WebhookEndpointDto,
  WebhookEndpointListDto,
} from "@openedbot/contracts-api";
import type { AppVariables } from "../../routes/identity/auth";
import { requireRole } from "../../routes/identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import { decryptSecretFromKeyring, encryptSecret, SecretDecryptionError } from "../../infrastructure/crypto";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { isoUnlessNull } from "@openedbot/contracts-primitives";
import { HttpError, jsonBody } from "./http-error";
import { createWebhookSecret, hashWebhookSecret, UUID, webhookSecretMatches } from "./webhooks/shared";
import {
  countLiveEndpoints,
  insertEndpoint,
  insertManagementOperation,
  lockEndpointQuota,
  lockManagementOperation,
  readDeliveryReceipts,
  readEndpointById,
  readEndpoints,
  readManagementOperation,
  readThreadTarget,
  requireRunnableThread,
  requireThread,
  rotateEndpointSecret,
  tombstoneEndpoint,
  updateEndpoint,
  type DeliveryRow,
  type EndpointRow,
  type ManagementOperation,
} from "./webhooks/sql";

const MAX_ENDPOINTS_PER_ORGANIZATION = 20;
const MAX_ENDPOINTS_PER_THREAD = 5;
const MANAGEMENT_SECRET_RECOVERY_HOURS = 24;

/** The owner / admin side: `/api/webhooks`, session-authenticated. */
export function webhookManagementRoutes(
  db: Db,
  config: Pick<ApiConfig, "tokenEncryption">,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const threadId = readUuid(context.req.query("threadId"), "THREAD_ID_INVALID");
    const result = await withTenant(db, auth.organizationId, async (tx): Promise<WebhookEndpointListDto> => {
      await requireThread(tx, auth.organizationId, threadId);
      const endpoints = await readEndpoints(tx, auth.organizationId, threadId);
      const receipts = await readDeliveryReceipts(tx, auth.organizationId, threadId);
      return { endpoints: endpoints.map((row) => endpointDto(row, auth.organizationId)), receipts: receipts.map(receiptDto) };
    });
    context.header("Cache-Control", "no-store");
    return context.json(result);
  });

  routes.post("/", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const input = readEndpointInput(await jsonBody(context.req.raw));
    const idempotencyKey = readManagementIdempotencyKey(context.req.header("Idempotency-Key"));
    const requestHash = canonicalManagementRequestHash("webhook.create", input);
    const outcome = await withTenant(db, auth.organizationId, async (tx) => {
      await lockManagementOperation(tx, auth.organizationId, auth.userId, "webhook.create", idempotencyKey);
      const replay = await replayManagementOperation(
        tx, auth.organizationId, auth.userId, "webhook.create", idempotencyKey, requestHash,
        config.tokenEncryption,
      );
      if (replay) return replay;

      const id = crypto.randomUUID();
      const secret = createWebhookSecret();
      const hash = hashWebhookSecret(secret);
      await lockEndpointQuota(tx, auth.organizationId);
      const thread = await requireRunnableThread(tx, auth.organizationId, input.threadId);
      const counts = await countLiveEndpoints(tx, auth.organizationId, input.threadId);
      if (counts.organizationCount >= MAX_ENDPOINTS_PER_ORGANIZATION ||
          counts.threadCount >= MAX_ENDPOINTS_PER_THREAD) {
        throw new HttpError(409, "WEBHOOK_ENDPOINT_LIMIT", "Le nombre maximal de webhooks est atteint.");
      }
      const row = await insertEndpoint(tx, {
        id,
        organizationId: auth.organizationId,
        threadId: input.threadId,
        createdByUserId: auth.userId,
        name: input.name,
        instructions: input.instructions,
        secretHash: hash,
      });
      const endpoint = { ...row, botId: thread.botId, groupId: thread.groupId };
      await recordManagementOperation(
        tx, auth.organizationId, auth.userId, "webhook.create", idempotencyKey, requestHash,
        endpoint.id, secret, config.tokenEncryption,
      );
      return { endpoint, secret };
    });
    const body: WebhookEndpointCreatedDto = {
      endpoint: endpointDto(outcome.endpoint, auth.organizationId),
      credential: { ingressPath: ingressPath(auth.organizationId, outcome.endpoint.id), secret: outcome.secret },
    };
    context.header("Cache-Control", "no-store");
    return context.json(body, 201);
  });

  routes.patch("/:endpointId", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const endpointId = readUuid(context.req.param("endpointId"), "WEBHOOK_ENDPOINT_NOT_FOUND");
    const body = await jsonBody(context.req.raw);
    const name = body.name === undefined ? null : readText(body.name, "Le nom", 80);
    const instructions = body.instructions === undefined ? null : readText(body.instructions, "Les instructions", 20_000);
    const enabled = body.enabled === undefined ? null : readBoolean(body.enabled, "enabled");
    if (name === null && instructions === null && enabled === null) {
      throw new HttpError(400, "VALIDATION_ERROR", "Aucune modification n’a été fournie.");
    }
    const endpoint = await withTenant(db, auth.organizationId, async (tx) => {
      const row = await updateEndpoint(tx, auth.organizationId, endpointId, { name, instructions, enabled });
      if (!row) throw new HttpError(404, "WEBHOOK_ENDPOINT_NOT_FOUND", "Webhook introuvable.");
      const target = await readThreadTarget(tx, auth.organizationId, row.threadId);
      return { ...row, ...target };
    });
    return context.json(endpointDto(endpoint, auth.organizationId));
  });

  routes.post("/:endpointId/rotate", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const endpointId = readUuid(context.req.param("endpointId"), "WEBHOOK_ENDPOINT_NOT_FOUND");
    const idempotencyKey = readManagementIdempotencyKey(context.req.header("Idempotency-Key"));
    const requestHash = canonicalManagementRequestHash("webhook.rotate", { endpointId });
    const outcome = await withTenant(db, auth.organizationId, async (tx) => {
      await lockManagementOperation(tx, auth.organizationId, auth.userId, "webhook.rotate", idempotencyKey);
      const replay = await replayManagementOperation(
        tx, auth.organizationId, auth.userId, "webhook.rotate", idempotencyKey, requestHash,
        config.tokenEncryption,
      );
      if (replay) return replay;

      const secret = createWebhookSecret();
      const hash = hashWebhookSecret(secret);
      const row = await rotateEndpointSecret(tx, auth.organizationId, endpointId, hash);
      if (!row) throw new HttpError(404, "WEBHOOK_ENDPOINT_NOT_FOUND", "Webhook introuvable.");
      const endpoint = { ...row, ...await readThreadTarget(tx, auth.organizationId, row.threadId) };
      await recordManagementOperation(
        tx, auth.organizationId, auth.userId, "webhook.rotate", idempotencyKey, requestHash,
        endpoint.id, secret, config.tokenEncryption,
      );
      return { endpoint, secret };
    });
    const result: WebhookEndpointCreatedDto = {
      endpoint: endpointDto(outcome.endpoint, auth.organizationId),
      credential: { ingressPath: ingressPath(auth.organizationId, endpointId), secret: outcome.secret },
    };
    context.header("Cache-Control", "no-store");
    return context.json(result);
  });

  routes.delete("/:endpointId", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const endpointId = readUuid(context.req.param("endpointId"), "WEBHOOK_ENDPOINT_NOT_FOUND");
    const tombstoneHash = hashWebhookSecret(createWebhookSecret());
    await withTenant(db, auth.organizationId, async (tx) => {
      if (!await tombstoneEndpoint(tx, auth.organizationId, endpointId, tombstoneHash)) {
        throw new HttpError(404, "WEBHOOK_ENDPOINT_NOT_FOUND", "Webhook introuvable.");
      }
    });
    return context.body(null, 204);
  });

  return routes;
}

function readManagementIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || !UUID.test(key)) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key doit être un UUID.");
  }
  return key.toLowerCase();
}

export function canonicalManagementRequestHash(
  operation: ManagementOperation,
  input: { threadId: string; name: string; instructions: string } | { endpointId: string },
): string {
  const normalized = operation === "webhook.create"
    ? {
        operation,
        threadId: "threadId" in input ? input.threadId : "",
        name: "name" in input ? input.name : "",
        instructions: "instructions" in input ? input.instructions : "",
      }
    : { operation, endpointId: "endpointId" in input ? input.endpointId : "" };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function replayManagementOperation(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  operation: ManagementOperation,
  key: string,
  requestHash: string,
  keyring: ApiConfig["tokenEncryption"],
): Promise<{ endpoint: EndpointRow; secret: string } | null> {
  const saved = await readManagementOperation(tx, organizationId, userId, operation, key);
  if (!saved) return null;
  if (saved.requestHash !== requestHash) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé a déjà été utilisée pour une autre opération webhook.");
  }
  if (!saved.secretCiphertext || !saved.secretNonce || !saved.secretTag || !saved.secretKeyId ||
      new Date(saved.recoverableUntil).getTime() <= Date.now()) {
    throw new HttpError(
      409,
      "WEBHOOK_SECRET_RECOVERY_EXPIRED",
      "La récupération de ce secret a expiré. Renouvelez le secret de l’endpoint au lieu de recréer le webhook.",
    );
  }

  const endpoint = await readEndpointById(tx, organizationId, saved.endpointId);
  if (!endpoint) {
    throw new HttpError(409, "WEBHOOK_OPERATION_SUPERSEDED", "Ce webhook n’existe plus; cette réponse ne peut pas être rejouée.");
  }
  let secret: string;
  try {
    secret = decryptSecretFromKeyring(
      { ciphertext: saved.secretCiphertext, nonce: saved.secretNonce, tag: saved.secretTag },
      saved.secretKeyId,
      keyring,
    ).value;
  } catch (error) {
    if (!(error instanceof SecretDecryptionError)) throw error;
    throw new HttpError(
      409,
      "WEBHOOK_SECRET_RECOVERY_UNAVAILABLE",
      "Le secret sauvegardé ne peut plus être déchiffré. Renouvelez-le pour obtenir un nouvel identifiant.",
    );
  }
  if (endpoint.deletedAt !== null || !webhookSecretMatches(secret, endpoint.secretHash)) {
    throw new HttpError(
      409,
      "WEBHOOK_OPERATION_SUPERSEDED",
      "Ce secret a déjà été renouvelé ou révoqué. Utilisez l’état actuel du webhook.",
    );
  }
  return { endpoint, secret };
}

async function recordManagementOperation(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  operation: ManagementOperation,
  key: string,
  requestHash: string,
  endpointId: string,
  secret: string,
  keyring: ApiConfig["tokenEncryption"],
): Promise<void> {
  const encrypted = encryptSecret(secret, keyring.current.value);
  await insertManagementOperation(tx, {
    organizationId,
    userId,
    endpointId,
    operation,
    idempotencyKey: key,
    requestHash,
    secretCiphertext: encrypted.ciphertext,
    secretNonce: encrypted.nonce,
    secretTag: encrypted.tag,
    secretKeyId: keyring.current.id,
    recoverableHours: MANAGEMENT_SECRET_RECOVERY_HOURS,
  });
}

function endpointDto(row: EndpointRow, organizationId: string): WebhookEndpointDto {
  return {
    id: row.id,
    threadId: row.threadId,
    target: row.groupId ? "group" : "dm",
    name: row.name,
    instructions: row.instructions,
    enabled: row.enabled,
    deliveryCount: Number(row.deliveryCount),
    lastReceivedAt: isoUnlessNull(row.lastReceivedAt),
    rotatedAt: isoUnlessNull(row.rotatedAt)!,
    deletedAt: isoUnlessNull(row.deletedAt),
    createdAt: isoUnlessNull(row.createdAt)!,
    ingressPath: ingressPath(organizationId, row.id),
  };
}

function receiptDto(row: DeliveryRow): WebhookDeliveryReceiptDto {
  return {
    id: row.id,
    endpointId: row.endpointId,
    idempotencyKey: row.idempotencyKey,
    eventName: row.eventName,
    runId: row.runId,
    workflowId: row.workflowId,
    workflowStatus: row.workflowStatus,
    errorCode: row.errorCode,
    receivedAt: isoUnlessNull(row.receivedAt)!,
    acceptedAt: isoUnlessNull(row.acceptedAt),
  };
}

function readEndpointInput(body: Record<string, unknown>) {
  return {
    threadId: readUuid(typeof body.threadId === "string" ? body.threadId : undefined, "THREAD_ID_INVALID"),
    name: readText(body.name, "Le nom", 80),
    instructions: readText(body.instructions, "Les instructions", 20_000),
  };
}

function readText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new HttpError(400, "VALIDATION_ERROR", `${label} est requis.`);
  const text = value.trim();
  if (!text || text.length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} a une longueur invalide.`);
  return text;
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, "VALIDATION_ERROR", `${label} doit être un booléen.`);
  return value;
}

function readUuid(value: string | undefined, code: string): string {
  if (!value || !UUID.test(value)) throw new HttpError(400, code, "Identifiant invalide.");
  return value.toLowerCase();
}

function ingressPath(organizationId: string, endpointId: string): string {
  return `/api/hooks/${organizationId}/${endpointId}`;
}
