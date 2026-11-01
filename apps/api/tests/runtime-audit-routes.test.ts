import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  auditGenesis,
  chainNext,
  encryptSecret,
  sealCreationAudit,
  secretEncryptionKey,
  type CreationAuditEvent,
  type CreationAuditSnapshot,
} from "@openedbot/hermes";
import type { RelayTextFrame } from "@openedbot/contracts-connector";
import { readApiConfig } from "../src/infrastructure/config";
import { hashCredential } from "../src/infrastructure/crypto";
import type { RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import { createVerdictSigner, verifyVerdictSignature } from "@openedbot/runtime-link/application/audit-verdict";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { compareAnchor, checkWormAnchor, creationAuditRoutes, runtimeAuditRoutes, AUDIT_EXPORT_MAX_BYTES } from "../src/routes/runtimes/runtime-audit-routes";
import { anchorObjectKey, anchorRecordBytes, MemoryAuditWormStore, verdictObjectKey, type AuditWormStore } from "@openedbot/runtime-link/application/audit-worm";

/**
 * La route de vérification face à une base factice : chaque code d'erreur du
 * contrat, le verdict signé, l'idempotence, la liste, la rotation de clé et
 * la publication de la clé de verdict.
 */
const RUNTIME_ID = "8f3b2c1d-1111-4222-8333-444455556666";
const ORGANIZATION_ID = "org-1";
const owner: AuthContext = { sessionId: "s", organizationId: ORGANIZATION_ID, userId: "user-1", role: "owner", kind: "web", credentialHash: "hash" };
const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const config = readApiConfig({ OHB_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: encryptionKey });
const keyring = secretEncryptionKey(new Uint8Array(Buffer.from(encryptionKey, "base64")));
const master = new Uint8Array(Buffer.alloc(32, 5));
const RUN_KEY = "ohb-run-1";
const RUN_HASH = hashCredential(RUN_KEY);

type Statement = { sql: string; values: unknown[] };
type Verification = Record<string, unknown>;

function keyRow(keyId = "k-1", keyEncryptionKeyId = keyring.id, retiredAt: Date | null = null) {
  const encrypted = encryptSecret(Buffer.from(master).toString("base64"), keyring.value);
  return { keyId, ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, tag: encrypted.tag, keyEncryptionKeyId, createdAt: new Date("2026-09-06T10:00:00Z"), retiredAt };
}

function events(overrides: { hash?: string; remoteId?: string; occurredAt?: string } = {}): CreationAuditEvent[] {
  const hash = overrides.hash ?? RUN_HASH;
  const attempt: CreationAuditEvent = {
    eventId: "0c0d0e0f-1011-4213-9415-161718191a1b", attemptId: "0c0d0e0f-1011-4213-9415-161718191a1b", phase: "attempt",
    occurredAt: overrides.occurredAt ?? "2026-09-06T12:00:03Z", runtimeId: RUNTIME_ID, profile: "bot-a", correlationId: hash,
    idempotencyKeyHash: hash, method: "POST", path: "/v1/runs",
  };
  const outcome: CreationAuditEvent = {
    ...attempt, eventId: "28292a2b-2c2d-4e2f-b031-323334353637", phase: "outcome", occurredAt: "2026-09-06T12:00:05Z",
    status: 200, remoteId: overrides.remoteId ?? "remote-1", outcome: "response",
  };
  return [attempt, outcome];
}

function snapshot(list: CreationAuditEvent[], writeSeq = 3): CreationAuditSnapshot {
  let tail = auditGenesis(RUNTIME_ID);
  for (const event of list) tail = chainNext(tail, event);
  return {
    schemaVersion: 2, startedAt: "2026-09-06T12:00:01Z", lastWrittenAt: "2026-09-06T12:00:06Z", runtimeId: RUNTIME_ID,
    writeSeq, count: list.length, dropped: 0, base: auditGenesis(RUNTIME_ID), tail, events: list,
  };
}

function seal(state: CreationAuditSnapshot, options: { keyId?: string; headerWriteSeq?: number; runtimeId?: string } = {}): Uint8Array {
  return sealCreationAudit(
    { keyId: options.keyId ?? "k-1", runtimeId: options.runtimeId ?? RUNTIME_ID, schemaVersion: 2, writeSeq: options.headerWriteSeq ?? state.writeSeq },
    state,
    master,
  );
}

type MountOptions = {
  role?: AuthContext["role"];
  runtime?: { id: string; reachability: string } | null;
  keys?: ReturnType<typeof keyRow>[];
  anchor?: { keyId: string; writeSeq: number; eventCount: number; dropped: number; tail: string; receivedAt: Date } | null;
  dispatches?: Array<{ hash: string; dispatchedAt: Date }>;
  runs?: string[];
  pushFrame?: (runtimeId: string, frame: RelayTextFrame) => boolean;
  /** Le bucket WORM (OHB-57) ; absent = `worm: disabled`. */
  worm?: AuditWormStore | null;
  /** `audit.anchor` de l'organisation (AuditAnchor bloquant). */
  anchorBlocking?: (organizationId: string) => Promise<boolean>;
};

function mount(options: MountOptions = {}) {
  const statements: Statement[] = [];
  const verifications: Verification[] = [];
  const events: Array<{ kind: unknown; meta: unknown }> = [];
  const keys = options.keys ?? [keyRow()];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join("?");
    statements.push({ sql, values });
    if (sql.includes("from runtimes")) return options.runtime === undefined ? [{ id: RUNTIME_ID, reachability: "connector" }] : options.runtime ? [options.runtime] : [];
    if (sql.includes("from runtime_audit_verifications") && sql.includes("export_sha256 =")) {
      return verifications.filter((row) => row.exportSha256 === values[2]);
    }
    if (sql.includes("from runtime_audit_verifications")) return [...verifications].reverse();
    if (sql.includes("insert into runtime_audit_verifications")) {
      const [id, , runtimeId, exportSha256, keyId, verdict, errorCode, anchorState, writeSeq, eventCount, dropped, tail, startedAt, lastWrittenAt, findings, signature, signatureKeyId, receivedAt] = values;
      if (!verifications.some((row) => row.exportSha256 === exportSha256)) {
        verifications.push({ id, runtimeId, exportSha256, keyId, verdict, errorCode, anchorState, writeSeq, eventCount, dropped, tail, startedAt, lastWrittenAt, findings, signature, signatureKeyId, receivedAt });
      }
      return [];
    }
    if (sql.includes("update runtime_audit_keys set retired_at")) {
      for (const key of keys) if (key.retiredAt === null) key.retiredAt = new Date();
      return [];
    }
    if (sql.includes("from runtime_audit_keys")) return keys;
    if (sql.includes("from runtime_audit_anchors")) return options.anchor ? [{ ...options.anchor }] : [];
    if (sql.includes("from runtime_link_dispatches")) {
      const wanted = values[2] as string[];
      return (options.dispatches ?? [{ hash: RUN_HASH, dispatchedAt: new Date("2026-09-06T12:00:02Z") }]).filter((row) => wanted.includes(row.hash));
    }
    if (sql.includes("from runs")) {
      const wanted = values[1] as string[];
      return (options.runs ?? ["remote-1"]).filter((id) => wanted.includes(id)).map((remoteId) => ({ remoteId }));
    }
    if (sql.includes("insert into runtime_link_events")) {
      events.push({ kind: values[2], meta: values[6] });
      return [];
    }
    return [];
  }) as unknown as SQL;
  // Comme `db.begin` sur PostgreSQL : une transaction dont le callback lève
  // est annulée, et ce qu'elle a inséré disparaît.
  (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin =
    async (callback) => {
      const verificationsBefore = verifications.length;
      const eventsBefore = events.length;
      try {
        return await callback(tx as unknown as Bun.TransactionSQL);
      } catch (error) {
        verifications.length = verificationsBefore;
        events.length = eventsBefore;
        throw error;
      }
    };
  const signer = createVerdictSigner(config.auditVerdictSigning);
  const links: RuntimeLinks = {
    connected: () => true, dial: () => () => Promise.reject(new Error("unused")), revoke: () => false,
    notifyRotation: () => false, close: () => false, pushFrame: options.pushFrame ?? (() => false),
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => { context.set("auth", { ...owner, role: options.role ?? "owner" }); await next(); });
  app.onError((error, context) => {
    if (error instanceof HttpError) return context.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    throw error;
  });
  app.route("/api/runtimes", runtimeAuditRoutes(tx, config, { links, signer, worm: options.worm ?? null, anchorBlocking: options.anchorBlocking }));
  app.route("/api/creation-audit", creationAuditRoutes(config, { signer }));
  return { app, statements, verifications, events, signer };
}

function submit(app: Hono<{ Variables: AppVariables }>, body: Uint8Array, headers: Record<string, string> = {}) {
  return app.request(`/api/runtimes/${RUNTIME_ID}/creation-audit/verifications`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body: new Blob([body as unknown as ArrayBuffer]),
  });
}

type VerdictBody = {
  id: string; verdict: string; anchor: string; errorCode: string | null; findings: Array<{ kind: string }>;
  events?: unknown[]; signature?: { keyId: string; value: string; ephemeral: boolean }; error?: { code: string; message: string };
} & Record<string, unknown>;

describe("POST /api/runtimes/:id/creation-audit/verifications", () => {
  test("refuse un membre avant toute lecture", async () => {
    const mounted = mount({ role: "member" });
    const response = await submit(mounted.app, seal(snapshot(events())));
    expect(response.status).toBe(403);
    expect(mounted.statements).toHaveLength(0);
  });

  test("exige application/octet-stream, une borne de taille et un corps non vide", async () => {
    const mounted = mount();
    expect((await submit(mounted.app, seal(snapshot(events())), { "Content-Type": "application/json" })).status).toBe(415);
    expect((await submit(mounted.app, new Uint8Array(1), { "Content-Length": String(AUDIT_EXPORT_MAX_BYTES + 1) })).status).toBe(413);
    const empty = await submit(mounted.app, new Uint8Array(0));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as VerdictBody).error?.code).toBe("AUDIT_FORMAT_INVALID");
  });

  test("un snapshot.json v1 en clair est refusé 409 avec le message opérateur, et le refus est persisté", async () => {
    const mounted = mount();
    const response = await submit(mounted.app, new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, runtimeId: RUNTIME_ID, events: [] })));
    expect(response.status).toBe(409);
    const body = (await response.json()) as VerdictBody;
    expect(body.error?.code).toBe("AUDIT_PLAINTEXT_EXPORT");
    expect(body.error?.message).toContain("mettez à jour edge-setup");
    expect(mounted.verifications).toHaveLength(1);
    expect(mounted.verifications[0]).toMatchObject({ verdict: "invalid", errorCode: "AUDIT_PLAINTEXT_EXPORT" });
  });

  test("un en-tête qui nomme un autre runtime est 409 AUDIT_RUNTIME_MISMATCH", async () => {
    const mounted = mount();
    const other = "00000000-0000-4000-8000-000000000001";
    const response = await submit(mounted.app, seal({ ...snapshot(events()), runtimeId: other }, { runtimeId: other }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as VerdictBody).error?.code).toBe("AUDIT_RUNTIME_MISMATCH");
  });

  test("une clé jamais remise à ce runtime, ou indéchiffrable par le keyring, est 409 AUDIT_KEY_UNKNOWN", async () => {
    const unknown = mount();
    const response = await submit(unknown.app, seal(snapshot(events()), { keyId: "k-ghost" }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as VerdictBody).error?.code).toBe("AUDIT_KEY_UNKNOWN");
    const stale = mount({ keys: [keyRow("k-1", "keyring-gone")] });
    const gone = await submit(stale.app, seal(snapshot(events())));
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as VerdictBody).error?.code).toBe("AUDIT_KEY_UNKNOWN");
  });

  test("un tag altéré est 422 AUDIT_AUTH_FAILED", async () => {
    const mounted = mount();
    const tampered = seal(snapshot(events()));
    const last = tampered.byteLength - 1;
    tampered[last] = tampered[last]! ^ 0x01;
    const response = await submit(mounted.app, tampered);
    expect(response.status).toBe(422);
    expect(((await response.json()) as VerdictBody).error?.code).toBe("AUDIT_AUTH_FAILED");
  });

  test("un writeSeq d'en-tête différent du clair est 422 AUDIT_SEQ_MISMATCH ; une chaîne rompue 422 AUDIT_CHAIN_BROKEN", async () => {
    const mounted = mount();
    const seq = await submit(mounted.app, seal(snapshot(events()), { headerWriteSeq: 4 }));
    expect(seq.status).toBe(422);
    expect(((await seq.json()) as VerdictBody).error?.code).toBe("AUDIT_SEQ_MISMATCH");
    const broken = await submit(mounted.app, seal({ ...snapshot(events()), tail: auditGenesis(RUNTIME_ID) }));
    expect(broken.status).toBe(422);
    expect(((await broken.json()) as VerdictBody).error?.code).toBe("AUDIT_CHAIN_BROKEN");
  });

  test("un export en retrait de la dernière ancre est 409 AUDIT_STALE_EXPORT", async () => {
    const state = snapshot(events());
    const mounted = mount({ anchor: { keyId: "k-1", writeSeq: 5, eventCount: 4, dropped: 0, tail: "f".repeat(64), receivedAt: new Date() } });
    const response = await submit(mounted.app, seal(state));
    expect(response.status).toBe(409);
    expect(((await response.json()) as VerdictBody).error?.code).toBe("AUDIT_STALE_EXPORT");
    expect(mounted.verifications[0]).toMatchObject({ verdict: "invalid", anchorState: "stale" });
  });

  test("un événement que l'API n'a jamais relayé est 422 AUDIT_UNKNOWN_DISPATCH, constats à l'appui", async () => {
    const mounted = mount({ dispatches: [] });
    const response = await submit(mounted.app, seal(snapshot(events())));
    expect(response.status).toBe(422);
    expect(((await response.json()) as VerdictBody).error?.code).toBe("AUDIT_UNKNOWN_DISPATCH");
    expect(mounted.verifications[0]).toMatchObject({ verdict: "invalid", findings: [{ kind: "unknown_dispatch" }] });
    const strangerRun = mount({ runs: [] });
    const remote = await submit(strangerRun.app, seal(snapshot(events())));
    expect(remote.status).toBe(422);
    expect(strangerRun.verifications[0]).toMatchObject({ findings: [{ kind: "unknown_remote_id" }] });
  });

  test("un export valide dont l'ancre concorde : verdict valid signé, événements rendus, résumé seul persisté", async () => {
    const state = snapshot(events());
    const mounted = mount({ anchor: { keyId: "k-1", writeSeq: 3, eventCount: 2, dropped: 0, tail: state.tail, receivedAt: new Date() } });
    const response = await submit(mounted.app, seal(state));
    expect(response.status).toBe(200);
    const body = (await response.json()) as VerdictBody;
    expect(body).toMatchObject({ verdict: "valid", anchor: "matches", errorCode: null, writeSeq: 3, count: 2, dropped: 0, tail: state.tail, findings: [] });
    expect(body.events).toHaveLength(2);
    expect(body.coverage).toEqual({ startedAt: "2026-09-06T12:00:01Z", lastWrittenAt: "2026-09-06T12:00:06Z" });
    const { events: _events, signature, ...payload } = body;
    expect(signature?.keyId).toBe(mounted.signer.keyId);
    expect(verifyVerdictSignature(payload, signature!.value, mounted.signer.publicKey)).toBe(true);
    expect(verifyVerdictSignature({ ...payload, verdict: "invalid" }, signature!.value, mounted.signer.publicKey)).toBe(false);
    expect(mounted.verifications).toHaveLength(1);
    expect(JSON.stringify(mounted.verifications[0])).not.toContain("remote-1");
    expect(JSON.stringify(mounted.statements)).not.toContain(Buffer.from(master).toString("base64"));
  });

  test("sans ancre : valid_unanchored ; ancre en retard : behind ; horloge en dérive : constat clock_skew et événement", async () => {
    const state = snapshot(events());
    const none = mount({ anchor: null });
    expect(((await (await submit(none.app, seal(state))).json()) as VerdictBody)).toMatchObject({ verdict: "valid_unanchored", anchor: "none" });
    const behind = mount({ anchor: { keyId: "k-1", writeSeq: 1, eventCount: 0, dropped: 0, tail: state.base, receivedAt: new Date() } });
    expect(((await (await submit(behind.app, seal(state))).json()) as VerdictBody)).toMatchObject({ verdict: "valid", anchor: "behind" });
    const skewed = mount({ dispatches: [{ hash: RUN_HASH, dispatchedAt: new Date("2026-09-06T11:00:00Z") }] });
    const body = (await (await submit(skewed.app, seal(state))).json()) as VerdictBody;
    expect(body.verdict).toBe("valid_unanchored");
    expect(body.findings[0]).toMatchObject({ kind: "clock_skew" });
    expect(skewed.events.some((event) => event.kind === "clock_skew")).toBe(true);
  });

  test("les mêmes octets rendent le même verdict, sans nouvelle ligne", async () => {
    const mounted = mount();
    const bytes = seal(snapshot(events()));
    const first = (await (await submit(mounted.app, bytes)).json()) as VerdictBody;
    const second = (await (await submit(mounted.app, bytes)).json()) as VerdictBody;
    expect(second.id).toBe(first.id);
    expect(second.signature?.value).toBe(first.signature?.value);
    expect(second.events).toHaveLength(2);
    expect(mounted.verifications).toHaveLength(1);
  });

  test("un refus est persisté malgré le 4xx, hors de la transaction annulée", async () => {
    const mounted = mount();
    const tampered = seal(snapshot(events()));
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    const response = await submit(mounted.app, tampered);
    expect(response.status).toBe(422);
    expect(mounted.verifications).toHaveLength(1);
    expect(mounted.verifications[0]).toMatchObject({ verdict: "invalid", errorCode: "AUDIT_AUTH_FAILED", exportSha256: createHash("sha256").update(tampered).digest("hex") });
    // La ligne est née d'une transaction dédiée, après l'annulation de la vérification.
    const inserts = mounted.statements.filter((statement) => statement.sql.includes("insert into runtime_audit_verifications"));
    expect(inserts).toHaveLength(1);
  });

  test("les mêmes octets refusés rendent le même refus, sans nouvelle ligne", async () => {
    const mounted = mount();
    const tampered = seal(snapshot(events()));
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    const first = await submit(mounted.app, tampered);
    const second = await submit(mounted.app, tampered);
    expect([first.status, second.status]).toEqual([422, 422]);
    expect(((await second.json()) as VerdictBody).error?.code).toBe("AUDIT_AUTH_FAILED");
    expect(mounted.verifications).toHaveLength(1);
    const listed = await mounted.app.request(`/api/runtimes/${RUNTIME_ID}/creation-audit/verifications`);
    const body = (await listed.json()) as { verifications: Array<{ verdict: string; errorCode: string | null }> };
    expect(body.verifications).toEqual([expect.objectContaining({ verdict: "invalid", errorCode: "AUDIT_AUTH_FAILED" })]);
  });

  test("un runtime absent est 404, un runtime non connecteur 409", async () => {
    expect((await submit(mount({ runtime: null }).app, seal(snapshot(events())))).status).toBe(404);
    expect((await submit(mount({ runtime: { id: RUNTIME_ID, reachability: "direct" } }).app, seal(snapshot(events())))).status).toBe(409);
  });
});

describe("historique, rotation et clé de verdict", () => {
  test("GET liste les verdicts du plus récent au plus ancien, signature comprise", async () => {
    const mounted = mount();
    await submit(mounted.app, seal(snapshot(events())));
    await submit(mounted.app, seal(snapshot(events(), 4)));
    const response = await mounted.app.request(`/api/runtimes/${RUNTIME_ID}/creation-audit/verifications?limit=10`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { verifications: Array<{ writeSeq: number; signature: { value: string } }> };
    expect(body.verifications.map((entry) => entry.writeSeq)).toEqual([4, 3]);
    expect(body.verifications[0]!.signature.value).toMatch(/=+$/);
  });

  test("POST key/rotate retire la clé courante, en crée une, pousse audit.key avec previous sur le lien", async () => {
    const pushed: RelayTextFrame[] = [];
    const mounted = mount({ pushFrame: (_runtimeId, frame) => { pushed.push(frame); return true; } });
    const response = await mounted.app.request(`/api/runtimes/${RUNTIME_ID}/creation-audit/key/rotate`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { keyId: string; previous: string[]; pushed: boolean };
    expect(body.previous).toEqual(["k-1"]);
    expect(body.pushed).toBe(true);
    expect(pushed[0]).toMatchObject({ t: "audit.key", runtimeId: RUNTIME_ID, keyId: body.keyId, previous: [{ keyId: "k-1" }] });
    expect(mounted.events.some((event) => event.kind === "rotated")).toBe(true);
    expect((await mount({ role: "member" }).app.request(`/api/runtimes/${RUNTIME_ID}/creation-audit/key/rotate`, { method: "POST" })).status).toBe(403);
  });

  test("GET /api/creation-audit/verdict-key publie la clé qui signe, et dit qu'elle est éphémère hors production", async () => {
    const mounted = mount();
    const response = await mounted.app.request("/api/creation-audit/verdict-key");
    const body = (await response.json()) as { keyId: string; publicKey: string; algorithm: string; ephemeral: boolean };
    expect(body).toEqual({ keyId: mounted.signer.keyId, publicKey: mounted.signer.publicKey, algorithm: "ed25519", ephemeral: true });
    expect(Buffer.from(body.publicKey, "base64").byteLength).toBe(32);
  });

  test("compareAnchor : none, matches, behind, stale (position ou tail)", () => {
    const anchor = { keyId: "k", writeSeq: 3, eventCount: 2, dropped: 0, tail: "a".repeat(64), receivedAt: new Date() };
    expect(compareAnchor(null, { writeSeq: 3, tail: "a".repeat(64) })).toBe("none");
    expect(compareAnchor(anchor, { writeSeq: 3, tail: "a".repeat(64) })).toBe("matches");
    expect(compareAnchor(anchor, { writeSeq: 4, tail: "b".repeat(64) })).toBe("behind");
    expect(compareAnchor(anchor, { writeSeq: 2, tail: "a".repeat(64) })).toBe("stale");
    expect(compareAnchor(anchor, { writeSeq: 3, tail: "b".repeat(64) })).toBe("stale");
  });
});

/** Laisse partir les dépôts WORM asynchrones (fire-and-forget) avant de les observer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ancrage WORM (OHB-57)", () => {
  const state = snapshot(events());
  const anchor = { keyId: "k-1", writeSeq: 3, eventCount: 2, dropped: 0, tail: state.tail, receivedAt: new Date() };
  const archived = (overrides: Partial<{ keyId: string; tail: string; count: number }> = {}) =>
    anchorRecordBytes({ runtimeId: RUNTIME_ID, keyId: overrides.keyId ?? "k-1", writeSeq: 3, count: overrides.count ?? 2, dropped: 0, tail: overrides.tail ?? state.tail, receivedAt: "2026-09-06T12:00:07Z" });

  test("sans store, le verdict dit worm: disabled et rien n'est déposé", async () => {
    const mounted = mount({ anchor });
    const body = (await (await submit(mounted.app, seal(state))).json()) as VerdictBody;
    expect(body).toMatchObject({ verdict: "valid", anchor: "matches", worm: "disabled" });
    expect(mounted.verifications[0]).toMatchObject({ anchorState: "matches" });
  });

  test("l'ancre archivée concorde : worm: matches, et le verdict signé est déposé une fois", async () => {
    const worm = new MemoryAuditWormStore();
    await worm.putOnce(anchorObjectKey(RUNTIME_ID, 3), archived());
    const mounted = mount({ anchor, worm });
    const bytes = seal(state);
    const body = (await (await submit(mounted.app, bytes)).json()) as VerdictBody;
    expect(body).toMatchObject({ verdict: "valid", anchor: "matches", worm: "matches" });
    await settle();
    const key = verdictObjectKey(RUNTIME_ID, body.id);
    expect(worm.keys()).toEqual([anchorObjectKey(RUNTIME_ID, 3), key]);
    const deposited = JSON.parse(new TextDecoder().decode((await worm.get(key))!)) as Record<string, unknown>;
    expect(deposited).toMatchObject({ id: body.id, verdict: "valid", worm: "matches", signature: { value: body.signature!.value } });
    expect(deposited).not.toHaveProperty("events");
    // Les mêmes octets une seconde fois : même verdict, aucun second dépôt.
    await submit(mounted.app, bytes);
    await settle();
    expect(worm.keys()).toHaveLength(2);
  });

  test("aucune ancre archivée pour cette position : worm: missing, verdict inchangé", async () => {
    const mounted = mount({ anchor, worm: new MemoryAuditWormStore() });
    const body = (await (await submit(mounted.app, seal(state))).json()) as VerdictBody;
    expect(body).toMatchObject({ verdict: "valid", anchor: "matches", worm: "missing" });
  });

  test("l'ancre archivée décrit une autre position : 422 AUDIT_ANCHOR_TAMPERED, verdict invalid persisté, événement anchor_tampered", async () => {
    const worm = new MemoryAuditWormStore();
    await worm.putOnce(anchorObjectKey(RUNTIME_ID, 3), archived({ tail: "f".repeat(64) }));
    const mounted = mount({ anchor, worm });
    const response = await submit(mounted.app, seal(state));
    expect(response.status).toBe(422);
    expect(((await response.json()) as VerdictBody).error?.code).toBe("AUDIT_ANCHOR_TAMPERED");
    expect(mounted.verifications[0]).toMatchObject({ verdict: "invalid", errorCode: "AUDIT_ANCHOR_TAMPERED", anchorState: "matches", findings: [{ kind: "anchor_tampered", detail: "export" }] });
    await settle();
    expect(mounted.events.some((event) => event.kind === "anchor_tampered")).toBe(true);
    // Le refus est archivé lui aussi.
    expect(worm.keys()).toHaveLength(2);
  });

  test("checkWormAnchor : la base réécrite pour la même position est aussi tampered ; un objet illisible aussi", async () => {
    const worm = new MemoryAuditWormStore();
    await worm.putOnce(anchorObjectKey(RUNTIME_ID, 3), archived());
    const position = { writeSeq: 3, count: 2, dropped: 0, tail: state.tail };
    expect(await checkWormAnchor(worm, RUNTIME_ID, "k-1", position, anchor)).toEqual({ state: "matches" });
    expect(await checkWormAnchor(worm, RUNTIME_ID, "k-1", position, { ...anchor, tail: "e".repeat(64) })).toEqual({ state: "tampered", detail: "database" });
    expect(await checkWormAnchor(worm, RUNTIME_ID, "k-1", position, null)).toEqual({ state: "matches" });
    expect(await checkWormAnchor(null, RUNTIME_ID, "k-1", position, anchor)).toEqual({ state: "disabled" });
    const unreadable = new MemoryAuditWormStore();
    await unreadable.putOnce(anchorObjectKey(RUNTIME_ID, 3), new TextEncoder().encode("{"));
    expect(await checkWormAnchor(unreadable, RUNTIME_ID, "k-1", position, anchor)).toEqual({ state: "tampered", detail: "unreadable" });
  });

  test("un dépôt de verdict qui échoue journalise worm_write_failed sans altérer la réponse", async () => {
    const failing: AuditWormStore = { mode: "memory", putOnce: async () => { throw new Error("bucket unreachable"); }, get: async () => null };
    const mounted = mount({ anchor, worm: failing });
    const response = await submit(mounted.app, seal(state));
    expect(response.status).toBe(200);
    expect(((await response.json()) as VerdictBody)).toMatchObject({ verdict: "valid", worm: "missing" });
    await settle();
    const event = mounted.events.find((entry) => entry.kind === "worm_write_failed");
    expect(event).toBeDefined();
    expect(event!.meta).toMatchObject({ reason: "verdict", writeSeq: 3 });
  });
});

describe("AuditAnchor (étape 5)", () => {
  const failing: AuditWormStore = { mode: "memory", putOnce: async () => { throw new Error("bucket unreachable"); }, get: async () => null };

  test("verdict : chaîné dans la transaction qui l'insère, sous sa clé WORM", async () => {
    const mounted = mount({ worm: new MemoryAuditWormStore() });
    const response = await submit(mounted.app, seal(snapshot(events())));
    expect(response.status).toBe(200);
    const body = (await response.json()) as VerdictBody;
    const insert = mounted.statements.find((entry) => entry.sql.includes("insert into audit_chain"));
    expect(insert?.values.slice(0, 5)).toEqual([ORGANIZATION_ID, RUNTIME_ID, 1, "audit_verdict", verdictObjectKey(RUNTIME_ID, body.id)]);
  });

  test("organisation audit.anchor : un ancrage en échec est 503 AUDIT_ANCHOR_FAILED et le verdict n'est pas persisté", async () => {
    const asked: string[] = [];
    const mounted = mount({ worm: failing, anchorBlocking: async (organizationId) => { asked.push(organizationId); return true; } });
    const response = await submit(mounted.app, seal(snapshot(events())));
    expect(response.status).toBe(503);
    const body = (await response.json()) as VerdictBody;
    expect(body.error?.code).toBe("AUDIT_ANCHOR_FAILED");
    expect(body.error?.message).toContain("L’ancrage externe de l’audit a échoué");
    expect(mounted.verifications).toHaveLength(0);
    expect(mounted.events.some((entry) => entry.kind === "worm_write_failed")).toBe(false);
    expect(asked).toEqual([ORGANIZATION_ID]);
  });

  test("organisation audit.anchor : un refus dont l'ancrage échoue devient 503, sans refus persisté", async () => {
    const mounted = mount({ worm: failing, anchorBlocking: async () => true });
    const response = await submit(mounted.app, new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, runtimeId: RUNTIME_ID, events: [] })));
    expect(response.status).toBe(503);
    expect(((await response.json()) as VerdictBody).error?.code).toBe("AUDIT_ANCHOR_FAILED");
    expect(mounted.verifications).toHaveLength(0);
  });

  test("sans audit.anchor : le même échec est journalisé (worm_write_failed) et la réponse inchangée", async () => {
    const mounted = mount({ worm: failing, anchorBlocking: async () => false });
    const response = await submit(mounted.app, seal(snapshot(events())));
    expect(response.status).toBe(200);
    expect(mounted.verifications).toHaveLength(1);
    expect(mounted.events.find((entry) => entry.kind === "worm_write_failed")?.meta).toMatchObject({ reason: "verdict" });
  });

  test("GET local-chain : la vérification de la chaîne locale, opérateur seulement, 404 sans runtime", async () => {
    const ok = await mount().app.request(`/api/runtimes/${RUNTIME_ID}/creation-audit/local-chain`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ runtimeId: RUNTIME_ID, valid: true, length: 0, head: null });
    expect((await mount({ role: "member" }).app.request(`/api/runtimes/${RUNTIME_ID}/creation-audit/local-chain`)).status).toBe(403);
    expect((await mount({ runtime: null }).app.request(`/api/runtimes/${RUNTIME_ID}/creation-audit/local-chain`)).status).toBe(404);
  });
});

describe("empreinte de l'export", () => {
  test("le SHA-256 persisté est celui des octets soumis", async () => {
    const mounted = mount();
    const bytes = seal(snapshot(events()));
    await submit(mounted.app, bytes);
    expect(mounted.verifications[0]!.exportSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
