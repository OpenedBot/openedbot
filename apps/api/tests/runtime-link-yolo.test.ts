import { afterAll, describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import {
  decodeTextFrame,
  parseYoloLease,
  RELAY_FEATURE_YOLO_LEASE,
  RELAY_FEATURE_YOLO_THREAD_SCOPE,
  RELAY_MAX_FEATURES,
  YOLO_KEY_ENDORSEMENT_PREFIX,
  type RelayTextFrame,
  type RelayYoloAuditEntry,
  type RelayYoloAuditFrame,
  type RelayYoloLeaseFrame,
} from "@openedbot/contracts-connector";
import type { Db } from "@openedbot/platform-db";
import { createYoloLeaseSigner } from "@openedbot/execution/application/yolo-leases";
import { RuntimeLinkBroker, createLinkLivenessStore, type LinkIdentity, type LinkLivenessStore } from "@openedbot/runtime-link/application/broker";
import type { LinkLocation, RuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import {
  createLinkYoloPublisher,
  verifyYoloAuditSlice,
  yoloAuditEntryHash,
  yoloAuditGenesis,
  yoloLinkLeaseKeys,
} from "@openedbot/runtime-link/application/link-yolo";
import { runtimeLinkInternalRoutes } from "../src/routes/runtimes/runtime-link-routes";
import { RUNTIME_LINK_WS_PATH } from "@openedbot/runtime-link/application/gateway";
import { FakeHostAgent } from "../../../tests/fake-hermes/host-agent";
import { LINK_RUNTIME_ID, LINK_TOKEN, linkConfig, openLinkSession, startShared, stopLinkSessions } from "./fixtures/link-gateway-session";

afterAll(() => stopLinkSessions());

const id = (n: number) => `95900000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const RUNTIME = id(51);
const ORG = id(1);
const LEASE = id(201);
const OTHER_LEASE = id(202);
const link: LinkIdentity = { runtimeId: RUNTIME, organizationId: ORG, tokenHash: "a".repeat(64), expiresAt: null };
const YOLO_FEATURES = [RELAY_FEATURE_YOLO_LEASE, RELAY_FEATURE_YOLO_THREAD_SCOPE];
// Public TEST seeds, never real keys: 0x00..0x1f and 0x20..0x3f.
const TEST_SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const OLDER_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 32);

async function settle() { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); }

/** A chain of `count` entries after `tail` (or from the genesis), hashed by the code under test. */
function chain(count: number, options: { tail?: { seq: number; hash: string }; leaseId?: string; runtimeId?: string } = {}): RelayYoloAuditEntry[] {
  const entries: RelayYoloAuditEntry[] = [];
  let seq = options.tail?.seq ?? 0;
  let prev = options.tail?.hash ?? yoloAuditGenesis(options.runtimeId ?? RUNTIME);
  for (let index = 0; index < count; index++) {
    seq += 1;
    const body = {
      seq, eventId: id(1000 + seq), occurredAt: 1_793_491_300 + seq, leaseId: options.leaseId ?? LEASE, profile: "designer",
      gateKind: "plugin_tool", toolKey: "write_file", argsHash: "c".repeat(64), prevHash: prev,
    };
    const entryHash = yoloAuditEntryHash(body);
    entries.push({ ...body, entryHash });
    prev = entryHash;
  }
  return entries;
}

function auditFrame(entries: RelayYoloAuditEntry[], runtimeId = RUNTIME): RelayYoloAuditFrame {
  return { t: "yolo.audit", runtimeId, entries, fromSeq: entries[0]!.seq, toSeq: entries.at(-1)!.seq, tail: entries.at(-1)!.entryHash };
}

function leaseFrame(leaseId: string, scope: "thread" | "bot" | "runtime" = "runtime"): RelayYoloLeaseFrame {
  const lease = parseYoloLease({
    v: 1, leaseId, organizationId: ORG, runtimeId: RUNTIME, scope,
    profile: scope === "runtime" ? null : "designer", sessionKey: scope === "thread" ? "d".repeat(64) : null,
    issuedAt: 1_793_491_000, notBefore: 1_793_491_000, expiresAt: 1_793_505_400, grantedBy: id(11),
    deny: { commands: [], tools: [], paths: [] }, protect: ["ssh"],
  });
  return { t: "yolo.lease", lease, keyId: "e".repeat(32), signature: `${"A".repeat(86)}==` };
}

describe("chaîne de l'audit YOLO : la règle de l'hôte, octet pour octet", () => {
  test("genèse et hash des entrées identiques au Go (YoloAuditGenesis, YoloEntryHash)", () => {
    // Vecteur calculé par edge-setup/internal/connector/yolo_audit.go (PR 3) sur ces mêmes entrées.
    const genesis = yoloAuditGenesis(RUNTIME);
    expect(genesis).toBe("0e4fa97dbd490a840793b97290d5453d02479faa4b1310bb86258bf3728bca77");
    const first = {
      seq: 1, eventId: id(101), occurredAt: 1793491307, leaseId: LEASE, profile: "designer", gateKind: "plugin_tool",
      toolKey: "write_file", argsHash: "cb1533f3eb4170695956d87bb17a94f79c8126c59bb60392d71d7e7c20192465", prevHash: genesis,
    };
    const h1 = yoloAuditEntryHash(first);
    expect(h1).toBe("d6cca717bdb8c3b0145df5843cfd0ebe3fdb5d7926ddc8aecb318ca5b05b0983");
    // Un `toolKey` nul (porte du terminal) entre dans la forme canonique comme `null`.
    expect(yoloAuditEntryHash({
      seq: 2, eventId: id(102), occurredAt: 1793491308, leaseId: LEASE, profile: "designer", gateKind: "terminal_danger",
      toolKey: null, argsHash: "c9cb855ad8ca1bacbb1aa0c33e2f092cf96153d561473bc8ccbeae1132a9f944", prevHash: h1,
    })).toBe("6fd854fcf52d09421597b620b3afaab9c343792ab5179b249f35fc5f2501a78f");
  });

  const known = new Set([LEASE]);
  const verdict = (entries: RelayYoloAuditEntry[], tail: { seq: number; hash: string } | null, stored = new Map<number, string>(), leases = known) =>
    verifyYoloAuditSlice({ runtimeId: RUNTIME, entries, tail, stored, knownLeases: leases });

  test("une première tranche part de la genèse ; la suivante suit le dernier maillon", () => {
    const first = chain(3);
    expect(verdict(first, null)).toEqual({ kind: "append", entries: first });
    const next = chain(2, { tail: { seq: 3, hash: first[2]!.entryHash } });
    expect(verdict(next, { seq: 3, hash: first[2]!.entryHash })).toEqual({ kind: "append", entries: next });
  });

  test("idempotence : une tranche rejouée n'apporte rien ; un recouvrement n'apporte que le neuf", () => {
    const entries = chain(4);
    const stored = new Map(entries.slice(0, 2).map((entry) => [entry.seq, entry.entryHash]));
    expect(verdict(entries.slice(0, 2), { seq: 2, hash: entries[1]!.entryHash }, stored)).toEqual({ kind: "append", entries: [] });
    expect(verdict(entries, { seq: 2, hash: entries[1]!.entryHash }, stored)).toEqual({ kind: "append", entries: entries.slice(2) });
  });

  test("chaîne rompue : chaque défaut est nommé avec la première séquence fautive", () => {
    const entries = chain(3);
    const tampered = entries.map((entry, index) => index === 1 ? { ...entry, argsHash: "f".repeat(64) } : entry);
    expect(verdict(tampered, null)).toEqual({ kind: "quarantine", reason: "hash_mismatch", brokenSeq: 2 });
    // Un hôte qui recommence à la genèse sur un runtime qui a déjà un journal.
    expect(verdict(chain(2), { seq: 2, hash: "9".repeat(64) }, new Map([[1, "8".repeat(64)], [2, "9".repeat(64)]])))
      .toEqual({ kind: "quarantine", reason: "conflict", brokenSeq: 1 });
    expect(verdict(chain(2, { tail: { seq: 5, hash: "7".repeat(64) } }), { seq: 3, hash: "7".repeat(64) }))
      .toEqual({ kind: "quarantine", reason: "seq_gap", brokenSeq: 6 });
    expect(verdict(chain(2, { tail: { seq: 3, hash: "7".repeat(64) } }), { seq: 3, hash: "6".repeat(64) }))
      .toEqual({ kind: "quarantine", reason: "prev_mismatch", brokenSeq: 4 });
    expect(verdict(chain(2, { runtimeId: id(99) }), null)).toEqual({ kind: "quarantine", reason: "prev_mismatch", brokenSeq: 1 });
    expect(verdict(chain(1, { leaseId: OTHER_LEASE }), null)).toEqual({ kind: "quarantine", reason: "unknown_lease", brokenSeq: 1 });
  });

  test("après une quarantaine, la suite chaînée sur la tranche gardée reprend le journal", () => {
    const quarantined = chain(2, { tail: { seq: 3, hash: "7".repeat(64) } });
    const tail = { seq: 5, hash: quarantined[1]!.entryHash };
    const next = chain(1, { tail });
    expect(verdict(next, tail)).toEqual({ kind: "append", entries: next });
  });
});

type Statement = { sql: string; values: unknown[] };

/** A fake database that answers the YOLO queries of `link-yolo.ts` and records every statement. */
function yoloDb(state: {
  runtime?: boolean;
  tail?: { seq: number; hash: string } | null;
  stored?: Array<{ seq: number; hash: string }>;
  knownLeases?: string[];
  live?: Array<{ id: string; payload: unknown; keyId: string; signature: string }>;
  hostRevoked?: string[];
  recentQuarantine?: boolean;
} = {}) {
  const statements: Statement[] = [];
  const inserted = new Set<number>();
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    statements.push({ sql, values });
    if (sql.includes("select name from runtimes")) return state.runtime === false ? [] : [{ name: "MacBook atelier" }];
    if (sql.includes("union all")) return state.tail ? [state.tail] : [];
    if (sql.includes("write_seq between")) return state.stored ?? [];
    if (sql.includes("select id from permission_yolo_leases")) return (state.knownLeases ?? [LEASE]).map((lease) => ({ id: lease }));
    if (sql.includes("received_at > now()")) return state.recentQuarantine ? [{ one: 1 }] : [];
    if (sql.includes("insert into permission_yolo_audit_quarantine")) return [{ id: "7", receivedAt: new Date("2026-11-02T09:14:00Z") }];
    if (sql.includes("insert into permission_yolo_audit")) {
      const seq = values[3] as number;
      if (inserted.has(seq)) return [];
      inserted.add(seq);
      return [{ one: 1 }];
    }
    if (sql.includes("revoke_permission_yolo_leases_by_host")) return (state.hostRevoked ?? []).map((leaseId) => ({ leaseId }));
    if (sql.includes("select id, payload, key_id")) return state.live ?? [];
    if (sql.includes("join users u")) return [{ userId: id(11), email: "owner@example.com" }];
    if (sql.includes("select slug from organizations")) return [{ slug: "atelier" }];
    if (sql.includes("insert into email_outbox")) return [{ id: id(700) }];
    return [];
  }) as unknown as Bun.TransactionSQL;
  const db = { begin: async (callback: (inner: Bun.TransactionSQL) => Promise<unknown>) => callback(tx) } as unknown as Db;
  return { db, statements, store: createLinkLivenessStore(db, { webAppUrl: "https://openedbot.app" }) };
}

describe("persistance de yolo.audit", () => {
  test("une tranche saine s'insère sous le tenant, jeton revérifié, sans doublon au rejeu", async () => {
    const fixture = yoloDb();
    const entries = chain(2);
    expect(await fixture.store.yoloAudit!(link, auditFrame(entries))).toEqual({ outcome: "recorded", inserted: 2 });
    expect(fixture.statements[0]!.sql).toContain("app.organization_id");
    expect(fixture.statements[0]!.values[0]).toBe(ORG);
    const check = fixture.statements.find(({ sql }) => sql.includes("select name from runtimes"))!;
    expect(check.values).toEqual([RUNTIME, ORG, link.tokenHash, link.tokenHash]);
    expect(fixture.statements.some(({ sql }) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    const inserts = fixture.statements.filter(({ sql }) => sql.includes("insert into permission_yolo_audit\n"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]!.sql).toContain("on conflict (runtime_id, write_seq) do nothing");
    // Les mêmes séquences, rejouées après un accusé perdu : rien de plus n'entre.
    expect(await fixture.store.yoloAudit!(link, auditFrame(entries))).toEqual({ outcome: "duplicate", inserted: 0 });
  });

  test("un runtime révoqué, ou un jeton qui n'est plus le sien, n'écrit rien", async () => {
    const fixture = yoloDb({ runtime: false });
    await expect(fixture.store.yoloAudit!(link, auditFrame(chain(1)))).rejects.toThrow();
    expect(fixture.statements.some(({ sql }) => sql.includes("insert into"))).toBe(false);
  });

  test("chaîne rompue : quarantaine, journal du lien et e-mail aux owners et admins, jamais d'insertion au journal", async () => {
    const fixture = yoloDb({ tail: { seq: 3, hash: "7".repeat(64) } });
    const frame = auditFrame(chain(2, { tail: { seq: 3, hash: "6".repeat(64) } }));
    expect(await fixture.store.yoloAudit!(link, frame)).toEqual({ outcome: "quarantined", reason: "prev_mismatch", brokenSeq: 4 });
    expect(fixture.statements.some(({ sql }) => sql.includes("insert into permission_yolo_audit\n"))).toBe(false);
    const quarantine = fixture.statements.find(({ sql }) => sql.includes("insert into permission_yolo_audit_quarantine"))!;
    expect(quarantine.values.slice(0, 7)).toEqual([ORG, RUNTIME, 4, 5, frame.tail, "prev_mismatch", 4]);
    // Les entrées sont gardées telles que reçues : métadonnées et hash, jamais d'argument.
    expect(JSON.parse(quarantine.values[7] as string)).toEqual(frame.entries);
    const event = fixture.statements.find(({ sql }) => sql.includes("insert into runtime_link_events"))!;
    expect(event.sql).toContain("'anchor_tampered'");
    expect(event.values[2]).toEqual({ reason: "yolo_audit_prev_mismatch", writeSeq: 4 });
    const email = fixture.statements.find(({ sql }) => sql.includes("insert into email_outbox"))!;
    expect(email.values).toContain("yolo_audit_quarantined");
    expect(email.values).toContain("yolo_audit_quarantined:7:" + id(11));
  });

  test("une quarantaine dans l'heure ne renvoie pas d'e-mail, mais se garde et se journalise", async () => {
    const fixture = yoloDb({ recentQuarantine: true });
    const outcome = await fixture.store.yoloAudit!(link, auditFrame(chain(1, { leaseId: OTHER_LEASE })));
    expect(outcome).toEqual({ outcome: "quarantined", reason: "unknown_lease", brokenSeq: 1 });
    expect(fixture.statements.some(({ sql }) => sql.includes("insert into permission_yolo_audit_quarantine"))).toBe(true);
    expect(fixture.statements.some(({ sql }) => sql.includes("insert into runtime_link_events"))).toBe(true);
    expect(fixture.statements.some(({ sql }) => sql.includes("insert into email_outbox"))).toBe(false);
  });
});

describe("persistance de yolo.state", () => {
  test("livraison et état hôte écrits ; un bail vivant non cité est redonné, un bail actif inconnu est retiré", async () => {
    const live = leaseFrame(LEASE);
    const fixture = yoloDb({ live: [{ id: LEASE, payload: live.lease, keyId: live.keyId, signature: live.signature }] });
    const outcome = await fixture.store.yoloState!(link, { t: "yolo.state", leases: [{ leaseId: OTHER_LEASE, status: "active" }] });
    expect(outcome).toEqual({ redeliver: [live], revoke: [OTHER_LEASE], revokedByHost: 0 });
    const update = fixture.statements.find(({ sql }) => sql.includes("update permission_yolo_leases l"))!;
    expect(update.sql).toContain("delivered_at = coalesce(l.delivered_at, now())");
    expect(update.values).toEqual([`{"${OTHER_LEASE}"}`, `{"active"}`, `{""}`, ORG, RUNTIME]);
    expect(fixture.statements.some(({ sql }) => sql.includes("revoke_permission_yolo_leases_by_host"))).toBe(false);
  });

  test("kill hôte (`edge-setup yolo off`) : les baux émis jusqu'à killedAt sont révoqués ici, raison host_cli", async () => {
    const fixture = yoloDb({ hostRevoked: [LEASE] });
    const killedAt = 1_793_491_500;
    const outcome = await fixture.store.yoloState!(link, { t: "yolo.state", leases: [], killedAt });
    expect(outcome).toEqual({ redeliver: [], revoke: [], revokedByHost: 1 });
    const revoke = fixture.statements.find(({ sql }) => sql.includes("revoke_permission_yolo_leases_by_host"))!;
    expect(revoke.values).toEqual([ORG, RUNTIME, link.tokenHash, null, new Date(killedAt * 1000), "host_cli"]);
    const marked = fixture.statements.find(({ sql }) => sql.includes("host_state_reason = 'host_kill'"))!;
    expect(marked.values).toContain(`{"${LEASE}"}`);
  });

  test("un bail refusé par l'hôte est révoqué ici, raison host_rejected", async () => {
    const fixture = yoloDb({ hostRevoked: [LEASE] });
    await fixture.store.yoloState!(link, { t: "yolo.state", leases: [{ leaseId: LEASE, status: "rejected", reason: "key_unknown" }] });
    const revoke = fixture.statements.find(({ sql }) => sql.includes("revoke_permission_yolo_leases_by_host"))!;
    expect(revoke.values).toEqual([ORG, RUNTIME, link.tokenHash, `{"${LEASE}"}`, null, "host_rejected"]);
  });
});

function openBroker(yolo: Pick<LinkLivenessStore, "yoloState" | "yoloAudit">, features: string[] = YOLO_FEATURES) {
  const sent: RelayTextFrame[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const broker = new RuntimeLinkBroker({
    instanceId: "api-test", pingIntervalMs: 60_000, log: (event, fields) => logs.push({ event, fields }),
    liveness: { connected: async () => {}, seen: async () => {}, disconnected: async () => {}, ...yolo },
  });
  const connection = broker.open({
    send: (raw) => { if (typeof raw === "string") sent.push(decodeTextFrame(raw)); return 1; },
    close() {},
  });
  connection.features = [...features];
  return { broker, connection, sent, logs };
}

describe("ingestion sur le lien", () => {
  test("yolo.audit accusé après écriture (journal ou quarantaine), jamais avant l'admission ni pour un autre runtime", async () => {
    const seen: RelayYoloAuditFrame[] = [];
    let next: "recorded" | "quarantined" = "recorded";
    const { broker, connection, sent, logs } = openBroker({
      yoloAudit: async (_link, frame) => {
        seen.push(frame);
        return next === "recorded" ? { outcome: "recorded", inserted: frame.entries.length } : { outcome: "quarantined", reason: "hash_mismatch", brokenSeq: frame.fromSeq };
      },
    });
    const frame = auditFrame(chain(2));
    connection.handleText(frame);
    await settle();
    expect(seen).toHaveLength(0);
    broker.bind(connection, link);
    connection.handleText(auditFrame(chain(1), id(99)));
    connection.handleText(frame);
    await settle();
    expect(seen).toEqual([frame]);
    expect(sent).toEqual([{ t: "yolo.audit.ack", toSeq: 2 }]);
    expect(logs.some((entry) => entry.event === "runtime_link.yolo_audit_refused" && entry.fields.reason === "runtime_mismatch")).toBe(true);
    next = "quarantined";
    connection.handleText(frame);
    await settle();
    expect(sent.at(-1)).toEqual({ t: "yolo.audit.ack", toSeq: 2 });
    expect(logs.some((entry) => entry.event === "runtime_link.yolo_audit_quarantined" && entry.fields.reason === "hash_mismatch")).toBe(true);
    broker.closeAll();
  });

  test("une écriture ratée n'est pas accusée : l'hôte garde la tranche et la renverra", async () => {
    const { broker, connection, sent, logs } = openBroker({ yoloAudit: async () => { throw new Error("db down"); } });
    broker.bind(connection, link);
    connection.handleText(auditFrame(chain(1)));
    await settle();
    expect(sent).toEqual([]);
    expect(logs.some((entry) => entry.event === "runtime_link.yolo_audit_write_failed")).toBe(true);
    expect(connection.isClosed).toBe(false);
    broker.closeAll();
  });

  test("yolo.state : redonne les baux manquants et retire les baux morts, dans les capacités de l'hôte", async () => {
    const runtimeLease = leaseFrame(LEASE);
    const threadLease = leaseFrame(OTHER_LEASE, "thread");
    const yolo = { yoloState: async () => ({ redeliver: [runtimeLease, threadLease], revoke: [id(203)], revokedByHost: 0 }) };
    const full = openBroker(yolo);
    full.broker.bind(full.connection, link);
    full.connection.handleText({ t: "yolo.state", leases: [] });
    await settle();
    expect(full.sent.map((frame) => frame.t)).toEqual(["yolo.lease", "yolo.lease", "yolo.revoke"]);
    expect(full.sent[2]).toMatchObject({ t: "yolo.revoke", leaseId: id(203) });
    full.broker.closeAll();
    // Sans `yolo_thread_scope`, un bail de thread n'est jamais poussé (jamais élargi).
    const partial = openBroker(yolo, [RELAY_FEATURE_YOLO_LEASE]);
    partial.broker.bind(partial.connection, link);
    partial.connection.handleText({ t: "yolo.state", leases: [] });
    await settle();
    expect(partial.sent.map((frame) => frame.t === "yolo.lease" ? frame.lease.scope : frame.t)).toEqual(["runtime", "yolo.revoke"]);
    partial.broker.closeAll();
  });

  test("capabilities garde yolo_* quand l'hôte les annonce encore ; sans elles, plus rien n'est poussé", async () => {
    const yolo = { yoloState: async () => ({ redeliver: [leaseFrame(LEASE)], revoke: [], revokedByHost: 0 }) };
    const { broker, connection, sent } = openBroker(yolo, []);
    broker.bind(connection, link);
    connection.handleText({ t: "capabilities", features: ["approval_policy", ...YOLO_FEATURES] });
    expect(connection.features).toEqual(["approval_policy", ...YOLO_FEATURES]);
    connection.handleText({ t: "yolo.state", leases: [] });
    await settle();
    expect(sent.map((frame) => frame.t)).toEqual(["yolo.lease"]);
    connection.handleText({ t: "capabilities", features: ["approval_policy"] });
    connection.handleText({ t: "yolo.state", leases: [] });
    await settle();
    expect(sent).toHaveLength(1);
    broker.closeAll();
  });
});

describe("poussée des baux", () => {
  const forwarder = (location: LinkLocation, pushed = true) => {
    const forwarded: unknown[] = [];
    return { forwarded, locate: async () => location, forwardYolo: async (_runtimeId: string, frame: unknown) => { forwarded.push(frame); return pushed; } };
  };

  test("le lien d'ici d'abord, sinon l'instance qui le tient ; sans lien, journalisé, jamais levé", async () => {
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const log = (event: string, fields: Record<string, unknown>) => logs.push({ event, fields });
    const { broker, connection, sent } = openBroker({});
    broker.bind(connection, link);
    const remote = forwarder({ kind: "remote", instanceId: "gateway-b", internalUrl: "http://gateway-b:8792" });
    const frame = leaseFrame(LEASE);
    await createLinkYoloPublisher(broker, remote, log).pushLease({ organizationId: ORG, runtimeId: RUNTIME, frame });
    expect(sent).toEqual([frame]);
    expect(remote.forwarded).toEqual([]);
    await createLinkYoloPublisher(broker, remote, log).pushRevoke({ organizationId: ORG, runtimeId: id(52), frame: { t: "yolo.revoke", all: true, revokedAt: 1 } });
    expect(remote.forwarded).toEqual([{ t: "yolo.revoke", all: true, revokedAt: 1 }]);
    const none = forwarder({ kind: "unavailable", detail: "no_link" });
    await createLinkYoloPublisher(null, none, log).pushLease({ organizationId: ORG, runtimeId: RUNTIME, frame });
    expect(none.forwarded).toEqual([]);
    expect(logs.map((entry) => entry.fields.outcome)).toEqual(["pushed", "pushed", "no_link"]);
    broker.closeAll();
  });

  test("le relais de contrôle `kind: yolo` pousse sur le lien d'ici, refuse une trame invalide et relaie au propriétaire", async () => {
    const config = linkConfig();
    const { broker, connection, sent } = openBroker({});
    broker.bind(connection, link);
    const forwarded: unknown[] = [];
    const locator = {
      locate: async () => ({ kind: "remote", instanceId: "gateway-b", internalUrl: "http://gateway-b:8792" }),
      forwardYolo: async (_runtimeId: string, frame: unknown) => { forwarded.push(frame); return true; },
    } as unknown as RuntimeLinkLocator;
    const routes = runtimeLinkInternalRoutes(config, broker, locator);
    const post = (runtimeId: string, body: unknown) => routes.request(`/${runtimeId}/control`, {
      method: "POST", headers: { Authorization: `Bearer ${config.workerInternalToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const frame = leaseFrame(LEASE);
    expect(await (await post(RUNTIME, { kind: "yolo", frame })).json()).toEqual({ pushed: true });
    expect(sent).toEqual([frame]);
    expect((await post(RUNTIME, { kind: "yolo", frame: { t: "yolo.audit.ack", toSeq: 1 } })).status).toBe(400);
    expect((await post(RUNTIME, { kind: "yolo", frame: { ...frame, signature: "forged" } })).status).toBe(400);
    expect(await (await post(id(52), { kind: "yolo", frame })).json()).toEqual({ pushed: true });
    expect(forwarded).toEqual([frame]);
    broker.closeAll();
  });
});

describe("clés de bail dans link.context", () => {
  test("clé courante puis retirées, chacune endossée par la suivante ; parties publiques seulement", () => {
    const keys = yoloLinkLeaseKeys({ seed: TEST_SEED, previousSeeds: [OLDER_SEED] });
    const signer = createYoloLeaseSigner({ seed: TEST_SEED, previousSeeds: [OLDER_SEED] });
    expect(keys.map(({ keyId, publicKey }) => ({ keyId, publicKey }))).toEqual(signer.keys.map(({ keyId, publicKey }) => ({ keyId, publicKey })));
    const [current, older] = keys;
    expect(older).toEqual({ keyId: signer.keys[1]!.keyId, publicKey: signer.keys[1]!.publicKey });
    expect(current!.endorsedBy).toBe(older!.keyId);
    const olderPublic = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(older!.publicKey, "base64")]), format: "der", type: "spki" });
    const message = Buffer.from(`${YOLO_KEY_ENDORSEMENT_PREFIX}${current!.keyId}\n${current!.publicKey}`);
    expect(verify(null, message, olderPublic, Buffer.from(current!.endorsement!, "base64"))).toBe(true);
    // Le contrat du lien les accepte telles quelles ; aucune graine n'y figure.
    const context = decodeTextFrame(JSON.stringify({ t: "link.context", environment: "dev", ohb: "https://openedbot.app", leaseKeys: keys }));
    expect(context.t === "link.context" && context.leaseKeys).toEqual(keys);
    expect(JSON.stringify(keys)).not.toContain(Buffer.from(TEST_SEED).toString("base64"));
    expect(yoloLinkLeaseKeys({ seed: null, previousSeeds: [] })).toEqual([]);
  });

  test("la passerelle annonce leaseKeys, et un hello qui liste yolo_* sous la borne est admis tel quel", async () => {
    const leaseKeys = yoloLinkLeaseKeys({ seed: TEST_SEED, previousSeeds: [] });
    // L'hôte le plus chargé annonce ~28 noms, yolo_* en dernier : la borne annoncée (64) les couvre.
    const features = [...Array.from({ length: 26 }, (_, index) => `feature_${index + 1}`), ...YOLO_FEATURES];
    expect(features.length).toBeLessThanOrEqual(RELAY_MAX_FEATURES);
    const session = await openLinkSession({ registeredDeviceKey: null, features, leaseKeys });
    const frame = await session.waitFrame((entry) => entry.t === "link.context");
    expect(frame.t === "link.context" && frame.leaseKeys).toEqual(leaseKeys);
    expect(frame.t === "link.context" && frame.limits).toEqual({ features: RELAY_MAX_FEATURES });
    expect(session.shared.broker.connection(LINK_RUNTIME_ID)?.features).toEqual(features);
  });

  test("le faux hôte (PR 8) : clés reçues, bail redonné, audit chaîné vérifié ici puis accusé et purgé", async () => {
    const lease = leaseFrame(LEASE);
    const audits: RelayYoloAuditFrame[] = [];
    const shared = startShared({
      registeredDeviceKey: null,
      leaseKeys: yoloLinkLeaseKeys({ seed: TEST_SEED, previousSeeds: [] }),
      yolo: {
        yoloState: async () => ({ redeliver: [lease], revoke: [], revokedByHost: 0 }),
        // Le hash du faux hôte est écrit à part : il doit passer la vérification du cloud.
        yoloAudit: async (identity, frame) => {
          audits.push(frame);
          const verdict = verifyYoloAuditSlice({ runtimeId: identity.runtimeId, entries: frame.entries, tail: null, stored: new Map(), knownLeases: new Set([LEASE]) });
          if (verdict.kind !== "append") throw new Error(`the fake host chain does not verify: ${JSON.stringify(verdict)}`);
          return { outcome: "recorded", inserted: verdict.entries.length };
        },
      },
    });
    const host = new FakeHostAgent({
      wsUrl: `ws://127.0.0.1:${shared.server.port}${RUNTIME_LINK_WS_PATH}`,
      auth: { kind: "link", runtimeId: LINK_RUNTIME_ID, linkToken: LINK_TOKEN },
      gatewayUrl: "http://127.0.0.1:9", gatewayToken: "local-bearer", features: YOLO_FEATURES,
    });
    await host.connect();
    for (let attempt = 0; attempt < 200 && !host.leaseKeys; attempt++) await Bun.sleep(5);
    expect(host.leaseKeys?.[0]?.keyId).toBe(createYoloLeaseSigner({ seed: TEST_SEED, previousSeeds: [] }).keys[0]!.keyId);
    host.sendYoloState([]);
    expect(await host.waitYolo((frame) => frame.t === "yolo.lease")).toEqual(lease);
    host.sendYoloAudit(LINK_RUNTIME_ID, [
      { leaseId: LEASE, profile: "designer", gateKind: "plugin_tool", toolKey: "write_file", args: "{\"path\":\"/tmp/x\"}" },
      { leaseId: LEASE, profile: "designer", gateKind: "terminal_danger", toolKey: null, args: "chmod 777 build" },
    ]);
    expect(await host.waitYolo((frame) => frame.t === "yolo.audit.ack")).toEqual({ t: "yolo.audit.ack", toSeq: 2 });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain("chmod 777 build");
    host.close();
  });

  test("bout en bout : yolo.state à la reconnexion fait redonner le bail manquant sur le même lien", async () => {
    const lease = leaseFrame(LEASE);
    const session = await openLinkSession({
      registeredDeviceKey: null, features: YOLO_FEATURES,
      yolo: { yoloState: async () => ({ redeliver: [lease], revoke: [], revokedByHost: 0 }) },
    });
    await session.waitFrame((entry) => entry.t === "link.context");
    session.send({ t: "yolo.state", leases: [] });
    expect(await session.waitFrame((entry) => entry.t === "yolo.lease")).toEqual(lease);
  });
});
