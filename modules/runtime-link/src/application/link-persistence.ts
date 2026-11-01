import { invalidateHermesPreflightCache } from "@openedbot/hermes";
import type { RelayAuditAnchorFrame } from "@openedbot/contracts-connector";
import { withCredential, withTenant, type Db } from "@openedbot/platform-db";
import {
  bumpToolsetEpoch,
  markLinkConnected,
  markLinkDisconnected,
  markLinkSeen,
  replaceLinkTokenEmergency,
  setLinkFeatures,
} from "@openedbot/runtimes/sql/runtime-link-rows";
import { hashCredential, randomCredential } from "@openedbot/platform-db/credential";
import { logEvent } from "@openedbot/platform-observability";
import { recordAuditAnchor } from "./audit-keys";
import { anchorObjectKey, anchorRecordBytes, type AuditWormStore } from "./audit-worm";
import {
  createAuditAnchoring,
  recordWormOrphans,
  withWormOrphanMarking,
  wormAuditAnchor,
  type AnchorBlockingCheck,
  type AuditAnchoring,
} from "./audit-anchor";
import { sanitizeDiagnosticText } from "../domain/diagnostics";
import {
  LinkLeaseLostError,
  type LinkIdentity,
  type LinkEventKind,
  type LinkEventMeta,
  type LinkLivenessStore,
} from "./link-types";

/**
 * Vitalité en base, sous la porte RLS du jeton : la ligne n'est visible que
 * par le hash exact, et jamais cherchée par son seul identifiant. Pendant la
 * grâce d'une rotation (0027), le hash présenté peut être l'ANCIEN : la
 * porte et ces requêtes l'acceptent au même titre que le courant.
 *
 * Le journal `runtime_link_events`, lui, s'écrit sous la porte de
 * l'organisation : l'identité liée la connaît.
 */
function requiredGeneration(link: LinkIdentity): string {
  if (!link.generation || !/^[1-9][0-9]*$/.test(link.generation)) throw new LinkLeaseLostError();
  return link.generation;
}

export type LinkLivenessStoreOptions = {
  /**
   * Le bucket WORM (OHB-57), installation legacy de l'`AuditAnchor` jusqu'à
   * l'étape 8 : chaque ancre enregistrée y est déposée une fois ; `null` =
   * chaîne locale seule.
   */
  worm?: AuditWormStore | null;
  /** `audit.anchor` de l'organisation : un ancrage externe en échec devient bloquant. */
  anchorBlocking?: AnchorBlockingCheck;
  /** Remplace l'ancrage construit à partir de `worm` (tests, plug-in). */
  anchoring?: AuditAnchoring;
  now?: () => Date;
};

export function createLinkLivenessStore(db: Db, options: LinkLivenessStoreOptions = {}): LinkLivenessStore {
  const worm = options.worm ?? null;
  const anchoring = options.anchoring ?? createAuditAnchoring({ anchor: worm ? wormAuditAnchor(worm) : null, blocking: options.anchorBlocking });
  const now = options.now ?? (() => new Date());
  const store: LinkLivenessStore = {
    async reserveGeneration(link) {
      return withCredential(db, link.tokenHash, async (tx) => {
        const rows = await tx<Array<{ generation: string }>>`
          select nextval('runtime_link_generation_seq')::text as generation
            from runtimes where id = ${link.runtimeId} and organization_id = ${link.organizationId} and revoked_at is null
             and (link_token_hash = ${link.tokenHash}
               or (link_token_previous_hash = ${link.tokenHash} and link_token_previous_expires_at > now()))
        `;
        if (!rows.length) throw new LinkLeaseLostError();
        return rows[0]!.generation;
      });
    },
    async connected(link, instanceId, features) {
      const generation = requiredGeneration(link);
      await withCredential(db, link.tokenHash, async (tx) => {
        if (!await markLinkConnected(tx, link, { instanceId, generation, features })) throw new LinkLeaseLostError();
      });
      // Hello accepté : les capacités annoncées peuvent avoir changé. Le
      // worker, autre processus, voit le même événement via `link_connected_at`.
      invalidateHermesPreflightCache({
        organizationId: link.organizationId,
        runtimeId: link.runtimeId,
      });
    },
    async diagnostic(link, frame, receiverInstanceId) {
      await withTenant(db, link.organizationId, async (tx) => {
        // Scope the authenticated runtime again at persistence time; an ACK
        // must never make a revoked or foreign runtime's event disappear.
        const allowed = await tx<Array<{ id: string }>>`
          select id from runtimes where id = ${link.runtimeId}
            and organization_id = ${link.organizationId} and revoked_at is null
            and (link_token_hash = ${link.tokenHash}
              or (link_token_previous_hash = ${link.tokenHash} and link_token_previous_expires_at > now()))
        `;
        if (!allowed.length) throw new Error("Diagnostic runtime unavailable");
        await tx`
          insert into runtime_link_diagnostics
            (organization_id, runtime_id, event_id, component, state, code, message, stack, occurred_at, receiver_instance_id, receiver_generation)
          values (${link.organizationId}, ${link.runtimeId}, ${frame.eventId}, ${frame.component}, ${frame.state},
            ${frame.code}, ${sanitizeDiagnosticText(frame.message, 256)},
            ${frame.stack === undefined ? null : sanitizeDiagnosticText(frame.stack, 8192)}, ${frame.occurredAt},
            ${receiverInstanceId ?? null}, ${link.generation ?? null}::bigint)
          on conflict (runtime_id, event_id) do nothing
        `;
      });
    },
    async retire(link, instanceId) {
      await withTenant(db, link.organizationId, async (tx) => {
        // The current token only, on a runtime not already revoked: the same
        // write as `DELETE /api/runtime/:id`, in one update (0013).
        const rows = await tx<Array<{ id: string }>>`
          update runtimes set revoked_at = now(), is_active = false, updated_at = now()
           where id = ${link.runtimeId} and organization_id = ${link.organizationId}
             and revoked_at is null and link_token_hash = ${link.tokenHash}
          returning id
        `;
        if (!rows.length) throw new Error("Retired runtime unavailable");
        await insertRuntimeLinkEvent(tx, link.organizationId, link.runtimeId, "revoked", {
          reason: "host_retired",
          ...(instanceId !== undefined ? { instanceId } : {}),
          ...(link.generation !== undefined ? { generation: link.generation } : {}),
        });
      });
      invalidateHermesPreflightCache({ organizationId: link.organizationId, runtimeId: link.runtimeId });
    },
    async capabilities(link, instanceId, features) {
      const generation = requiredGeneration(link);
      await withCredential(db, link.tokenHash, async (tx) => {
        if (!await setLinkFeatures(tx, link, { instanceId, generation, features })) throw new LinkLeaseLostError();
      });
    },
    async seen(link, instanceId) {
      const generation = requiredGeneration(link);
      await withCredential(db, link.tokenHash, async (tx) => {
        if (!await markLinkSeen(tx, link, { instanceId, generation })) throw new LinkLeaseLostError();
      });
    },
    async disconnected(link, instanceId, reason) {
      const generation = requiredGeneration(link);
      if (!instanceId) throw new LinkLeaseLostError();
      await withCredential(db, link.tokenHash, async (tx) => {
        if (!await markLinkDisconnected(tx, link, { instanceId, generation, reason })) throw new LinkLeaseLostError();
      });
      invalidateHermesPreflightCache({
        organizationId: link.organizationId,
        runtimeId: link.runtimeId,
      });
    },
    async event(link, kind, meta) {
      await withTenant(db, link.organizationId, async (tx) => {
        await tx`
          insert into runtime_link_events (organization_id, runtime_id, kind, ip, agent, previous_ip, meta)
          values (${link.organizationId}, ${link.runtimeId}, ${kind}, ${meta.ip ?? null}, ${meta.agent ?? null}, ${meta.previousIp ?? null}, ${linkEventMetadata(meta)}::jsonb)
        `;
      });
    },
    async toolsetsWritten(link) {
      // Same runtime scope as the other link writes; no row (revoked, rotated
      // away) is not an error: there is no worker cache to invalidate then.
      await withTenant(db, link.organizationId, async (tx) => {
        await bumpToolsetEpoch(tx, link);
      });
    },
    async auditAnchor(link, frame) {
      const receivedAt = now().toISOString();
      // L'ancre, son maillon de chaîne locale et son ancrage externe dans la
      // MÊME transaction (AuditAnchor) : une ancre enregistrée est chaînée.
      // Un ancrage externe en échec bloque pour une organisation `audit.anchor`
      // (la transaction est annulée), sinon il se journalise après le commit.
      // Un objet WORM déposé dans une transaction annulée est marqué orphelin
      // (`audit_worm_orphans`), jamais supprimé.
      const { outcome, failure } = await withWormOrphanMarking(anchoring, (anchoring) => withCredential(db, link.tokenHash, async (tx) => {
        const outcome = await recordAuditAnchor(tx, link.organizationId, link.runtimeId, frame);
        if (outcome !== "recorded") return { outcome, failure: null };
        const record = { runtimeId: link.runtimeId, keyId: frame.keyId, writeSeq: frame.writeSeq, count: frame.count, dropped: frame.dropped, tail: frame.tail, receivedAt };
        let objectKey: string;
        try {
          objectKey = anchorObjectKey(link.runtimeId, frame.writeSeq);
        } catch (error) {
          // Comme avant : une position hors des clés WORM n'empêche pas
          // l'ancre en base ; elle se journalise, sans maillon.
          return { outcome, failure: String(error) };
        }
        const anchored = await anchoring(tx, {
          organizationId: link.organizationId,
          runtimeId: link.runtimeId,
          kind: "runtime_anchor",
          objectKey,
          payload: record,
          bytes: anchorRecordBytes(record),
        });
        return { outcome, failure: anchored.external.state === "failed" ? anchored.external.error : null };
      }), (attempts, reason) => withCredential(db, link.tokenHash, (tx) => recordWormOrphans(tx, attempts, reason)));
      if (failure !== null) await journalAnchorFailure(store, link, frame, failure);
      return outcome;
    },
    async dispatched(link, record, instanceId) {
      await withCredential(db, link.tokenHash, async (tx) => {
        await tx`
          insert into runtime_link_dispatches (organization_id, runtime_id, instance_id, generation, idempotency_key_hash, dispatched_at, status, remote_id)
          values (${link.organizationId}, ${link.runtimeId}, ${instanceId}, ${link.generation ?? null}::bigint, ${record.idempotencyKeyHash},
                  ${record.dispatchedAt}, ${record.status}, ${record.remoteId})
        `;
      });
    },
    async emergencyRotate(link, meta) {
      // Le nouveau jeton n'est jamais rendu : son hash seul existe. Personne
      // ne peut plus monter avec l'ancien, ni avec l'ancien-précédent.
      const tokenHash = hashCredential(randomCredential(32));
      await withTenant(db, link.organizationId, async (tx) => {
        await replaceLinkTokenEmergency(tx, { organizationId: link.organizationId, runtimeId: link.runtimeId, tokenHash });
        await insertRuntimeLinkEvent(tx, link.organizationId, link.runtimeId, "rotated", meta);
      });
    },
  };
  return store;
}

/** Un ancrage externe non bloquant en échec : journalisé (`worm_write_failed`), jamais levé. */
async function journalAnchorFailure(store: LinkLivenessStore, link: LinkIdentity, frame: RelayAuditAnchorFrame, error: string): Promise<void> {
  logEvent("runtime_link.worm_write_failed", { runtimeId: link.runtimeId, keyId: frame.keyId, writeSeq: frame.writeSeq, error });
  if (!store.event) return;
  await store.event(link, "worm_write_failed", { reason: "anchor", keyId: frame.keyId, writeSeq: frame.writeSeq }).catch((failure) => {
    logEvent("runtime_link.liveness_failed", { runtimeId: link.runtimeId, write: "event:worm_write_failed", error: String(failure) });
  });
}

/** Keep existing peer columns separate from bounded correlation metadata. */
function linkEventMetadata(meta: LinkEventMeta): Record<string, unknown> {
  return {
    ...(meta.minimum !== undefined ? { minimum: sanitizeDiagnosticText(meta.minimum, 256) } : {}),
    ...(meta.instanceId !== undefined ? { instanceId: meta.instanceId } : {}),
    ...(meta.generation !== undefined ? { generation: meta.generation } : {}),
    ...(meta.closeCode !== undefined ? { closeCode: meta.closeCode } : {}),
    ...(meta.ownershipCurrent !== undefined ? { ownershipCurrent: meta.ownershipCurrent } : {}),
    ...(meta.closeReason !== undefined ? { closeReason: sanitizeDiagnosticText(meta.closeReason, 123) } : {}),
    ...(meta.automatic !== undefined ? { automatic: meta.automatic } : {}),
    ...(meta.reason !== undefined ? { reason: sanitizeDiagnosticText(meta.reason, 64) } : {}),
    ...(meta.keyId !== undefined ? { keyId: sanitizeDiagnosticText(meta.keyId, 128) } : {}),
    ...(meta.writeSeq !== undefined ? { writeSeq: meta.writeSeq } : {}),
  };
}

/** L'insertion d'un événement du lien depuis une route déjà sous `withTenant` (révocation, rotation). */
export function insertRuntimeLinkEvent(
  tx: Bun.TransactionSQL,
  organizationId: string,
  runtimeId: string,
  kind: LinkEventKind,
  meta: LinkEventMeta = {},
) {
  return tx`
    insert into runtime_link_events (organization_id, runtime_id, kind, ip, agent, previous_ip, meta)
    values (${organizationId}, ${runtimeId}, ${kind}, ${meta.ip ?? null}, ${meta.agent ?? null}, ${meta.previousIp ?? null}, ${linkEventMetadata(meta)}::jsonb)
  `;
}
