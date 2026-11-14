import type { RelayAuditAnchorFrame } from "@openedbot/contracts-connector";
import { AuditAnchorError } from "./audit-anchor";
import type { ConnectionOptions, LinkIdentity } from "./link-types";

/**
 * Chaque `audit.anchor` ouvre une transaction (ancre, maillon, ancrage
 * externe). Un hôte défaillant ou hostile qui en enchaîne ne doit pas saturer
 * le pool PostgreSQL que partagent tous les runtimes de la passerelle : une
 * écriture à la fois par connexion, une file courte derrière, et un plafond
 * pour tout le processus.
 */
export const AUDIT_ANCHOR_QUEUE_PER_LINK = 4;
export const AUDIT_ANCHOR_GLOBAL_WRITES = 4;

/** Les écritures d'ancre en cours dans le processus, et celles qui attendent leur tour. */
class WriteSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    // Le créneau passe directement au suivant : `active` ne bouge pas.
    if (next) next();
    else this.active -= 1;
  }
}

const globalSlots = new WriteSlots(AUDIT_ANCHOR_GLOBAL_WRITES);

/**
 * La file d'ancres d'UNE connexion. Les ancres s'écrivent dans l'ordre reçu ;
 * pleine, la file lâche la plus ancienne en attente : la suivante la remplace
 * (même runtime, position plus récente). Une connexion fermée n'écrit plus.
 */
export class AuditAnchorQueue {
  private readonly pending: Array<{ identity: LinkIdentity; frame: RelayAuditAnchorFrame }> = [];
  private draining = false;

  constructor(
    private readonly options: ConnectionOptions,
    private readonly isClosed: () => boolean,
  ) {}

  get size(): number {
    return this.pending.length;
  }

  push(identity: LinkIdentity, frame: RelayAuditAnchorFrame): void {
    if (!this.options.liveness.auditAnchor || frame.runtimeId !== identity.runtimeId) return;
    if (this.pending.length >= AUDIT_ANCHOR_QUEUE_PER_LINK) {
      const dropped = this.pending.shift()!;
      this.options.log("runtime_link.audit_anchor_dropped", { runtimeId: identity.runtimeId, keyId: dropped.frame.keyId, writeSeq: dropped.frame.writeSeq });
    }
    this.pending.push({ identity, frame });
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.pending.length > 0 && !this.isClosed()) {
        const next = this.pending.shift()!;
        await globalSlots.acquire();
        try {
          await recordAuditAnchorFrame(next.identity, next.frame, this.options);
        } finally {
          globalSlots.release();
        }
      }
    } finally {
      this.pending.length = 0;
      this.draining = false;
    }
  }
}

/**
 * `audit.anchor` reçu d'un lien admis : l'enregistrer, et journaliser une
 * ancre refusée (position en recul ou contradictoire, clé jamais remise) ou
 * un ancrage externe en échec. Ne rejette jamais : la connexion continue.
 */
export async function recordAuditAnchorFrame(identity: LinkIdentity, frame: RelayAuditAnchorFrame, options: ConnectionOptions): Promise<void> {
  const persist = options.liveness.auditAnchor;
  if (!persist || frame.runtimeId !== identity.runtimeId) return;
  try {
    const outcome = await persist(identity, frame);
    if (outcome === "recorded") return;
    // Une position en recul ou contradictoire, une clé jamais remise : l'hôte
    // rejoue un fichier restauré, ou deux copies du runtime se disputent le lien.
    options.log("runtime_link.audit_anchor_refused", { runtimeId: identity.runtimeId, outcome, keyId: frame.keyId, writeSeq: frame.writeSeq });
    const event = options.liveness.event;
    if (event) void event.call(options.liveness, identity, "clock_skew", { reason: `anchor_${outcome}`, keyId: frame.keyId, writeSeq: frame.writeSeq, instanceId: options.instanceId, generation: identity.generation ?? null }).catch(() => {});
  } catch (error) {
    // `audit.anchor` : l'ancrage externe a échoué, l'ancre n'est pas
    // enregistrée (transaction annulée) ; la suivante la rattrapera.
    if (error instanceof AuditAnchorError) {
      options.log("runtime_link.audit_anchor_failed", { runtimeId: identity.runtimeId, keyId: frame.keyId, writeSeq: frame.writeSeq, anchor: error.anchorId, error: error.reason });
      return;
    }
    options.log("runtime_link.liveness_failed", { runtimeId: identity.runtimeId, write: "audit_anchor", error: String(error) });
  }
}
