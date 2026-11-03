import { Hono } from "hono";
import { createHash } from "node:crypto";
import {
  CREATION_AUDIT_MAX_EXPORT_BYTES,
  CreationAuditError,
  openCreationAudit,
  parseCreationAuditHeader,
  type CreationAuditEvent,
  type CreationAuditSnapshot,
} from "@openedbot/hermes";
import type { RelayTextFrame } from "@openedbot/contracts-connector";
import { SecretDecryptionError } from "@openedbot/hermes/secrets";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { pgTextArray } from "@openedbot/platform-db/text-array";
import { runtimeLinks, type RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import {
  auditKeyFrame,
  decryptAuditKey,
  readAuditAnchor,
  readAuditKeyRows,
  rotateAuditKey,
  type AuditAnchorRow,
} from "@openedbot/runtime-link/application/audit-keys";
import { createVerdictSigner, type VerdictSigner } from "@openedbot/runtime-link/application/audit-verdict";
import { insertRuntimeLinkEvent } from "@openedbot/runtime-link/application/broker";
import {
  anchorObjectKey,
  parseWormAnchor,
  sameAnchor,
  verdictObjectKey,
  type AuditWormStore,
} from "@openedbot/runtime-link/application/audit-worm";
import { canonicalJson } from "@openedbot/hermes";
import {
  AuditAnchorError,
  createAuditAnchoring,
  recordWormOrphans,
  withWormOrphanMarking,
  wormAuditAnchor,
  type AnchorBlockingCheck,
  type AuditAnchoring,
} from "@openedbot/runtime-link/application/audit-anchor";
import { verifyLocalChain } from "@openedbot/runtime-link/application/audit-chain";
import { logger } from "@openedbot/platform-observability";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import { assertString, HttpError } from "../../interfaces/http/http-error";
import { readRuntimeRowById } from "./runtime-routes";

/**
 * Vérification d'un export d'audit de création (OHB-56).
 *
 * L'opérateur recopie `snapshot.bin` à l'octet près et le soumet ici ; il ne
 * détient aucune clé. L'API lit l'en-tête clair, retrouve la clé maîtresse
 * du runtime (courante ou retirée), dérive, déchiffre, recalcule la chaîne,
 * compare à la dernière ancre reçue du connecteur, recoupe chaque événement
 * avec ce qu'elle a elle-même relayé (`runtime_link_dispatches`) et avec les
 * runs (`runs.hermes_run_id`), signale une dérive d'horloge, puis rend un
 * verdict daté et signé Ed25519 : persisté sans les événements ni la clé.
 *
 * Idempotent par SHA-256 de l'export : les mêmes octets rendent le même
 * verdict (même `id`, même signature), sans nouvelle ligne.
 */
export const AUDIT_EXPORT_MAX_BYTES = CREATION_AUDIT_MAX_EXPORT_BYTES;
/** Au-delà, `occurredAt` du connecteur et `dispatched_at` de l'API ne racontent plus la même histoire. */
export const AUDIT_CLOCK_SKEW_MS = 60_000;
export const AUDIT_VERIFICATIONS_PAGE_LIMIT = 200;

type AnchorState = "matches" | "behind" | "none" | "stale" | "db_only";
/**
 * Ce que le bucket WORM (OHB-57) dit de l'export : `disabled` (aucun store),
 * `missing` (l'ancre de cette position n'y a jamais été déposée), `matches`
 * (l'objet archivé décrit la même position que l'export ET que la base),
 * `tampered` (il en décrit une autre : la base ou l'export a été réécrit).
 */
type WormState = "disabled" | "missing" | "matches" | "tampered";
type Verdict = "valid" | "valid_unanchored" | "invalid";

export type AuditFinding = { kind: string; eventId?: string; detail?: string; skewMs?: number };

export type VerdictPayload = {
  id: string;
  runtimeId: string;
  keyId: string | null;
  exportSha256: string;
  receivedAt: string;
  verdict: Verdict;
  errorCode: string | null;
  anchor: AnchorState;
  worm: WormState;
  coverage: { startedAt: string; lastWrittenAt: string } | null;
  writeSeq: number | null;
  count: number | null;
  dropped: number | null;
  tail: string | null;
  findings: AuditFinding[];
};

type VerificationRow = {
  id: string;
  keyId: string | null;
  exportSha256: string;
  verdict: Verdict;
  errorCode: string | null;
  anchorState: AnchorState;
  wormState: WormState | null;
  writeSeq: string | number | null;
  eventCount: number | null;
  dropped: string | number | null;
  tail: string | null;
  startedAt: Date | string | null;
  lastWrittenAt: Date | string | null;
  findings: AuditFinding[];
  signature: string | null;
  signatureKeyId: string | null;
  receivedAt: Date | string;
};

export type RuntimeAuditRouteDeps = {
  links?: RuntimeLinks;
  signer?: VerdictSigner;
  /** Le bucket WORM (OHB-57) ; `null` ou absent : vérification sur la base seule, `worm: disabled`. */
  worm?: AuditWormStore | null;
  /** `audit.anchor` de l'organisation : un ancrage externe en échec devient bloquant. */
  anchorBlocking?: AnchorBlockingCheck;
  /** Remplace l'ancrage construit à partir de `worm` (tests). */
  anchoring?: AuditAnchoring;
  now?: () => Date;
};

/** Le refus est porté par une `HttpError` ET persisté comme verdict `invalid` : un export refusé laisse une trace datée. */
class AuditRefusal extends HttpError {
  constructor(status: number, code: string, message: string, readonly context: Partial<VerdictPayload> = {}) {
    super(status, code, message);
  }
}

export function runtimeAuditRoutes(db: Db, config: ApiConfig, deps: RuntimeAuditRouteDeps = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const links = deps.links ?? runtimeLinks();
  const signer = deps.signer ?? createVerdictSigner(config.auditVerdictSigning);
  const worm = deps.worm ?? null;
  const now = deps.now ?? (() => new Date());

  const anchoring = deps.anchoring ?? createAuditAnchoring({ anchor: worm ? wormAuditAnchor(worm) : null, blocking: deps.anchorBlocking });

  /**
   * Chaîne le verdict signé (chaîne locale) puis l'ancre à l'extérieur (le
   * bucket WORM, installation legacy), DANS la transaction qui l'insère.
   * Pour une organisation `audit.anchor`, un échec externe lève
   * `AuditAnchorError` (503 AUDIT_ANCHOR_FAILED) et annule la transaction ;
   * sinon il est rendu, pour être journalisé après le commit.
   */
  async function anchorVerdict(anchoring: AuditAnchoring, tx: TransactionDb, organizationId: string, payload: VerdictPayload, signed: { signature: string; signatureKeyId: string }): Promise<string | null> {
    // Même forme que la réponse HTTP, sans les événements : un verdict archivé se revérifie avec la clé publiée.
    const record = { ...payload, signature: { keyId: signed.signatureKeyId, value: signed.signature, algorithm: "ed25519" } } as unknown as Record<string, unknown>;
    const anchored = await anchoring(tx, {
      organizationId,
      runtimeId: payload.runtimeId,
      kind: "audit_verdict",
      objectKey: verdictObjectKey(payload.runtimeId, payload.id),
      payload: record,
      bytes: canonicalJson(record),
    });
    return anchored.external.state === "failed" ? anchored.external.error : null;
  }

  /**
   * Une transaction de verdict, avec le marquage des objets WORM orphelins :
   * un verdict déposé dans le bucket puis annulé est marqué
   * (`audit_worm_orphans`) dans une transaction à lui, jamais supprimé.
   */
  function verdictTransaction<T>(organizationId: string, work: (anchoring: AuditAnchoring, tx: TransactionDb) => Promise<T>): Promise<T> {
    return withWormOrphanMarking(
      anchoring,
      (tracked) => withTenant(db, organizationId, (tx) => work(tracked, tx)),
      (attempts, reason) => withTenant(db, organizationId, (tx) => recordWormOrphans(tx, attempts, reason)),
    );
  }

  /** Un ancrage externe non bloquant en échec : journalisé, n'altère jamais la réponse. */
  async function journalVerdictAnchorFailure(organizationId: string, payload: VerdictPayload, error: string): Promise<void> {
    logger.warn({ event: "api.creation_audit_worm_write_failed", runtimeId: payload.runtimeId, verdictId: payload.id, error }, "creation audit verdict could not be archived");
    await withTenant(db, organizationId, (tx) => insertRuntimeLinkEvent(tx, organizationId, payload.runtimeId, "worm_write_failed", { reason: "verdict", writeSeq: payload.writeSeq ?? undefined }))
      .catch((journalError) => logger.warn({ event: "api.creation_audit_event_failed", runtimeId: payload.runtimeId, error: String(journalError) }, "worm_write_failed could not be journaled"));
  }

  routes.post("/:runtimeId/creation-audit/verifications", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = assertString(context.req.param("runtimeId"), "L’identifiant du runtime", { max: 64 });
    const contentType = (context.req.header("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("application/octet-stream")) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "L’export d’audit se soumet en application/octet-stream, tel quel.");
    }
    const declaredLength = Number(context.req.header("content-length") ?? "");
    if (Number.isSafeInteger(declaredLength) && declaredLength > AUDIT_EXPORT_MAX_BYTES) {
      throw new HttpError(413, "BODY_TOO_LARGE", "L’export dépasse la borne d’un audit de création.");
    }
    const raw = new Uint8Array(await context.req.raw.arrayBuffer());
    if (raw.byteLength > AUDIT_EXPORT_MAX_BYTES) {
      throw new HttpError(413, "BODY_TOO_LARGE", "L’export dépasse la borne d’un audit de création.");
    }
    if (raw.byteLength === 0) throw new HttpError(400, "AUDIT_FORMAT_INVALID", "L’export est vide.");
    const exportSha256 = createHash("sha256").update(raw).digest("hex");
    const receivedAt = now();
    // Un refus est persisté dans SA PROPRE transaction, après que celle de la
    // vérification a été annulée : la transaction qui lève est annulée par
    // `db.begin`, donc un verdict `invalid` inséré dedans n'existerait jamais
    // sur PostgreSQL. Le refus persisté est ensuite archivé et, s'il dit que
    // l'ancre a été réécrite, journalisé pour le staff.
    let refusal: { payload: VerdictPayload; signed: { signature: string; signatureKeyId: string } } | null = null;

    const result = await verdictTransaction(auth.organizationId, async (anchoring, tx) => {
      const rows = await readRuntimeRowById(tx, auth.organizationId, runtimeId);
      const runtime = rows[0];
      if (!runtime) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
      if (runtime.reachability !== "connector") {
        throw new HttpError(409, "RUNTIME_NOT_CONNECTOR", "Seul un runtime joint par le connecteur tient un audit de création.");
      }
      const existing = await readVerification(tx, auth.organizationId, runtimeId, exportSha256);
      try {
        const opened = await verifyExport(tx, config, auth.organizationId, runtimeId, raw, exportSha256, receivedAt, worm);
        if (existing) return { payload: rowToPayload(existing, runtimeId), signature: existing.signature, signatureKeyId: existing.signatureKeyId, events: opened.events, replayed: true, signed: null, anchorFailure: null };
        const signed = signer.sign(opened.payload as unknown as Record<string, unknown>);
        await insertVerification(tx, auth.organizationId, auth.userId, opened.payload, signed);
        const anchorFailure = await anchorVerdict(anchoring, tx, auth.organizationId, opened.payload, signed);
        if (opened.payload.findings.some((finding) => finding.kind === "clock_skew")) {
          await insertRuntimeLinkEvent(tx, auth.organizationId, runtimeId, "clock_skew", { reason: "verification" });
        }
        return { payload: opened.payload, signature: signed.signature, signatureKeyId: signed.signatureKeyId, events: opened.events, replayed: false, signed, anchorFailure };
      } catch (error) {
        if (error instanceof AuditRefusal && !existing) {
          const payload: VerdictPayload = {
            id: crypto.randomUUID(), runtimeId, keyId: error.context.keyId ?? null, exportSha256, receivedAt: receivedAt.toISOString(),
            verdict: "invalid", errorCode: error.code, anchor: error.context.anchor ?? "none", worm: error.context.worm ?? (worm ? "missing" : "disabled"),
            coverage: error.context.coverage ?? null,
            writeSeq: error.context.writeSeq ?? null, count: error.context.count ?? null, dropped: error.context.dropped ?? null,
            tail: error.context.tail ?? null, findings: error.context.findings ?? [],
          };
          refusal = { payload, signed: signer.sign(payload as unknown as Record<string, unknown>) };
        }
        throw error;
      }
    }).catch(async (error: unknown) => {
      if (refusal) {
        const { payload, signed } = refusal;
        // `on conflict do nothing` : un rejeu des mêmes octets garde la première ligne.
        // Le refus persisté est chaîné et ancré dans SA transaction ; un
        // ancrage bloquant en échec remplace le refus par AUDIT_ANCHOR_FAILED.
        let anchorFailure: string | null = null;
        try {
          anchorFailure = await verdictTransaction(auth.organizationId, async (anchoring, tx) => {
            await insertVerification(tx, auth.organizationId, auth.userId, payload, signed);
            return anchorVerdict(anchoring, tx, auth.organizationId, payload, signed);
          });
        } catch (persistError) {
          if (persistError instanceof AuditAnchorError) {
            logger.error({ event: "api.creation_audit_anchor_failed", runtimeId, verdictId: payload.id, anchor: persistError.anchorId, error: persistError.reason }, "creation audit anchoring failed (blocking)");
            throw persistError;
          }
          logger.error({ event: "api.creation_audit_refusal_not_persisted", runtimeId, verdictId: payload.id, error: String(persistError) }, "creation audit refusal could not be persisted");
        }
        if (payload.errorCode === "AUDIT_ANCHOR_TAMPERED") {
          logger.error({ event: "api.creation_audit_anchor_tampered", runtimeId, verdictId: payload.id, writeSeq: payload.writeSeq }, "creation audit anchor tampered");
          await withTenant(db, auth.organizationId, (tx) => insertRuntimeLinkEvent(tx, auth.organizationId, runtimeId, "anchor_tampered", { reason: "verification", writeSeq: payload.writeSeq ?? undefined }))
            .catch((journalError) => logger.warn({ event: "api.creation_audit_event_failed", runtimeId, error: String(journalError) }, "anchor_tampered could not be journaled"));
        }
        if (anchorFailure !== null) await journalVerdictAnchorFailure(auth.organizationId, payload, anchorFailure);
      } else if (error instanceof AuditAnchorError) {
        logger.error({ event: "api.creation_audit_anchor_failed", runtimeId, anchor: error.anchorId, error: error.reason }, "creation audit anchoring failed (blocking)");
      }
      throw error;
    });
    if (result.anchorFailure !== null) await journalVerdictAnchorFailure(auth.organizationId, result.payload, result.anchorFailure);
    logger.info({ event: "api.creation_audit_verified", runtimeId, verdict: result.payload.verdict, anchor: result.payload.anchor, worm: result.payload.worm, replayed: result.replayed }, "creation audit verified");
    context.header("Cache-Control", "no-store");
    return context.json({
      ...result.payload,
      signature: { keyId: result.signatureKeyId, value: result.signature, algorithm: "ed25519", ephemeral: signer.ephemeral },
      events: result.events,
    });
  });

  routes.get("/:runtimeId/creation-audit/verifications", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = assertString(context.req.param("runtimeId"), "L’identifiant du runtime", { max: 64 });
    const requested = Number(context.req.query("limit") ?? "50");
    const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(AUDIT_VERIFICATIONS_PAGE_LIMIT, requested)) : 50;
    const verifications = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await readRuntimeRowById(tx, auth.organizationId, runtimeId);
      if (!rows[0]) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
      return tx<VerificationRow[]>`
        select id, key_id as "keyId", export_sha256 as "exportSha256", verdict, error_code as "errorCode", anchor_state as "anchorState",
               worm_state as "wormState",
               write_seq as "writeSeq", event_count as "eventCount", dropped, tail, started_at as "startedAt", last_written_at as "lastWrittenAt",
               findings, signature, signature_key_id as "signatureKeyId", received_at as "receivedAt"
          from runtime_audit_verifications
         where organization_id = ${auth.organizationId} and runtime_id = ${runtimeId}
         order by received_at desc, id desc
         limit ${limit}
      `;
    });
    return context.json({
      verifications: verifications.map((row) => ({
        ...rowToPayload(row, runtimeId),
        signature: { keyId: row.signatureKeyId, value: row.signature, algorithm: "ed25519" },
      })),
    });
  });

  /**
   * Vérification de la chaîne de hachage locale du runtime (`audit_chain`) :
   * la seule vérification que tient le cœur. L'export de preuve appartient
   * au plug-in `audit` (`/api/pro/audit`).
   */
  routes.get("/:runtimeId/creation-audit/local-chain", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = assertString(context.req.param("runtimeId"), "L’identifiant du runtime", { max: 64 });
    const verification = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await readRuntimeRowById(tx, auth.organizationId, runtimeId);
      if (!rows[0]) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
      return verifyLocalChain(tx, auth.organizationId, runtimeId);
    });
    context.header("Cache-Control", "no-store");
    return context.json({ runtimeId, ...verification });
  });

  /**
   * Rotation de la clé d'audit : nouvelle clé courante, l'ancienne retirée
   * mais encore remise dans `previous` pour que l'hôte rescelle. La trame
   * part sur le lien s'il est ouvert ici ; sinon la session suivante la
   * reçoit à la liaison.
   */
  routes.post("/:runtimeId/creation-audit/key/rotate", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const runtimeId = assertString(context.req.param("runtimeId"), "L’identifiant du runtime", { max: 64 });
    const frame = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await readRuntimeRowById(tx, auth.organizationId, runtimeId);
      const runtime = rows[0];
      if (!runtime) throw new HttpError(404, "RUNTIME_NOT_FOUND", "Ce runtime n’existe pas.");
      if (runtime.reachability !== "connector") {
        throw new HttpError(409, "RUNTIME_NOT_CONNECTOR", "Seul un runtime joint par le connecteur tient un audit de création.");
      }
      const keys = await rotateAuditKey(tx, auth.organizationId, runtimeId, config.tokenEncryption);
      await insertRuntimeLinkEvent(tx, auth.organizationId, runtimeId, "rotated", { reason: "audit_key", keyId: keys.current.keyId });
      return auditKeyFrame(runtimeId, keys);
    });
    const pushed = links.pushFrame?.(runtimeId, frame as RelayTextFrame) ?? false;
    logger.info({ event: "api.creation_audit_key_rotated", runtimeId, keyId: frame.keyId, pushed }, "creation audit key rotated");
    context.header("Cache-Control", "no-store");
    return context.json({ runtimeId, keyId: frame.keyId, previous: (frame.previous ?? []).map((entry) => entry.keyId), pushed });
  });

  return routes;
}

/** `GET /api/creation-audit/verdict-key` : la clé publique qui signe les verdicts, pour une revérification hors API. */
export function creationAuditRoutes(config: ApiConfig, deps: Pick<RuntimeAuditRouteDeps, "signer"> = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const signer = deps.signer ?? createVerdictSigner(config.auditVerdictSigning);
  routes.get("/verdict-key", (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({ keyId: signer.keyId, publicKey: signer.publicKey, algorithm: "ed25519", ephemeral: signer.ephemeral });
  });
  return routes;
}

/** Le verdict d'un export, ou une `AuditRefusal` qui dit exactement pourquoi. */
async function verifyExport(
  tx: TransactionDb,
  config: ApiConfig,
  organizationId: string,
  runtimeId: string,
  raw: Uint8Array,
  exportSha256: string,
  receivedAt: Date,
  worm: AuditWormStore | null,
): Promise<{ payload: VerdictPayload; events: CreationAuditEvent[] }> {
  let header;
  try {
    header = parseCreationAuditHeader(raw).header;
  } catch (error) {
    if (error instanceof CreationAuditError) {
      throw new AuditRefusal(error.code === "AUDIT_PLAINTEXT_EXPORT" ? 409 : 400, error.code, error.message);
    }
    throw error;
  }
  if (header.runtimeId !== runtimeId) {
    throw new AuditRefusal(409, "AUDIT_RUNTIME_MISMATCH", "L’en-tête de l’export nomme un autre runtime que celui de la requête.", { keyId: header.keyId });
  }
  const keyRows = await readAuditKeyRows(tx, organizationId, runtimeId);
  const keyRow = keyRows.find((row) => row.keyId === header.keyId);
  if (!keyRow) {
    throw new AuditRefusal(409, "AUDIT_KEY_UNKNOWN", `La clé ${header.keyId} n’a jamais été remise à ce runtime.`, { keyId: header.keyId });
  }
  let master: Uint8Array;
  try {
    master = decryptAuditKey(keyRow, config.tokenEncryption).key;
  } catch (error) {
    if (error instanceof SecretDecryptionError) {
      throw new AuditRefusal(409, "AUDIT_KEY_UNKNOWN", "La clé d’audit ne peut plus être déchiffrée avec le keyring configuré.", { keyId: header.keyId });
    }
    throw error;
  }
  let snapshot: CreationAuditSnapshot;
  try {
    snapshot = openCreationAudit(raw, (keyId) => (keyId === header.keyId ? master : null)).snapshot;
  } catch (error) {
    if (error instanceof CreationAuditError) throw new AuditRefusal(422, error.code, error.message, { keyId: header.keyId, writeSeq: header.writeSeq });
    throw error;
  }
  const summary: Partial<VerdictPayload> = {
    keyId: header.keyId, writeSeq: snapshot.writeSeq, count: snapshot.count, dropped: snapshot.dropped, tail: snapshot.tail,
    coverage: { startedAt: snapshot.startedAt, lastWrittenAt: snapshot.lastWrittenAt },
  };
  const anchor = await readAuditAnchor(tx, organizationId, runtimeId);
  const anchorState = compareAnchor(anchor, snapshot);
  if (anchorState === "stale") {
    throw new AuditRefusal(409, "AUDIT_STALE_EXPORT", "L’export est en retrait de la dernière ancre reçue du connecteur : c’est une copie antérieure, pas l’audit courant.", { ...summary, anchor: "stale", worm: worm ? "missing" : "disabled" });
  }
  const wormCheck = await checkWormAnchor(worm, runtimeId, header.keyId, snapshot, anchor);
  if (wormCheck.state === "tampered") {
    throw new AuditRefusal(422, "AUDIT_ANCHOR_TAMPERED", "L’ancre archivée hors base pour cette position ne décrit pas cet audit : la base ou l’export a été réécrit.", {
      ...summary, anchor: anchorState, worm: "tampered", findings: [{ kind: "anchor_tampered", detail: wormCheck.detail }],
    });
  }
  const findings = await crossCheck(tx, organizationId, runtimeId, snapshot.events);
  const unknown = findings.filter((finding) => finding.kind === "unknown_dispatch" || finding.kind === "unknown_remote_id");
  if (unknown.length > 0) {
    throw new AuditRefusal(422, "AUDIT_UNKNOWN_DISPATCH", "L’audit décrit une création que l’API n’a jamais relayée vers ce runtime.", { ...summary, anchor: anchorState, worm: wormCheck.state, findings });
  }
  return {
    payload: {
      id: crypto.randomUUID(),
      runtimeId,
      keyId: header.keyId,
      exportSha256,
      receivedAt: receivedAt.toISOString(),
      verdict: anchorState === "none" ? "valid_unanchored" : "valid",
      errorCode: null,
      anchor: anchorState,
      worm: wormCheck.state,
      coverage: { startedAt: snapshot.startedAt, lastWrittenAt: snapshot.lastWrittenAt },
      writeSeq: snapshot.writeSeq,
      count: snapshot.count,
      dropped: snapshot.dropped,
      tail: snapshot.tail,
      findings,
    },
    events: snapshot.events,
  };
}

/**
 * Ce que le bucket WORM dit de la position de l'export. L'objet
 * `anchors/<writeSeq>` a été déposé une fois, à la réception de l'ancre ;
 * s'il décrit une autre clé, un autre compte ou une autre `tail` que
 * l'export : ou que l'ancre en base pour la même position : quelqu'un a
 * réécrit l'un des deux, et l'export n'est plus une preuve.
 */
export async function checkWormAnchor(
  worm: AuditWormStore | null,
  runtimeId: string,
  keyId: string,
  snapshot: Pick<CreationAuditSnapshot, "writeSeq" | "count" | "dropped" | "tail">,
  anchor: AuditAnchorRow | null,
): Promise<{ state: WormState; detail?: string }> {
  if (!worm) return { state: "disabled" };
  const bytes = await worm.get(anchorObjectKey(runtimeId, snapshot.writeSeq));
  if (!bytes) return { state: "missing" };
  const archived = parseWormAnchor(bytes);
  if (!archived) return { state: "tampered", detail: "unreadable" };
  if (!sameAnchor(archived, { runtimeId, keyId, writeSeq: snapshot.writeSeq, count: snapshot.count, dropped: snapshot.dropped, tail: snapshot.tail })) {
    return { state: "tampered", detail: "export" };
  }
  if (anchor && anchor.writeSeq === snapshot.writeSeq && !sameAnchor(archived, { runtimeId, keyId: anchor.keyId, writeSeq: anchor.writeSeq, count: anchor.eventCount, dropped: anchor.dropped, tail: anchor.tail })) {
    return { state: "tampered", detail: "database" };
  }
  return { state: "matches" };
}

/** Où l'export se situe par rapport à la dernière ancre : `stale` est un refus, `behind` un signalement. */
export function compareAnchor(anchor: AuditAnchorRow | null, snapshot: Pick<CreationAuditSnapshot, "writeSeq" | "tail">): AnchorState {
  if (!anchor) return "none";
  if (anchor.writeSeq > snapshot.writeSeq) return "stale";
  if (anchor.writeSeq === snapshot.writeSeq) return anchor.tail === snapshot.tail ? "matches" : "stale";
  return "behind";
}

/**
 * Le recoupement à trois voies : chaque `attempt` doit correspondre à un
 * dispatch relayé par l'API (même SHA-256 d'Idempotency-Key) ; chaque
 * `remoteId` d'un `outcome` doit être un `runs.hermes_run_id` de
 * l'organisation ; un `occurredAt` à plus de 60 s du `dispatched_at` est une
 * dérive d'horloge, signalée sans invalider.
 *
 * Exported for its PostgreSQL proof (`tests/integration/text-array-binds.ts`):
 * the route tests use a fake database that never parses the array binds.
 */
export async function crossCheck(tx: TransactionDb, organizationId: string, runtimeId: string, events: readonly CreationAuditEvent[]): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const hashes = [...new Set(events.map((event) => event.idempotencyKeyHash).filter((hash) => /^[0-9a-f]{64}$/.test(hash)))];
  const dispatches = hashes.length
    ? await tx<Array<{ hash: string; dispatchedAt: Date | string }>>`
        select idempotency_key_hash as "hash", min(dispatched_at) as "dispatchedAt"
          from runtime_link_dispatches
         where organization_id = ${organizationId} and runtime_id = ${runtimeId} and idempotency_key_hash = any(${pgTextArray(hashes)}::text[])
         group by idempotency_key_hash
      `
    : [];
  const dispatchedAt = new Map(dispatches.map((row) => [row.hash, new Date(row.dispatchedAt).getTime()]));
  const remoteIds = [...new Set(events.map((event) => event.remoteId).filter((id): id is string => Boolean(id)))];
  const runs = remoteIds.length
    ? await tx<Array<{ remoteId: string }>>`
        select hermes_run_id as "remoteId" from runs
         where organization_id = ${organizationId} and hermes_run_id = any(${pgTextArray(remoteIds)}::text[])
      `
    : [];
  const knownRuns = new Set(runs.map((row) => row.remoteId));
  for (const event of events) {
    if (event.phase === "attempt") {
      const at = dispatchedAt.get(event.idempotencyKeyHash);
      if (at === undefined) {
        findings.push({ kind: "unknown_dispatch", eventId: event.eventId });
        continue;
      }
      const occurred = Date.parse(event.occurredAt);
      if (Number.isFinite(occurred) && Math.abs(occurred - at) > AUDIT_CLOCK_SKEW_MS) {
        findings.push({ kind: "clock_skew", eventId: event.eventId, skewMs: occurred - at });
      }
    }
    if (event.phase === "outcome" && event.remoteId && !knownRuns.has(event.remoteId)) {
      findings.push({ kind: "unknown_remote_id", eventId: event.eventId });
    }
  }
  return findings;
}

async function readVerification(tx: TransactionDb, organizationId: string, runtimeId: string, exportSha256: string): Promise<VerificationRow | null> {
  const rows = await tx<VerificationRow[]>`
    select id, key_id as "keyId", export_sha256 as "exportSha256", verdict, error_code as "errorCode", anchor_state as "anchorState",
           worm_state as "wormState",
           write_seq as "writeSeq", event_count as "eventCount", dropped, tail, started_at as "startedAt", last_written_at as "lastWrittenAt",
           findings, signature, signature_key_id as "signatureKeyId", received_at as "receivedAt"
      from runtime_audit_verifications
     where organization_id = ${organizationId} and runtime_id = ${runtimeId} and export_sha256 = ${exportSha256}
     limit 1
  `;
  return rows[0] ?? null;
}

async function insertVerification(
  tx: TransactionDb,
  organizationId: string,
  userId: string,
  payload: VerdictPayload,
  signed: { signature: string; signatureKeyId: string },
): Promise<void> {
  await tx`
    insert into runtime_audit_verifications (
      id, organization_id, runtime_id, export_sha256, key_id, verdict, error_code, anchor_state,
      write_seq, event_count, dropped, tail, started_at, last_written_at, findings, signature, signature_key_id, received_at, verified_by, worm_state
    ) values (
      ${payload.id}, ${organizationId}, ${payload.runtimeId}, ${payload.exportSha256}, ${payload.keyId}, ${payload.verdict}, ${payload.errorCode},
      ${payload.anchor}, ${payload.writeSeq}, ${payload.count}, ${payload.dropped}, ${payload.tail},
      ${payload.coverage?.startedAt ?? null}, ${payload.coverage?.lastWrittenAt ?? null}, ${payload.findings}::jsonb,
      ${signed.signature}, ${signed.signatureKeyId}, ${payload.receivedAt}, ${userId}, ${payload.worm}
    )
    on conflict (runtime_id, export_sha256) do nothing
  `;
}

function rowToPayload(row: VerificationRow, runtimeId: string): VerdictPayload {
  return {
    id: row.id,
    runtimeId,
    keyId: row.keyId,
    exportSha256: row.exportSha256,
    receivedAt: new Date(row.receivedAt).toISOString(),
    verdict: row.verdict,
    errorCode: row.errorCode,
    anchor: row.anchorState,
    worm: row.wormState ?? "disabled",
    coverage: row.startedAt && row.lastWrittenAt
      ? { startedAt: new Date(row.startedAt).toISOString(), lastWrittenAt: new Date(row.lastWrittenAt).toISOString() }
      : null,
    writeSeq: row.writeSeq === null ? null : Number(row.writeSeq),
    count: row.eventCount,
    dropped: row.dropped === null ? null : Number(row.dropped),
    tail: row.tail,
    findings: Array.isArray(row.findings) ? row.findings : [],
  };
}
