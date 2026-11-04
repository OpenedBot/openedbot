import { describe, expect, test } from "bun:test";
import type { RelayAuditAnchorFrame } from "@openedbot/contracts-connector";
import {
  AUDIT_ANCHOR_GLOBAL_WRITES,
  AUDIT_ANCHOR_QUEUE_PER_LINK,
  AuditAnchorQueue,
} from "../src/application/audit-anchor-frame";
import type { ConnectionOptions, LinkIdentity } from "../src/application/link-types";

/**
 * Un hôte qui enchaîne les `audit.anchor` ne doit pas ouvrir autant de
 * transactions : une écriture à la fois par connexion, une file courte, et un
 * plafond pour tout le processus. Les écritures restent suspendues jusqu'à ce
 * que le test les libère, pour mesurer la concurrence.
 */
function harness() {
  let active = 0;
  let peak = 0;
  const written: number[] = [];
  const gates: Array<() => void> = [];
  const logs: string[] = [];
  const options = {
    instanceId: "gw-test",
    log: (event: string) => logs.push(event),
    liveness: {
      async auditAnchor(_link: LinkIdentity, frame: RelayAuditAnchorFrame) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        written.push(frame.writeSeq);
        return "recorded" as const;
      },
    },
  } as unknown as ConnectionOptions;
  const releaseAll = async () => {
    for (let round = 0; round < 50 && (gates.length > 0 || active > 0); round += 1) {
      gates.splice(0).forEach((open) => open());
      await Bun.sleep(1);
    }
  };
  return { options, written, logs, releaseAll, peak: () => peak, waiting: () => gates.length };
}

const identity = (runtimeId: string): LinkIdentity => ({ runtimeId, organizationId: "org-1", tokenHash: "hash", expiresAt: null });
const frame = (runtimeId: string, writeSeq: number): RelayAuditAnchorFrame =>
  ({ t: "audit.anchor", runtimeId, keyId: "k-1", writeSeq, count: writeSeq, dropped: 0, tail: "a".repeat(64) });

describe("écritures d'audit.anchor bornées", () => {
  test("une connexion : une écriture à la fois, la file garde les plus récentes", async () => {
    const { options, written, logs, releaseAll, peak } = harness();
    const queue = new AuditAnchorQueue(options, () => false);
    for (let seq = 1; seq <= 100; seq += 1) queue.push(identity("rt-1"), frame("rt-1", seq));
    await Bun.sleep(5);
    expect(peak()).toBe(1);
    expect(queue.size).toBe(AUDIT_ANCHOR_QUEUE_PER_LINK);
    await releaseAll();
    // La première partie tout de suite, puis les dernières reçues.
    expect(written).toEqual([1, 97, 98, 99, 100]);
    expect(logs.filter((event) => event === "runtime_link.audit_anchor_dropped")).toHaveLength(100 - 1 - AUDIT_ANCHOR_QUEUE_PER_LINK);
  });

  test("toutes connexions confondues : au plus le plafond global en même temps", async () => {
    const { options, written, releaseAll, peak, waiting } = harness();
    const queues = Array.from({ length: 10 }, () => new AuditAnchorQueue(options, () => false));
    queues.forEach((queue, index) => queue.push(identity(`rt-${index}`), frame(`rt-${index}`, index + 1)));
    await Bun.sleep(5);
    expect(waiting()).toBe(AUDIT_ANCHOR_GLOBAL_WRITES);
    await releaseAll();
    expect(peak()).toBe(AUDIT_ANCHOR_GLOBAL_WRITES);
    expect(written.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("une connexion fermée n'écrit plus ce qui attendait", async () => {
    const { options, written, releaseAll } = harness();
    let closed = false;
    const queue = new AuditAnchorQueue(options, () => closed);
    for (let seq = 1; seq <= 3; seq += 1) queue.push(identity("rt-closed"), frame("rt-closed", seq));
    await Bun.sleep(5);
    closed = true;
    await releaseAll();
    expect(written).toEqual([1]);
    expect(queue.size).toBe(0);
  });

  test("une ancre d'un autre runtime n'est jamais mise en file", () => {
    const { options } = harness();
    const queue = new AuditAnchorQueue(options, () => false);
    queue.push(identity("rt-1"), frame("rt-other", 1));
    expect(queue.size).toBe(0);
  });
});
