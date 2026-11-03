import { afterAll, describe, expect, test } from "bun:test";
import { encryptSecret, secretEncryptionKey } from "@openedbot/hermes";
import { RELAY_FEATURE_CREATION_AUDIT_V2 } from "@openedbot/contracts-connector";
import { hashCredential } from "../src/infrastructure/crypto";
import {
  auditKeyFrame,
  ensureAuditKey,
  recordAuditAnchor,
  rotateAuditKey,
  type AuditKeyRow,
} from "@openedbot/runtime-link/application/audit-keys";
import {
  LINK_ENCRYPTION_KEY,
  LINK_RUNTIME_ID,
  openLinkSession,
  stopLinkSessions,
  type Statement,
} from "./fixtures/link-gateway-session";

afterAll(() => stopLinkSessions());

const master = Buffer.alloc(32, 5);
const currentKeyring = secretEncryptionKey(new Uint8Array(Buffer.from(LINK_ENCRYPTION_KEY, "base64")));
const olderKeyring = secretEncryptionKey(new Uint8Array(Buffer.alloc(32, 9)));

function keyRow(keyId: string, keyring = currentKeyring, retired = false): AuditKeyRow {
  const encrypted = encryptSecret(master.toString("base64"), keyring.value);
  return {
    keyId, ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, tag: encrypted.tag, keyEncryptionKeyId: keyring.id,
    createdAt: new Date("2026-09-06T10:00:00Z"), retiredAt: retired ? new Date("2026-09-06T11:00:00Z") : null,
  };
}

function fakeTx(rows: AuditKeyRow[], statements: Statement[], anchor: { writeSeq: number } | null = null) {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    statements.push({ sql, values });
    if (sql.includes("from runtime_audit_keys") && sql.includes("key_id = ")) return rows.filter((row) => row.keyId === values[2]).map((row) => ({ keyId: row.keyId }));
    if (sql.includes("from runtime_audit_keys")) return rows;
    if (sql.includes("update runtime_audit_keys set retired_at")) {
      for (const row of rows) if (row.retiredAt === null) row.retiredAt = new Date();
      return [];
    }
    if (sql.includes("insert into runtime_audit_anchors")) {
      const writeSeq = Number(values[3]);
      if (anchor && anchor.writeSeq > writeSeq) return [];
      return [{ runtimeId: LINK_RUNTIME_ID }];
    }
    return [];
  }) as unknown as Bun.TransactionSQL;
}

describe("clé d'audit remise à la liaison", () => {
  test("hello avec creation_audit_v2 : audit.key part juste après la liaison, avec la clé courante", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null, features: [RELAY_FEATURE_CREATION_AUDIT_V2], auditKeyRows: [] });
    const frame = await session.waitFrame((entry) => entry.t === "audit.key");
    if (frame.t !== "audit.key") throw new Error("unreachable");
    expect(frame.runtimeId).toBe(LINK_RUNTIME_ID);
    expect(Buffer.from(frame.key, "base64").byteLength).toBe(32);
    expect(frame.previous).toBeUndefined();
    // La clé a été créée sous la porte du credential, chiffrée par le keyring, et n'est journalisée nulle part.
    const insert = session.shared.statements.find((entry) => entry.sql.includes("insert into runtime_audit_keys"));
    expect(insert).toBeDefined();
    expect(insert!.values).toContain(currentKeyring.id);
    expect(JSON.stringify(session.shared.logs)).not.toContain(frame.key);
    expect(session.shared.liveness.some((entry) => entry.write === "connected")).toBe(true);
  });

  test("hello sans la feature : aucune audit.key, aucune clé créée", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null, features: ["provider_management"] });
    await session.waitLiveness((entry) => entry.write === "connected");
    await Bun.sleep(30);
    expect(session.frames.some((frame) => frame.t === "audit.key")).toBe(false);
    expect(session.shared.statements.some((entry) => entry.sql.includes("runtime_audit_keys"))).toBe(false);
  });

  test("une clé retirée encore lisible part dans previous (au plus deux, les plus récentes)", async () => {
    const rows = [keyRow("k-3"), keyRow("k-2", currentKeyring, true), keyRow("k-1", currentKeyring, true), keyRow("k-0", currentKeyring, true)];
    const session = await openLinkSession({ registeredDeviceKey: null, features: [RELAY_FEATURE_CREATION_AUDIT_V2], auditKeyRows: rows });
    const frame = await session.waitFrame((entry) => entry.t === "audit.key");
    if (frame.t !== "audit.key") throw new Error("unreachable");
    expect(frame.keyId).toBe("k-3");
    expect(frame.previous?.map((entry) => entry.keyId)).toEqual(["k-2", "k-1"]);
    expect(frame.previous?.every((entry) => entry.key === master.toString("base64"))).toBe(true);
  });

  test("audit.anchor est persistée ; une position en recul est refusée et journalisée", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null, features: [RELAY_FEATURE_CREATION_AUDIT_V2], auditKeyRows: [keyRow("k-1")], anchorOutcome: "regressed" });
    await session.waitFrame((entry) => entry.t === "audit.key");
    session.send({ t: "audit.anchor", runtimeId: LINK_RUNTIME_ID, keyId: "k-1", writeSeq: 2, count: 1, dropped: 0, tail: "b".repeat(64) });
    await session.waitLiveness((entry) => entry.write === "anchor");
    await session.waitLiveness((entry) => entry.write === "event" && entry.kind === "clock_skew");
    expect(session.shared.logs.some((entry) => entry.event === "runtime_link.audit_anchor_refused")).toBe(true);
  });

  test("une ancre pour un autre runtime est ignorée", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null, features: [RELAY_FEATURE_CREATION_AUDIT_V2], auditKeyRows: [keyRow("k-1")] });
    await session.waitFrame((entry) => entry.t === "audit.key");
    session.send({ t: "audit.anchor", runtimeId: "00000000-0000-4000-8000-000000000000", keyId: "k-1", writeSeq: 1, count: 1, dropped: 0, tail: "c".repeat(64) });
    await Bun.sleep(50);
    expect(session.shared.liveness.some((entry) => entry.write === "anchor")).toBe(false);
  });
});

describe("journal de dispatch", () => {
  test("un POST /v1/runs relayé est journalisé avec le hash de l'Idempotency-Key, le statut et le run_id", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null });
    await session.waitLiveness((entry) => entry.write === "connected");
    const dialer = session.shared.broker.dialer(LINK_RUNTIME_ID);
    const pending = dialer({ method: "POST", path: "/p/bot-a/v1/runs", headers: { "idempotency-key": "run-42" }, body: null });
    const request = await session.waitFrame((frame) => frame.t === "req");
    if (request.t !== "req") throw new Error("unreachable");
    session.send({ t: "res", id: request.id, status: 200, headers: { "content-type": "application/json" } });
    session.sendBody(request.id, JSON.stringify({ run_id: "remote-9", prompt: "never stored" }));
    session.send({ t: "end", id: request.id });
    const response = await pending;
    expect(await response.text()).toContain("remote-9");
    const dispatched = await session.waitLiveness((entry) => entry.write === "dispatched");
    if (dispatched.write !== "dispatched") throw new Error("unreachable");
    expect(dispatched.record).toMatchObject({ idempotencyKeyHash: hashCredential("run-42"), status: 200, remoteId: "remote-9" });
    expect(dispatched.record.dispatchedAt).toBeInstanceOf(Date);
  });

  test("un lien fermé après l'envoi journalise le dispatch sans statut (livraison ambiguë)", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null });
    await session.waitLiveness((entry) => entry.write === "connected");
    const dialer = session.shared.broker.dialer(LINK_RUNTIME_ID);
    const pending = dialer({ method: "POST", path: "/v1/runs", headers: {}, body: null });
    await session.waitFrame((frame) => frame.t === "req");
    session.shared.broker.closeLink(LINK_RUNTIME_ID, 1012, "TEST_CLOSE");
    await expect(pending).rejects.toThrow();
    const dispatched = await session.waitLiveness((entry) => entry.write === "dispatched");
    if (dispatched.write !== "dispatched") throw new Error("unreachable");
    expect(dispatched.record).toMatchObject({ idempotencyKeyHash: null, status: null, remoteId: null });
  });

  test("une lecture (GET) ou une autre route n'est jamais journalisée comme dispatch", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null });
    await session.waitLiveness((entry) => entry.write === "connected");
    const dialer = session.shared.broker.dialer(LINK_RUNTIME_ID);
    const pending = dialer({ method: "GET", path: "/v1/runs/abc", headers: {}, body: null });
    const request = await session.waitFrame((frame) => frame.t === "req");
    if (request.t !== "req") throw new Error("unreachable");
    session.send({ t: "res", id: request.id, status: 200, headers: {} });
    session.send({ t: "end", id: request.id });
    await pending;
    await Bun.sleep(30);
    expect(session.shared.liveness.some((entry) => entry.write === "dispatched")).toBe(false);
  });
});

describe("clés d'audit en base", () => {
  test("ensureAuditKey crée la clé courante quand il n'y en a pas, chiffrée par le keyring courant", async () => {
    const statements: Statement[] = [];
    const keys = await ensureAuditKey(fakeTx([], statements), "org-1", LINK_RUNTIME_ID, { current: currentKeyring, previous: [] });
    expect(keys.current.key.byteLength).toBe(32);
    expect(keys.previous).toEqual([]);
    const insert = statements.find((entry) => entry.sql.includes("insert into runtime_audit_keys"));
    expect(insert!.values).toContain(keys.current.keyId);
    expect(insert!.values).toContain(currentKeyring.id);
    expect(JSON.stringify(insert!.values)).not.toContain(Buffer.from(keys.current.key).toString("base64"));
  });

  test("une clé chiffrée sous une clé de keyring précédente se déchiffre encore", async () => {
    const statements: Statement[] = [];
    const rows = [keyRow("k-old", olderKeyring)];
    const keys = await ensureAuditKey(fakeTx(rows, statements), "org-1", LINK_RUNTIME_ID, { current: currentKeyring, previous: [olderKeyring] });
    expect(keys.current.keyId).toBe("k-old");
    expect(Buffer.from(keys.current.key).equals(master)).toBe(true);
  });

  test("rotateAuditKey retire la clé courante et en crée une nouvelle ; la trame remet l'ancienne dans previous", async () => {
    const statements: Statement[] = [];
    const rows = [keyRow("k-1")];
    const keys = await rotateAuditKey(fakeTx(rows, statements), "org-1", LINK_RUNTIME_ID, { current: currentKeyring, previous: [] });
    expect(keys.current.keyId).not.toBe("k-1");
    expect(keys.previous.map((entry) => entry.keyId)).toEqual(["k-1"]);
    const frame = auditKeyFrame(LINK_RUNTIME_ID, keys);
    expect(frame).toMatchObject({ t: "audit.key", runtimeId: LINK_RUNTIME_ID, keyId: keys.current.keyId });
    expect(frame.previous).toEqual([{ keyId: "k-1", key: master.toString("base64") }]);
  });

  test("recordAuditAnchor : clé inconnue refusée, position en recul refusée, sinon enregistrée", async () => {
    const statements: Statement[] = [];
    const frame = { t: "audit.anchor" as const, runtimeId: LINK_RUNTIME_ID, keyId: "k-1", writeSeq: 3, count: 2, dropped: 0, tail: "a".repeat(64) };
    expect(await recordAuditAnchor(fakeTx([], statements), "org-1", LINK_RUNTIME_ID, frame)).toBe("unknown_key");
    expect(await recordAuditAnchor(fakeTx([keyRow("k-1")], statements, { writeSeq: 5 }), "org-1", LINK_RUNTIME_ID, frame)).toBe("regressed");
    expect(await recordAuditAnchor(fakeTx([keyRow("k-1")], statements, { writeSeq: 2 }), "org-1", LINK_RUNTIME_ID, frame)).toBe("recorded");
    const upsert = statements.filter((entry) => entry.sql.includes("insert into runtime_audit_anchors"));
    expect(upsert.every((entry) => entry.sql.includes("runtime_audit_anchors.write_seq <= excluded.write_seq"))).toBe(true);
  });
});
