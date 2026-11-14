import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import type { ApiConfig } from "../src/infrastructure/config";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { HermesClientError } from "@openedbot/hermes";
import type { RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import {
  RuntimeModelContextCache,
  runtimeModelContextRoutes,
} from "../src/routes/runtimes/runtime-model-context-routes";
import type { RuntimeRow } from "../src/routes/runtimes/runtime-routes";

/**
 * A runtime's context window. It exists nowhere else: the
 * gateway publishes it neither on `/v1/models`, nor on `/api/model/options`, nor
 * on `/v1/capabilities`. This route is therefore the only path, and a host that
 * does not advertise it must be read as "unknown", never as a failure.
 */

const owner: AuthContext = {
  sessionId: "s", organizationId: "org-1", userId: "u", role: "owner", kind: "web", credentialHash: "hash",
};
const row: RuntimeRow = {
  id: "runtime-1", name: "VPS", reachability: "connector", endpoint: null,
  tokenCiphertext: null, tokenNonce: null, tokenTag: null, tokenKeyId: null,
  linkConnectedAt: new Date("2026-09-09T08:00:00Z"), linkLastSeenAt: new Date(),
  linkFeatures: ["model_context"],
  linkRotatedAt: null,
  linkLastReplacedAt: null,
  linkHijackSuspectedAt: null, selectedProvider: "anthropic", selectedModel: "claude-sonnet-5",
  reasoningEffort: null, capacity: 4, lastHealthStatus: "healthy", lastHealthError: null,
  lastProbedAt: null, isActive: true, createdAt: new Date(), updatedAt: new Date(),
};

const document = {
  profile: null,
  model: "claude-sonnet-5",
  provider: "anthropic",
  autoContextLength: 200_000,
  configContextLength: 0,
  effectiveContextLength: 200_000,
  maxOutputTokens: 64_000,
};

function mount(options: {
  role?: AuthContext["role"];
  runtime?: RuntimeRow | null;
  context?: () => Promise<unknown>;
  onCall?: (profile: string | undefined) => void;
  now?: () => Date;
  linked?: boolean;
} = {}) {
  let reads = 0;
  let calls = 0;
  const tx = ((strings: TemplateStringsArray) => {
    const sql = strings.join(" ");
    reads += 1;
    if (sql.includes("from runtimes")) {
      return Promise.resolve(options.runtime === undefined ? [row] : options.runtime ? [options.runtime] : []);
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin =
    async (callback) => callback(tx as unknown as Bun.TransactionSQL);
  const links: RuntimeLinks = {
    connected: () => options.linked ?? true,
    dial: () => () => Promise.reject(new Error("unused")),
    revoke: () => false,
    notifyRotation: () => false,
    close: () => false,
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", { ...owner, role: options.role ?? "owner" });
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/", runtimeModelContextRoutes(tx, { runtimeMode: "external" } as ApiConfig, links, {
    cache: new RuntimeModelContextCache(),
    clientFactory: () => ({
      modelContext: async (clientOptions?: { profile?: string }) => {
        calls += 1;
        options.onCall?.(clientOptions?.profile);
        return (options.context ? await options.context() : document) as never;
      },
    }),
    now: options.now,
  }));
  return { app, reads: () => reads, calls: () => calls };
}

describe("GET /:runtimeId/model-context", () => {
  test("refuse un membre avant cache, base ou appel hôte", async () => {
    const mounted = mount({ role: "member" });
    expect((await mounted.app.request("/runtime-1/model-context")).status).toBe(403);
    expect(mounted.reads()).toBe(0);
    expect(mounted.calls()).toBe(0);
  });

  test("rend la fenêtre effective de l'hôte", async () => {
    const mounted = mount();
    const body = await (await mounted.app.request("/runtime-1/model-context")).json() as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      model: "claude-sonnet-5",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    });
  });

  // The preamble measured by the host passes through as-is; an older host
  // does not publish one, and the response says so with `null` rather than omitting it.
  test("rend le préambule de l'hôte, ou null quand il ne le publie pas", async () => {
    const preamble = {
      buckets: [
        { key: "identity", tokens: 120, items: [] },
        { key: "mcp", tokens: null, items: [{ name: "linear", tokens: null }] },
      ],
    };
    const withPreamble = mount({ context: async () => ({ ...document, preamble }) });
    const body = await (await withPreamble.app.request("/runtime-1/model-context")).json() as Record<string, unknown>;
    expect(body.preamble).toEqual(preamble);
    const older = await (await mount().app.request("/runtime-1/model-context")).json() as Record<string, unknown>;
    expect(older.preamble).toBeNull();
  });

  // The window moves only on a model change: rereading it on every
  // thread display would charge a host probe on every navigation.
  test("une deuxième lecture sert le cache sans rappeler l'hôte", async () => {
    const mounted = mount();
    await mounted.app.request("/runtime-1/model-context");
    await mounted.app.request("/runtime-1/model-context");
    expect(mounted.calls()).toBe(1);
  });

  // `edge-setup upgrade` reconnects the link: what the previous probe read no longer
  // describes the host, and the cache must not serve it again.
  test("une reconnexion du lien invalide la lecture en cache", async () => {
    const current: RuntimeRow = { ...row };
    const mounted = mount({ runtime: current });
    await mounted.app.request("/runtime-1/model-context?profile=atlas");
    current.linkConnectedAt = new Date("2026-10-12T22:30:03Z");
    await mounted.app.request("/runtime-1/model-context?profile=atlas");
    expect(mounted.calls()).toBe(2);
    await mounted.app.request("/runtime-1/model-context?profile=atlas");
    expect(mounted.calls()).toBe(2);
  });

  // A bot is a profile: two profiles of the same runtime can carry two
  // models, hence two windows. A shared cache key would mix them up.
  test("deux profils ne partagent pas la même entrée de cache", async () => {
    const seen: Array<string | undefined> = [];
    const mounted = mount({ onCall: (profile) => seen.push(profile) });
    await mounted.app.request("/runtime-1/model-context?profile=atlas");
    await mounted.app.request("/runtime-1/model-context?profile=bloub");
    expect(seen).toEqual(["atlas", "bloub"]);
    expect(mounted.calls()).toBe(2);
  });

  test("un profil hors grammaire est refusé avant tout appel", async () => {
    const mounted = mount();
    const response = await mounted.app.request("/runtime-1/model-context?profile=../etc");
    expect(response.status).toBe(400);
    expect(mounted.calls()).toBe(0);
  });

  test("distingue runtime absent, capacité absente et lien fermé sans appel hôte", async () => {
    const absent = mount({ runtime: null });
    expect((await absent.app.request("/runtime-1/model-context")).status).toBe(404);

    const old = mount({ runtime: { ...row, linkFeatures: [] } });
    expect(await (await old.app.request("/runtime-1/model-context")).json())
      .toMatchObject({ status: "unsupported", reason: "feature_absent", contextWindow: 0 });
    expect(old.calls()).toBe(0);

    const closed = mount({ runtime: { ...row, linkConnectedAt: null }, linked: false });
    expect(await (await closed.app.request("/runtime-1/model-context")).json())
      .toMatchObject({ status: "disconnected", reason: "link_closed" });
    expect(closed.calls()).toBe(0);
  });

  // An older host advertises the capability but serves a 404: it is the same
  // absence, and an operator has nothing to fix. It is not read as an error.
  test("un 404 de l'hôte se lit comme capacité absente", async () => {
    const mounted = mount({
      context: () => Promise.reject(new HermesClientError("route inconnue", 404, "HERMES_PROFILE_MISSING")),
    });
    expect(await (await mounted.app.request("/runtime-1/model-context")).json())
      .toMatchObject({ status: "unsupported", reason: "feature_absent", error: null });
  });

  // A host failure stays a failure, and the rendered message is already normalized
  // by the Hermes client: never a raw upstream response.
  test("une panne d'hôte se lit en erreur et ne relance pas aussitôt", async () => {
    const mounted = mount({
      context: () => Promise.reject(new HermesClientError("l’hôte n’a pas répondu", 502, "HERMES_UNREACHABLE")),
    });
    const body = await (await mounted.app.request("/runtime-1/model-context")).json() as { status: string; error: string };
    expect(body.status).toBe("error");
    expect(body.error).toBe("l’hôte n’a pas répondu");
    await mounted.app.request("/runtime-1/model-context");
    expect(mounted.calls()).toBe(1);
  });
});
