/**
 * `AuditAnchor`: anchoring of the creation audit, called SYNCHRONOUSLY in
 * the business transaction (the anchor being recorded, the verdict being
 * inserted), after the core's local hash chain.
 *
 * 1. The local chain (`audit_chain`) is always appended: solo mode anchors
 *    locally, and the core only ever verifies that chain.
 * 2. An external anchor, when one is installed, is then called in the same
 *    transaction. Until step 8 the legacy install is the WORM bucket
 *    (`wormAuditAnchor`), exactly the `AuditWormStore` the core used before.
 * 3. An external failure (or no answer within `timeoutMs`):
 *    - organization holding `audit.anchor`: BLOCKING, `AuditAnchorError`
 *      (503 `AUDIT_ANCHOR_FAILED`), the transaction rolls back;
 *    - otherwise: reported to the caller, which logs it
 *      (`worm_write_failed`), and the write goes on.
 * 4. A transaction that rolls back AFTER an external write was attempted
 *    may leave a WORM object no link points to. `withWormOrphanMarking`
 *    marks it (`audit_worm_orphans`, 0153) in a transaction of its own;
 *    nothing is ever deleted.
 */
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { TransactionDb } from "@openedbot/platform-db";
import { logEvent } from "@openedbot/platform-observability";
import { appendLocalChain, type AppendedLink, type AuditChainEntry } from "./audit-chain";
import type { AuditWormStore } from "./audit-worm";

export type AuditAnchorEvent = AuditChainEntry & {
  /** The exact bytes to anchor (canonical JSON of `payload`). */
  bytes: Uint8Array;
};

export type AuditAnchor = {
  /** For logs only. */
  readonly id: string;
  /** Anchors the event; throws on failure. May use `tx` for its own rows. */
  anchor(tx: TransactionDb, event: AuditAnchorEvent): Promise<void>;
};

export const AUDIT_ANCHOR_ENTITLEMENT = "audit.anchor";
export const DEFAULT_AUDIT_ANCHOR_TIMEOUT_MS = 5_000;

export class AuditAnchorError extends HttpError {
  constructor(readonly anchorId: string, readonly reason: string, options?: { cause?: unknown }) {
    super(503, "AUDIT_ANCHOR_FAILED", "L’ancrage externe de l’audit a échoué : l’opération est annulée et peut être retentée.");
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export type AnchorOutcome = {
  local: AppendedLink;
  external: { state: "none" } | { state: "anchored"; anchorId: string } | { state: "failed"; anchorId: string; error: string };
};

/** Is anchoring blocking for this organization (`audit.anchor`)? A failing check reads as not entitled. */
export type AnchorBlockingCheck = (organizationId: string) => Promise<boolean>;

export type AuditAnchoring = (tx: TransactionDb, event: AuditAnchorEvent) => Promise<AnchorOutcome>;

export function createAuditAnchoring(options: {
  anchor?: AuditAnchor | null;
  blocking?: AnchorBlockingCheck;
  timeoutMs?: number;
} = {}): AuditAnchoring {
  const anchor = options.anchor ?? null;
  const blocking = options.blocking ?? (async () => false);
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUDIT_ANCHOR_TIMEOUT_MS;
  return async (tx, event) => {
    const local = await appendLocalChain(tx, event);
    // A link already chained was anchored with it: nothing more to do.
    if (!anchor || !local.appended) return { local, external: { state: "none" } };
    try {
      await withTimeout(anchor.anchor(tx, event), timeoutMs);
      return { local, external: { state: "anchored", anchorId: anchor.id } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let blocks = false;
      try {
        blocks = await blocking(event.organizationId);
      } catch {
        blocks = false;
      }
      if (blocks) throw new AuditAnchorError(anchor.id, message, { cause: error });
      return { local, external: { state: "failed", anchorId: anchor.id, error: message } };
    }
  };
}

/** The legacy install (until step 8): the WORM bucket, written once per key. */
export function wormAuditAnchor(store: AuditWormStore): AuditAnchor {
  return {
    id: `worm:${store.mode}`,
    async anchor(_tx, event) {
      await store.putOnce(event.objectKey, event.bytes);
    },
  };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** An external write attempted inside a business transaction. */
export type AnchorAttempt = {
  organizationId: string;
  runtimeId: string;
  kind: AuditAnchorEvent["kind"];
  objectKey: string;
  anchorId: string;
  /** `confirmed`: the anchor answered. `unknown`: it failed or timed out, the object may exist. */
  written: "confirmed" | "unknown";
};

/** Writes the marks, in a transaction of its own (the business one is gone). */
export type WormOrphanMarker = (attempts: readonly AnchorAttempt[], reason: string) => Promise<void>;

const ORPHAN_REASON_MAX = 512;

/**
 * Runs ONE business transaction (`work` must wrap the whole `begin`, commit
 * included) with an anchoring that records its external attempts. If the
 * transaction throws after an attempt, every attempted object is marked as a
 * possible orphan, then the original error is rethrown unchanged. A marking
 * that fails is logged, never raised: it must not mask the business error.
 */
export async function withWormOrphanMarking<T>(
  anchoring: AuditAnchoring,
  work: (anchoring: AuditAnchoring) => Promise<T>,
  mark: WormOrphanMarker,
): Promise<T> {
  const attempts: AnchorAttempt[] = [];
  const tracked: AuditAnchoring = async (tx, event) => {
    const attempt = (anchorId: string, written: AnchorAttempt["written"]) => attempts.push({
      organizationId: event.organizationId, runtimeId: event.runtimeId, kind: event.kind, objectKey: event.objectKey, anchorId, written,
    });
    try {
      const outcome = await anchoring(tx, event);
      if (outcome.external.state === "anchored") attempt(outcome.external.anchorId, "confirmed");
      if (outcome.external.state === "failed") attempt(outcome.external.anchorId, "unknown");
      return outcome;
    } catch (error) {
      if (error instanceof AuditAnchorError) attempt(error.anchorId, "unknown");
      throw error;
    }
  };
  try {
    return await work(tracked);
  } catch (error) {
    if (attempts.length > 0) {
      const reason = orphanReason(error);
      const objectKeys = attempts.map((entry) => entry.objectKey);
      try {
        await mark(attempts, reason);
        logEvent("runtime_link.worm_orphan_marked", { runtimeId: attempts[0]!.runtimeId, objectKeys, reason });
      } catch (markError) {
        logEvent("runtime_link.worm_orphan_mark_failed", { runtimeId: attempts[0]!.runtimeId, objectKeys, reason, error: String(markError) });
      }
    }
    throw error;
  }
}

function orphanReason(error: unknown): string {
  const text = error instanceof AuditAnchorError
    ? `${error.code}: ${error.reason}`
    : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (text.trim() || "rolled back").slice(0, ORPHAN_REASON_MAX);
}

/** The marks, under the caller's tenant or link-credential context; a mark already there is kept. */
export async function recordWormOrphans(tx: TransactionDb, attempts: readonly AnchorAttempt[], reason: string): Promise<void> {
  for (const attempt of attempts) {
    await tx`
      insert into audit_worm_orphans (organization_id, runtime_id, kind, object_key, anchor_id, written, reason)
      values (${attempt.organizationId}, ${attempt.runtimeId}, ${attempt.kind}, ${attempt.objectKey}, ${attempt.anchorId.slice(0, 128)}, ${attempt.written}, ${reason})
      on conflict (runtime_id, object_key, anchor_id) do nothing
    `;
  }
}
