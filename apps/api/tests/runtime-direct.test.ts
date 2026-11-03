import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import { HermesClient, HermesClientError, decryptSecretFromKeyring, encryptSecret, secretEncryptionKey } from "@openedbot/hermes";
import type { ApiConfig } from "../src/infrastructure/config";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { NO_RUNTIME_LINKS } from "@openedbot/runtime-link/application/dialer";
import { directProbeResult, runtimeRoutes, type RuntimeRow } from "../src/routes/runtimes/runtime-routes";

const key = secretEncryptionKey(new Uint8Array(32).fill(7));
const previous = secretEncryptionKey(new Uint8Array(32).fill(6));
const config = { tokenEncryption: { current: key, previous: [previous] }, hermesEndpointPolicy: { environment: "test" }, hermesMtls: null, billingEnforced: false, environment: "test", publicUrl: "https://api.example.com", linkPublicUrl: undefined, linkLegacyPublicUrls: [] } as unknown as ApiConfig;
const auth = { organizationId: "org-1", role: "owner", userId: "user-1" } as AuthContext;
const base = { id: "direct-1", name: "Direct", reachability: "direct", endpoint: "https://hermes.example.com", isActive: false,
  tokenCiphertext: null, tokenNonce: null, tokenTag: null, tokenKeyId: null,
  linkFeatures: [], linkConnectedAt: null, linkLastSeenAt: null, linkRotatedAt: null,
  linkLastReplacedAt: null, linkHijackSuspectedAt: null, selectedModel: null, selectedProvider: null,
  reasoningEffort: null, capacity: 4, lastHealthStatus: "unknown", lastHealthError: null,
  lastProbedAt: null, createdAt: new Date(), updatedAt: new Date() } satisfies RuntimeRow;
function stored(): RuntimeRow {
  const token = encryptSecret("old-bearer", previous.value);
  const edge = encryptSecret(JSON.stringify({ clientId: "old-client-id", clientSecret: "old-client-secret" }), previous.value);
  return { ...base, tokenCiphertext: token.ciphertext, tokenNonce: token.nonce, tokenTag: token.tag, tokenKeyId: previous.id,
    edgeAuthCiphertext: edge.ciphertext, edgeAuthNonce: edge.nonce, edgeAuthTag: edge.tag, edgeAuthKeyId: previous.id };
}
function mount(initial: RuntimeRow[] = [], role: AuthContext["role"] = "owner", healthy = true) {
  let rows = initial;
  const revoked = new Set<string>();
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ? ").replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    const live = rows.filter((row) => !revoked.has(row.id));
    if (sql.startsWith("insert into runtimes")) {
      const [id, , name, endpoint, tokenCiphertext, tokenNonce, tokenTag, tokenKeyId, capacity, isActive, , edgeAuthCiphertext, edgeAuthNonce, edgeAuthTag, edgeAuthKeyId] = values;
      const row = { ...base, id, name, endpoint, tokenCiphertext, tokenNonce, tokenTag, tokenKeyId, capacity, isActive, edgeAuthCiphertext, edgeAuthNonce, edgeAuthTag, edgeAuthKeyId } as RuntimeRow;
      rows.push(row); return [row];
    }
    if (sql.startsWith("update runtimes set endpoint")) {
      const [endpoint, name, tokenCiphertext, tokenNonce, tokenTag, tokenKeyId, edgeAuthCiphertext, edgeAuthNonce, edgeAuthTag, edgeAuthKeyId, , id] = values;
      rows = rows.map((row) => row.id === id ? { ...row, endpoint, name: name ?? row.name, tokenCiphertext, tokenNonce, tokenTag, tokenKeyId, edgeAuthCiphertext, edgeAuthNonce, edgeAuthTag, edgeAuthKeyId } as RuntimeRow : row);
      return [{ id }];
    }
    // Replacement: the serving runtime is revoked, then the target is activated.
    if (sql.startsWith("select id, reachability from runtimes")) return live.filter((row) => row.isActive && row.id !== values[1]);
    if (sql.startsWith("update runtimes set revoked_at")) {
      for (const row of live) if (row.isActive && row.id !== values[1]) revoked.add(row.id);
      rows = rows.map((row) => revoked.has(row.id) ? { ...row, isActive: false } : row);
      return [];
    }
    if (sql.startsWith("update runtimes set is_active = true")) {
      rows = rows.map((row) => row.id === values[2] && !revoked.has(row.id) ? { ...row, isActive: true } : row);
      return rows.filter((row) => row.id === values[2] && !revoked.has(row.id));
    }
    // `hasPendingReplacement`: a live runtime that does not serve.
    if (sql.includes("from runtimes") && sql.includes("not is_active")) return live.filter((row) => !row.isActive);
    if (sql.includes("from runtimes")) return sql.includes("and id =") ? live.filter((row) => row.id === values[1]) : live;
    return [];
  }) as unknown as SQL;
  (tx as unknown as { begin: (fn: (inner: Bun.TransactionSQL) => Promise<unknown>) => Promise<unknown> }).begin = (fn) => fn(tx as unknown as Bun.TransactionSQL);
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => { c.set("auth", { ...auth, role }); await next(); });
  app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status as 400) : c.json({ error: "unexpected" }, 500));
  let probed = 0;
  app.route("/", runtimeRoutes(tx, config, NO_RUNTIME_LINKS, { clientFactory: (clientConfig) => {
    expect(clientConfig.profile).toBeNull();
    return { health: async () => { probed++; if (!healthy) throw new HermesClientError("unreachable", 502, "HERMES_UNREACHABLE"); return { status: "ok" }; }, capabilities: async () => ({ max_concurrent_runs: 2 }),
      probe: async () => ({ health: { status: "ok" }, capabilities: { max_concurrent_runs: 2 } }), toolsets: async () => [],
      hostCapabilities: async () => { throw new Error("No host administration in direct mode"); } };
  } }));
  return { app, calls, rows: () => rows, revoked: () => [...revoked], probed: () => probed };
}
const body = (value: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

describe("OHB-74 direct HTTP contract", () => {
  test("draft probe works with an active connector and returns three ordered proofs", async () => {
    const { app, calls } = mount([{ ...base, reachability: "connector", endpoint: null, isActive: true }]);
    const response = await app.request("/test-draft", body({ url: "https://hermes.example.com", token: "bearer" }));
    expect(response.status).toBe(200);
    expect((await response.json()).steps).toEqual([{ step: "edge", ok: true }, { step: "auth", ok: true }, { step: "toolsets", ok: true }]);
    expect(calls).toHaveLength(0);
  });
  test("Quick Tunnel fails as a 200 probe but malformed fields return 400", async () => {
    const { app } = mount();
    const response = await app.request("/test-draft", body({ url: "https://hello.trycloudflare.com", token: "bearer" }));
    expect(response.status).toBe(200);
    expect((await response.json()).steps[0].code).toBe("RUNTIME_QUICK_TUNNEL_REFUSED");
    expect((await app.request("/test-draft", body({ url: 42 }))).status).toBe(400);
    expect((await app.request("/test-draft", body({ url: "https://hermes.example.com", edgeAuth: { Authorization: "stolen" } }))).status).toBe(400);
    const add = await app.request("/", body({ name: "Quick", url: "https://hello.trycloudflare.com", token: "bearer" }));
    expect(add.status).toBe(400);
    expect((await add.json()).error.code).toBe("RUNTIME_QUICK_TUNNEL_REFUSED");
  });
  test("create returns the public DTO directly and serves at once when no runtime serves, from an encrypted row", async () => {
    const { app, calls, rows } = mount();
    const response = await app.request("/", body({ name: "Direct", url: "https://hermes.example.com", token: "new-bearer", edgeAuth: { clientId: "client-id", clientSecret: "access-secret" } }));
    expect(response.status).toBe(201);
    const dto = await response.json();
    expect(dto.isActive).toBe(true);
    expect(dto.reachability).toBe("direct");
    expect(dto.edgeAuthConfigured).toBe(true);
    expect(dto.runtime).toBeUndefined();
    expect(JSON.stringify(dto)).not.toMatch(/new-bearer|access-secret|client-id|ciphertext|nonce|tokenKeyId/);
    expect(JSON.stringify(calls)).not.toMatch(/new-bearer|access-secret|client-id/);
    const row = rows()[0]!;
    expect(decryptSecretFromKeyring({ ciphertext: row.edgeAuthCiphertext!, nonce: row.edgeAuthNonce!, tag: row.edgeAuthTag! }, row.edgeAuthKeyId!, config.tokenEncryption).value).toContain("access-secret");
  });
  test("create next to a serving runtime declares the inactive pending replacement and refuses a second one", async () => {
    const serving = { ...base, id: "connector-1", reachability: "connector", endpoint: null, isActive: true } satisfies RuntimeRow;
    const { app, calls } = mount([serving]);
    const response = await app.request("/", body({ name: "Direct", url: "https://hermes.example.com", token: "new-bearer" }));
    expect(response.status).toBe(201);
    expect((await response.json()).isActive).toBe(false);
    // The pending check runs under the per-organization declaration lock.
    expect(calls.some((call) => call.sql.includes("pg_advisory_xact_lock"))).toBe(true);
    const second = await app.request("/", body({ name: "Other", url: "https://other.example.com", token: "other-bearer" }));
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("RUNTIME_REPLACEMENT_PENDING");
  });
  test("access update re-encrypts both old envelopes with the current key and can remove Access", async () => {
    const { app, rows } = mount([stored()]);
    const response = await app.request("/direct-1/access", body({ token: "rotated-bearer" }, "PUT"));
    expect(response.status).toBe(200);
    expect((await response.json()).edgeAuthConfigured).toBe(true);
    expect(rows()[0]!.tokenKeyId).toBe(key.id);
    expect(rows()[0]!.edgeAuthKeyId).toBe(key.id);
    const removed = await app.request("/direct-1/access", body({ edgeAuth: null }, "PUT"));
    expect(removed.status).toBe(200);
    expect((await removed.json()).edgeAuthConfigured).toBe(false);
    expect(rows()[0]!.edgeAuthNonce).toBeNull();
    expect(rows()[0]!.edgeAuthTag).toBeNull();
    expect(rows()[0]!.edgeAuthKeyId).toBeNull();
  });
  test("test by id selects an inactive direct row even when a connector is active", async () => {
    const { app, probed } = mount([{ ...base, id: "connector-1", reachability: "connector", endpoint: null, isActive: true }, stored()]);
    const response = await app.request("/direct-1/test", { method: "POST" });
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(probed()).toBe(1);
  });
  test("activation is retired: it answers 410 without probing or touching a row", async () => {
    const { app, calls, probed } = mount([stored()]);
    const response = await app.request("/direct-1/activate", { method: "POST" });
    expect(response.status).toBe(410);
    expect((await response.json()).error.code).toBe("RUNTIME_ACTIVATE_RETIRED");
    expect(probed()).toBe(0);
    expect(calls).toHaveLength(0);
  });
  test("replacement probes the inactive direct row, revokes the serving one, and keeps the historical response envelope", async () => {
    const serving = { ...base, id: "direct-0", endpoint: "https://old-hermes.example.com", isActive: true } satisfies RuntimeRow;
    const { app, probed, rows, revoked } = mount([serving, stored()]);
    const response = await app.request("/direct-1/replace", { method: "POST" });
    expect(response.status).toBe(200);
    expect((await response.json()).runtime.isActive).toBe(true);
    expect(probed()).toBe(1);
    expect(revoked()).toEqual(["direct-0"]);
    expect(rows().filter((row) => row.isActive).map((row) => row.id)).toEqual(["direct-1"]);
  });
  test("a failed probe refuses the replacement and leaves the serving runtime in place", async () => {
    const serving = { ...base, id: "direct-0", endpoint: "https://old-hermes.example.com", isActive: true } satisfies RuntimeRow;
    const { app, calls, probed, rows, revoked } = mount([serving, stored()], "owner", false);
    const response = await app.request("/direct-1/replace", { method: "POST" });
    expect(response.status).toBe(502);
    expect(probed()).toBe(1);
    expect(revoked()).toEqual([]);
    expect(calls.some((call) => call.sql.startsWith("update runtimes set revoked_at") || call.sql.startsWith("update runtimes set is_active = true"))).toBe(false);
    expect(rows().filter((row) => row.isActive).map((row) => row.id)).toEqual(["direct-0"]);
  });
  test("access updates reject connectors and non-administrators; mode is retired", async () => {
    const connector = mount([{ ...base, reachability: "connector" }]);
    expect((await connector.app.request("/direct-1/access", body({ token: "x" }, "PUT"))).status).toBe(409);
    expect((await mount([stored()], "member").app.request("/direct-1/access", body({ token: "x" }, "PUT"))).status).toBe(403);
    const retired = await connector.app.request("/mode", body({ runtimeMode: "legacy" }, "PUT"));
    expect(retired.status).toBe(410);
    expect((await retired.json()).error.code).toBe("RUNTIME_MODE_RETIRED");
  });
});

describe("bounded direct probe evidence", () => {
  const probe = (status: number, headers: Record<string, string>, responseBody: string, edge = false) => directProbeResult(() => new HermesClient({ transport: { kind: "direct", send: async () => new Response(responseBody, { status, headers }) } }), edge);
  test("only an Access redirect establishes required/rejected Access authentication", async () => {
    const headers = { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login?secret=do-not-return" };
    expect((await probe(302, headers, "")).steps[0]?.code).toBe("RUNTIME_EDGE_AUTH_REQUIRED");
    expect((await probe(302, headers, "", true)).steps[0]?.code).toBe("RUNTIME_EDGE_AUTH_REJECTED");
    for (const status of [403, 530]) {
      const result = await probe(status, { server: "cloudflare", "content-type": "text/html", "cf-ray": "secret-ray" }, "private-access-secret", true);
      expect(result.steps[0]?.code).toBe("RUNTIME_PROBE_INDETERMINATE");
      expect(JSON.stringify(result)).not.toMatch(/private-access-secret|secret-ray/);
    }
  });
  test("Cloudflare error 1033 and a gateway auth JSON each support their named diagnosis", async () => {
    expect((await probe(530, { server: "cloudflare", "content-type": "text/html" }, "<h1>Error 1033</h1>")).steps[0]?.code).toBe("RUNTIME_TUNNEL_DOWN");
    expect((await probe(401, { "content-type": "application/json" }, '{"error":"unauthorized"}')).steps[0]?.code).toBe("RUNTIME_BEARER_REJECTED");
    expect((await probe(401, { "content-type": "application/json" }, '{"unrelated":"private"}')).steps[0]?.code).toBe("RUNTIME_PROBE_INDETERMINATE");
  });
  test("capabilities and toolsets failures preserve the preceding proofs", async () => {
    const client = new HermesClient({ transport: { kind: "direct", send: async (path) => path === "/health" ? Response.json({ status: "ok" }) : new Response(null, { status: 404 }) } });
    const missing = await directProbeResult(() => client);
    expect(missing.steps).toEqual([{ step: "edge", ok: true }, { step: "auth", ok: false, code: "RUNTIME_CAPABILITIES_MISSING" }, { step: "toolsets", ok: null }]);
    const forbidden = await directProbeResult(() => ({ health: async () => ({ status: "ok" }), capabilities: async () => ({}), probe: async () => ({ health: {}, capabilities: {} }), toolsets: async () => [{ name: "memory", label: "Memory", description: null, configured: true, enabled: true, tools: [] }], hostCapabilities: async () => [] }));
    expect(forbidden.steps[2]?.code).toBe("RUNTIME_TOOLSET_FORBIDDEN");
    const dns = await directProbeResult(() => { throw new HermesClientError("private hostname", 502, "HERMES_DNS_FAILED"); });
    expect(dns.steps[0]?.code).toBe("RUNTIME_DNS_UNRESOLVED");
    expect(JSON.stringify(dns)).not.toContain("private hostname");
  });
});
