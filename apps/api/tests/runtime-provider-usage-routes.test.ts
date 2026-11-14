import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import type { ApiConfig } from "../src/infrastructure/config";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { HermesClientError } from "@openedbot/hermes";
import type { RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import {
  PROVIDER_USAGE_FRESH_MS,
  RuntimeProviderUsageCache,
  runtimeProviderUsageRoutes,
} from "../src/routes/runtimes/runtime-provider-usage-routes";
import type { RuntimeRow } from "../src/routes/runtimes/runtime-routes";

const owner: AuthContext = { sessionId: "s", organizationId: "org-1", userId: "u", role: "owner", kind: "web", credentialHash: "hash" };
const row: RuntimeRow = {
  id: "runtime-1", name: "VPS", reachability: "connector", endpoint: null,
  tokenCiphertext: null, tokenNonce: null, tokenTag: null, tokenKeyId: null,
  linkConnectedAt: new Date("2026-09-02T08:00:00Z"), linkLastSeenAt: new Date(),
  linkFeatures: ["provider_usage"],
  linkRotatedAt: null,
  linkLastReplacedAt: null,
  linkHijackSuspectedAt: null, selectedProvider: "anthropic", selectedModel: "claude-sonnet",
  reasoningEffort: null, capacity: 4, lastHealthStatus: "healthy", lastHealthError: null,
  lastProbedAt: null, isActive: true, createdAt: new Date(), updatedAt: new Date(),
};

function mount(options: {
  role?: AuthContext["role"];
  runtime?: RuntimeRow | null;
  runtimeMode?: "external" | null;
  usage?: () => Promise<unknown>;
  onUsage?: (refresh: boolean) => void;
  now?: () => Date;
  /** Whether THIS instance's broker holds the link (default: yes). */
  linked?: boolean;
} = {}) {
  let reads = 0;
  let calls = 0;
  const tx = ((strings: TemplateStringsArray) => {
    const sql = strings.join(" ");
    reads += 1;
    if (sql.includes("from runtimes")) return Promise.resolve(options.runtime === undefined ? [row] : options.runtime ? [options.runtime] : []);
    if (sql.includes("from organizations")) return Promise.resolve([{ runtimeMode: options.runtimeMode ?? null }]);
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin =
    async (callback) => callback(tx as unknown as Bun.TransactionSQL);
  const links: RuntimeLinks = { connected: () => options.linked ?? true, dial: () => () => Promise.reject(new Error("unused")), revoke: () => false, notifyRotation: () => false, close: () => false };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => { context.set("auth", { ...owner, role: options.role ?? "owner" }); await next(); });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/", runtimeProviderUsageRoutes(tx, { runtimeMode: "external" } as ApiConfig, links, {
    cache: new RuntimeProviderUsageCache(),
    clientFactory: () => ({ providerUsage: async (usageOptions?: { refresh?: boolean }) => {
      calls += 1;
      options.onUsage?.(usageOptions?.refresh === true);
      return (options.usage ? await options.usage() : {
        fetchedAt: "2026-09-02T10:00:00Z",
        providers: [{ provider: "anthropic", source: "oauth_usage_api", plan: null, windows: [], details: [], unavailableReason: null }],
      }) as never;
    } }),
    now: options.now,
  }));
  return { app, reads: () => reads, calls: () => calls };
}

describe("GET /:runtimeId/provider-usage", () => {
  test("refuse un membre avant cache, base ou appel hôte", async () => {
    const mounted = mount({ role: "member" });
    const response = await mounted.app.request("/runtime-1/provider-usage");
    expect(response.status).toBe(403);
    expect(mounted.reads()).toBe(0);
    expect(mounted.calls()).toBe(0);
  });

  test("rend loading puis le cache frais, avec un seul appel de sonde", async () => {
    const mounted = mount();
    expect((await mounted.app.request("/runtime-1/provider-usage")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = await (await mounted.app.request("/runtime-1/provider-usage")).json() as { status: string; providers: unknown[] };
    expect(body.status).toBe("ok");
    expect(body.providers).toHaveLength(1);
    expect(mounted.calls()).toBe(1);
  });

  test("distingue runtime absent, capacité absente et lien fermé sans appel hôte", async () => {
    const absent = mount({ runtime: null });
    expect((await absent.app.request("/runtime-1/provider-usage")).status).toBe(404);
    const old = mount({ runtime: { ...row, linkFeatures: [] } });
    expect(await (await old.app.request("/runtime-1/provider-usage")).json()).toMatchObject({ status: "unsupported", reason: "feature_absent" });
    const closed = mount({ runtime: { ...row, linkConnectedAt: null }, linked: false });
    expect(await (await closed.app.request("/runtime-1/provider-usage")).json()).toMatchObject({ status: "disconnected", reason: "link_closed" });
    expect(old.calls()).toBe(0);
    expect(closed.calls()).toBe(0);
  });

  test("sert la valeur stale pendant la relance, sans bloquer le drawer", async () => {
    let observedAt = new Date("2026-09-02T10:00:00Z");
    const mounted = mount({ now: () => observedAt });
    await mounted.app.request("/runtime-1/provider-usage");
    await new Promise((resolve) => setTimeout(resolve, 0));

    observedAt = new Date(observedAt.getTime() + PROVIDER_USAGE_FRESH_MS + 1);
    const response = await mounted.app.request("/runtime-1/provider-usage");
    expect(await response.json()).toMatchObject({ status: "stale", providers: [{ provider: "anthropic" }] });
    expect(mounted.calls()).toBe(2);
  });

  test("« Actualiser » attend une sonde neuve et rend le nouveau relevé, pas l'ancien", async () => {
    let observedAt = new Date("2026-09-02T10:00:00Z");
    let fetched = "2026-09-02T10:00:00Z";
    const refreshes: boolean[] = [];
    const mounted = mount({
      now: () => observedAt,
      usage: async () => ({
        fetchedAt: fetched,
        providers: [{ provider: "openai-codex", source: "usage_api", plan: "Prolite", windows: [{ label: "Session", usedPercent: fetched === "2026-09-02T10:00:00Z" ? 100 : 12, resetAt: null, detail: null }], details: [], unavailableReason: null }],
      }),
      onUsage: (refresh) => refreshes.push(refresh),
    });
    await mounted.app.request("/runtime-1/provider-usage");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Still "fresh" (30 s): without refresh=1 the read serves the cache.
    observedAt = new Date(observedAt.getTime() + 30_000);
    fetched = "2026-09-02T10:00:30Z";
    const cached = await (await mounted.app.request("/runtime-1/provider-usage")).json() as { fetchedAt: string };
    expect(cached.fetchedAt).toBe("2026-09-02T10:00:00Z");

    const refreshed = await (await mounted.app.request("/runtime-1/provider-usage?refresh=1")).json() as {
      status: string; fetchedAt: string; providers: Array<{ windows: Array<{ usedPercent: number }> }>;
    };
    expect(refreshed.status).toBe("ok");
    expect(refreshed.fetchedAt).toBe("2026-09-02T10:00:30Z");
    expect(refreshed.providers[0]?.windows[0]?.usedPercent).toBe(12);
    expect(mounted.calls()).toBe(2);
    // The forced probe asks the host to bypass its own cache.
    expect(refreshes).toEqual([false, true]);

    // A second click within 30 s does not start another probe and returns the current reading.
    const again = await (await mounted.app.request("/runtime-1/provider-usage?refresh=1")).json() as { status: string; fetchedAt: string };
    expect(again).toMatchObject({ status: "ok", fetchedAt: "2026-09-02T10:00:30Z" });
    expect(mounted.calls()).toBe(2);
  });

  test("compte les TTL à partir de la réponse de sonde, pas de son départ", async () => {
    let observedAt = new Date("2026-09-02T10:00:00Z");
    let release: (value: unknown) => void = () => undefined;
    const mounted = mount({
      now: () => observedAt,
      usage: () => new Promise((resolve) => { release = resolve; }),
    });
    await mounted.app.request("/runtime-1/provider-usage");
    observedAt = new Date(observedAt.getTime() + 25_000);
    release({
      fetchedAt: "2026-09-02T10:00:25Z",
      providers: [{ provider: "anthropic", source: "oauth_usage_api", plan: null, windows: [], details: [], unavailableReason: null }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = await (await mounted.app.request("/runtime-1/provider-usage")).json() as { status: string; freshUntil: string };
    expect(body.status).toBe("ok");
    expect(body.freshUntil).toBe("2026-09-02T10:05:25.000Z");
  });

  test("normalise une erreur de sonde sans révéler son détail", async () => {
    const mounted = mount({ usage: async () => { throw new Error("upstream bearer=secret"); } });
    await mounted.app.request("/runtime-1/provider-usage");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = await mounted.app.request("/runtime-1/provider-usage");
    const body = await response.json() as {
      runtimeId: string;
      status: string;
      reason: string | null;
      fetchedAt: string | null;
      freshUntil: string | null;
      providers: unknown[];
      error: string | null;
    };
    expect(body).toEqual({
      runtimeId: "runtime-1",
      status: "error",
      reason: null,
      fetchedAt: null,
      freshUntil: null,
      providers: [],
      error: "Les limites fournisseur sont momentanément indisponibles.",
    });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  test("colonne link_connected_at NULL mais lien tenu ici : la sonde part quand même", async () => {
    // A sweep cleared the column during a gap in `seen`; the socket,
    // for its part, never closed. The broker's registry is authoritative.
    const mounted = mount({ runtime: { ...row, linkConnectedAt: null }, linked: true });
    expect(await (await mounted.app.request("/runtime-1/provider-usage")).json()).toMatchObject({ status: "loading" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await mounted.app.request("/runtime-1/provider-usage")).json()).toMatchObject({ status: "ok" });
    expect(mounted.calls()).toBe(1);
  });

  test("lien absent ICI : DTO disconnected, jamais un 503 sans corps exploitable", async () => {
    const mounted = mount({ linked: false });
    const first = await mounted.app.request("/runtime-1/provider-usage");
    expect(first.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await mounted.app.request("/runtime-1/provider-usage")).json()).toMatchObject({ status: "disconnected", reason: "link_closed" });
    expect(mounted.calls()).toBe(0);
  });

  test("opérateur hôte absent : une erreur nommée, pas un lien fermé", async () => {
    const mounted = mount({ usage: async () => { throw new HermesClientError("socket absent", 503, "HERMES_OPERATOR_UNAVAILABLE"); } });
    await mounted.app.request("/runtime-1/provider-usage");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await mounted.app.request("/runtime-1/provider-usage")).json()).toMatchObject({
      status: "error",
      reason: null,
      error: "L’opérateur de l’hôte Hermes est indisponible.",
    });
  });

  test("une relance efface l'échec précédent au lieu de le servir pendant la sonde", async () => {
    let fail = true;
    let release: (value: unknown) => void = () => undefined;
    let observedAt = new Date("2026-09-02T10:00:00Z");
    const mounted = mount({
      now: () => observedAt,
      usage: async () => {
        if (fail) throw new Error("boom");
        await new Promise((resolve) => { release = resolve; });
        return { fetchedAt: "2026-09-02T10:05:00Z", providers: [] };
      },
    });
    await mounted.app.request("/runtime-1/provider-usage");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await mounted.app.request("/runtime-1/provider-usage")).json()).toMatchObject({ status: "error" });
    fail = false;
    observedAt = new Date(observedAt.getTime() + 60_000);
    // Past the backoff, the read starts again; during the probe it is `loading`
    // that is read, not the previous failure.
    expect(await (await mounted.app.request("/runtime-1/provider-usage")).json()).toMatchObject({ status: "loading" });
    release(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await mounted.app.request("/runtime-1/provider-usage")).json()).toMatchObject({ status: "ok" });
  });
});
