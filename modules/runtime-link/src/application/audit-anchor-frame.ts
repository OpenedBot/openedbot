import type { RelayAuditAnchorFrame } from "@openedbot/contracts-connector";
import { AuditAnchorError } from "./audit-anchor";
import type { ConnectionOptions, LinkIdentity } from "./link-types";

/**
 * `audit.anchor` reçu d'un lien admis : l'enregistrer, et journaliser une
 * ancre refusée (position en recul, clé jamais remise) ou un ancrage externe
 * en échec. Rien ne remonte : la connexion continue.
 */
export function recordAuditAnchorFrame(identity: LinkIdentity, frame: RelayAuditAnchorFrame, options: ConnectionOptions): void {
  const persist = options.liveness.auditAnchor;
  if (!persist || frame.runtimeId !== identity.runtimeId) return;
  void persist(identity, frame).then((outcome) => {
    if (outcome === "recorded") return;
    // Une position en recul ou une clé jamais remise : l'hôte rejoue un
    // fichier restauré, ou deux copies du runtime se disputent le lien.
    options.log("runtime_link.audit_anchor_refused", { runtimeId: identity.runtimeId, outcome, keyId: frame.keyId, writeSeq: frame.writeSeq });
    const event = options.liveness.event;
    if (event) void event.call(options.liveness, identity, "clock_skew", { reason: `anchor_${outcome}`, keyId: frame.keyId, writeSeq: frame.writeSeq, instanceId: options.instanceId, generation: identity.generation ?? null }).catch(() => {});
  }).catch((error) => {
    // `audit.anchor` : l'ancrage externe a échoué, l'ancre n'est pas
    // enregistrée (transaction annulée) ; la suivante la rattrapera.
    if (error instanceof AuditAnchorError) {
      options.log("runtime_link.audit_anchor_failed", { runtimeId: identity.runtimeId, keyId: frame.keyId, writeSeq: frame.writeSeq, anchor: error.anchorId, error: error.reason });
      return;
    }
    options.log("runtime_link.liveness_failed", { runtimeId: identity.runtimeId, write: "audit_anchor", error: String(error) });
  });
}
