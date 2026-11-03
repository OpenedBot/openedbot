/**
 * Mode YOLO de bout en bout (PR 8/8) : les vraies routes `/api/organization/yolo`,
 * la vraie passerelle WebSocket du lien et son broker, sur une base PostgreSQL
 * jetable (rôle `ohb_api`), face au faux hôte (`tests/fake-hermes/host-agent.ts`
 * pour le fil, `host-yolo.ts` pour ce que l'hôte décide seul) et au faux Hermes.
 *
 *   1. un bot, un outil ou un membre n'octroie jamais (403), rien n'est poussé ;
 *   2. un owner octroie un bail de conversation : l'hôte reçoit `yolo.lease`,
 *      vérifie la signature sur la clé épinglée par `link.context`, rejette une
 *      copie altérée, et l'état de l'hôte remonte (`delivered_at`, `active`) ;
 *   3. une écriture dans /tmp est auto-approuvée sans humain ; l'audit qui
 *      arrive au cloud ne porte que le hash des arguments ; la même écriture
 *      dans une autre conversation reste à un humain ;
 *   4. `.ssh` et `.env` sont refusés sous YOLO, sans entrée d'audit ;
 *   5. une porte terminal ordinaire est approuvée « once » par l'auto-répondeur
 *      sur le gateway local ; une commande hardline reste à un humain ;
 *   6. le bail échu par l'horloge de l'hôte : retour au comportement normal ;
 *   7. lien coupé : une auto-approbation est journalisée hors ligne, puis
 *      `edge-setup yolo off` (killedAt) ; au retour du lien le cloud révoque
 *      (`host_cli`), l'audit est enregistré et acquitté, un renvoi est idempotent ;
 *   8. « Couper YOLO partout » pousse `yolo.revoke {all}` à l'hôte ;
 *   9. une chaîne altérée est mise en quarantaine, jamais enregistrée.
 */
import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { RelayYoloLeaseFrame, RelayYoloAuditFrame } from "@openedbot/contracts-connector";
import { HttpError } from "../../contracts/errors/src/http-error";
import { readApiConfig } from "../../platform/config/src/api-config";
import { hashCredential } from "../../platform/db/src/credential";
import { RuntimeLinkBroker, createLinkLivenessStore } from "../../modules/runtime-link/src/application/broker";
import { createRuntimeLinkGateway, RUNTIME_LINK_WS_PATH, type LinkSocketData } from "../../modules/runtime-link/src/application/gateway";
import { createRuntimeLinkLocator } from "../../modules/runtime-link/src/application/instances";
import { createLinkYoloPublisher, yoloLinkLeaseKeys } from "../../modules/runtime-link/src/application/link-yolo";
import { yoloRoutes } from "../../apps/api/src/routes/identity/yolo-routes";
import type { AppVariables, AuthContext } from "../../apps/api/src/routes/identity/auth";
import { startFakeHermes } from "../fake-hermes/server";
import { FakeHostAgent } from "../fake-hermes/host-agent";
import { FakeHostYolo, type FakeYoloGate } from "../fake-hermes/host-yolo";
import { withDisposablePostgres } from "./disposable-postgres";

const id = (n: number) => `96000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1);
const OWNER = id(11);
const ADMIN = id(12);
const MEMBER = id(13);
const SECTION = id(21);
const BOT = id(31);
const THREAD = id(41);
const OTHER_THREAD = id(42);
const RUNTIME = id(51);
const SESSION = "hermes-session-yolo-e2e";
const OTHER_SESSION = "hermes-session-yolo-other";
// Jetons de TEST générés pour ce processus : jamais des valeurs réelles.
const LINK_TOKEN = `yolo-e2e-${crypto.randomUUID()}`;
const GATEWAY_TOKEN = `yolo-e2e-gateway-${crypto.randomUUID()}`;
// Une graine de TEST publique (0x40..0x5f) : jamais une vraie clé.
const TEST_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 64);
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function eventually<T>(read: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error(`timeout: ${label}`);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const actors: Record<string, AuthContext> = {
  owner: { sessionId: "s-owner", organizationId: ORG, userId: OWNER, role: "owner", kind: "web", credentialHash: "c-owner" },
  admin: { sessionId: "s-admin", organizationId: ORG, userId: ADMIN, role: "admin", kind: "native", credentialHash: "c-admin" },
  member: { sessionId: "s-member", organizationId: ORG, userId: MEMBER, role: "member", kind: "web", credentialHash: "c-member" },
  // Une identité de bot ou d'outil MCP qui porterait le rôle owner : jamais une session humaine.
  bot: { sessionId: "s-bot", organizationId: ORG, userId: OWNER, role: "owner", kind: "bot", credentialHash: "c-bot" } as unknown as AuthContext,
  mcp: { sessionId: "s-mcp", organizationId: ORG, userId: OWNER, role: "owner", kind: "mcp", credentialHash: "c-mcp" } as unknown as AuthContext,
};

await withDisposablePostgres("ohb160_yolo_link_e2e", async ({ owner, connect }) => {
  const linkDb = await connect("ohb_api");
  const routesDb = await connect("ohb_api");

  for (const [user, email] of [[OWNER, "owner@example.com"], [ADMIN, "admin@example.com"], [MEMBER, "member@example.com"]] as const) {
    await owner`insert into users (id, email) values (${user}, ${email})`;
  }
  await owner`insert into organizations (id, slug, name, permission_pipeline) values (${ORG}, 'yolo-e2e', 'Acme', 'v2')`;
  await owner`insert into memberships (organization_id, user_id, role) values (${ORG}, ${OWNER}, 'owner'), (${ORG}, ${ADMIN}, 'admin'), (${ORG}, ${MEMBER}, 'member')`;
  await owner`insert into sections (id, organization_id, name, position) values (${SECTION}, ${ORG}, 'Acme', 0)`;
  await owner`insert into bots (id, organization_id, section_id, name, slug, position, permission_mode, hermes_profile) values
    (${BOT}, ${ORG}, ${SECTION}, 'Designer', 'designer', 0, 'manual', 'designer')`;
  await owner`insert into threads (id, organization_id, bot_id, title, hermes_session_id) values
    (${THREAD}, ${ORG}, ${BOT}, 'Maquette', ${SESSION}), (${OTHER_THREAD}, ${ORG}, ${BOT}, 'Autre', ${OTHER_SESSION})`;
  // Aucune capacité en base : c'est le `hello` du faux hôte qui annonce `yolo_lease`.
  await owner`insert into runtimes (id, organization_id, name, reachability, is_active, link_token_hash, link_features, last_health_status) values
    (${RUNTIME}, ${ORG}, 'Mac', 'connector', true, ${hashCredential(LINK_TOKEN)}, '{}', 'healthy')`;

  // ---------------------------------------------------------------- le cloud
  const signing = { seed: TEST_SEED, previousSeeds: [] };
  const config = readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY });
  const broker = new RuntimeLinkBroker({
    instanceId: "api-yolo-e2e",
    liveness: createLinkLivenessStore(linkDb, { webAppUrl: "https://openedbot.app" }),
    pingIntervalMs: 60_000,
    log: () => undefined,
  });
  const wsUrls: string[] = [];
  const gateway = createRuntimeLinkGateway({ db: linkDb, config, broker, wsUrls, leaseKeys: yoloLinkLeaseKeys(signing), log: () => undefined });
  const linkServer = Bun.serve<LinkSocketData, string>({
    port: 0,
    fetch: (request, server) => gateway.handleUpgrade(request, server),
    websocket: {
      open: (ws) => gateway.websocket.open(ws),
      message: (ws, message) => gateway.websocket.message(ws, message),
      close: (ws, code, reason) => gateway.websocket.close(ws, code, reason),
      pong: (ws) => gateway.websocket.pong(ws),
    },
  });
  const wsUrl = `ws://127.0.0.1:${linkServer.port}${RUNTIME_LINK_WS_PATH}`;
  wsUrls.push(wsUrl);
  const locator = createRuntimeLinkLocator(routesDb, { instanceId: "api-yolo-e2e", apiInternalUrl: "http://api.invalid", workerInternalToken: "internal-token" });
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", actors[context.req.header("x-test-actor") ?? ""]!);
    await next();
  });
  app.route("/api/organization/yolo", yoloRoutes(routesDb, { signing, publisher: createLinkYoloPublisher(broker, locator, () => undefined) }));
  app.onError((error, context) => {
    if (error instanceof HttpError) {
      return context.json({ error: { code: error.code, ...(error.details ? { details: error.details } : {}) } }, error.status as 400);
    }
    throw error;
  });
  const call = (who: keyof typeof actors, method: string, path: string, body?: unknown) => app.request(`/api/organization/yolo${path}`, {
    method,
    headers: { "x-test-actor": who, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  // ----------------------------------------------------------------- l'hôte
  const hermes = startFakeHermes({ port: 0, token: GATEWAY_TOKEN, delayMs: 0 });
  const hardlineHermes = startFakeHermes({ port: 0, token: GATEWAY_TOKEN, delayMs: 0, terminalCommand: "sudo rm -rf / --no-preserve-root" });
  const gatewayUrl = hermes.url.toString().replace(/\/$/, "");
  let clockOffset = 0;
  const now = () => Math.floor(Date.now() / 1000) + clockOffset;
  let agent!: FakeHostAgent;
  const host = new FakeHostYolo({ runtimeId: RUNTIME, now, journal: (records) => agent.recordYoloAudit(RUNTIME, records) });
  agent = new FakeHostAgent({
    wsUrl, auth: { kind: "link", runtimeId: RUNTIME, linkToken: LINK_TOKEN }, gatewayUrl, gatewayToken: GATEWAY_TOKEN,
    features: ["yolo_lease", "yolo_thread_scope"],
    onLeaseKeys: (keys) => host.pin(keys),
    // Comme edge-setup : chaque trame reçue change l'état, et l'état remonte.
    onYolo: (frame) => {
      if (frame.t === "yolo.audit.ack") return;
      host.receive(frame);
      agent.sendYoloState(host.states());
    },
  });

  const leaseRow = async (leaseId: string) => (await owner<Array<{ hostState: string; reason: string | null; delivered: boolean; revoke: string | null; by: string | null }>>`
    select host_state as "hostState", host_state_reason as reason, delivered_at is not null as delivered, revoke_reason as revoke, revoked_by_user_id as by
      from permission_yolo_leases where id = ${leaseId}`)[0]!;
  const auditRows = () => owner<Array<{ seq: string; leaseId: string; gateKind: string; toolKey: string | null; argsHash: string; row: string }>>`
    select write_seq::text as seq, lease_id as "leaseId", gate_kind as "gateKind", tool_key as "toolKey", args_hash as "argsHash", to_jsonb(a)::text as row
      from permission_yolo_audit a where runtime_id = ${RUNTIME} order by write_seq`;
  const writeGate = (path: string, sessionId: string | null = SESSION): FakeYoloGate => ({
    profile: "designer", sessionId, gateKind: "plugin_tool", toolKey: "write_file", paths: [path], command: null,
    args: JSON.stringify({ path, content: "rapport" }),
  });
  // Une fonction, pas une propriété : `assert` ne fige pas la longueur d'une étape à l'autre.
  const pendingCount = () => agent.yoloPending.length;
  const flushAndAck = async () => {
    const from = agent.yoloFrames.length;
    const frame = agent.flushYoloAudit(RUNTIME);
    await agent.waitYolo((received) => received.t === "yolo.audit.ack" && received.toSeq === frame.toSeq, from);
    return frame;
  };

  try {
    await agent.connect();
    await eventually(async () => (await owner<Array<{ features: string[] }>>`
      select link_features as features from runtimes where id = ${RUNTIME} and link_connected_at is not null`)[0]?.features.includes("yolo_lease"),
      "the host's hello did not announce yolo_lease");
    await eventually(async () => agent.leaseKeys, "link.context carried no leaseKeys");

    // 1. Un bot, un outil MCP ou un membre n'octroie jamais ; rien n'est écrit ni poussé.
    const threadGrant = { scope: "thread", botId: BOT, threadId: THREAD, acknowledged: true };
    for (const [who, code] of [["bot", "YOLO_HUMAN_REQUIRED"], ["mcp", "YOLO_HUMAN_REQUIRED"], ["member", "ROLE_REQUIRED"]] as const) {
      const response = await call(who, "POST", "/leases", threadGrant);
      const body = await response.json() as { error?: { code?: string } };
      assert(response.status === 403 && body.error?.code === code, `${who} was not refused with ${code}: ${response.status} ${JSON.stringify(body)}`);
    }
    assert((await call("member", "POST", "/kill")).status === 403, "a member used the kill switch");
    assert((await owner`select 1 from permission_yolo_leases`).length === 0, "a refused grant wrote a lease");
    assert(agent.yoloFrames.length === 0, "a refused grant pushed a frame to the host");

    // 2. L'owner octroie (4 h par défaut) ; l'hôte vérifie la signature lui-même et l'état remonte.
    const granted = await call("owner", "POST", "/leases", threadGrant);
    assert(granted.status === 201, `the owner's grant failed: ${granted.status} ${await granted.clone().text()}`);
    const lease = (await granted.json() as { lease: { id: string; issuedAt: string; expiresAt: string } }).lease;
    assert(Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt) === 14_400_000, "the thread lease does not last 4 h by default");
    const pushed = await agent.waitYolo((frame) => frame.t === "yolo.lease" && frame.lease.leaseId === lease.id) as RelayYoloLeaseFrame;
    assert(pushed.lease.scope === "thread" && pushed.lease.profile === "designer" && pushed.lease.sessionKey === sha256(SESSION)
      && pushed.lease.grantedBy === OWNER && pushed.lease.protect.includes("ssh") && pushed.lease.protect.includes("env"),
      `the pushed lease is not the granted one: ${JSON.stringify(pushed.lease)}`);
    assert(host.states().some((state) => state.leaseId === lease.id && state.status === "active"), `the host did not accept the signed lease: ${JSON.stringify(host.states())}`);
    // Une copie altérée (une heure de plus) ne passe pas la vérification de l'hôte.
    const probe = new FakeHostYolo({ runtimeId: RUNTIME, now, journal: () => { throw new Error("a probe never journals"); } });
    probe.pin(agent.leaseKeys);
    probe.receive({ ...pushed, lease: { ...pushed.lease, leaseId: id(901), expiresAt: pushed.lease.expiresAt + 3600 } });
    probe.receive({ ...pushed, lease: { ...pushed.lease, leaseId: id(902), runtimeId: id(59) } });
    assert(JSON.stringify(probe.states()) === JSON.stringify([
      { leaseId: id(901), status: "rejected", reason: "signature_invalid" },
      { leaseId: id(902), status: "rejected", reason: "signature_invalid" },
    ]), `a tampered lease passed the host verification: ${JSON.stringify(probe.states())}`);
    await eventually(async () => { const row = await leaseRow(lease.id); return row.delivered && row.hostState === "active"; }, "the host state did not reach the cloud");
    const listed = await (await call("member", "GET", `/leases?threadId=${THREAD}`)).json() as { leases: Array<{ id: string }> };
    assert(listed.leases.map((item) => item.id).join() === lease.id, "a member does not see the live lease (badge, countdown)");

    // 3. /tmp sans humain ; seule cette conversation est couverte ; l'audit ne porte qu'un hash.
    const tmpWrite = writeGate("/tmp/yolo-e2e/rapport.md");
    assert(host.decide(tmpWrite).decision === "auto", "a /tmp write under the lease was not auto-approved");
    assert(host.decide(writeGate("/tmp/yolo-e2e/rapport.md", OTHER_SESSION)).decision === "ask", "a thread lease covered another conversation");
    assert(host.decide({ ...tmpWrite, profile: "redaction" }).decision === "ask", "a thread lease covered another bot");
    const firstSlice = await flushAndAck();
    assert(firstSlice.entries.length === 1, "the host did not journal exactly one auto-approval");
    const recorded = await auditRows();
    assert(recorded.length === 1 && recorded[0]!.leaseId === lease.id && recorded[0]!.gateKind === "plugin_tool"
      && recorded[0]!.toolKey === "write_file" && recorded[0]!.argsHash === sha256(tmpWrite.args),
      `the cloud audit is not the auto-approval: ${JSON.stringify(recorded)}`);
    assert(!recorded[0]!.row.includes("/tmp/yolo-e2e") && !recorded[0]!.row.includes("rapport"), "the cloud audit holds the arguments in clear");
    assert(pendingCount() === 0, "the acknowledged entry was not purged on the host");
    const audit = await (await call("owner", "GET", `/audit?leaseId=${lease.id}`)).json() as { entries: Array<{ argsHash: string; gateKind: string }> };
    assert(audit.entries.length === 1 && audit.entries[0]!.argsHash === sha256(tmpWrite.args), `the owner does not read the audit: ${JSON.stringify(audit)}`);
    assert((await call("member", "GET", "/audit")).status === 403, "a member read the YOLO audit");

    // 4. .ssh et .env refusés sous YOLO, sans entrée d'audit.
    for (const [path, reason] of [["/home/hermes/.ssh/authorized_keys", "protected ssh"], ["/srv/app/.env", "protected env"]] as const) {
      const verdict = host.decide(writeGate(path));
      assert(verdict.decision === "deny" && verdict.reason === reason, `${path} was not refused under YOLO: ${JSON.stringify(verdict)}`);
    }
    assert(host.decide({ ...writeGate("/tmp/x"), toolKey: "cronjob", paths: [] }).decision === "deny", "a hardline tool passed under YOLO");
    assert(pendingCount() === 0, "a refused gate was journaled as auto-approved");

    // 5. Le terminal : l'auto-répondeur répond « once » sur le gateway local ; une commande hardline reste à un humain.
    const startRun = async (url: string, input: string) => {
      const response = await fetch(`${url}/v1/runs`, {
        method: "POST", headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input, session_id: SESSION }),
      });
      return (await response.json() as { run_id: string }).run_id;
    };
    const runId = await startRun(gatewayUrl, "build FAKE_APPROVAL:terminal");
    const terminal = await host.answerTerminalApprovals({ gatewayUrl, gatewayToken: GATEWAY_TOKEN, runId, profile: "designer", sessionId: SESSION, until: () => false });
    const run = await (await fetch(`${gatewayUrl}/v1/runs/${runId}`, { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } })).json() as { status: string };
    assert(terminal.length === 1 && terminal[0]!.decision === "auto" && run.status === "completed", `the terminal gate was not auto-approved: ${JSON.stringify({ terminal, run })}`);
    const hardlineUrl = hardlineHermes.url.toString().replace(/\/$/, "");
    const hardRun = await startRun(hardlineUrl, "FAKE_APPROVAL:terminal");
    const hard = await host.answerTerminalApprovals({ gatewayUrl: hardlineUrl, gatewayToken: GATEWAY_TOKEN, runId: hardRun, profile: "designer", sessionId: SESSION, until: (verdicts) => verdicts.length > 0 });
    const hardStatus = await (await fetch(`${hardlineUrl}/v1/runs/${hardRun}`, { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } })).json() as { status: string };
    assert(hard[0]?.decision === "deny" && hard[0].reason === "hardline rm_root_or_home" && hardStatus.status === "waiting_for_approval",
      `a hardline command was not left to a human: ${JSON.stringify({ hard, hardStatus })}`);
    await fetch(`${hardlineUrl}/v1/runs/${hardRun}/stop`, { method: "POST", headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } });
    const terminalSlice = await flushAndAck();
    assert(terminalSlice.entries.length === 1 && terminalSlice.entries[0]!.gateKind === "terminal_danger" && terminalSlice.entries[0]!.toolKey === null,
      `the terminal auto-approval was not journaled: ${JSON.stringify(terminalSlice.entries)}`);
    assert((await auditRows()).map((row) => row.seq).join() === "1,2", "the chain did not go on after the acknowledgement");

    // 6. Échu par l'horloge de l'hôte : retour à un humain, l'hôte le dit au cloud.
    clockOffset = pushed.lease.expiresAt - Math.floor(Date.now() / 1000) + 1;
    assert(host.decide(tmpWrite).decision === "ask", "an elapsed lease still auto-approved");
    agent.sendYoloState(host.states());
    await eventually(async () => (await leaseRow(lease.id)).hostState === "expired", "the host's expiry did not reach the cloud");
    clockOffset = 0;

    // 7. Lien coupé : auto-approbation journalisée, puis `yolo off` ; au retour, révocation host_cli et audit acquitté.
    const botGrant = await call("admin", "POST", "/leases", { scope: "bot", botId: BOT, acknowledged: true });
    assert(botGrant.status === 201, `the admin's bot grant failed: ${botGrant.status}`);
    const botLease = (await botGrant.json() as { lease: { id: string } }).lease;
    await agent.waitYolo((frame) => frame.t === "yolo.lease" && frame.lease.leaseId === botLease.id);
    await eventually(async () => (await leaseRow(botLease.id)).hostState === "active", "the bot lease was not delivered");
    agent.close();
    await eventually(async () => agent.closeCode !== null, "the link did not close");
    const offlineWrite = writeGate("/tmp/yolo-e2e/hors-ligne.md", OTHER_SESSION);
    assert(host.decide(offlineWrite).decision === "auto", "the host did not decide alone while offline");
    assert(pendingCount() === 1, "the offline auto-approval was not journaled");
    // Une seconde plus tard, `edge-setup yolo off` : le bail émis avant est mort pour l'hôte.
    clockOffset = 1;
    host.kill();
    assert(host.decide(offlineWrite).decision === "ask", "a write passed after `yolo off`");
    assert((await leaseRow(botLease.id)).revoke === null, "the cloud revoked before hearing from the host");
    await agent.connect();
    await eventually(async () => (await owner`select 1 from runtimes where id = ${RUNTIME} and link_connected_at is not null`).length === 1, "the link did not come back");
    agent.sendYoloState(host.states(), host.killedAt!);
    const offlineSlice = await flushAndAck();
    await eventually(async () => (await leaseRow(botLease.id)).revoke === "host_cli", "the host kill did not revoke the lease in the cloud");
    const killed = await leaseRow(botLease.id);
    assert(killed.by === null && killed.hostState === "revoked", `the host revocation is not attributed to the host: ${JSON.stringify(killed)}`);
    const afterSync = await auditRows();
    assert(afterSync.length === 3 && afterSync[2]!.leaseId === botLease.id && afterSync[2]!.argsHash === sha256(offlineWrite.args),
      `the offline audit was not synchronised: ${JSON.stringify(afterSync)}`);
    // Le même envoi, rejoué : acquitté, rien de neuf.
    const from = agent.yoloFrames.length;
    agent.sendYoloAuditFrame(offlineSlice);
    await agent.waitYolo((frame) => frame.t === "yolo.audit.ack" && frame.toSeq === offlineSlice.toSeq, from);
    assert((await auditRows()).length === 3, "a replayed slice was recorded twice");
    clockOffset = 0;

    // 8. « Couper YOLO partout » : tout est révoqué et l'hôte reçoit `yolo.revoke {all}`.
    const fresh = await call("owner", "POST", "/leases", { scope: "runtime", acknowledged: true });
    const runtimeLease = (await fresh.json() as { lease: { id: string } }).lease;
    assert(fresh.status === 201, `the runtime grant failed: ${fresh.status}`);
    // L'hôte refuse ce bail tant que son `yolo off` tient (issuedAt ≤ killedAt) ; le cloud le révoque aussitôt.
    const fromKill = agent.yoloFrames.length;
    const kill = await call("owner", "POST", "/kill");
    assert(kill.status === 200, `the kill switch failed: ${kill.status}`);
    await agent.waitYolo((frame) => frame.t === "yolo.revoke" && "all" in frame && frame.all === true, fromKill);
    assert((await owner`select 1 from permission_yolo_leases where revoked_at is null`).length === 0, "a lease survived the kill switch");
    assert((await leaseRow(runtimeLease.id)).revoke !== null, "the runtime lease was not revoked");

    // 9. Une chaîne altérée : en quarantaine, journalisée, jamais dans l'audit.
    agent.recordYoloAudit(RUNTIME, [{ leaseId: lease.id, profile: "designer", gateKind: "plugin_tool", toolKey: "write_file", args: "{}" }]);
    const honest = agent.yoloPending.at(-1)!;
    const tampered: RelayYoloAuditFrame = { t: "yolo.audit", runtimeId: RUNTIME, entries: [{ ...honest, argsHash: "f".repeat(64) }], fromSeq: honest.seq, toSeq: honest.seq, tail: honest.entryHash };
    const fromTamper = agent.yoloFrames.length;
    agent.sendYoloAuditFrame(tampered);
    await agent.waitYolo((frame) => frame.t === "yolo.audit.ack" && frame.toSeq === honest.seq, fromTamper);
    assert((await auditRows()).length === 3, "a tampered entry reached the audit");
    const quarantine = await owner<Array<{ reason: string }>>`select reason from permission_yolo_audit_quarantine where runtime_id = ${RUNTIME}`;
    assert(quarantine.length === 1 && quarantine[0]!.reason === "hash_mismatch", `the tampered slice was not quarantined: ${JSON.stringify(quarantine)}`);
    assert((await owner`select 1 from runtime_link_events where runtime_id = ${RUNTIME} and kind = 'anchor_tampered'`).length === 1, "the quarantine was not journaled");
  } finally {
    agent.close();
    await broker.flushPersistence();
    linkServer.stop(true);
    hermes.stop(true);
    hardlineHermes.stop(true);
  }
});

console.log("yolo-link integration: grant, host verification, auto-approval, protections, hardline, expiry, offline kill, audit sync and quarantine hold end to end.");
