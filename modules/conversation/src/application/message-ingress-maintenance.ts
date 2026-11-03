import type { Db } from "@openedbot/platform-db";
import { UUID_STRICT_BODY } from "@openedbot/contracts-primitives";
import {
  claimIngress,
  deferIngressRetry,
  purgeClaimedIngress,
  readObjectSafety,
  releaseQuarantinedIngress,
  renewIngressLease,
  type ClaimedTask,
} from "../sql/message-ingress-cleanup";

const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 100;
const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_RETRY_SECONDS = 60;
const DEFAULT_ABANDON_GRACE_SECONDS = 300;
const MAX_MANIFEST_OBJECTS = 5;
const OBJECT_KEY = new RegExp(`^org/(${UUID_STRICT_BODY})/${UUID_STRICT_BODY}$`, "i");

export type MessageIngressMaintenanceOptions = {
  /** Removes one blob; the worker passes the same deleter as tenant cleanup. Idempotent. */
  deleteObject: (key: string) => Promise<void>;
  batchSize?: number;
  leaseSeconds?: number;
  retrySeconds?: number;
  /** Quarantine after an API lease expires, allowing a late writer to settle. */
  abandonGraceSeconds?: number;
};

export type MessageIngressMaintenanceResult = {
  claimed: number;
  abandoned: number;
  purged: number;
  deletedObjects: number;
  retainedObjects: number;
  failed: number;
  leaseLost: number;
  failures: Array<{
    ingressId: string;
    code: "LEASE_LOST" | "MANIFEST_INVALID" | "BLOB_DELETE_FAILED" | "CLEANUP_FAILED";
  }>;
};

/**
 * Claims and cleans a bounded number of expired message ingress rows.
 *
 * - an expired `reserved` row becomes `abandoned` under the cleanup lease;
 * - only an `abandoned` manifest can delete blobs;
 * - completed rows only lose their idempotency receipt after expiry;
 * - partial blob deletion is safe to retry because the shared deleter is
 *   idempotent and the row is retained with a short retry lease.
 *
 * The worker schedules it from its maintenance tick (`maintenance-jobs.ts`,
 * job `message-ingress`).
 */
export async function maintainMessageIngress(
  db: Db,
  config: { workerId: string },
  options: MessageIngressMaintenanceOptions,
): Promise<MessageIngressMaintenanceResult> {
  const batchSize = boundedInteger(options.batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE, "batchSize");
  const leaseSeconds = boundedInteger(options.leaseSeconds, DEFAULT_LEASE_SECONDS, 30, 3_600, "leaseSeconds");
  const retrySeconds = boundedInteger(options.retrySeconds, DEFAULT_RETRY_SECONDS, 5, 3_600, "retrySeconds");
  const abandonGraceSeconds = boundedInteger(
    options.abandonGraceSeconds,
    DEFAULT_ABANDON_GRACE_SECONDS,
    30,
    3_600,
    "abandonGraceSeconds",
  );
  const deleteObject = options.deleteObject;
  const result: MessageIngressMaintenanceResult = {
    claimed: 0,
    abandoned: 0,
    purged: 0,
    deletedObjects: 0,
    retainedObjects: 0,
    failed: 0,
    leaseLost: 0,
    failures: [],
  };

  for (let index = 0; index < batchSize; index += 1) {
    const task = await claimIngress(db, config.workerId, leaseSeconds, abandonGraceSeconds);
    if (!task) break;
    result.claimed += 1;

    try {
      if (task.previousState === "reserved") {
        const released = await releaseQuarantinedIngress(db, task);
        if (!released) throw new LeaseLostError();
        result.abandoned += 1;
        continue;
      }
      if (task.state === "abandoned") {
        const keys = manifestKeys(task);
        for (const key of keys) {
          await renewLease(db, task, leaseSeconds);
          const safety = await readObjectSafety(db, task, key);
          if (!safety.owned) throw new LeaseLostError();
          if (safety.attached || safety.protectedByIngress) {
            result.retainedObjects += 1;
            continue;
          }
          try {
            await deleteObject(key);
          } catch {
            throw new MaintenanceError("BLOB_DELETE_FAILED");
          }
          result.deletedObjects += 1;
        }
      }
      await renewLease(db, task, leaseSeconds);
      const purged = await purgeClaimedIngress(db, task);
      if (!purged) throw new LeaseLostError();
      result.purged += 1;
    } catch (error) {
      result.failed += 1;
      if (error instanceof LeaseLostError) result.leaseLost += 1;
      result.failures.push({
        ingressId: task.id,
        code: error instanceof MaintenanceError ? error.code : "CLEANUP_FAILED",
      });
      await deferIngressRetry(db, task, retrySeconds).catch(() => undefined);
    }
  }

  return result;
}

function manifestKeys(task: ClaimedTask): string[] {
  if (!Array.isArray(task.attachmentManifest) || task.attachmentManifest.length > MAX_MANIFEST_OBJECTS) {
    throw new MaintenanceError("MANIFEST_INVALID");
  }
  const keys: string[] = [];
  for (const item of task.attachmentManifest) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new MaintenanceError("MANIFEST_INVALID");
    }
    const key = (item as Record<string, unknown>).key;
    if (typeof key !== "string") throw new MaintenanceError("MANIFEST_INVALID");
    const match = OBJECT_KEY.exec(key);
    if (!match || match[1]?.toLowerCase() !== task.organizationId.toLowerCase() || keys.includes(key)) {
      throw new MaintenanceError("MANIFEST_INVALID");
    }
    keys.push(key);
  }
  return keys;
}

async function renewLease(db: Db, task: ClaimedTask, leaseSeconds: number): Promise<void> {
  if (!await renewIngressLease(db, task, leaseSeconds)) throw new LeaseLostError();
}

class MaintenanceError extends Error {
  constructor(readonly code: MessageIngressMaintenanceResult["failures"][number]["code"]) {
    super(code);
    this.name = "MaintenanceError";
  }
}

class LeaseLostError extends MaintenanceError {
  constructor() {
    super("LEASE_LOST");
    this.name = "LeaseLostError";
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}
