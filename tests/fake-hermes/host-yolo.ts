/**
 * Fake host-side YOLO: what edge-setup does once a `yolo.lease` reached the
 * host (`internal/connector/yolo_lease.go`, `yolo.go`, the approval plugin),
 * for the integration proofs of `tests/integration/yolo-link.ts`. It sits
 * next to `FakeHostAgent` (the transport) and decides alone, link or no link:
 *
 *   - pins `link.context.leaseKeys` on first contact (TOFU) and verifies each
 *     lease itself: Ed25519 over `ohb-yolo-lease/v1\n || canonical(lease)`,
 *     written here independently of the cloud signer; then the runtime, the
 *     window (300 s skew), 24 h at most, the tombstones and the local kill;
 *   - `decide()`: under a covering lease, the shared hardline, the
 *     organization deny-list and the protections refuse, anything else is
 *     auto-approved and journaled first (the arguments' hash only); without a
 *     lease, or once it elapsed by THIS host's clock, the gate is a human's;
 *   - `kill()` is `edge-setup yolo off`: offline, local, and reported as
 *     `killedAt` on the next `yolo.state`;
 *   - `answerTerminalApprovals()` is the connector's auto-responder: it reads
 *     a run's events on the local gateway and answers a native terminal
 *     approval `once` when `decide()` lets it pass, and leaves it pending
 *     (a human's) otherwise.
 *
 * The rules come from the shared hardline fixture (the TS copy in
 * `modules/execution`), which Go and Python also consume.
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import type {
  RelayYoloLeaseFrame,
  RelayYoloLeaseState,
  RelayYoloRevokeFrame,
  YoloLeaseKey,
  YoloLeaseV1,
} from "@openedbot/contracts-connector";
import {
  yoloDenyListHit,
  yoloHardlineHit,
  yoloProtectionHit,
  type YoloGateSubject,
} from "../../modules/execution/src/domain/yolo-hardline";
import type { HostAgentYoloRecord } from "./host-agent";

const SIGNING_PREFIX = "ohb-yolo-lease/v1\n";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const CLOCK_SKEW_SECONDS = 300;
const MAX_LEASE_SECONDS = 86_400;
const SCOPE_RANK = { thread: 3, bot: 2, runtime: 1 } as const;

/** One gate as the host sees it: who asks, and what the descriptor or the terminal names. */
export type FakeYoloGate = {
  profile: string;
  /** The Hermes session of the run; `null` when the hook does not know it. */
  sessionId: string | null;
  gateKind: "plugin_tool" | "terminal_danger";
  toolKey: string | null;
  paths: string[];
  command: string | null;
  /** The raw arguments: hashed into the audit, never kept. */
  args: string;
};

export type FakeYoloVerdict =
  | { decision: "auto"; leaseId: string }
  | { decision: "deny"; leaseId: string; reason: string }
  | { decision: "ask"; reason: "no_lease" };

type HeldLease = { lease: YoloLeaseV1; status: RelayYoloLeaseState["status"]; reason?: string };

export type FakeHostYoloOptions = {
  runtimeId: string;
  /** Seconds epoch; the host's own clock, which alone enforces the expiry. */
  now?: () => number;
  /** Where an auto-approval is journaled before it is answered (`FakeHostAgent.recordYoloAudit`). */
  journal: (records: HostAgentYoloRecord[]) => void;
};

/** Canonical JSON of the lease: sorted keys, arrays in order, ASCII strings and integers only. */
export function fakeCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fakeCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${fakeCanonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export class FakeHostYolo {
  private pinned = new Map<string, string>();
  private readonly leases = new Map<string, HeldLease>();
  private readonly tombstones = new Set<string>();
  private killed: number | null = null;
  private readonly now: () => number;

  constructor(private readonly options: FakeHostYoloOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** `edge-setup yolo off`: when it happened, `null` before. */
  get killedAt(): number | null {
    return this.killed;
  }

  /** First contact pins every key; later keys are ignored (the real host wants an endorsement). */
  pin(keys: readonly YoloLeaseKey[] | null): void {
    if (!keys || this.pinned.size > 0) return;
    for (const key of keys) this.pinned.set(key.keyId, key.publicKey);
  }

  /** A `yolo.lease` (verified, then held or rejected) or a `yolo.revoke` (tombstoned) from openedbot. */
  receive(frame: RelayYoloLeaseFrame | RelayYoloRevokeFrame): void {
    if (frame.t === "yolo.revoke") {
      const targets = "all" in frame && frame.all ? [...this.leases.keys()] : ["leaseId" in frame && frame.leaseId ? frame.leaseId : ""];
      for (const leaseId of targets.filter(Boolean)) {
        this.tombstones.add(leaseId);
        const held = this.leases.get(leaseId);
        if (held) this.leases.set(leaseId, { ...held, status: "revoked" });
      }
      return;
    }
    const issue = this.check(frame);
    this.leases.set(frame.lease.leaseId, issue ? { lease: frame.lease, status: "rejected", reason: issue } : { lease: frame.lease, status: "active" });
  }

  /** What `yolo.state` reports, elapsed and killed leases settled first. */
  states(): RelayYoloLeaseState[] {
    this.settle();
    return [...this.leases.values()].map((held) => (held.reason
      ? { leaseId: held.lease.leaseId, status: held.status, reason: held.reason }
      : { leaseId: held.lease.leaseId, status: held.status }));
  }

  /** `edge-setup yolo off`: every lease issued up to now stops here, without the link. */
  kill(at = this.now()): void {
    this.killed = at;
  }

  /** The host's verdict on one gate; an auto-approval is journaled before it is returned. */
  decide(gate: FakeYoloGate): FakeYoloVerdict {
    const lease = this.covering(gate);
    if (!lease) return { decision: "ask", reason: "no_lease" };
    const subject: YoloGateSubject = { toolKey: gate.toolKey, paths: gate.paths, command: gate.command };
    const hardline = yoloHardlineHit(subject);
    if (hardline) return { decision: "deny", leaseId: lease.leaseId, reason: `hardline ${hardline}` };
    const denied = yoloDenyListHit(subject, lease.deny);
    if (denied !== false) return { decision: "deny", leaseId: lease.leaseId, reason: denied === null ? "unreadable command" : "organization deny-list" };
    const protectedId = yoloProtectionHit(subject, lease.protect);
    if (protectedId) return { decision: "deny", leaseId: lease.leaseId, reason: `protected ${protectedId}` };
    this.options.journal([{ leaseId: lease.leaseId, profile: gate.profile, gateKind: gate.gateKind, toolKey: gate.toolKey, args: gate.args, occurredAt: this.now() }]);
    return { decision: "auto", leaseId: lease.leaseId };
  }

  /**
   * The connector's auto-responder for one run of the local gateway: every
   * native terminal approval `decide()` lets pass is answered `once` on the
   * loopback API; any other stays pending for a human. Resolves with the
   * verdicts once the event stream ends or `until` says so.
   */
  async answerTerminalApprovals(input: {
    gatewayUrl: string;
    gatewayToken: string;
    runId: string;
    profile: string;
    sessionId: string | null;
    until: (verdicts: FakeYoloVerdict[]) => boolean;
  }): Promise<FakeYoloVerdict[]> {
    const headers = { Authorization: `Bearer ${input.gatewayToken}` };
    const response = await fetch(`${input.gatewayUrl}/v1/runs/${input.runId}/events`, { headers: { ...headers, Accept: "text/event-stream" } });
    if (!response.ok || !response.body) throw new Error(`the run events did not open: HTTP ${response.status}`);
    const verdicts: FakeYoloVerdict[] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!input.until(verdicts)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let boundary = buffer.indexOf("\n\n"); boundary >= 0; boundary = buffer.indexOf("\n\n")) {
          const data = buffer.slice(0, boundary).split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          buffer = buffer.slice(boundary + 2);
          if (!data) continue;
          const event = JSON.parse(data) as { event?: string; command?: string; request_id?: string; pattern_key?: string };
          if (event.event !== "approval.request" || event.pattern_key?.startsWith("plugin_rule:") || typeof event.command !== "string") continue;
          const verdict = this.decide({
            profile: input.profile, sessionId: input.sessionId, gateKind: "terminal_danger", toolKey: null,
            paths: [], command: event.command, args: event.command,
          });
          verdicts.push(verdict);
          if (verdict.decision !== "auto") continue;
          const answer = await fetch(`${input.gatewayUrl}/v1/runs/${input.runId}/approval`, {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ choice: "once", request_id: event.request_id }),
          });
          // A human who answered first wins: 409 is tolerated, as upstream.
          if (!answer.ok && answer.status !== 409) throw new Error(`the auto-approval failed: HTTP ${answer.status}`);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return verdicts;
  }

  /** An active lease past its expiry (this host's clock) or issued up to the kill stops for good. */
  private settle(): void {
    const now = this.now();
    for (const held of this.leases.values()) {
      if (held.status !== "active") continue;
      if (this.isKilled(held.lease)) held.status = "revoked";
      else if (now >= held.lease.expiresAt) held.status = "expired";
    }
  }

  private isKilled(lease: YoloLeaseV1): boolean {
    return this.killed !== null && lease.issuedAt <= this.killed;
  }

  /** The most specific live lease covering the gate (thread, then bot, then runtime), or `null`. */
  private covering(gate: FakeYoloGate): YoloLeaseV1 | null {
    this.settle();
    const now = this.now();
    const sessionKey = gate.sessionId ? createHash("sha256").update(gate.sessionId).digest("hex") : null;
    let best: YoloLeaseV1 | null = null;
    for (const { lease, status } of this.leases.values()) {
      if (status !== "active" || this.tombstones.has(lease.leaseId) || this.isKilled(lease)) continue;
      if (!(lease.notBefore - CLOCK_SKEW_SECONDS <= now && now < lease.expiresAt)) continue;
      const covers = lease.scope === "runtime"
        || (lease.scope === "bot" && lease.profile === gate.profile)
        || (lease.scope === "thread" && lease.profile === gate.profile && sessionKey !== null && lease.sessionKey === sessionKey);
      if (!covers) continue;
      if (!best || SCOPE_RANK[lease.scope] > SCOPE_RANK[best.scope]
        || (SCOPE_RANK[lease.scope] === SCOPE_RANK[best.scope] && lease.expiresAt > best.expiresAt)) best = lease;
    }
    return best;
  }

  /** The refusal code of edge-setup (`YoloIssue*`), or `null` when the lease holds. */
  private check(frame: RelayYoloLeaseFrame): string | null {
    const { lease } = frame;
    const publicKey = this.pinned.get(frame.keyId);
    if (!publicKey) return "key_unknown";
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, "base64")]), format: "der", type: "spki" });
    const message = Buffer.from(SIGNING_PREFIX + fakeCanonicalJson(lease));
    if (!verify(null, message, key, Buffer.from(frame.signature, "base64"))) return "signature_invalid";
    if (lease.runtimeId !== this.options.runtimeId) return "runtime_mismatch";
    if (lease.expiresAt - lease.issuedAt > MAX_LEASE_SECONDS) return "duration_exceeded";
    const now = this.now();
    if (now < lease.notBefore - CLOCK_SKEW_SECONDS) return "not_yet_valid";
    if (now >= lease.expiresAt) return "expired";
    if (this.tombstones.has(lease.leaseId)) return "revoked";
    if (this.isKilled(lease)) return "killed";
    return null;
  }
}
