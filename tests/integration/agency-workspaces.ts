import { memberInvitationRoutes } from "../../apps/api/src/routes/identity/member-invitation-routes";
import { previewAgencyInvitation, respondToAgencyInvitation } from "../../modules/identity/src/application/agency-invitation-consent";
import { sendAgencyInvitation, listAgencyInvitations, cancelAgencyInvitation } from "../../modules/identity/src/application/agency-invitations";
import { sendMemberInvitation } from "../../modules/identity/src/application/member-invitations";
/** Personal and Agency organizations proven with actual routes and PostgreSQL RLS; no customer runtime. */
import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { authMiddleware, type AppVariables } from "../../apps/api/src/routes/identity/auth";
import { memberRoutes } from "../../apps/api/src/routes/identity/member-routes";
import { workspaceRoutes } from "../../apps/api/src/routes/identity/workspace-routes";
import { fleetMounts, requireFleetPlugin } from "./pro-fleet";
import { eventRoutes } from "../../apps/api/src/routes/events/event-routes";
import { hashCredential } from "../../platform/db/src/credential";
import { hasLiveWorkspaceSession } from "../../modules/identity/src/sql/session-access";
import { EventHub } from "../../modules/notifications/src/application/event-hub";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import { agencyBusinessScenarios } from "./agency-business-scenarios";
import { installSubscriptionPort } from "../../platform/db/src/subscription-port";
import { loadApiProPlugins, organizationCreatingHookOf, subscriptionPortOf } from "../../apps/api/src/application/pro-plugins";
import { installOrganizationCreatingListener } from "../../modules/identity/src/application/organization-creating";

async function capture(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(`Test database discovery failed (${command[0]}): ${error}`);
  return output.trimEnd();
}

async function adminUrl(): Promise<URL> {
  if (process.env.INTEGRATION_ADMIN_DATABASE_URL) return new URL(process.env.INTEGRATION_ADMIN_DATABASE_URL);
  const container = process.env.OPENEDBOT_POSTGRES_CONTAINER ?? "infra-postgres";
  const port = (await capture(["docker", "port", container, "5432/tcp"])).split("\n").find((line) => line.startsWith("127.0.0.1:") || line.startsWith("0.0.0.0:"))?.split(":").at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error("Existing PostgreSQL must expose a loopback port, or supply INTEGRATION_ADMIN_DATABASE_URL.");
  // Credentials are captured in memory only, never printed or passed in argv.
  const credentials = await capture(["docker", "exec", container, "sh", "-ceu", 'printf "%s\\n%s" "$POSTGRES_USER" "$POSTGRES_PASSWORD"']);
  const newline = credentials.indexOf("\n");
  if (newline < 1) throw new Error("Existing PostgreSQL credentials are unavailable.");
  const url = new URL(`postgresql://127.0.0.1:${port}/postgres`);
  url.username = credentials.slice(0, newline);
  url.password = credentials.slice(newline + 1);
  return url;
}

function assert(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SseFrameBuffer = { text: string; decoder: TextDecoder };
async function nextSseEventFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: SseFrameBuffer,
  milliseconds: number,
): Promise<string | null> {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const separator = /\r?\n\r?\n/.exec(buffer.text);
    if (separator?.index !== undefined) {
      const frame = buffer.text.slice(0, separator.index);
      buffer.text = buffer.text.slice(separator.index + separator[0].length);
      if (/^event:/m.test(frame)) return frame;
      continue;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("SSE frame timed out");
    const result = await withTimeout(reader.read(), remaining, "SSE frame timed out");
    if (result.done) return null;
    buffer.text += buffer.decoder.decode(result.value, { stream: true });
  }
}

function sseProbeEvent(organizationId: string, cursor: number, delta: string): OrganizationEvent {
  return {
    version: 1, cursor, organizationId, threadId: null, runId: "agency-stream-fixture", botId: null,
    turnId: null, sessionKey: null, leaseGeneration: null, sequence: cursor, type: "agent.message",
    payload: { delta }, occurredAt: new Date().toISOString(),
  };
}

// The fleet routes are the plug-in's since step 11.2 (`./pro-fleet`).
const fleetPlugin = await requireFleetPlugin("agency-workspaces");
// As the API does with the plug-in billing loaded (steps 8d, 11.4): its port
// gives the member limits, its onOrganizationCreating hook writes the welcome
// subscription in the creation transaction; not the solo default.
const { plugins: loadedPlugins } = await loadApiProPlugins(process.env.OPENEDBOT_PLUGINS);
const billingPort = subscriptionPortOf(loadedPlugins);
const welcomeHook = organizationCreatingHookOf(loadedPlugins, process.env);
if (!billingPort || !welcomeHook) throw new Error("agency-workspaces: the scenarios need the plug-in billing in OPENEDBOT_PLUGINS");
installSubscriptionPort(billingPort);
installOrganizationCreatingListener(welcomeHook);
const root = resolve(import.meta.dir, "../..");
const source = await adminUrl();
const database = `ohb86_kinds_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new SQL({ url: source.toString(), max: 1 });
let created = false;
let target: SQL | null = null;
let api: SQL | null = null;
let apiSecond: SQL | null = null;
const A = "86000000-0000-4000-8000-000000000001"; // personal organization of the agency operator
const B = "86000000-0000-4000-8000-000000000002"; // client, reached through a legacy agency membership
const C = "86000000-0000-4000-8000-000000000003"; // client, reached through a new agency invitation
const U = "86000000-0000-4000-8000-000000000010"; // agency operator
const OWNER = "86000000-0000-4000-8000-000000000020"; // owner of both clients
const MATE = "86000000-0000-4000-8000-000000000030"; // colleague inside the agency organization
const ADMIN = "86000000-0000-4000-8000-000000000031"; // agency administrator
const NEWCOMER = "86000000-0000-4000-8000-000000000040"; // signed in, no organization yet
const RACER = "86000000-0000-4000-8000-000000000050"; // two concurrent personal creations
const D = "86000000-0000-4000-8000-000000000004"; // client used to prove agency leave permissions
const LIMIT_ORG = "86000000-0000-4000-8000-000000000007";
const LIMIT_OWNER = "86000000-0000-4000-8000-000000000060";
try {
  await admin.unsafe(`create database "${database}"`); created = true;
  const destination = new URL(source); destination.pathname = `/${database}`;
  target = new SQL({ url: destination.toString(), max: 1 });
  const migrations = (await readdir(resolve(root, "db/migrations"))).filter((p) => p.endsWith(".sql")).sort();
  const apply = async (files: string[]) => {
    for (const migration of files) await target!.unsafe(await Bun.file(resolve(root, "db/migrations", migration)).text());
  };

  // 1. The state 0083 left behind: a personal preference and a per-user agency role on a client.
  await apply(migrations.filter((file) => file < "0086"));
  await target`insert into users (id, email) values (${U}, 'operator@example.test'), (${OWNER}, 'owner@example.test'),
    (${MATE}, 'mate@example.test'), (${ADMIN}, 'agency-admin@example.test'),
    (${NEWCOMER}, 'newcomer@example.test'), (${RACER}, 'racer@example.test'),
    (${LIMIT_OWNER}, 'limit-owner@example.test')`;
  for (const [id, name] of [[A, "Personal"], [B, "Client B"], [C, "Client C"], [D, "Client D"]]) {
    await target`insert into organizations (id, slug, name) values (${id!}, ${`fixture-${id!.slice(-2)}`}, ${name!})`;
    await target`insert into subscriptions (organization_id, status, member_limit) values (${id!}, 'trialing', 5)`;
  }
  await target`insert into organizations (id, slug, name) values (${LIMIT_ORG}, 'member-limit', 'Acme limit')`;
  await target`insert into subscriptions (organization_id, status, member_limit) values (${LIMIT_ORG}, 'trialing', 2)`;
  await target`insert into memberships (organization_id, user_id, role) values (${LIMIT_ORG}, ${LIMIT_OWNER}, 'owner')`;
  await target`insert into memberships (organization_id, user_id, role) values
    (${A}, ${U}, 'owner'), (${B}, ${OWNER}, 'owner'), (${C}, ${OWNER}, 'owner'),
    (${D}, ${OWNER}, 'owner'), (${B}, ${U}, 'agency')`;
  await target`insert into account_preferences (user_id, agency_enabled, home_mode) values (${U}, true, 'agency')`;

  // 2. 0086 converts the role into a grant from a new agency organization, without deleting history.
  await apply(migrations.filter((file) => file >= "0086"));
  const agencies = await target<Array<{ id: string }>>`select o.id from organizations o join memberships m
    on m.organization_id = o.id and m.user_id = ${U} and m.role = 'owner' and m.revoked_at is null where o.kind = 'agency'`;
  assert(agencies.length === 1, "One agency organization per legacy agency operator");
  const AG = agencies[0]!.id;
  assert((await target`select count(*)::int as count from agency_grants where agency_organization_id = ${AG}
    and client_organization_id = ${B} and revoked_at is null`)[0].count === 1, "Legacy agency role became a live grant");
  const legacy = await target<Array<{ revokedAt: Date | null }>>`select revoked_at as "revokedAt" from memberships
    where organization_id = ${B} and user_id = ${U}`;
  assert(legacy.length === 1 && legacy[0]!.revokedAt !== null, "Legacy membership is revoked, never deleted");
  assert((await target`select personal_owner_user_id as owner from organizations where id = ${A}`)[0].owner === U, "Unambiguous personal owner backfilled");
  const features = await target<Array<{ enabled: boolean }>>`select enabled from product_features where feature_key = 'agency_billing'`;
  assert(features[0]?.enabled === false, "agency_billing ships disabled");
  let rejected = false;
  try { await target`insert into memberships (organization_id, user_id, role) values (${C}, ${MATE}, 'agency')`; } catch { rejected = true; }
  assert(rejected, "No live membership can carry the agency role any more");

  for (const [token, organizationId, userId] of [["operator", A, U], ["owner", B, OWNER], ["mate", A, U],
    ["agency-admin", A, ADMIN], ["newcomer", null, NEWCOMER], ["racer", null, RACER],
    ["limit-owner", LIMIT_ORG, LIMIT_OWNER]] as const) {
    const sessionUser = token === "mate" ? MATE : userId;
    await target`insert into sessions (id, organization_id, user_id, kind, session_token_hash, csrf_hash, access_expires_at)
      values (${crypto.randomUUID()}, ${token === "mate" ? null : organizationId}, ${sessionUser}, 'web', ${hashCredential(token)},
        ${hashCredential("csrf")}, now() + interval '1 hour')`;
  }
  await target`insert into memberships (organization_id, user_id, role) values
    (${AG}, ${MATE}, 'member'), (${AG}, ${ADMIN}, 'admin')`;

  api = new SQL({ url: destination.toString(), max: 1, idleTimeout: 0 });
  await api`set role ohb_api`;
  apiSecond = new SQL({ url: destination.toString(), max: 1, idleTimeout: 0 });
  await apiSecond`set role ohb_api`;
  const features86 = async () => ({ fleetWorkspaces: true, connectorOnlyEnrollment: true, fleetBilling: false, waitlist: true });
  // No DNS from the test: `nomail.example` is a domain that refuses mail (a
  // Null MX in production), everything else is deliverable.
  const stubDomainCheck = async (domain: string) => (domain === "nomail.example" ? "unknown_domain" as const : "deliverable" as const);
  const mount = (db: SQL, agencyEnabled: boolean, eventDb: SQL = db, hub = new EventHub()) => {
    const server = new Hono<{ Variables: AppVariables }>();
    const fleet = fleetMounts(fleetPlugin, db, { environment: "test", trustProxy: false, billingEnforced: false, webUrl: "https://openedbot.app" }, agencyEnabled);
    server.route("/", fleet.public);
    server.route("/api/invite/member", memberInvitationRoutes(db, { environment: "test", trustProxy: false }));
    server.use("*", authMiddleware(db, agencyEnabled));
    server.route("/api/account", workspaceRoutes(db, { agencyAvailable: agencyEnabled, billingEnforced: true, environment: "test" }));
    server.route("/", fleet.session);
    server.route("/api/organization", memberRoutes(db, { webUrl: "https://openedbot.app" }, { checkDomain: stubDomainCheck }));
    server.route("/api/events", eventRoutes(eventDb, hub, { fallbackPollMs: 60_000, replayWindowMs: 3_600_000, replayWindowEvents: 1_000 }, features86));
    server.get("/api/proof", (c) => c.json({ organizationId: c.get("auth").organizationId, role: c.get("auth").role,
      actingFleetId: c.get("auth").actingFleetId }));
    server.onError((error, c) => c.json({ message: error.message, code: (error as any).code }, (error as any).status ?? 500));
    return server;
  };
  const server = mount(api, true);
  const req = (as: string, path: string, org?: string, method = "GET", body?: unknown, app = server, actingFleetId?: string) => app.request(`http://localhost${path}`, {
    method, headers: { Cookie: `ohb_session=${as}`, "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...(org ? { "X-OHB-Organization": org } : {}),
      ...(actingFleetId ? { "X-OHB-Fleet": actingFleetId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const code = async (response: Response) => ((await response.json()) as { code?: string }).code;

  // 3. A signed-in account without organization reaches only the account doors, then defines one of each kind.
  const empty = await (await req("newcomer", "/api/account/workspaces")).json();
  assert(empty.workspaces.length === 0, "An account without organization lists no workspace");
  assert((await req("newcomer", "/api/proof")).status === 403, "No business route opens without an organization");
  const personal = await req("newcomer", "/api/account/organizations", undefined, "POST", { kind: "personal", name: "Chez moi" });
  assert(personal.status === 201, `Personal organization created: ${await personal.clone().text()}`);
  assert((await req("newcomer", "/api/account/organizations", undefined, "POST", { kind: "personal", name: "Encore" })).status === 409, "A second personal organization is refused");
  assert((await req("newcomer", "/api/account/organizations", undefined, "POST", { kind: "agency", name: "Mon agence" })).status === 201, "An agency organization is a separate organization");
  const kinds = (await (await req("newcomer", "/api/account/workspaces")).json()).workspaces.map((w: { kind: string }) => w.kind).sort();
  assert(JSON.stringify(kinds) === JSON.stringify(["agency", "personal"]), `Both kinds listed: ${kinds}`);
  const createdId = (await personal.json()).organizationId;
  assert((await target`select organization_id as id from sessions where session_token_hash = ${hashCredential("newcomer")}`)[0].id === createdId, "The open web session attaches to its first organization");
  const race = await Promise.all([api, apiSecond].map((db) => mount(db, true).request("http://localhost/api/account/organizations", {
    method: "POST", headers: { Cookie: "ohb_session=racer", "X-CSRF-Token": "csrf", "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "personal", name: "Course" }),
  })));
  assert(race.map((r) => r.status).sort().join() === "201,409", `Concurrent personal creation yields one organization: ${race.map((r) => r.status)}`);

  // 4. Access is derived from the grant, for every member of the agency.
  const proof = await (await req("operator", "/api/proof", B)).json();
  assert(proof.role === "agency", `Agency role derived on the client: ${JSON.stringify(proof)}`);
  assert((await req("mate", "/api/proof", B)).status === 200, "A colleague of the agency inherits the client");
  const fleet = await (await req("operator", "/api/pro/agency/fleet", AG)).json();
  assert(fleet.clients.length === 1 && fleet.clients[0].workspace.id === B, `Fleet of the agency lists its client: ${JSON.stringify(fleet)}`);
  const AG2 = "86000000-0000-4000-8000-000000000006";
  await target`insert into organizations (id, slug, name, kind) values (${AG2}, 'second-agency', 'Second agency', 'agency')`;
  await target`insert into memberships (organization_id, user_id, role) values
    (${AG2}, ${OWNER}, 'owner'), (${AG2}, ${U}, 'member'), (${AG2}, ${MATE}, 'member')`;
  await target`insert into agency_grants (id, agency_organization_id, client_organization_id, granted_by_user_id)
    values (${crypto.randomUUID()}, ${AG2}, ${B}, ${OWNER})`;
  // Only an agency grows its team (a personal space takes no other member):
  // the member invitation proofs below invite into AG2 and LIMIT_ORG.
  await target`insert into subscriptions (organization_id, status, member_limit) values (${AG2}, 'trialing', 5)`;
  await target`update organizations set kind = 'agency', personal_owner_user_id = null where id = ${LIMIT_ORG}`;
  const liveAccess = { sessionId: (await target`select id from sessions where session_token_hash = ${hashCredential("operator")}`)[0].id,
    credentialHash: hashCredential("operator"), organizationId: B, userId: U };
  for (const directRole of ["owner", "admin", "member"]) {
    await target`update memberships set role = ${directRole}, revoked_at = null where organization_id = ${B} and user_id = ${U}`;
    const account = await (await req("operator", "/api/account/workspaces")).json();
    const clientEntries = account.workspaces.filter((w: { id: string }) => w.id === B);
    assert(clientEntries.length === 1 && clientEntries[0].role === directRole, `Direct ${directRole} access remains personal and unique`);
    assert(clientEntries[0].viaAgencyIds.includes(AG) && clientEntries[0].viaAgencyIds.includes(AG2), "Both live mandates remain discoverable alongside direct access");
    for (const selectedAgency of [AG, AG2]) {
      const operatorFleet = await (await req("operator", "/api/pro/agency/fleet", selectedAgency)).json();
      const colleagueFleet = await (await req("mate", "/api/pro/agency/fleet", selectedAgency)).json();
      assert(operatorFleet.clients.length === 1 && operatorFleet.clients[0].workspace.id === B, `Direct ${directRole} does not omit the selected mandate`);
      assert(colleagueFleet.clients.length === 1 && colleagueFleet.clients[0].workspace.id === B, "Colleagues see the same agency portfolio");
      assert(operatorFleet.clients[0].workspace.role === "agency", "Fleet projects the mandate role independently of the personal role");
      const underMandate = await (await req("operator", "/api/proof", B, "GET", undefined, server, selectedAgency)).json();
      assert(underMandate.role === "agency" && underMandate.actingFleetId === selectedAgency, `Direct ${directRole} never lends privileges to the selected mandate`);
      assert((await req("operator", "/api/organization/members", B, "GET", undefined, server, selectedAgency)).status === 403, "Agency context cannot manage client members");
      assert(await hasLiveWorkspaceSession(api, { ...liveAccess, actingFleetId: selectedAgency }, true), "The selected live mandate opens its stream");
    }
    assert((await (await req("operator", "/api/proof", B)).json()).role === directRole, "Opening the client personally preserves the direct role");
  }

  // A normal agency revoke between the real metrics read and the final mandate check
  // must close this selected frame, while the other agency and direct membership survive.
  let reachFinalMandateCheck!: () => void;
  let resumeFinalMandateCheck!: () => void;
  const atFinalMandateCheck = new Promise<void>((resolve) => { reachFinalMandateCheck = resolve; });
  const allowFinalMandateCheck = new Promise<void>((resolve) => { resumeFinalMandateCheck = resolve; });
  let paused = false;
  const raceDb = new Proxy(api!, { get(sql, key) {
    if (key === "begin") return (callback: (tx: any) => Promise<unknown>, ...options: unknown[]) => sql.begin((tx: any) => {
      let mandateChecks = 0;
      const pausedTransaction = new Proxy(tx, { apply(transaction, thisArg, args: unknown[]) {
        const strings = args[0] as readonly string[] | undefined;
        const query = strings?.join(" ").toLowerCase() ?? "";
        if (query.includes("from workspace_access(")) {
          mandateChecks++;
          if (mandateChecks === 2 && !paused) {
            paused = true;
            reachFinalMandateCheck();
            return allowFinalMandateCheck.then(() => Reflect.apply(transaction, thisArg, args));
          }
        }
        return Reflect.apply(transaction, thisArg, args);
      } });
      return callback(pausedTransaction);
    }, ...(options as []));
    const value = Reflect.get(sql, key, sql);
    return typeof value === "function" ? value.bind(sql) : value;
  } }) as SQL;
  const raceServer = mount(raceDb, true);
  const pendingClientRead = req("operator", `/api/pro/agency/clients/${B}`, AG, "GET", undefined, raceServer);
  let barrierTimer: ReturnType<typeof setTimeout> | undefined;
  let raceError: unknown;
  try {
    await Promise.race([
      atFinalMandateCheck,
      Promise.resolve(pendingClientRead).then((response) => { throw new Error(`Client read ended before final check (${response.status})`); }),
      new Promise<never>((_resolve, reject) => { barrierTimer = setTimeout(() => reject(new Error("Client read did not reach final mandate check")), 10_000); }),
    ]);
    const revokeEventsBefore = Number((await target`select count(*)::int as count from membership_events
      where kind = 'agency_revoked' and ((organization_id = ${B} and subject_organization_id = ${AG})
        or (organization_id = ${AG} and subject_organization_id = ${B}))`)[0].count);
    const revoke = await req("operator", `/api/pro/agency/clients/${B}`, AG, "DELETE", undefined, mount(apiSecond!, true));
    assert(revoke.status === 204, "A separate normal API connection revokes the selected mandate during the read");
    const revokeEventsAfter = Number((await target`select count(*)::int as count from membership_events
      where kind = 'agency_revoked' and ((organization_id = ${B} and subject_organization_id = ${AG})
        or (organization_id = ${AG} and subject_organization_id = ${B}))`)[0].count);
    assert(revokeEventsAfter === revokeEventsBefore + 2, "One revoke writes exactly one event on each side");
  } catch (error) {
    raceError = error;
  } finally {
    if (barrierTimer) clearTimeout(barrierTimer);
    resumeFinalMandateCheck();
  }
  let staleRead: Response | null = null;
  try { staleRead = await pendingClientRead; } catch (error) { raceError ??= error; }
  if (raceError) throw raceError;
  assert(staleRead?.status === 403, "Revocation during observations rejects the in-flight client detail");
  const staleBody = await staleRead.json() as Record<string, unknown>;
  assert(staleBody.code === "WORKSPACE_ACCESS_REVOKED" && !("workspace" in staleBody) && !("metrics" in staleBody),
    "The rejected in-flight response contains no client detail");
  const otherAgencyDetail = await req("operator", `/api/pro/agency/clients/${B}`, AG2);
  assert(otherAgencyDetail.status === 200 && (await otherAgencyDetail.json()).mandate.agencyOrganizationId === AG2,
    "Another agency retains its own client frame after the selected mandate is revoked");
  assert((await (await req("operator", "/api/proof", B)).json()).role === "member",
    "Direct client membership remains available after the agency revoke");
  assert((await req("operator", "/api/proof", B, "GET", undefined, server, AG)).status === 403,
    "Direct membership cannot reopen the revoked agency frame");
  await target`update agency_grants set revoked_at = null, revoked_by_user_id = null
    where agency_organization_id = ${AG} and client_organization_id = ${B}`;

  // A live SSE is reauthorized under ohb_api while a frame is buffered.
  const streamHub = new EventHub();
  const accessCheckReached = deferred();
  const releaseAccessCheck = deferred();
  const accessCheckFinished = deferred();
  let pauseWorkspaceAccess = false;
  let accessCheckPaused = false;
  const eventDb = new Proxy(api!, { get(sql, key) {
    if (key === "begin") return (callback: (tx: any) => Promise<unknown>, ...options: unknown[]) => sql.begin((tx: any) => {
      const watchedTransaction = new Proxy(tx, { apply(transaction, thisArg, args: unknown[]) {
        const strings = args[0] as readonly string[] | undefined;
        const query = strings?.join(" ").toLowerCase() ?? "";
        if (pauseWorkspaceAccess && query.includes("from workspace_access(")) {
          pauseWorkspaceAccess = false;
          accessCheckPaused = true;
          accessCheckReached.resolve();
          return releaseAccessCheck.promise.then(async () => {
            const rows = await Reflect.apply(transaction, thisArg, args);
            accessCheckFinished.resolve();
            return rows;
          });
        }
        return Reflect.apply(transaction, thisArg, args);
      } });
      return callback(watchedTransaction);
    }, ...(options as []));
    const value = Reflect.get(sql, key, sql);
    return typeof value === "function" ? value.bind(sql) : value;
  } }) as SQL;
  const streamServer = mount(api!, true, eventDb, streamHub);
  const streamCursorRows = await target<Array<{ cursor: number }>>`select coalesce(max(cursor), 0)::int as cursor
    from run_events where organization_id = ${B}`;
  const streamCursor = Number(streamCursorRows[0]?.cursor ?? 0);
  const streamBuffer: SseFrameBuffer = { text: "", decoder: new TextDecoder() };
  let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let accessCheckTick: (() => void) | undefined;
  const realSetInterval = globalThis.setInterval;
  try {
    globalThis.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 15_000 && typeof handler === "function" && !accessCheckTick) {
        accessCheckTick = () => handler(...args);
        return realSetInterval(() => {}, 60_000);
      }
      return realSetInterval(handler, delay, ...args);
    }) as typeof setInterval;
    const streamResponse = await req("operator", `/api/events?cursor=${streamCursor}`, B, "GET", undefined, streamServer, AG);
    assert(streamResponse.status === 200 && streamResponse.body, "The selected client SSE opens under its agency mandate");
    streamReader = streamResponse.body.getReader();
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  try {
    await withTimeout((async () => { while (streamHub.subscriberCount() === 0) await Bun.sleep(10); })(), 5_000,
      "The authorized agency SSE did not subscribe");
    assert(accessCheckTick, "The live SSE did not install its periodic access check");
    streamHub.publish(sseProbeEvent(B, streamCursor + 1, "agency-stream-open"));
    const openingFrame = await nextSseEventFrame(streamReader!, streamBuffer, 5_000);
    assert(openingFrame?.includes("event: agent.message") && openingFrame.includes("agency-stream-open"),
      "The selected agency SSE delivers its own client event before revocation");

    pauseWorkspaceAccess = true;
    accessCheckTick();
    await withTimeout(accessCheckReached.promise, 5_000, "The SSE mandate recheck did not reach PostgreSQL");
    const streamRevoke = await req("operator", `/api/pro/agency/clients/${B}`, AG, "DELETE", undefined, mount(apiSecond!, true));
    assert(streamRevoke.status === 204, "A separate ohb_api connection revokes the selected SSE mandate");
    streamHub.publish(sseProbeEvent(B, streamCursor + 2, "buffered-after-revocation"));
    releaseAccessCheck.resolve();
    const trailingFrames: string[] = [];
    const streamDeadline = Date.now() + 5_000;
    for (;;) {
      const remaining = streamDeadline - Date.now();
      if (remaining <= 0) throw new Error("The revoked agency SSE did not close");
      const frame = await nextSseEventFrame(streamReader!, streamBuffer, remaining);
      if (frame === null) break;
      trailingFrames.push(frame);
    }
    assert(trailingFrames.length === 1 && trailingFrames[0]?.includes("event: stream.revoked"),
      "Revocation sends only the SSE access-refused frame");
    assert(!trailingFrames.some((frame) => frame.includes("buffered-after-revocation")),
      "The SSE discards the buffered event after PostgreSQL revokes this exact mandate");
    assert(streamHub.subscriberCount() === 0, "The revoked SSE unsubscribes from the event hub");
    assert(await hasLiveWorkspaceSession(api, { ...liveAccess, actingFleetId: AG2 }, true),
      "Another agency remains authorized after the selected agency stream is revoked");
  } finally {
    globalThis.setInterval = realSetInterval;
    releaseAccessCheck.resolve();
    if (accessCheckPaused) await withTimeout(accessCheckFinished.promise, 5_000, "The SSE PostgreSQL check did not finish").catch(() => undefined);
    if (streamReader) await streamReader.cancel().catch(() => undefined);
  }
  await target`update agency_grants set revoked_at = null, revoked_by_user_id = null
    where agency_organization_id = ${AG} and client_organization_id = ${B}`;

  await target`update agency_grants set revoked_at = now() where agency_organization_id = ${AG} and client_organization_id = ${B}`;
  assert((await (await req("operator", "/api/pro/agency/fleet", AG)).json()).clients.length === 0, "Revoked mandate A leaves its fleet even with direct access and mandate B");
  assert((await req("operator", `/api/pro/agency/clients/${B}`, AG)).status === 403, "Direct access cannot bypass a revoked selected mandate");
  assert((await (await req("operator", "/api/pro/agency/fleet", AG2)).json()).clients.length === 1, "Mandate B remains independent of mandate A");
  assert((await (await req("operator", "/api/proof", B)).json()).role === "member", "Personal access survives mandate revocation without changing role priority");
  assert((await req("operator", "/api/proof", B, "GET", undefined, server, AG)).status === 403, "Request under revoked mandate A is refused even with personal access and mandate B");
  assert((await req("operator", "/api/proof", B, "GET", undefined, server, AG2)).status === 200, "Request under mandate B still works");
  assert(!await hasLiveWorkspaceSession(api, { ...liveAccess, actingFleetId: AG }, true), "Periodic verification closes precisely the withdrawn A stream");
  assert(await hasLiveWorkspaceSession(api, { ...liveAccess, actingFleetId: AG2 }, true), "Mandate B stream remains authorized");
  assert(await hasLiveWorkspaceSession(api, liveAccess, true), "Personal stream remains authorized");
  assert(!await hasLiveWorkspaceSession(api, { ...liveAccess, actingFleetId: AG2 }, false), "Feature rollback closes an explicit agency stream even with personal access");
  assert(await hasLiveWorkspaceSession(api, liveAccess, false), "Feature rollback preserves a direct personal stream");
  await target`update agency_grants set revoked_at = null where agency_organization_id = ${AG} and client_organization_id = ${B}`;
  await target`update organizations set deleted_at = now() where id = ${B}`;
  assert((await (await req("operator", "/api/pro/agency/fleet", AG)).json()).clients.length === 0, "Deleted clients are absent even with direct access");
  await target`update organizations set deleted_at = null where id = ${B}`;
  await target`update organizations set deleted_at = now() where id = ${AG2}`;
  assert((await req("operator", "/api/pro/agency/fleet", AG2)).status === 403, "Deleted agencies cannot open a portfolio");
  const afterAgencyDeletion = await (await req("operator", "/api/account/workspaces")).json();
  assert(!afterAgencyDeletion.workspaces.find((w: { id: string }) => w.id === B).viaAgencyIds.includes(AG2), "Deleted agencies are removed from direct clients' mandates");
  assert((await req("operator", "/api/proof", B, "GET", undefined, server, AG2)).status === 403, "Deleted agency cannot use personal client privileges");
  assert(!await hasLiveWorkspaceSession(api, { ...liveAccess, actingFleetId: AG2 }, true), "Deleted agency closes its selected stream");
  await target`update organizations set deleted_at = null where id = ${AG2}`;
  await target`update memberships set revoked_at = now() where organization_id = ${AG2} and user_id = ${U}`;
  assert((await req("operator", "/api/pro/agency/fleet", AG2)).status === 403, "Revoked agency membership cannot borrow direct client access");
  assert((await req("operator", "/api/proof", B, "GET", undefined, server, AG2)).status === 403, "Leaving an agency closes its explicit request context");
  assert(!await hasLiveWorkspaceSession(api, { ...liveAccess, actingFleetId: AG2 }, true), "Leaving an agency closes its selected stream");
  await target`update memberships set revoked_at = now() where organization_id = ${B} and user_id = ${U}`;
  await target`update agency_grants set revoked_at = now() where agency_organization_id = ${AG2} and client_organization_id = ${B}`;
  assert(await code(await req("operator", "/api/pro/agency/fleet", A)) === "AGENCY_ORGANIZATION_REQUIRED", "A personal organization has no fleet");
  assert((await req("operator", "/api/organization/members", B)).status === 403, "Agency access still excludes member management");
  assert(await hasLiveWorkspaceSession(api, liveAccess, true), "Live stream through a grant");
  assert(!await hasLiveWorkspaceSession(api, liveAccess, false), "Feature rollback closes agency streams");
  const disabled = mount(api, false);
  assert((await req("operator", "/api/proof", AG, "GET", undefined, disabled)).status === 403, "Feature rollback also closes agency organizations");
  await target`update memberships set revoked_at = now() where organization_id = ${AG} and user_id = ${MATE}`;
  assert((await req("mate", "/api/proof", B)).status === 403, "Leaving the agency closes its clients at once");

  // 5. A client grant is a row written for the agency, never a membership and never an invitation.
  await target`update memberships set revoked_at = null where organization_id = ${AG} and user_id = ${MATE}`;
  await target`insert into agency_grants (id, agency_organization_id, client_organization_id, granted_by_user_id)
    values (${crypto.randomUUID()}, ${AG}, ${C}, ${OWNER})`;
  assert((await target`select count(*)::int as count from agency_grants where agency_organization_id = ${AG} and client_organization_id = ${C} and revoked_at is null`)[0].count === 1, "Exactly one grant");
  assert((await target`select count(*)::int as count from memberships where organization_id = ${C} and user_id = ${U}`)[0].count === 0, "No membership in the client");

  // 6. The client owner withdraws the agency; RLS keeps grants invisible to a third tenant.
  const grants = await (await req("owner", "/api/organization/fleet-grants", C)).json();
  assert(grants.grants.length === 1 && grants.grants[0].agencyOrganizationId === AG, `Client lists its agency: ${JSON.stringify(grants)}`);
  assert((await req("owner", `/api/organization/fleet-grants/${grants.grants[0].id}`, C, "DELETE")).status === 204, "Owner withdraws the agency");
  assert((await req("operator", "/api/proof", C)).status === 403, "Withdrawn client closes");
  const foreign = await api.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${A}, true)`;
    return tx`select count(*)::int as count from agency_grants`;
  });
  assert(foreign[0].count === 0, "A tenant that is party to no grant sees none");
  const ownerRevokeEventsBefore = Number((await target`select count(*)::int as count from membership_events
    where kind = 'agency_revoked' and ((organization_id = ${B} and subject_organization_id = ${AG})
      or (organization_id = ${AG} and subject_organization_id = ${B}))`)[0].count);
  assert((await req("operator", `/api/pro/agency/clients/${B}`, AG, "DELETE")).status === 204, "The agency owner can leave a client");
  const ownerRepeat = await req("operator", `/api/pro/agency/clients/${B}`, AG, "DELETE");
  assert(ownerRepeat.status === 404 && await code(ownerRepeat) === "AGENCY_GRANT_NOT_FOUND", "A repeated owner DELETE reports the missing mandate");
  const ownerRevokeEventsAfter = Number((await target`select count(*)::int as count from membership_events
    where kind = 'agency_revoked' and ((organization_id = ${B} and subject_organization_id = ${AG})
      or (organization_id = ${AG} and subject_organization_id = ${B}))`)[0].count);
  assert(ownerRevokeEventsAfter === ownerRevokeEventsBefore + 2, "Repeated owner DELETE does not duplicate either audit event");
  assert((await (await req("operator", "/api/pro/agency/fleet", AG)).json()).clients.length === 0, "Fleet empties once every grant is closed");
  await agencyBusinessScenarios({ target, api, userId: U, agencyId: AG, otherAgencyId: AG2, clients: [B, C], outOfMandateClientId: D,
    request: async (path, organizationId, database = api!) => req("operator", path, organizationId, "GET", undefined, mount(database, true)) });

  // Owner/admin can leave; a member and an invalid CSRF token cannot.
  await target`insert into agency_grants (id, agency_organization_id, client_organization_id, granted_by_user_id)
    values (${crypto.randomUUID()}, ${AG}, ${D}, ${OWNER})`;
  await target`update memberships set revoked_at = null where organization_id = ${AG} and user_id = ${MATE}`;
  const memberLeave = await req("mate", `/api/pro/agency/clients/${D}`, AG, "DELETE");
  assert(memberLeave.status === 403 && await code(memberLeave) === "ROLE_REQUIRED", "An agency member cannot withdraw a client mandate");
  const csrfFailure = await server.request(`http://localhost/api/pro/agency/clients/${D}`, {
    method: "DELETE",
    headers: { Cookie: "ohb_session=agency-admin", "X-CSRF-Token": "wrong", "Content-Type": "application/json", "X-OHB-Organization": AG },
  });
  assert(csrfFailure.status === 403 && await code(csrfFailure) === "CSRF_INVALID", "The real session middleware rejects an invalid CSRF token");
  assert((await target`select revoked_at from agency_grants where agency_organization_id = ${AG}
    and client_organization_id = ${D} and revoked_at is null`).length === 1, "Member and CSRF refusals leave the mandate active");
  const adminRevokeEventsBefore = Number((await target`select count(*)::int as count from membership_events
    where kind = 'agency_revoked' and ((organization_id = ${D} and subject_organization_id = ${AG})
      or (organization_id = ${AG} and subject_organization_id = ${D}))`)[0].count);
  const adminLeave = await req("agency-admin", `/api/pro/agency/clients/${D}`, AG, "DELETE");
  assert(adminLeave.status === 204, "An agency admin can withdraw a client mandate");
  const adminRepeat = await req("agency-admin", `/api/pro/agency/clients/${D}`, AG, "DELETE");
  assert(adminRepeat.status === 404 && await code(adminRepeat) === "AGENCY_GRANT_NOT_FOUND", "A repeated admin DELETE reports the missing mandate");
  const adminRevokeEventsAfter = Number((await target`select count(*)::int as count from membership_events
    where kind = 'agency_revoked' and ((organization_id = ${D} and subject_organization_id = ${AG})
      or (organization_id = ${AG} and subject_organization_id = ${D}))`)[0].count);
  assert(adminRevokeEventsAfter === adminRevokeEventsBefore + 2, "Repeated admin DELETE does not duplicate either audit event");
  assert((await target`select id from organizations where id = ${D} and deleted_at is null`).length === 1,
    "Withdrawing a mandate preserves the client organization data");
  await target`update memberships set revoked_at = null where organization_id = ${AG} and user_id = ${U}`;
  const invitationActor = { organizationId: AG, userId: U };
  const invitationInput = { email: "client@example.com", webUrl: "https://openedbot.app" };
  const invitation = await sendAgencyInvitation(api, invitationActor, invitationInput, stubDomainCheck);
  assert(invitation.status === "pending", "Agency owner creates a pending invitation");
  const originalHash = (await target`select token_hash from agency_client_invitations where id = ${invitation.id}`)[0].token_hash;
  await sendAgencyInvitation(api, invitationActor, { invitationId: invitation.id, webUrl: invitationInput.webUrl }, stubDomainCheck);
  assert((await target`select token_hash from agency_client_invitations where id = ${invitation.id}`)[0].token_hash !== originalHash,
    "Resending rotates the invitation key");
  assert((await listAgencyInvitations(api, invitationActor)).some((row) => row.id === invitation.id), "Agency lists its invitations");
  await cancelAgencyInvitation(api, invitationActor, invitation.id);
  assert((await target`select status from agency_client_invitations where id = ${invitation.id}`)[0].status === "canceled", "Cancel invalidates the invitation");
  let memberInviteRejected = false;
  try { await sendAgencyInvitation(api, { organizationId: AG, userId: MATE }, invitationInput, stubDomainCheck); }
  catch (error) { memberInviteRejected = error instanceof Error && "status" in error && error.status === 403; }
  assert(memberInviteRejected, "An agency member cannot invite a client");
  console.log("Agency invitation management integration passed: create, list, resend, cancel and member refusal.");
  const consentOptions = { billingEnforced: false, environment: "test" as const };
  const inviteToken = async (email: string) => {
    const row = await sendAgencyInvitation(api!, invitationActor, { email, webUrl: invitationInput.webUrl }, stubDomainCheck);
    const mail = (await target!`select payload from email_outbox where kind = 'agency_client_invitation'
      and recipient_email = ${email} order by created_at desc limit 1`)[0];
    return { id: row.id, token: String(mail.payload.invitationUrl).split("/").at(-1)! };
  };
  const fresh = await inviteToken("new-client@example.com");
  assert(!(await previewAgencyInvitation(api, fresh.token)).hasAccount, "Public preview identifies a new invitee");
  const registration = await server.request(`http://localhost/api/pro/agency/invite/${fresh.token}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "Invitation-Password1!" }),
  });
  assert(registration.status === 201, `Invitation signup opens a session: ${await registration.clone().text()}`);
  const registered = await registration.json();
  const freshUser = { userId: registered.user.id };
  const inviteeCookie = registration.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  assert((await target`select access_tier from users where id = ${freshUser.userId}`)[0].access_tier === "classic", "Invitation signup bypasses waitlist as classic");
  const acceptResponse = await server.request(`http://localhost/api/pro/agency/invite/${fresh.token}/accept`, {
    method: "POST", headers: { Cookie: inviteeCookie, "X-CSRF-Token": registered.csrfToken, "Content-Type": "application/json" }, body: "{}",
  });
  assert(acceptResponse.status === 200, `An invitee without organization accepts through the real auth middleware: ${await acceptResponse.clone().text()}`);
  const acceptedNew = await acceptResponse.json();
  assert(acceptedNew.organizationId, "Accepting a new client creates its personal organization");
  const inviteeSession = (await target`select organization_id as id from sessions where user_id = ${freshUser.userId}`)[0];
  assert(inviteeSession.id === acceptedNew.organizationId, "Accepting binds the invitation signup session to the personal organization");
  const inviteeProof = await server.request("http://localhost/api/proof", { headers: { Cookie: inviteeCookie } });
  assert(inviteeProof.status === 200 && (await inviteeProof.json()).organizationId === acceptedNew.organizationId,
    "The next request resolves the personal organization without a workspace header");
  assert((await target`select granted_by_user_id from agency_grants where agency_organization_id = ${AG}
    and client_organization_id = ${acceptedNew.organizationId}`)[0].granted_by_user_id === freshUser.userId, "The client grants the mandate");
  assert((await target`select count(*)::int as count from membership_events where kind = 'agency_granted'
    and actor_user_id = ${freshUser.userId}`)[0].count === 2, "Acceptance journals both sides");
  let usedRejected = false;
  try { await respondToAgencyInvitation(api, { ...consentOptions, token: fresh.token, userId: freshUser.userId, accept: true }); }
  catch (error) { usedRejected = error instanceof Error && "status" in error && error.status === 410; }
  assert(usedRejected, "A used key cannot be accepted twice");
  const existing = await inviteToken("newcomer@example.test");
  const acceptedExisting = await respondToAgencyInvitation(api, { ...consentOptions, token: existing.token, userId: NEWCOMER, accept: true, organizationName: "Existing account client" });
  assert(acceptedExisting.organizationId, "An existing account accepts without signing up again");
  const wrong = await inviteToken("wrong-client@example.com");
  let wrongRejected = false;
  try { await respondToAgencyInvitation(api, { ...consentOptions, token: wrong.token, userId: NEWCOMER, accept: true }); }
  catch (error) { wrongRejected = error instanceof Error && "status" in error && error.status === 403; }
  assert(wrongRejected, "A different signed-in email cannot accept");
  await target`update agency_client_invitations set expires_at = now() - interval '1 minute' where id = ${wrong.id}`;
  let expiredRejected = false;
  try { await previewAgencyInvitation(api, wrong.token); }
  catch (error) { expiredRejected = error instanceof Error && "status" in error && error.status === 410; }
  assert(expiredRejected, "An expired key cannot be previewed or used");
  const decline = await inviteToken("new-client@example.com");
  const grantCountBefore = (await target`select count(*)::int as count from agency_grants`)[0].count;
  const declined = await respondToAgencyInvitation(api, { ...consentOptions, token: decline.token, userId: freshUser.userId, accept: false });
  assert(declined.status === "declined" && declined.organizationId === null, "Declining does not select or create an organization");
  assert((await target`select count(*)::int as count from agency_grants`)[0].count === grantCountBefore, "Declining creates no mandate");
  assert((await target`select count(*)::int as count from email_outbox where kind = 'agency_client_response'`)[0].count === 3,
    "The inviter receives acceptance and decline notifications");
  console.log("Agency invitation consent integration passed: accept new, accept existing, wrong email, expired/used key and decline.");

  const memberInvitation = await sendMemberInvitation(api, { organizationId: AG2, userId: OWNER }, {
    email: "member-invite@example.com", role: "member", locale: "en", webUrl: "https://openedbot.app",
  }, stubDomainCheck);
  const memberMail = (await target`select payload from email_outbox where kind = 'organization_member_invitation'
    and recipient_email = 'member-invite@example.com' order by created_at desc limit 1`)[0];
  const memberToken = String(memberMail.payload.invitationUrl).split("/").at(-1)!;
  const memberPreview = await server.request(`http://localhost/api/invite/member/${memberToken}`);
  assert(memberPreview.status === 200 && (await memberPreview.json()).hasAccount === false,
    "Public member invitation preview identifies a new account");
  const memberRegistration = await server.request(`http://localhost/api/invite/member/${memberToken}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "Member-Password1!" }),
  });
  assert(memberRegistration.status === 201, `Member invitation signup opens a session: ${await memberRegistration.clone().text()}`);
  const memberRegistered = await memberRegistration.json();
  const memberCookie = memberRegistration.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  const memberAccept = await server.request(`http://localhost/api/invite/member/${memberToken}/accept`, {
    method: "POST", headers: { Cookie: memberCookie, "X-CSRF-Token": memberRegistered.csrfToken },
  });
  assert(memberAccept.status === 200 && (await memberAccept.json()).organizationId === AG2,
    "A member invitation accepts through the accountless session");
  assert((await target`select role from memberships where organization_id = ${AG2} and user_id = ${memberRegistered.user.id}
    and revoked_at is null`)[0].role === "member", "Member acceptance creates the invited role");
  assert((await target`select status from organization_member_invitations where id = ${memberInvitation.id}`)[0].status === "accepted",
    "Member acceptance consumes the invitation");
  assert((await target`select count(*)::int as count from membership_events where organization_id = ${AG2}
    and actor_user_id = ${memberRegistered.user.id} and kind = 'member_joined'`)[0].count === 1,
    "Member acceptance journals the join");

  await target`update memberships set revoked_at = now() where organization_id = ${AG2} and user_id = ${memberRegistered.user.id}`;
  const reactivation = await server.request("http://localhost/api/organization/invitations", {
    method: "POST", headers: { Cookie: "ohb_session=owner", "X-CSRF-Token": "csrf", "Content-Type": "application/json", "X-OHB-Organization": AG2 },
    body: JSON.stringify({ email: "member-invite@example.com", role: "admin", locale: "en" }),
  });
  assert(reactivation.status === 201, `A revoked membership can be invited again: ${await reactivation.clone().text()}`);
  const reactivationRow = await reactivation.json();
  const reactivationMail = (await target`select payload from email_outbox where kind = 'organization_member_invitation'
    and recipient_email = 'member-invite@example.com' order by created_at desc limit 1`)[0];
  const reactivationToken = String(reactivationMail.payload.invitationUrl).split("/").at(-1)!;
  const reactivationAccept = await server.request(`http://localhost/api/invite/member/${reactivationToken}/accept`, {
    method: "POST", headers: { Cookie: memberCookie, "X-CSRF-Token": memberRegistered.csrfToken },
  });
  assert(reactivationAccept.status === 200, `A revoked membership is reactivated: ${await reactivationAccept.clone().text()}`);
  const reactivated = await target`select role, revoked_at as "revokedAt" from memberships
    where organization_id = ${AG2} and user_id = ${memberRegistered.user.id}`;
  assert(reactivated.length === 1 && reactivated[0].role === "admin" && reactivated[0].revokedAt === null,
    "Member acceptance reactivates the existing membership row");
  assert(reactivationRow.status === "pending", "Reactivation invitation remains pending before acceptance");

  const unknownDomain = await server.request("http://localhost/api/organization/invitations", {
    method: "POST", headers: { Cookie: "ohb_session=owner", "X-CSRF-Token": "csrf", "Content-Type": "application/json", "X-OHB-Organization": AG2 },
    body: JSON.stringify({ email: "camille@nomail.example", role: "member" }),
  });
  assert(unknownDomain.status === 400 && await code(unknownDomain) === "EMAIL_DOMAIN_UNKNOWN",
    "A member invitation to a domain that receives no mail is refused before anything is written");
  const disposable = await server.request("http://localhost/api/organization/invitations", {
    method: "POST", headers: { Cookie: "ohb_session=owner", "X-CSRF-Token": "csrf", "Content-Type": "application/json", "X-OHB-Organization": AG2 },
    body: JSON.stringify({ email: "camille@mailinator.com", role: "member" }),
  });
  assert(disposable.status === 400 && await code(disposable) === "EMAIL_DISPOSABLE",
    "A member invitation to a disposable mailbox is refused");
  assert((await target`select count(*)::int as count from organization_member_invitations where email in ('camille@nomail.example', 'camille@mailinator.com')`)[0].count === 0,
    "A refused invitation leaves no row");
  const memberLimitFirst = await server.request("http://localhost/api/organization/invitations", {
    method: "POST", headers: { Cookie: "ohb_session=limit-owner", "X-CSRF-Token": "csrf", "Content-Type": "application/json", "X-OHB-Organization": LIMIT_ORG },
    body: JSON.stringify({ email: "first-limit@example.com", role: "member" }),
  });
  assert(memberLimitFirst.status === 201, "A trialing organization can reserve its final member seat");
  const memberLimitSecond = await server.request("http://localhost/api/organization/invitations", {
    method: "POST", headers: { Cookie: "ohb_session=limit-owner", "X-CSRF-Token": "csrf", "Content-Type": "application/json", "X-OHB-Organization": LIMIT_ORG },
    body: JSON.stringify({ email: "second-limit@example.com", role: "member" }),
  });
  assert(memberLimitSecond.status === 409 && await code(memberLimitSecond) === "MEMBER_QUOTA_REACHED",
    "A trialing organization refuses an invitation past its member limit");
  const foreignMemberRows = await api.begin(async (tx) => {
    await tx`select set_config('app.organization_id', ${A}, true)`;
    return tx`select count(*)::int as count from organization_member_invitations where organization_id = ${AG2}`;
  });
  assert(foreignMemberRows[0].count === 0, "Member invitation RLS hides another organization");
  const journalFirstResponse = await req("operator", "/api/pro/agency/journal?limit=2", AG);
  assert(journalFirstResponse.status === 200, `Agency journal route is available: ${await journalFirstResponse.clone().text()}`);
  const journalFirst = await journalFirstResponse.json();
  assert(journalFirst.events.length === 2 && journalFirst.hasMore && journalFirst.nextCursor, "Agency journal returns a bounded first page");
  assert(journalFirst.events[0].occurredAt >= journalFirst.events[1].occurredAt, "Agency journal orders events newest first");
  const journalSecondResponse = await req(
    "operator", `/api/pro/agency/journal?limit=2&after=${encodeURIComponent(journalFirst.nextCursor)}`, AG,
  );
  assert(journalSecondResponse.status === 200, `Agency journal cursor route is available: ${await journalSecondResponse.clone().text()}`);
  const journalSecond = await journalSecondResponse.json();
  const firstIds = new Set(journalFirst.events.map((event: { id: string }) => event.id));
  assert(!journalSecond.events.some((event: { id: string }) => firstIds.has(event.id)), "Agency journal cursor does not duplicate events");
  const otherJournalResponse = await req("owner", "/api/pro/agency/journal?limit=50", AG2);
  assert(otherJournalResponse.status === 200, "Another agency can read its own journal");
  const otherJournal = await otherJournalResponse.json();
  assert(!otherJournal.events.some((event: { id: string }) => firstIds.has(event.id)), "RLS hides the first agency journal from another agency");
  console.log("Organization member invitation integration passed: preview, registration, accept, reactivation, capacity and RLS.");
  console.log("Organization kinds integration passed: migration, agency mandates, revocation races and RLS.");
} finally {
  await apiSecond?.close(); await api?.close(); await target?.close();
  if (created) await admin.unsafe(`drop database "${database}"`);
  await admin.close();
}
