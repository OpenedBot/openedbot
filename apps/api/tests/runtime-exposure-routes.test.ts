import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import { decryptSecretFromKeyring, secretEncryptionKey } from "@openedbot/hermes";
import { CloudflareApiError, type CloudflareApiClient } from "@openedbot/platform-integrations/cloudflare-api";
import type { TailscaleApiClient } from "@openedbot/platform-integrations/tailscale-api";
import type { ApiConfig } from "../src/infrastructure/config";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import type { RuntimeExposureRow } from "@openedbot/runtimes/sql/runtime-exposures";
import type { RuntimeRow } from "../src/routes/runtimes/runtime-routes";
import { EXPOSURE_CHECK_CACHE_MS, reachabilityVerdict, runtimeExposureRoutes } from "../src/routes/runtimes/runtime-exposure-routes";

const key = secretEncryptionKey(new Uint8Array(32).fill(9));
const managed = { accountId: "openedbot-acct", apiToken: "openedbot-".padEnd(40, "k"), zoneId: "openedbot-zone", hostSuffix: "rt.openedbot.app" };
const baseConfig = { tokenEncryption: { current: key, previous: [] }, hermesEndpointPolicy: { environment: "test" }, hermesMtls: null, billingEnforced: false, environment: "test", publicUrl: "https://api.example.com", linkPublicUrl: undefined, linkLegacyPublicUrls: [], connectorVersions: {}, managedTunnel: null, tailscaleFunnelEnabled: false } as unknown as ApiConfig;
const auth = { organizationId: "org-1", role: "owner", userId: "user-1" } as AuthContext;
const OAUTH = { oauthClientId: "openedbot-client-id", oauthClientSecret: "openedbot-".padEnd(40, "s") };
/** Le déploiement qui a ouvert Funnel ; fermé, la voie répond 404. */
const funnelOpen = { tailscaleFunnelEnabled: true } as Partial<ApiConfig>;

/** A Cloudflare account in memory, one per token, recording every verb. */
function fakeCloudflare() {
  const log: string[] = [];
  const dns = new Set<string>();
  /** Une zone où tout nom est déjà publié : ce que voit un tirage saturé. */
  const state = { everyNameTaken: false, failNextTunnelDelete: false };
  const factory = (apiToken: string): CloudflareApiClient => ({
    verifyToken: async () => { log.push(`verify:${apiToken.slice(0, 4)}`); return { id: "t", status: "active" }; },
    listZones: async (name) => { log.push(`zones:${name}`); return name === "example.com" ? [{ id: "zone-1", name, accountId: "acct-1" }] : []; },
    findTunnel: async () => null,
    createTunnel: async (_a, name) => { log.push(`tunnel:${name}`); return { id: "tun-1", name, status: "inactive", deletedAt: null }; },
    readTunnel: async (_a, id) => ({ id, name: "x", status: "healthy", deletedAt: null }),
    putTunnelIngress: async (_a, _id, hostname) => { log.push(`ingress:${hostname}`); },
    readTunnelToken: async () => "install-".padEnd(48, "t"),
    deleteTunnel: async (_a, id) => {
      if (state.failNextTunnelDelete) {
        state.failNextTunnelDelete = false;
        throw new CloudflareApiError("CLOUDFLARE_UNAVAILABLE", 503, "down");
      }
      log.push(`deleteTunnel:${id}`);
    },
    findDnsRecord: async (_z, name) => state.everyNameTaken || dns.has(name) ? { id: "rec-taken", name, type: "CNAME", content: "" } : null,
    upsertTunnelCname: async (_z, name) => { log.push(`cname:${name}`); return { id: "rec-1", name, type: "CNAME", content: "" }; },
    deleteDnsRecord: async (_z, id) => { log.push(`deleteDns:${id}`); },
    findAccessApp: async () => null,
    createAccessApp: async (_a, domain, name) => { log.push(`app:${domain}`); return { id: "app-1", domain, name }; },
    deleteAccessApp: async (_a, id) => { log.push(`deleteApp:${id}`); },
    createServiceToken: async (_a, name) => ({ id: "st-1", name, clientId: "cf-client-id", clientSecret: "cf-client-secret" }),
    deleteServiceToken: async (_a, id) => { log.push(`deleteToken:${id}`); },
    createServiceAuthPolicy: async () => { log.push("policy"); },
  });
  return {
    factory, log, dns,
    takeEveryName: () => { state.everyNameTaken = true; },
    failNextTunnelDelete: () => { state.failNextTunnelDelete = true; },
  };
}

/** Un tailnet en mémoire : un fichier de politique, des machines, un journal des verbes. */
function fakeTailscale(devices: Array<{ id: string; name: string }> = [{ id: "dev-laptop", name: "laptop.tail1234.ts.net" }]) {
  const log: string[] = [];
  let policy: Record<string, unknown> = { acls: [] };
  const factory = (credentials: { clientId: string; clientSecret: string }): TailscaleApiClient => ({
    readPolicy: async () => { log.push(`read:${credentials.clientId}`); return { policy, etag: "etag-1" }; },
    writePolicy: async (next, etag) => { log.push(`write:${etag}`); policy = next; },
    listDevices: async () => devices.map((device) => ({ ...device, hostname: device.name.split(".")[0]!, tags: [] })),
    deleteDevice: async (id) => { log.push(`deleteDevice:${id}`); },
    createAuthKey: async ({ tag }) => { log.push(`key:${tag}`); return { id: "key-1", key: "tskey-auth-".padEnd(48, "k") }; },
    deleteAuthKey: async (id) => { log.push(`deleteKey:${id}`); },
  });
  return { factory, log, devices, policy: () => policy };
}

function mount(options: { config?: Partial<ApiConfig>; role?: AuthContext["role"]; runtimes?: RuntimeRow[]; healthy?: () => boolean; now?: () => Date; tailscale?: ReturnType<typeof fakeTailscale>; failExposureInsert?: boolean } = {}) {
  const exposures: RuntimeExposureRow[] = [];
  const runtimes: RuntimeRow[] = options.runtimes ?? [];
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const cloudflare = fakeCloudflare();
  const tailscale = options.tailscale ?? fakeTailscale();
  const healthy = options.healthy ?? (() => true);
  let probes = 0;
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ? ").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (sql.startsWith("insert into runtime_direct_exposures")) {
      if (options.failExposureInsert) throw new Error("insert refused");
      const [id, organizationId, , kind, hostname, endpoint, cloudflareAccountId, zoneId, tunnelId, dnsRecordId, accessAppId, serviceTokenId, tailscaleAuthKeyId,
        installTokenCiphertext, installTokenNonce, installTokenTag, installTokenKeyId, edgeAuthCiphertext, edgeAuthNonce, edgeAuthTag, edgeAuthKeyId] = values as string[];
      const row = { id, organizationId, runtimeId: null, kind, hostname, endpoint, cloudflareAccountId, zoneId, tunnelId, dnsRecordId, accessAppId, serviceTokenId, tailscaleAuthKeyId,
        installTokenCiphertext, installTokenNonce, installTokenTag, installTokenKeyId, edgeAuthCiphertext, edgeAuthNonce, edgeAuthTag, edgeAuthKeyId,
        status: "awaiting_install", lastTunnelStatus: null, lastCheckedAt: null, errorCode: null, createdAt: new Date(), revokedAt: null } as RuntimeExposureRow;
      exposures.push(row); return [row];
    }
    if (sql.includes("from runtime_direct_exposures") && sql.includes("and id =")) return exposures.filter((row) => row.id === values[1]);
    if (sql.includes("from runtime_direct_exposures") && sql.includes("runtime_id =")) return exposures.filter((row) => row.runtimeId === values[1] && !row.revokedAt);
    if (sql.includes("from runtime_direct_exposures") && sql.includes("runtime_id is null")) return exposures.filter((row) => row.runtimeId === null && !row.revokedAt);
    if (sql.startsWith("update runtime_direct_exposures set status = case")) {
      const [reachable, tunnelStatus, code, , id] = values as [boolean, string, string | null, string, string];
      const row = exposures.find((candidate) => candidate.id === id)!;
      if (row.status === "awaiting_install" && reachable) row.status = "reachable";
      row.lastTunnelStatus = tunnelStatus; row.errorCode = code; row.lastCheckedAt = new Date();
      return [row];
    }
    if (sql.startsWith("update runtime_direct_exposures set runtime_id")) {
      const row = exposures.find((candidate) => candidate.id === values[2])!;
      Object.assign(row, { runtimeId: values[0], status: "declared", installTokenCiphertext: null, installTokenNonce: null, installTokenTag: null, installTokenKeyId: null,
        edgeAuthCiphertext: null, edgeAuthNonce: null, edgeAuthTag: null, edgeAuthKeyId: null });
      return [];
    }
    if (sql.startsWith("update runtime_direct_exposures set status = 'revoked'")) {
      const row = exposures.find((candidate) => candidate.id === values.at(-1))!;
      Object.assign(row, { status: "revoked", revokedAt: new Date(), cleanupStatus: values[0], installTokenCiphertext: null, edgeAuthCiphertext: null });
      return [];
    }
    if (sql.startsWith("update runtime_direct_exposures set cleanup_status = 'done'")) {
      const row = exposures.find((candidate) => candidate.id === values.at(-1))!;
      if (row.cleanupStatus === "pending") row.cleanupStatus = "done";
      return [];
    }
    if (sql.startsWith("insert into runtimes")) {
      const [id, , name, endpoint, tokenCiphertext, tokenNonce, tokenTag, tokenKeyId, capacity, isActive, , edgeAuthCiphertext, edgeAuthNonce, edgeAuthTag, edgeAuthKeyId] = values;
      const row = { id, name, endpoint, reachability: "direct", tokenCiphertext, tokenNonce, tokenTag, tokenKeyId, capacity, isActive, edgeAuthCiphertext, edgeAuthNonce, edgeAuthTag, edgeAuthKeyId,
        linkFeatures: [], linkConnectedAt: null, linkLastSeenAt: null, linkRotatedAt: null, linkLastReplacedAt: null, linkHijackSuspectedAt: null,
        selectedModel: null, selectedProvider: null, reasoningEffort: null, lastHealthStatus: "healthy", lastHealthError: null, lastProbedAt: null, createdAt: new Date(), updatedAt: new Date() } as RuntimeRow;
      runtimes.push(row); return [row];
    }
    if (sql.startsWith("select id from runtimes")) {
      // `hasPendingReplacement`: a live runtime that does not serve.
      if (sql.includes("not is_active")) return runtimes.filter((row) => !row.isActive).map((row) => ({ id: row.id }));
      return runtimes.filter((row) => row.id === values[1]).map((row) => ({ id: row.id }));
    }
    if (sql.includes("from runtimes")) return runtimes;
    return [];
  }) as unknown as SQL;
  (tx as unknown as { begin: (fn: (inner: Bun.TransactionSQL) => Promise<unknown>) => Promise<unknown> }).begin = (fn) => fn(tx as unknown as Bun.TransactionSQL);
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => { c.set("auth", { ...auth, role: options.role ?? "owner" }); await next(); });
  app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status as 400) : c.json({ error: "unexpected" }, 500));
  app.route("/", runtimeExposureRoutes(tx, { ...baseConfig, ...options.config } as ApiConfig, {
    cloudflareFactory: cloudflare.factory,
    tailscaleFactory: tailscale.factory,
    now: options.now,
    clientFactory: () => ({
      health: async () => { probes++; if (!healthy()) throw new Error("connection refused"); return { status: "ok" }; },
      capabilities: async () => ({ max_concurrent_runs: 2 }),
      probe: async () => ({ health: { status: "ok" }, capabilities: { max_concurrent_runs: 2 } }),
      toolsets: async () => [],
      hostCapabilities: async () => { throw new Error("no host administration in direct mode"); },
    }),
  }));
  return { app, calls, exposures, runtimes, cloudflare, tailscale, probes: () => probes };
}
const body = (value: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

describe("runtime exposure routes", () => {
  test("managed tunnel: hidden without openedbot credentials, published under the managed suffix, taken names refused", async () => {
    const hidden = await mount().app.request("/", body({ kind: "managed_cloudflare", slug: "mon-vps" }));
    expect(hidden.status).toBe(404);
    const { app, cloudflare } = mount({ config: { managedTunnel: managed } as Partial<ApiConfig> });
    const response = await app.request("/", body({ kind: "managed_cloudflare", slug: "Mon-VPS" }));
    expect(response.status).toBe(201);
    expect((await response.json()).exposure.hostname).toBe("mon-vps.rt.openedbot.app");
    expect(cloudflare.log).toContain("tunnel:openedbot-managed-mon-vps");
    cloudflare.dns.add("taken.rt.openedbot.app");
    const taken = await app.request("/", body({ kind: "managed_cloudflare", slug: "taken" }));
    expect(taken.status).toBe(409);
    expect((await app.request("/", body({ kind: "managed_cloudflare", slug: "a" }))).status).toBe(400);
  });

  test("managed tunnel sans nom : openedbot tire openedbot-<hex> et évite un sous-domaine déjà publié", async () => {
    const { app, cloudflare } = mount({ config: { managedTunnel: managed } as Partial<ApiConfig> });
    const response = await app.request("/", body({ kind: "managed_cloudflare" }));
    expect(response.status).toBe(201);
    const hostname = (await response.json()).exposure.hostname as string;
    expect(hostname).toMatch(/^openedbot-[0-9a-f]{8}\.rt\.openedbot\.app$/);
    expect(cloudflare.log).toContain(`tunnel:openedbot-managed-${hostname.split(".")[0]}`);

    // Chaque tirage est relu contre le DNS ; une zone saturée finit en 503 plutôt qu'en écrasement.
    const full = mount({ config: { managedTunnel: managed } as Partial<ApiConfig> });
    full.cloudflare.takeEveryName();
    const saturated = await full.app.request("/", body({ kind: "managed_cloudflare" }));
    expect(saturated.status).toBe(503);
    expect((await saturated.json()).error.code).toBe("EXPOSURE_HOSTNAME_TAKEN");
  });

  test("Tailscale Funnel: fermé par défaut, puis tag, attribut funnel, clé taguée et commande rendue une fois", async () => {
    const closed = await mount().app.request("/", body({ kind: "tailscale_funnel", slug: "mon-vps", ...OAUTH }));
    expect(closed.status).toBe(404);
    expect((await closed.json()).error.code).toBe("TAILSCALE_FUNNEL_UNAVAILABLE");

    const { app, cloudflare, tailscale, exposures } = mount({ config: funnelOpen });
    const response = await app.request("/", body({ kind: "tailscale_funnel", slug: "Mon-VPS", ...OAUTH }));
    expect(response.status).toBe(201);
    const dto = await response.json() as { exposure: Record<string, unknown>; installCommand: string };
    expect(dto.exposure).toMatchObject({ kind: "tailscale_funnel", status: "awaiting_install", hostname: "mon-vps.tail1234.ts.net", edgeAuthProvisioned: false });
    expect(dto.installCommand).toContain("--advertise-tags tag:openedbot-hermes");
    expect(dto.installCommand).toContain("tailscale funnel --bg 8642");
    expect(tailscale.log).toEqual(["read:openedbot-client-id", "write:etag-1", "key:tag:openedbot-hermes"]);
    expect(tailscale.policy()).toMatchObject({ tagOwners: { "tag:openedbot-hermes": ["autogroup:admin"] }, nodeAttrs: [{ target: ["tag:openedbot-hermes"], attr: ["funnel"] }] });
    // Ni le client OAuth ni la clé d'appairage ne sont écrits en clair.
    expect(JSON.stringify(dto.exposure)).not.toMatch(/tskey-|openedbot-client-id|ciphertext/);
    expect(JSON.stringify(exposures[0])).not.toContain("tskey-auth-");
    expect(exposures[0]!.tailscaleAuthKeyId).toBe("key-1");
    expect(cloudflare.log).toEqual([]);
  });

  test("Tailscale Funnel refuse un nom déjà pris et un tailnet sans machine", async () => {
    const taken = mount({ config: funnelOpen, tailscale: fakeTailscale([{ id: "dev-1", name: "mon-vps.tail1234.ts.net" }]) });
    const conflict = await taken.app.request("/", body({ kind: "tailscale_funnel", slug: "mon-vps", ...OAUTH }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("TAILSCALE_CONFLICT");

    const empty = mount({ config: funnelOpen, tailscale: fakeTailscale([]) });
    const unknown = await empty.app.request("/", body({ kind: "tailscale_funnel", slug: "mon-vps", ...OAUTH }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.code).toBe("TAILSCALE_TAILNET_UNKNOWN");
  });

  test("reading probes the hostname, moves to reachable once it answers, and caches within ten seconds", async () => {
    let up = false;
    let clock = Date.now();
    const { app, probes } = mount({ config: funnelOpen, healthy: () => up, now: () => new Date(clock) });
    const created = await (await app.request("/", body({ kind: "tailscale_funnel", slug: "vps", ...OAUTH }))).json();
    const id = created.exposure.id as string;
    const first = await (await app.request(`/${id}`)).json();
    expect(first.status).toBe("awaiting_install");
    expect(first.lastTunnelStatus).toBe("unreachable");
    expect(probes()).toBe(1);
    up = true;
    const cached = await (await app.request(`/${id}`)).json();
    expect(cached.status).toBe("awaiting_install");
    expect(probes()).toBe(1);
    clock += EXPOSURE_CHECK_CACHE_MS + 5_000;
    const second = await (await app.request(`/${id}`)).json();
    expect(second.status).toBe("reachable");
    expect(second.lastTunnelStatus).toBe("healthy");
    expect(probes()).toBe(2);
  });

  test("declare creates the runtime with the stored Access pair, serves at once when none serves, erases exposure secrets, and refuses twice", async () => {
    const { app, exposures, runtimes } = mount({ config: { managedTunnel: managed } as Partial<ApiConfig> });
    const created = await (await app.request("/", body({ kind: "managed_cloudflare", slug: "mon-vps" }))).json();
    const id = created.exposure.id as string;
    const probe = await app.request(`/${id}/test`, body({ token: "gateway-bearer" }));
    expect(probe.status).toBe(200);
    expect((await probe.json()).ok).toBe(true);
    const declared = await app.request(`/${id}/declare`, body({ name: "Mon gateway", token: "gateway-bearer" }));
    expect(declared.status).toBe(201);
    const dto = await declared.json();
    expect(dto).toMatchObject({ isActive: true, reachability: "direct", edgeAuthConfigured: true, exposure: { id, kind: "managed_cloudflare", hostname: "mon-vps.rt.openedbot.app" } });
    expect(JSON.stringify(dto)).not.toMatch(/gateway-bearer|cf-client|install-/);
    const runtime = runtimes[0]!;
    expect(decryptSecretFromKeyring({ ciphertext: runtime.edgeAuthCiphertext!, nonce: runtime.edgeAuthNonce!, tag: runtime.edgeAuthTag! }, runtime.edgeAuthKeyId!, baseConfig.tokenEncryption).value).toContain("cf-client-id");
    expect(exposures[0]).toMatchObject({ status: "declared", runtimeId: runtime.id, installTokenCiphertext: null, edgeAuthCiphertext: null });
    const again = await app.request(`/${id}/declare`, body({ name: "Encore", token: "gateway-bearer" }));
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("EXPOSURE_ALREADY_DECLARED");
    expect(runtimes).toHaveLength(1);
  });

  test("declare next to a serving runtime creates the inactive pending replacement, then refuses a second one", async () => {
    const serving = { id: "connector-1", name: "Serving", endpoint: null, reachability: "connector", isActive: true,
      tokenCiphertext: null, tokenNonce: null, tokenTag: null, tokenKeyId: null, capacity: 2,
      linkFeatures: [], linkConnectedAt: null, linkLastSeenAt: null, linkRotatedAt: null, linkLastReplacedAt: null, linkHijackSuspectedAt: null,
      selectedModel: null, selectedProvider: null, reasoningEffort: null, lastHealthStatus: "healthy", lastHealthError: null, lastProbedAt: null,
      createdAt: new Date(), updatedAt: new Date() } satisfies RuntimeRow;
    const { app, runtimes, exposures } = mount({ config: { managedTunnel: managed } as Partial<ApiConfig>, runtimes: [serving] });
    const first = (await (await app.request("/", body({ kind: "managed_cloudflare", slug: "mon-vps" }))).json()).exposure.id as string;
    const declared = await app.request(`/${first}/declare`, body({ name: "Mon gateway", token: "gateway-bearer" }));
    expect(declared.status).toBe(201);
    expect((await declared.json()).isActive).toBe(false);
    expect(runtimes.filter((row) => row.isActive).map((row) => row.id)).toEqual(["connector-1"]);

    const second = (await (await app.request("/", body({ kind: "managed_cloudflare", slug: "autre-vps" }))).json()).exposure.id as string;
    const refused = await app.request(`/${second}/declare`, body({ name: "Autre gateway", token: "gateway-bearer" }));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("RUNTIME_REPLACEMENT_PENDING");
    expect(runtimes).toHaveLength(2);
    // The refused publication keeps its secrets: nothing was handed to a runtime.
    expect(exposures.find((row) => row.id === second)).toMatchObject({ runtimeId: null });
    expect(exposures.find((row) => row.id === second)!.edgeAuthCiphertext).not.toBeNull();
  });

  test("revoke: le tunnel géré part avec le token d’openedbot, Funnel attend le client OAuth du tailnet", async () => {
    const managedSite = mount({ config: { managedTunnel: managed } as Partial<ApiConfig> });
    const managedId = (await (await managedSite.app.request("/", body({ kind: "managed_cloudflare", slug: "mon-vps" }))).json()).exposure.id as string;
    const removed = await managedSite.app.request(`/${managedId}`, { method: "DELETE" });
    expect(await removed.json()).toEqual({ ok: true, cloudflareCleanup: "done" });
    expect(managedSite.cloudflare.log.filter((entry) => entry.startsWith("delete"))).toEqual(["deleteToken:st-1", "deleteApp:app-1", "deleteDns:rec-1", "deleteTunnel:tun-1"]);

    // Sans identifiants, la publication est révoquée chez openedbot et le tailnet reste à nettoyer.
    const funnel = mount({ config: funnelOpen });
    const funnelId = (await (await funnel.app.request("/", body({ kind: "tailscale_funnel", slug: "mon-vps", ...OAUTH }))).json()).exposure.id as string;
    expect(await (await funnel.app.request(`/${funnelId}`, { method: "DELETE" })).json()).toEqual({ ok: true, cloudflareCleanup: "manual" });
    expect(funnel.tailscale.log.some((entry) => entry.startsWith("delete"))).toBe(false);
    expect(funnel.exposures[0]!.status).toBe("revoked");

    const withKeys = mount({ config: funnelOpen, tailscale: fakeTailscale([{ id: "dev-laptop", name: "laptop.tail1234.ts.net" }, { id: "dev-vps", name: "autre.tail1234.ts.net" }]) });
    const id = (await (await withKeys.app.request("/", body({ kind: "tailscale_funnel", slug: "autre-vps", ...OAUTH }))).json()).exposure.id as string;
    withKeys.tailscale.devices.push({ id: "dev-new", name: "autre-vps.tail1234.ts.net" });
    const cleaned = await withKeys.app.request(`/${id}`, body({ tailscale: { clientId: OAUTH.oauthClientId, clientSecret: OAUTH.oauthClientSecret } }, "DELETE"));
    expect(await cleaned.json()).toEqual({ ok: true, cloudflareCleanup: "done" });
    expect(withKeys.tailscale.log.filter((entry) => entry.startsWith("delete"))).toEqual(["deleteKey:key-1", "deleteDevice:dev-new"]);
  });

  test("revoke : la révocation est commitée avant Cloudflare, et un retrait à moitié fait se reprend", async () => {
    const site = mount({ config: { managedTunnel: managed } as Partial<ApiConfig> });
    const id = (await (await site.app.request("/", body({ kind: "managed_cloudflare", slug: "mon-vps" }))).json()).exposure.id as string;
    site.cloudflare.failNextTunnelDelete();
    const failed = await site.app.request(`/${id}`, { method: "DELETE" });
    expect(failed.status).toBe(502);
    // Le service token est déjà parti : la publication ne redevient pas vivante.
    expect(site.exposures[0]).toMatchObject({ status: "revoked", cleanupStatus: "pending" });
    expect(site.cloudflare.log).toContain("deleteToken:st-1");

    const resumed = await site.app.request(`/${id}`, { method: "DELETE" });
    expect(await resumed.json()).toEqual({ ok: true, cloudflareCleanup: "done" });
    expect(site.exposures[0]!.cleanupStatus).toBe("done");
    expect(site.cloudflare.log).toContain("deleteTunnel:tun-1");
    expect(await (await site.app.request(`/${id}`, { method: "DELETE" })).json()).toEqual({ ok: true, cloudflareCleanup: "none" });
  });

  test("une ligne non écrite (rollback certain) fait retirer le tunnel tout juste provisionné", async () => {
    const site = mount({ config: { managedTunnel: managed } as Partial<ApiConfig>, failExposureInsert: true });
    const response = await site.app.request("/", body({ kind: "managed_cloudflare", slug: "mon-vps" }));
    expect(response.status).toBe(500);
    expect(site.cloudflare.log.filter((entry) => entry.startsWith("delete")))
      .toEqual(["deleteToken:st-1", "deleteApp:app-1", "deleteDns:rec-1", "deleteTunnel:tun-1"]);
  });

  test("la liste rend les publications sans runtime, ni déclarées ni révoquées, et sans secret", async () => {
    const { app } = mount({ config: { managedTunnel: managed } as Partial<ApiConfig> });
    const abandoned = (await (await app.request("/", body({ kind: "managed_cloudflare" }))).json()).exposure.id as string;
    const declared = (await (await app.request("/", body({ kind: "managed_cloudflare" }))).json()).exposure.id as string;
    await app.request(`/${declared}/declare`, body({ name: "Mon gateway", token: "gateway-bearer" }));
    const revoked = (await (await app.request("/", body({ kind: "managed_cloudflare" }))).json()).exposure.id as string;
    await app.request(`/${revoked}`, { method: "DELETE" });

    const response = await app.request("/");
    expect(response.status).toBe(200);
    const listed = await response.json() as { exposures: Array<{ id: string }> };
    expect(listed.exposures.map((row) => row.id)).toEqual([abandoned]);
    expect(JSON.stringify(listed)).not.toMatch(/install-|cf-client|ciphertext/);
    expect((await mount({ role: "member" }).app.request("/")).status).toBe(403);
  });

  test("a publication with a live runtime cannot be revoked, and members cannot publish", async () => {
    const { app, exposures } = mount({ config: funnelOpen });
    const id = (await (await app.request("/", body({ kind: "tailscale_funnel", slug: "vps", ...OAUTH }))).json()).exposure.id as string;
    await app.request(`/${id}/declare`, body({ name: "VPS", token: "bearer" }));
    expect(exposures[0]!.runtimeId).toBeTruthy();
    expect((await app.request(`/${id}`, { method: "DELETE" })).status).toBe(409);
    expect((await mount({ role: "member", config: funnelOpen }).app.request("/", body({ kind: "tailscale_funnel", slug: "vps", ...OAUTH }))).status).toBe(403);
  });

  test("reachability verdict reads the first proof only", () => {
    expect(reachabilityVerdict(true, undefined)).toEqual({ reachable: true, tunnelStatus: "healthy", code: null });
    expect(reachabilityVerdict(false, "RUNTIME_BEARER_REJECTED").reachable).toBe(true);
    expect(reachabilityVerdict(false, "RUNTIME_TUNNEL_DOWN")).toEqual({ reachable: false, tunnelStatus: "down", code: "RUNTIME_TUNNEL_DOWN" });
    expect(reachabilityVerdict(false, "RUNTIME_DNS_UNRESOLVED").tunnelStatus).toBe("dns_pending");
    expect(reachabilityVerdict(null, undefined).code).toBe("RUNTIME_PROBE_INDETERMINATE");
  });
});
