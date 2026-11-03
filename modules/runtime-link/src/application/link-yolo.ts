/**
 * Mode YOLO côté lien (PR 4/8) : ce que le cloud pousse à l'hôte (`yolo.lease`,
 * `yolo.revoke`, les clés de `link.context`) et ce qu'il reçoit de lui
 * (`yolo.state`, `yolo.audit`). Une fois le bail livré, l'hôte décide seul ;
 * le cloud n'intervient qu'à l'octroi, à la révocation et à la réception de
 * l'audit (`docs/CONNECTOR.md` côté edge-setup, « Bail YOLO »).
 *
 * La poussée est au mieux : le lien d'ICI, sinon le relais de contrôle de
 * l'instance qui le tient (`kind: "yolo"`), sinon rien. Ce qui n'est pas
 * livré est repoussé par le worker (`yolo-lease-sync.ts`) et redonné à la
 * reconnexion : l'hôte envoie `yolo.state` après sa preuve de possession, et
 * un bail vivant qu'il ne cite pas lui est renvoyé. Seul un hôte qui annonce
 * `yolo_lease` (et `yolo_thread_scope` pour un bail de thread) reçoit ces
 * trames : un bail n'est jamais élargi faute de pouvoir être limité.
 *
 * L'audit : `entryHash = SHA-256(0x01 || canonique(entrée sans entryHash) ||
 * prevHash)`, la règle de chaîne de l'audit de création, et la première entrée
 * d'un runtime suit `SHA-256("ohb-yolo-audit/v1/genesis" || runtimeId)`
 * (`edge-setup/internal/connector/yolo_audit.go`). Une tranche qui ne se
 * vérifie pas part en quarantaine (0159), journalisée et signalée ; elle est
 * gardée telle que reçue et accusée, jamais rejetée en silence.
 */
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import {
  decodeTextFrame,
  parseYoloLease,
  RELAY_FEATURE_YOLO_LEASE,
  RELAY_FEATURE_YOLO_THREAD_SCOPE,
  YOLO_KEY_ENDORSEMENT_PREFIX,
  YOLO_MAX_LEASE_KEYS,
  type RelayTextFrame,
  type RelayYoloAuditEntry,
  type RelayYoloAuditFrame,
  type RelayYoloLeaseFrame,
  type RelayYoloRevokeFrame,
  type RelayYoloStateFrame,
  type YoloLeaseKey,
} from "@openedbot/contracts-connector";
import { canonicalJson } from "@openedbot/hermes";
import type { YoloLeaseSigningConfig } from "@openedbot/platform-config/yolo-lease-signing";
import { withTenant, type Db, type TransactionDb } from "@openedbot/platform-db";
import { pgTextArray } from "@openedbot/platform-db/text-array";
import { logEvent } from "@openedbot/platform-observability";
import { enqueueYoloAuditQuarantineEmails } from "./link-yolo-alerts";
import type { LinkLocation } from "./instances";
import type {
  ConnectionOptions,
  LinkIdentity,
  LinkLivenessStore,
  LinkLogger,
  YoloAuditOutcome,
  YoloAuditQuarantineReason,
  YoloStateOutcome,
} from "./link-types";

// ---------------------------------------------------------------- chaîne

const YOLO_AUDIT_GENESIS = "ohb-yolo-audit/v1/genesis";

/** Le `prevHash` de la toute première entrée d'un runtime. */
export function yoloAuditGenesis(runtimeId: string): string {
  return createHash("sha256").update(YOLO_AUDIT_GENESIS + runtimeId).digest("hex");
}

/** `SHA-256(0x01 || canonique(entrée sans entryHash) || prevHash brut)`, comme `YoloEntryHash` en Go. */
export function yoloAuditEntryHash(entry: Omit<RelayYoloAuditEntry, "entryHash">): string {
  const body = canonicalJson({
    seq: entry.seq,
    eventId: entry.eventId,
    occurredAt: entry.occurredAt,
    leaseId: entry.leaseId,
    profile: entry.profile,
    gateKind: entry.gateKind,
    toolKey: entry.toolKey,
    argsHash: entry.argsHash,
    prevHash: entry.prevHash,
  });
  return createHash("sha256").update(Uint8Array.of(0x01)).update(body).update(Buffer.from(entry.prevHash, "hex")).digest("hex");
}

/** Le dernier maillon reçu d'un runtime (journal ou quarantaine), ou rien. */
export type YoloAuditTail = { seq: number; hash: string } | null;

export type YoloAuditVerdict =
  | { kind: "append"; entries: RelayYoloAuditEntry[] }
  | { kind: "quarantine"; reason: YoloAuditQuarantineReason; brokenSeq: number };

/**
 * Pur : ce qu'une tranche apporte au journal d'un runtime. Le décodeur a déjà
 * vérifié qu'elle est contiguë et chaînée sur elle-même ; ici chaque hash est
 * recalculé, la tranche doit suivre exactement le dernier maillon reçu, une
 * entrée déjà reçue doit revenir à l'identique, et chaque entrée nouvelle doit
 * citer un bail de ce runtime.
 */
export function verifyYoloAuditSlice(input: {
  runtimeId: string;
  entries: readonly RelayYoloAuditEntry[];
  tail: YoloAuditTail;
  /** Les `entry_hash` déjà au journal pour les séquences de la tranche. */
  stored: ReadonlyMap<number, string>;
  knownLeases: ReadonlySet<string>;
}): YoloAuditVerdict {
  const broken = (reason: YoloAuditQuarantineReason, brokenSeq: number): YoloAuditVerdict => ({ kind: "quarantine", reason, brokenSeq });
  for (const entry of input.entries) {
    if (yoloAuditEntryHash(entry) !== entry.entryHash) return broken("hash_mismatch", entry.seq);
  }
  const last = input.tail?.seq ?? 0;
  for (const entry of input.entries) {
    if (entry.seq > last) break;
    const stored = input.stored.get(entry.seq);
    if (stored !== undefined && stored !== entry.entryHash) return broken("conflict", entry.seq);
  }
  const fresh = input.entries.filter((entry) => entry.seq > last);
  const first = fresh[0];
  if (!first) return { kind: "append", entries: [] };
  if (first.seq !== last + 1) return broken("seq_gap", first.seq);
  if (first.prevHash !== (input.tail ? input.tail.hash : yoloAuditGenesis(input.runtimeId))) return broken("prev_mismatch", first.seq);
  const unknown = fresh.find((entry) => !input.knownLeases.has(entry.leaseId));
  if (unknown) return broken("unknown_lease", unknown.seq);
  return { kind: "append", entries: fresh };
}

// ---------------------------------------------------------- persistance

/** La trame d'un bail stocké : sa charge signée telle quelle, ou rien si elle ne se relit pas. */
export function yoloLeaseFrameOf(row: { payload: unknown; keyId: string; signature: string }): RelayYoloLeaseFrame | null {
  try {
    const payload = typeof row.payload === "string" ? JSON.parse(row.payload) as unknown : row.payload;
    return { t: "yolo.lease", lease: parseYoloLease(payload), keyId: row.keyId, signature: row.signature };
  } catch {
    return null;
  }
}

/**
 * Le runtime du jeton présenté, revérifié à chaque écriture comme pour un
 * diagnostic : un runtime révoqué, ou un jeton qui n'est plus le sien,
 * n'écrit rien.
 */
async function linkedRuntime(tx: TransactionDb, link: LinkIdentity): Promise<{ name: string }> {
  const rows = await tx<Array<{ name: string }>>`
    select name from runtimes where id = ${link.runtimeId}
       and organization_id = ${link.organizationId} and revoked_at is null
       and (link_token_hash = ${link.tokenHash}
         or (link_token_previous_hash = ${link.tokenHash} and link_token_previous_expires_at > now()))
  `;
  if (!rows[0]) throw new Error("YOLO runtime unavailable");
  return rows[0];
}

async function revokeByHost(
  tx: TransactionDb,
  link: LinkIdentity,
  input: { leaseIds: string[] | null; issuedUntil: number | null; reason: "host_cli" | "host_rejected" },
): Promise<string[]> {
  const rows = await tx<Array<{ leaseId: string }>>`
    select lease_id as "leaseId" from revoke_permission_yolo_leases_by_host(
      ${link.organizationId}::uuid, ${link.runtimeId}::uuid, ${link.tokenHash},
      ${input.leaseIds === null ? null : pgTextArray(input.leaseIds)}::uuid[],
      ${input.issuedUntil === null ? null : new Date(input.issuedUntil * 1000)}::timestamptz, ${input.reason}
    )
  `;
  return rows.map((row) => row.leaseId);
}

/**
 * Le verrou des écrivains de baux YOLO d'une organisation (le même que les
 * fonctions SQL de 0165-0167 et la passe du worker), pris avant tout verrou de
 * ligne : sans lui, « Couper YOLO partout » et un `yolo.state` de l'hôte
 * verrouillaient les mêmes baux dans deux ordres (deadlock).
 */
export async function lockYoloLeases(tx: TransactionDb, organizationId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`permission_yolo:${organizationId}`}, 0))`;
}

export type LinkYoloPersistenceOptions = {
  /** Origine de la PWA, pour le lien de l'e-mail de quarantaine ; vide : pas de bouton. */
  webAppUrl?: string;
  log?: LinkLogger;
};

/** Une quarantaine signalée au plus une fois par heure et par runtime : un hôte qui insiste n'inonde personne. */
const QUARANTINE_EMAIL_WINDOW = "1 hour";

export function createLinkYoloPersistence(db: Db, options: LinkYoloPersistenceOptions = {}): Required<Pick<LinkLivenessStore, "yoloState" | "yoloAudit">> {
  return {
    async yoloState(link, frame): Promise<YoloStateOutcome> {
      return withTenant(db, link.organizationId, async (tx) => {
        await lockYoloLeases(tx, link.organizationId);
        await linkedRuntime(tx, link);
        const states = frame.leases;
        const listed = states.map((state) => state.leaseId);
        if (states.length > 0) {
          await tx`
            update permission_yolo_leases l
               set host_state = s.status, host_state_reason = nullif(s.reason, ''), host_state_at = now(),
                   delivered_at = coalesce(l.delivered_at, now())
              from unnest(${pgTextArray(listed)}::uuid[], ${pgTextArray(states.map((state) => state.status))}::text[],
                          ${pgTextArray(states.map((state) => state.reason ?? ""))}::text[]) as s(id, status, reason)
             where l.organization_id = ${link.organizationId} and l.runtime_id = ${link.runtimeId} and l.id = s.id
          `;
        }
        let revokedByHost = 0;
        const rejected = states.filter((state) => state.status === "rejected").map((state) => state.leaseId);
        if (rejected.length > 0) revokedByHost += (await revokeByHost(tx, link, { leaseIds: rejected, issuedUntil: null, reason: "host_rejected" })).length;
        if (frame.killedAt !== undefined) {
          // `edge-setup yolo off` : tout bail émis jusque-là est mort pour l'hôte,
          // qu'il le cite ou non ; un bail émis après reste valable pour lui, sauf
          // un bail solo : le YOLO par défaut est coupé avec ses baux (0160).
          const killed = await revokeByHost(tx, link, { leaseIds: null, issuedUntil: frame.killedAt, reason: "host_cli" });
          const unlisted = killed.filter((leaseId) => !listed.includes(leaseId));
          if (unlisted.length > 0) {
            await tx`
              update permission_yolo_leases set host_state = 'revoked', host_state_reason = 'host_kill', host_state_at = now()
               where organization_id = ${link.organizationId} and runtime_id = ${link.runtimeId}
                 and id = any(${pgTextArray(unlisted)}::uuid[])
            `;
          }
          revokedByHost += killed.length;
        }
        const live = await tx<Array<{ id: string; payload: unknown; keyId: string; signature: string }>>`
          select id, payload, key_id as "keyId", signature from permission_yolo_leases
           where organization_id = ${link.organizationId} and runtime_id = ${link.runtimeId}
             and revoked_at is null and expires_at > now()
           order by issued_at, id
        `;
        const redeliver: RelayYoloLeaseFrame[] = [];
        for (const row of live) {
          if (listed.includes(row.id)) continue;
          const lease = yoloLeaseFrameOf(row);
          if (lease) redeliver.push(lease);
          else options.log?.("runtime_link.yolo_lease_unreadable", { runtimeId: link.runtimeId, leaseId: row.id });
        }
        const liveIds = new Set(live.map((row) => row.id));
        const revoke = states.filter((state) => state.status === "active" && !liveIds.has(state.leaseId)).map((state) => state.leaseId);
        return { redeliver, revoke, revokedByHost };
      });
    },

    async yoloAudit(link, frame): Promise<YoloAuditOutcome> {
      return withTenant(db, link.organizationId, async (tx) => {
        const runtime = await linkedRuntime(tx, link);
        // Deux connexions du même runtime (remplacement) ne chaînent jamais en même temps.
        await tx`select pg_advisory_xact_lock(hashtextextended(${`yolo_audit:${link.runtimeId}`}, 0))`;
        const tails = await tx<Array<{ seq: string | number; hash: string }>>`
          select seq, hash from (
            (select write_seq as seq, entry_hash as hash from permission_yolo_audit
              where organization_id = ${link.organizationId} and runtime_id = ${link.runtimeId}
              order by write_seq desc limit 1)
            union all
            (select to_seq, tail from permission_yolo_audit_quarantine
              where organization_id = ${link.organizationId} and runtime_id = ${link.runtimeId}
              order by to_seq desc limit 1)
          ) received order by seq desc limit 1
        `;
        const stored = await tx<Array<{ seq: string | number; hash: string }>>`
          select write_seq as seq, entry_hash as hash from permission_yolo_audit
           where organization_id = ${link.organizationId} and runtime_id = ${link.runtimeId}
             and write_seq between ${frame.fromSeq} and ${frame.toSeq}
        `;
        const leaseIds = [...new Set(frame.entries.map((entry) => entry.leaseId))];
        const known = await tx<Array<{ id: string }>>`
          select id from permission_yolo_leases
           where organization_id = ${link.organizationId} and runtime_id = ${link.runtimeId}
             and id = any(${pgTextArray(leaseIds)}::uuid[])
        `;
        const verdict = verifyYoloAuditSlice({
          runtimeId: link.runtimeId,
          entries: frame.entries,
          tail: tails[0] ? { seq: Number(tails[0].seq), hash: tails[0].hash } : null,
          stored: new Map(stored.map((row) => [Number(row.seq), row.hash])),
          knownLeases: new Set(known.map((row) => row.id)),
        });
        if (verdict.kind === "quarantine") {
          const recent = await tx`
            select 1 from permission_yolo_audit_quarantine
             where organization_id = ${link.organizationId} and runtime_id = ${link.runtimeId}
               and received_at > now() - ${QUARANTINE_EMAIL_WINDOW}::interval
             limit 1
          `;
          const [row] = await tx<Array<{ id: string; receivedAt: Date }>>`
            insert into permission_yolo_audit_quarantine (organization_id, runtime_id, from_seq, to_seq, tail, reason, broken_seq, entries)
            values (${link.organizationId}, ${link.runtimeId}, ${frame.fromSeq}, ${frame.toSeq}, ${frame.tail}, ${verdict.reason},
                    ${verdict.brokenSeq}, ${JSON.stringify(frame.entries)}::text::jsonb)
            returning id::text as id, received_at as "receivedAt"
          `;
          // Même journal que `insertRuntimeLinkEvent` : l'écran Runtime le montre.
          await tx`
            insert into runtime_link_events (organization_id, runtime_id, kind, meta)
            values (${link.organizationId}, ${link.runtimeId}, 'anchor_tampered',
                    ${{ reason: `yolo_audit_${verdict.reason}`, writeSeq: verdict.brokenSeq }}::jsonb)
          `;
          if (recent.length === 0) {
            await enqueueYoloAuditQuarantineEmails(tx, {
              id: row!.id, organizationId: link.organizationId, runtimeName: runtime.name, reason: verdict.reason,
              fromSeq: frame.fromSeq, toSeq: frame.toSeq, receivedAt: new Date(row!.receivedAt),
            }, options.webAppUrl ?? "");
          }
          return { outcome: "quarantined", reason: verdict.reason, brokenSeq: verdict.brokenSeq };
        }
        let inserted = 0;
        for (const entry of verdict.entries) {
          const rows = await tx`
            insert into permission_yolo_audit
              (organization_id, runtime_id, lease_id, write_seq, event_id, occurred_at, profile, gate_kind, tool_key, args_hash, prev_hash, entry_hash)
            values (${link.organizationId}, ${link.runtimeId}, ${entry.leaseId}, ${entry.seq}, ${entry.eventId}, to_timestamp(${entry.occurredAt}),
                    ${entry.profile}, ${entry.gateKind}, ${entry.toolKey}, ${entry.argsHash}, ${entry.prevHash}, ${entry.entryHash})
            on conflict (runtime_id, write_seq) do nothing
            returning 1
          `;
          inserted += rows.length;
        }
        return { outcome: inserted > 0 ? "recorded" : "duplicate", inserted };
      });
    },
  };
}

// ------------------------------------------------------- sur la connexion

/** Ce que la connexion expose au mode YOLO : `LinkConnection` s'y conforme. */
export type YoloConnection = {
  readonly link: LinkIdentity | null;
  readonly isAdmitted: boolean;
  readonly isClosed: boolean;
  readonly features: readonly string[];
  sendFrame(frame: RelayTextFrame): boolean;
};

export type YoloPushOutcome = "pushed" | "unsupported" | "closed" | "no_link";

/** Ce que le cloud pousse à l'hôte ; jamais signée pour une révocation, qui ne peut que restreindre. */
export type YoloHostFrame = RelayYoloLeaseFrame | RelayYoloRevokeFrame;

/** Une trame vers l'hôte, seulement s'il sait l'appliquer. Un bail de thread exige `yolo_thread_scope`. */
export function sendYoloFrame(connection: YoloConnection, frame: RelayYoloLeaseFrame | RelayYoloRevokeFrame): YoloPushOutcome {
  if (connection.isClosed || !connection.isAdmitted) return "closed";
  if (!connection.features.includes(RELAY_FEATURE_YOLO_LEASE)) return "unsupported";
  if (frame.t === "yolo.lease" && frame.lease.scope === "thread" && !connection.features.includes(RELAY_FEATURE_YOLO_THREAD_SCOPE)) return "unsupported";
  return connection.sendFrame(frame) ? "pushed" : "closed";
}

/** Au plus autant de trames YOLO en attente d'écriture par connexion ; au-delà, l'hôte renvoie. */
const MAX_PENDING_YOLO_FRAMES = 4;
const pending = new WeakMap<YoloConnection, { tail: Promise<void>; size: number }>();

function enqueue(connection: YoloConnection, work: () => Promise<void>): boolean {
  const queue = pending.get(connection) ?? { tail: Promise.resolve(), size: 0 };
  if (queue.size >= MAX_PENDING_YOLO_FRAMES) return false;
  queue.size += 1;
  // `work` journalise ses propres échecs ; une erreur imprévue ne bloque pas la file.
  queue.tail = queue.tail.then(work).catch(() => {}).finally(() => { queue.size -= 1; });
  pending.set(connection, queue);
  return true;
}

/**
 * `yolo.state` et `yolo.audit` reçus de l'hôte, une trame à la fois par
 * connexion (dans l'ordre d'arrivée). Rend `false` pour toute autre trame :
 * `handleText` la journalise alors comme inattendue.
 */
export function handleLinkYoloFrame(
  connection: YoloConnection,
  options: Pick<ConnectionOptions, "liveness" | "log" | "now">,
  frame: RelayTextFrame,
): boolean {
  if (frame.t !== "yolo.state" && frame.t !== "yolo.audit") return false;
  const identity = connection.link;
  // Avant l'admission : rien n'est écrit ni accusé, l'hôte renverra.
  if (!identity || !connection.isAdmitted || connection.isClosed) return true;
  if (frame.t === "yolo.audit" && frame.runtimeId !== identity.runtimeId) {
    options.log("runtime_link.yolo_audit_refused", { runtimeId: identity.runtimeId, reason: "runtime_mismatch", fromSeq: frame.fromSeq, toSeq: frame.toSeq });
    return true;
  }
  const work = frame.t === "yolo.state"
    ? () => ingestState(connection, options, identity, frame)
    : () => ingestAudit(connection, options, identity, frame);
  if (!enqueue(connection, work)) options.log("runtime_link.yolo_frame_deferred", { runtimeId: identity.runtimeId, type: frame.t });
  return true;
}

async function ingestState(
  connection: YoloConnection,
  options: Pick<ConnectionOptions, "liveness" | "log" | "now">,
  identity: LinkIdentity,
  frame: RelayYoloStateFrame,
): Promise<void> {
  const store = options.liveness.yoloState;
  if (!store) return options.log("runtime_link.yolo_unsupported", { runtimeId: identity.runtimeId, type: frame.t });
  try {
    const outcome = await store(identity, frame);
    if (connection.isClosed) return;
    const redelivered = outcome.redeliver.filter((lease) => sendYoloFrame(connection, lease) === "pushed").length;
    const revokedAt = Math.floor(options.now() / 1000);
    const revoked = outcome.revoke.filter((leaseId) => sendYoloFrame(connection, { t: "yolo.revoke", leaseId, revokedAt }) === "pushed").length;
    options.log("runtime_link.yolo_state", {
      runtimeId: identity.runtimeId, leases: frame.leases.length, killed: frame.killedAt !== undefined,
      redelivered, revoked, revokedByHost: outcome.revokedByHost,
    });
  } catch (error) {
    options.log("runtime_link.yolo_state_failed", { runtimeId: identity.runtimeId, error: String(error) });
  }
}

async function ingestAudit(
  connection: YoloConnection,
  options: Pick<ConnectionOptions, "liveness" | "log" | "now">,
  identity: LinkIdentity,
  frame: RelayYoloAuditFrame,
): Promise<void> {
  const store = options.liveness.yoloAudit;
  if (!store) return options.log("runtime_link.yolo_unsupported", { runtimeId: identity.runtimeId, type: frame.t });
  try {
    const outcome = await store(identity, frame);
    if (outcome.outcome === "quarantined") {
      options.log("runtime_link.yolo_audit_quarantined", {
        runtimeId: identity.runtimeId, reason: outcome.reason, brokenSeq: outcome.brokenSeq, fromSeq: frame.fromSeq, toSeq: frame.toSeq,
      });
    }
    // Gardée au journal ou en quarantaine : l'hôte peut purger.
    if (!connection.isClosed) connection.sendFrame({ t: "yolo.audit.ack", toSeq: frame.toSeq });
  } catch (error) {
    // Pas d'accusé : l'hôte garde la tranche et la renverra.
    options.log("runtime_link.yolo_audit_write_failed", { runtimeId: identity.runtimeId, fromSeq: frame.fromSeq, toSeq: frame.toSeq, error: String(error) });
  }
}

// ---------------------------------------------------------------- poussée

/** Les liens tenus ICI (le broker), par runtime. */
export type YoloLinks = { connection(runtimeId: string): YoloConnection | null };

/** Le saut vers l'instance qui tient le lien (`instances.ts`). */
export type YoloForwarder = {
  locate(runtimeId: string): Promise<LinkLocation>;
  forwardYolo(runtimeId: string, frame: RelayYoloLeaseFrame | RelayYoloRevokeFrame): Promise<boolean>;
};

/** Le port `YoloLeasePublisher` des routes YOLO (`modules/execution/src/application/yolo-leases.ts`). */
export type LinkYoloPublisher = {
  pushLease(input: { organizationId: string; runtimeId: string; frame: RelayYoloLeaseFrame }): Promise<void>;
  pushRevoke(input: { organizationId: string; runtimeId: string; frame: RelayYoloRevokeFrame }): Promise<void>;
};

/** Sur le lien d'ICI seulement : `no_link` quand cette instance ne le tient pas. */
export function pushLocalYolo(links: YoloLinks | null, runtimeId: string, frame: RelayYoloLeaseFrame | RelayYoloRevokeFrame): YoloPushOutcome {
  const connection = links?.connection(runtimeId) ?? null;
  return connection ? sendYoloFrame(connection, frame) : "no_link";
}

/**
 * La poussée des routes YOLO : le lien d'ICI, sinon celui de l'instance qui
 * le tient. Jamais levée : un échec se journalise, le worker repousse.
 */
export function createLinkYoloPublisher(links: YoloLinks | null, forwarder: YoloForwarder, log: LinkLogger = logEvent): LinkYoloPublisher {
  const push = async (runtimeId: string, frame: RelayYoloLeaseFrame | RelayYoloRevokeFrame): Promise<void> => {
    let outcome: YoloPushOutcome | "not_pushed" = pushLocalYolo(links, runtimeId, frame);
    if (outcome === "no_link") {
      const location = await forwarder.locate(runtimeId);
      if (location.kind === "remote") outcome = await forwarder.forwardYolo(runtimeId, frame) ? "pushed" : "not_pushed";
    }
    log("runtime_link.yolo_pushed", { runtimeId, type: frame.t, leaseId: "leaseId" in frame ? frame.leaseId : frame.t === "yolo.lease" ? frame.lease.leaseId : null, outcome });
  };
  return {
    pushLease: ({ runtimeId, frame }) => push(runtimeId, frame),
    pushRevoke: ({ runtimeId, frame }) => push(runtimeId, frame),
  };
}

/** Le corps `frame` d'un `control` `kind: "yolo"` : une trame cloud → hôte valide, ou rien. */
export function readYoloControlFrame(value: unknown): RelayYoloLeaseFrame | RelayYoloRevokeFrame | null {
  if (!value || typeof value !== "object") return null;
  try {
    const frame = decodeTextFrame(JSON.stringify(value));
    return frame.t === "yolo.lease" || frame.t === "yolo.revoke" ? frame : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------- clés de link.context

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function leaseKeyOf(seed: Uint8Array): { keyId: string; publicKey: string; privateKey: KeyObject } {
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(ED25519_SPKI_PREFIX.byteLength);
  return { keyId: createHash("sha256").update(raw).digest("hex").slice(0, 32), publicKey: raw.toString("base64"), privateKey };
}

/**
 * `link.context.leaseKeys` : la clé courante puis les clés retirées, de la
 * plus récente à la plus ancienne (`OPENEDBOT_YOLO_LEASE_PREVIOUS_KEYS` dans
 * cet ordre). Chaque clé est endossée par la suivante, plus ancienne :
 * `Ed25519(prefix || keyId || "\n" || publicKey)` (`YoloStore.PinKeys`). Un
 * hôte qui a épinglé une clé plus ancienne remonte la chaîne d'une clé par
 * connexion ; un hôte neuf épingle tout au premier usage. Aucune graine ne
 * quitte ce processus : seules les parties publiques et les endossements.
 */
export function yoloLinkLeaseKeys(signing: YoloLeaseSigningConfig): YoloLeaseKey[] {
  const keys: Array<ReturnType<typeof leaseKeyOf>> = [];
  for (const seed of [signing.seed, ...signing.previousSeeds]) {
    if (!seed) continue;
    const key = leaseKeyOf(seed);
    if (!keys.some((known) => known.keyId === key.keyId)) keys.push(key);
  }
  return keys.slice(0, YOLO_MAX_LEASE_KEYS).map((key, index) => {
    const endorser = keys[index + 1];
    if (!endorser) return { keyId: key.keyId, publicKey: key.publicKey };
    const endorsement = sign(null, Buffer.from(`${YOLO_KEY_ENDORSEMENT_PREFIX}${key.keyId}\n${key.publicKey}`), endorser.privateKey).toString("base64");
    return { keyId: key.keyId, publicKey: key.publicKey, endorsedBy: endorser.keyId, endorsement };
  });
}
