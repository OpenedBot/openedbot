/**
 * Mode YOLO (PR 2/8) : octroi, liste, révocation, « Couper YOLO partout »,
 * consentement et lecture de l'audit. Le bail est construit et signé ici,
 * puis écrit par `grant_permission_yolo_lease`, qui dérive chaque colonne de
 * la charge signée et revérifie rôle, politique, hôte et cible sous le
 * verrou de l'organisation. Un refus est toujours nommé (409 avec sa raison,
 * 428, 503), jamais une rétrogradation silencieuse.
 *
 * La poussée vers l'hôte (`yolo.lease`, `yolo.revoke`) passe par le port
 * `YoloLeasePublisher`, après le commit et au mieux : le lien la branche en
 * PR 4, et le réconciliateur du worker repousse ce qui n'a pas été livré.
 */
import { createHash } from "node:crypto";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { isoInstant, isUuid } from "@openedbot/contracts-primitives";
import {
  YOLO_ACK_REQUIRED_CODE,
  YOLO_BLOCKED_BY_POLICY_CODE,
  YOLO_HOST_UNSUPPORTED_CODE,
  YOLO_HUMAN_REQUIRED_CODE,
  YOLO_MAX_SECONDS,
  YOLO_SCOPES,
  YOLO_SIGNING_UNAVAILABLE_CODE,
  YOLO_THREAD_DEFAULT_SECONDS,
  yoloPolicyBlock,
  type PermissionCeiling,
  type WorkspaceRole,
  type YoloAuditPageDto,
  type YoloConsentDto,
  type YoloKillResultDto,
  type YoloLease,
  type YoloLeaseDto,
  type YoloLeaseKeyDto,
  type YoloScope,
} from "@openedbot/contracts-api";
import { parseYoloLease, type RelayYoloLeaseFrame, type RelayYoloRevokeFrame } from "@openedbot/contracts-connector";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { logger } from "@openedbot/platform-observability";
import { signYoloLease, validateYoloLeaseShape, yoloSigningKeyFromSeed, type YoloSigningKey } from "../domain/yolo-lease";
import { YOLO_DEFAULT_PROTECT } from "../domain/yolo-hardline";
import {
  grantYoloLeaseTx,
  readLiveRuntimeIdsTx,
  readLiveYoloLeasesTx,
  readYoloAuditTx,
  readYoloConsentTx,
  readYoloLeaseTx,
  readYoloTargetTx,
  revokeYoloLeasesTx,
  writeYoloConsentTx,
  type YoloGrantStatus,
  type YoloLeaseRow,
} from "../sql/yolo-leases";

/** Qui demande : la session et son rôle dans l'organisation courante. */
export type YoloActor = {
  organizationId: string;
  userId: string;
  role: WorkspaceRole;
  /** Le type de session ; seuls `web` et `native` sont des sessions humaines. */
  kind: string;
  impersonatedByStaffUserId?: string | null;
};

/** La clé qui signe, et toutes celles que l'hôte doit pouvoir épingler. */
export type YoloLeaseSigner = { current: YoloSigningKey | null; keys: readonly YoloLeaseKeyDto[] };

/** La poussée vers l'hôte, au mieux (PR 4). Une erreur est journalisée, jamais remontée à l'utilisateur. */
export type YoloLeasePublisher = {
  pushLease(input: { organizationId: string; runtimeId: string; frame: RelayYoloLeaseFrame }): Promise<void>;
  pushRevoke(input: { organizationId: string; runtimeId: string; frame: RelayYoloRevokeFrame }): Promise<void>;
};

export const NO_YOLO_PUBLISHER: YoloLeasePublisher = {
  pushLease: async () => {},
  pushRevoke: async () => {},
};

/** Ce que la politique de l'organisation dit au moment de l'octroi (lue par l'appelant, revérifiée en base). */
export type YoloPolicyRead = (tx: TransactionDb, organizationId: string) => Promise<{
  maxMode: PermissionCeiling | null;
  enforceReview: boolean;
  commandBlocklist: readonly string[];
} | null>;

export type YoloLeaseDeps = {
  signer: YoloLeaseSigner;
  publisher: YoloLeasePublisher;
  readPolicy: YoloPolicyRead;
  /** Millisecondes epoch ; injectable pour les tests. */
  now?: () => number;
};

export type YoloGrantInput = {
  scope: YoloScope;
  runtimeId: string | null;
  botId: string | null;
  threadId: string | null;
  durationSeconds: number;
  acknowledged: boolean;
};

/** La clé courante et les clés retirées (leur partie publique seulement). */
export function createYoloLeaseSigner(config: { seed: Uint8Array | null; previousSeeds: readonly Uint8Array[] }): YoloLeaseSigner {
  const current = config.seed ? yoloSigningKeyFromSeed(config.seed) : null;
  const keys: YoloLeaseKeyDto[] = current ? [{ keyId: current.keyId, publicKey: current.publicKey, current: true }] : [];
  for (const seed of config.previousSeeds) {
    const { keyId, publicKey } = yoloSigningKeyFromSeed(seed);
    if (!keys.some((key) => key.keyId === keyId)) keys.push({ keyId, publicKey, current: false });
  }
  return { current, keys };
}

function manages(role: WorkspaceRole): boolean {
  return role === "owner" || role === "admin";
}

function requireManager(actor: YoloActor): void {
  if (!manages(actor.role)) {
    throw new HttpError(403, "ROLE_REQUIRED", "Seuls le propriétaire et les administrateurs gèrent le mode YOLO.");
  }
}

/**
 * Un bot ne s'octroie jamais un bail : seule une session humaine (navigateur
 * ou application) y parvient, jamais une session d'assistance ni un type de
 * session que ce code ne connaît pas.
 */
export function requireHumanSession(actor: Pick<YoloActor, "kind" | "impersonatedByStaffUserId">): void {
  if ((actor.kind !== "web" && actor.kind !== "native") || actor.impersonatedByStaffUserId) {
    throw new HttpError(403, YOLO_HUMAN_REQUIRED_CODE, "Seule une personne connectée peut activer le mode YOLO.");
  }
}

function invalid(field: string, message: string): HttpError {
  return new HttpError(400, "YOLO_LEASE_INVALID", message, {}, { field });
}

function optionalUuid(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isUuid(value)) throw invalid(field, "Identifiant invalide.");
  return value;
}

/** Le corps de `POST /leases`, canonique ou refusé. */
export function readYoloGrantInput(body: Record<string, unknown>): YoloGrantInput {
  const scope = body.scope;
  if (!(YOLO_SCOPES as readonly unknown[]).includes(scope)) throw invalid("scope", "Portée inconnue.");
  const runtimeId = optionalUuid(body, "runtimeId");
  const botId = optionalUuid(body, "botId");
  const threadId = optionalUuid(body, "threadId");
  if (scope !== "runtime" && botId === null) throw invalid("botId", "Cette portée vise un bot.");
  if (scope === "runtime" && botId !== null) throw invalid("botId", "Un bail de runtime ne vise aucun bot.");
  if (scope === "thread" && threadId === null) throw invalid("threadId", "Cette portée vise une conversation.");
  if (scope !== "thread" && threadId !== null) throw invalid("threadId", "Seule la portée thread vise une conversation.");
  const minutes = body.durationMinutes;
  if (minutes !== undefined && (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < 1 || minutes * 60 > YOLO_MAX_SECONDS)) {
    throw invalid("durationMinutes", "La durée va de 1 minute à 24 heures.");
  }
  if (body.acknowledged !== undefined && typeof body.acknowledged !== "boolean") throw invalid("acknowledged", "La confirmation doit être vraie ou fausse.");
  return {
    scope: scope as YoloScope,
    runtimeId,
    botId,
    threadId,
    durationSeconds: typeof minutes === "number" ? minutes * 60 : YOLO_THREAD_DEFAULT_SECONDS,
    acknowledged: body.acknowledged === true,
  };
}

function leaseDto(row: YoloLeaseRow): YoloLeaseDto {
  return {
    id: row.id,
    scope: row.scope,
    runtimeId: row.runtimeId,
    botId: row.botId,
    threadId: row.threadId,
    grantedByUserId: row.grantedByUserId,
    issuedAt: isoInstant(row.issuedAt),
    expiresAt: isoInstant(row.expiresAt),
    revokedAt: row.revokedAt ? isoInstant(row.revokedAt) : null,
    hostState: row.hostState,
    deliveredAt: row.deliveredAt ? isoInstant(row.deliveredAt) : null,
  };
}

function blocked(reason: "ceiling" | "enforce_review"): HttpError {
  return new HttpError(409, YOLO_BLOCKED_BY_POLICY_CODE, reason === "ceiling"
    ? "Le plafond de permissions de l'organisation n'autorise pas l'accès complet : le mode YOLO est refusé."
    : "L'organisation impose la revue : le mode YOLO est refusé.", {}, { reason });
}

function hostUnsupported(reason: "yolo_lease" | "yolo_thread_scope" | "bot_profile_missing"): HttpError {
  const message = reason === "yolo_lease" ? "Le connecteur de ce runtime ne sait pas encore appliquer un bail YOLO. Mettez-le à jour."
    : reason === "yolo_thread_scope" ? "Le connecteur de ce runtime ne sait pas limiter un bail à une conversation : choisissez le bot ou le runtime."
      : "Ce bot n'a pas de profil Hermes propre : le bail ne peut pas le viser.";
  return new HttpError(409, YOLO_HOST_UNSUPPORTED_CODE, message, {}, { reason });
}

/** Chaque refus de la fonction d'octroi, nommé. */
function grantRefusal(status: Exclude<YoloGrantStatus, "granted">): HttpError {
  switch (status) {
    case "blocked_ceiling": return blocked("ceiling");
    case "blocked_enforce_review": return blocked("enforce_review");
    case "policy_changed": return new HttpError(409, "YOLO_POLICY_CHANGED", "La politique de l'organisation a changé entre-temps. Réessayez.");
    case "runtime_not_found": return new HttpError(404, "YOLO_RUNTIME_NOT_FOUND", "Runtime introuvable.");
    case "host_unsupported": return hostUnsupported("yolo_lease");
    case "host_unsupported_thread": return hostUnsupported("yolo_thread_scope");
    case "bot_profile_missing": return hostUnsupported("bot_profile_missing");
    case "target_not_found": return new HttpError(404, "YOLO_TARGET_NOT_FOUND", "Bot ou conversation introuvable.");
    case "target_changed": return new HttpError(409, "YOLO_TARGET_CHANGED", "Le bot ou la conversation a changé entre-temps. Réessayez.");
    case "ack_required": return new HttpError(428, YOLO_ACK_REQUIRED_CODE, "Confirmez d'abord que vous activez le mode YOLO en connaissance de cause.");
  }
}

async function publish(kind: string, push: () => Promise<void>, context: Record<string, unknown>): Promise<void> {
  try {
    await push();
  } catch (error) {
    logger.warn({ event: `yolo.${kind}_push_failed`, ...context, error: error instanceof Error ? error.name : "unknown" }, "YOLO push failed; the reconciler retries");
  }
}

/** Octroie un bail signé : owner ou admin, session humaine, clé de signature présente. */
export async function grantYoloLease(db: Db, deps: YoloLeaseDeps, actor: YoloActor, input: YoloGrantInput): Promise<YoloLeaseDto> {
  requireHumanSession(actor);
  requireManager(actor);
  const key = deps.signer.current;
  if (!key) {
    throw new HttpError(503, YOLO_SIGNING_UNAVAILABLE_CODE, "Le mode YOLO n'est pas disponible sur ce serveur : aucune clé de signature n'est configurée.");
  }
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const granted = await withTenant(db, actor.organizationId, async (tx) => {
    const policy = await deps.readPolicy(tx, actor.organizationId);
    const block = yoloPolicyBlock({ maxMode: policy?.maxMode ?? null, enforceReview: policy?.enforceReview ?? false });
    if (block) throw blocked(block);
    const target = await readYoloTargetTx(tx, actor.organizationId, input);
    if (!target.runtimeId) throw grantRefusal("runtime_not_found");
    if (input.scope !== "runtime" && !target.botFound) throw grantRefusal("target_not_found");
    if (input.scope === "thread" && !target.threadFound) throw grantRefusal("target_not_found");
    if (input.scope !== "runtime" && target.botProfile === null) throw grantRefusal("bot_profile_missing");
    const lease: YoloLease = parseYoloLease({
      v: 1,
      leaseId: crypto.randomUUID(),
      organizationId: actor.organizationId,
      runtimeId: target.runtimeId,
      scope: input.scope,
      profile: input.scope === "runtime" ? null : target.botProfile,
      sessionKey: input.scope === "thread" ? createHash("sha256").update(target.threadSessionId!).digest("hex") : null,
      issuedAt: now,
      notBefore: now,
      expiresAt: now + input.durationSeconds,
      grantedBy: actor.userId,
      deny: { commands: [...(policy?.commandBlocklist ?? [])], tools: [], paths: [] },
      protect: [...YOLO_DEFAULT_PROTECT],
    });
    const shape = validateYoloLeaseShape(lease);
    if (!shape.ok) throw new Error(`a YOLO lease built here is invalid: ${shape.issue}`);
    const signed = signYoloLease(lease, key);
    const result = await grantYoloLeaseTx(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      botId: input.botId,
      threadId: input.threadId,
      keyId: signed.keyId,
      signature: signed.signature,
      lease,
      acknowledged: input.acknowledged,
    });
    if (result.status !== "granted") throw grantRefusal(result.status);
    const row = await readYoloLeaseTx(tx, actor.organizationId, lease.leaseId);
    if (!row) throw new Error("a granted YOLO lease cannot be read back");
    return { row, lease, signed, superseded: result.superseded };
  });
  const context = { organizationId: actor.organizationId, runtimeId: granted.row.runtimeId, leaseId: granted.row.id };
  for (const leaseId of granted.superseded) {
    await publish("revoke", () => deps.publisher.pushRevoke({
      organizationId: actor.organizationId, runtimeId: granted.row.runtimeId, frame: { t: "yolo.revoke", leaseId, revokedAt: now },
    }), { ...context, supersededLeaseId: leaseId });
  }
  await publish("lease", () => deps.publisher.pushLease({
    organizationId: actor.organizationId,
    runtimeId: granted.row.runtimeId,
    frame: { t: "yolo.lease", lease: granted.lease, keyId: granted.signed.keyId, signature: granted.signed.signature },
  }), context);
  return leaseDto(granted.row);
}

/** Les baux vivants, pour les badges et les comptes à rebours : tout membre. */
export async function listYoloLeases(
  db: Db,
  actor: YoloActor,
  filters: { runtimeId?: string; botId?: string; threadId?: string },
): Promise<{ leases: YoloLeaseDto[] }> {
  const rows = await withTenant(db, actor.organizationId, (tx) => readLiveYoloLeasesTx(tx, actor.organizationId, filters));
  return { leases: rows.map(leaseDto) };
}

/** Révoque un bail ; rejouée sur un bail déjà révoqué, elle le rend tel quel. */
export async function revokeYoloLease(db: Db, deps: YoloLeaseDeps, actor: YoloActor, leaseId: string): Promise<YoloLeaseDto> {
  requireManager(actor);
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const { row, revoked } = await withTenant(db, actor.organizationId, async (tx) => {
    if (!(await readYoloLeaseTx(tx, actor.organizationId, leaseId))) {
      throw new HttpError(404, "YOLO_LEASE_NOT_FOUND", "Bail introuvable.");
    }
    const revoked = await revokeYoloLeasesTx(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, leaseId, reason: "manual" });
    return { row: (await readYoloLeaseTx(tx, actor.organizationId, leaseId))!, revoked };
  });
  for (const lease of revoked) {
    await publish("revoke", () => deps.publisher.pushRevoke({
      organizationId: actor.organizationId, runtimeId: lease.runtimeId, frame: { t: "yolo.revoke", leaseId: lease.leaseId, revokedAt: now },
    }), { organizationId: actor.organizationId, runtimeId: lease.runtimeId, leaseId: lease.leaseId });
  }
  return leaseDto(row);
}

/**
 * « Couper YOLO partout » : tous les baux de l'organisation, et le YOLO solo
 * par défaut. Chaque runtime vivant reçoit `yolo.revoke {all}`, même sans
 * bail connu ici : un hôte peut tenir un bail que le cloud croit échu.
 */
export async function killYoloLeases(db: Db, deps: YoloLeaseDeps, actor: YoloActor): Promise<YoloKillResultDto> {
  requireManager(actor);
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const { revoked, runtimeIds } = await withTenant(db, actor.organizationId, async (tx) => ({
    revoked: await revokeYoloLeasesTx(tx, { organizationId: actor.organizationId, actorUserId: actor.userId, leaseId: null, reason: "kill_switch" }),
    runtimeIds: await readLiveRuntimeIdsTx(tx, actor.organizationId),
  }));
  const runtimes = [...new Set([...runtimeIds, ...revoked.map((lease) => lease.runtimeId)])];
  for (const runtimeId of runtimes) {
    await publish("revoke", () => deps.publisher.pushRevoke({
      organizationId: actor.organizationId, runtimeId, frame: { t: "yolo.revoke", all: true, revokedAt: now },
    }), { organizationId: actor.organizationId, runtimeId, all: true });
  }
  return { revoked: revoked.length, runtimes: runtimes.length };
}

export async function readYoloConsent(db: Db, actor: YoloActor): Promise<YoloConsentDto> {
  const row = await withTenant(db, actor.organizationId, (tx) => readYoloConsentTx(tx, actor.organizationId, actor.userId));
  return { acknowledgedAt: row ? isoInstant(row.acknowledgedAt) : null, soloDefault: row?.soloDefault ?? false };
}

/**
 * La confirmation de la première fois, par la personne elle-même. Le YOLO
 * solo par défaut (`soloDefault`, PR 7) équivaut à un octroi : owner ou
 * admin seulement.
 */
export async function saveYoloConsent(db: Db, actor: YoloActor, body: Record<string, unknown>): Promise<YoloConsentDto> {
  requireHumanSession(actor);
  if (body.acknowledged !== true) throw invalid("acknowledged", "La confirmation doit être donnée explicitement.");
  if (body.soloDefault !== undefined && typeof body.soloDefault !== "boolean") throw invalid("soloDefault", "Le choix doit être vrai ou faux.");
  if (body.soloDefault !== undefined) requireManager(actor);
  const row = await withTenant(db, actor.organizationId, (tx) => writeYoloConsentTx(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    soloDefault: typeof body.soloDefault === "boolean" ? body.soloDefault : null,
  }));
  return { acknowledgedAt: isoInstant(row.acknowledgedAt), soloDefault: row.soloDefault };
}

const AUDIT_PAGE = 100;

/** L'audit des auto-approbations, page par page : owner ou admin. */
export async function readYoloAudit(
  db: Db,
  actor: YoloActor,
  query: { leaseId: string | null; cursor: string | null },
): Promise<YoloAuditPageDto> {
  requireManager(actor);
  if (query.leaseId !== null && !isUuid(query.leaseId)) throw invalid("leaseId", "Identifiant invalide.");
  if (query.cursor !== null && !/^[1-9][0-9]{0,18}$/.test(query.cursor)) throw invalid("cursor", "Curseur invalide.");
  const rows = await withTenant(db, actor.organizationId, (tx) => readYoloAuditTx(tx, actor.organizationId, {
    leaseId: query.leaseId, before: query.cursor, limit: AUDIT_PAGE + 1,
  }));
  const page = rows.slice(0, AUDIT_PAGE);
  return {
    entries: page.map((row) => ({
      id: row.id,
      runtimeId: row.runtimeId,
      leaseId: row.leaseId,
      writeSeq: Number(row.writeSeq),
      occurredAt: isoInstant(row.occurredAt),
      profile: row.profile,
      gateKind: row.gateKind,
      toolKey: row.toolKey,
      argsHash: row.argsHash,
      entryHash: row.entryHash,
    })),
    nextCursor: rows.length > AUDIT_PAGE ? page.at(-1)!.id : null,
  };
}

/** Les clés publiques que l'hôte épingle (PR 3/4) : publiques, lisibles par tout membre. */
export function yoloLeaseKeys(signer: YoloLeaseSigner): { keys: YoloLeaseKeyDto[] } {
  return { keys: [...signer.keys] };
}
