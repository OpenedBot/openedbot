import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import type { HermesClientConfig } from "@openedbot/hermes";
import type { RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import type { CompactHermes } from "@openedbot/conversation/application/compact-thread";
import type { ApiConfig } from "../src/infrastructure/config";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { threadCompactRoutes } from "../src/routes/conversation/thread-compact-routes";
import type { RuntimeRow } from "../src/routes/runtimes/runtime-routes";
import { tableSubscriptionPort } from "./fixtures/table-subscription-port";
import { installSubscriptionPort } from "@openedbot/platform-db/subscription-port";

// The subscription reads go through the port, as the API installs it.
beforeAll(() => installSubscriptionPort(tableSubscriptionPort));
afterAll(() => installSubscriptionPort(null));

/**
 * `POST /api/threads/:threadId/compact` (DEV-332). La base est un faux `tx` qui
 * répond selon le texte de la requête ; il applique aussi la règle de la vraie
 * base pour `ohb_api` : `messages` ne rend aucune ligne hors d'une transaction
 * dont `app.organization_id` est posé (RLS), sans erreur.
 */

const THREAD = "11111111-1111-4111-8111-111111111111";
const owner: AuthContext = {
  sessionId: "s", organizationId: "org-1", userId: "u", role: "owner", kind: "web", credentialHash: "hash",
};
const runtime: RuntimeRow = {
  id: "runtime-1", name: "VPS", reachability: "connector", endpoint: null,
  tokenCiphertext: null, tokenNonce: null, tokenTag: null, tokenKeyId: null,
  linkConnectedAt: new Date("2026-09-09T08:00:00Z"), linkLastSeenAt: new Date(),
  linkFeatures: [], linkRotatedAt: null, linkLastReplacedAt: null, linkHijackSuspectedAt: null,
  selectedProvider: "anthropic", selectedModel: "claude-sonnet-5", reasoningEffort: null,
  capacity: 4, lastHealthStatus: "healthy", lastHealthError: null, lastProbedAt: null,
  isActive: true, createdAt: new Date(), updatedAt: new Date(),
};

const text = (value: string) => [{ type: "text", text: value }];
const long = "x".repeat(20_000);
const ada = { authorName: "Ada", authorSlug: "ada" };
const none = { authorName: null, authorSlug: null };
const longRoom = [
  { role: "user", content: text("Plan the launch"), sequence: 1, ...none },
  { role: "assistant", content: text("Draft ready"), sequence: 2, ...ada },
  { role: "user", content: text(long), sequence: 3, ...none },
  { role: "assistant", content: text(long), sequence: 4, ...ada },
];

type State = {
  role?: AuthContext["role"];
  group?: boolean;
  threadFound?: boolean;
  activeRun?: boolean;
  runtime?: RuntimeRow | null;
  messages?: typeof longRoom;
  subscription?: string | null;
  billingEnforced?: boolean;
  /** Le résumeur : un texte, ou `null` pour un run Hermes en échec. */
  output?: string | null;
};

function mount(state: State = {}) {
  const log = {
    queries: 0,
    inserts: [] as unknown[][],
    configs: [] as HermesClientConfig[],
    runBodies: [] as Array<{ model?: string | null; provider?: string | null }>,
  };
  let tenant: string | null = null;
  let inTransaction = false;
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ");
    log.queries += 1;
    if (sql.includes("set_config")) {
      if (inTransaction) tenant = String(values[0]);
      return Promise.resolve([]);
    }
    if (sql.includes("from subscriptions")) {
      return Promise.resolve(state.subscription === null ? [] : [{ status: state.subscription ?? "active" }]);
    }
    if (sql.includes("from threads t")) {
      return Promise.resolve(state.threadFound === false ? [] : [{
        groupId: state.group === false ? null : "group-1", assignmentMode: "per_bot", operatorName: "Camille",
      }]);
    }
    if (sql.includes("from runs")) return Promise.resolve([{ active: state.activeRun === true }]);
    if (sql.includes("from bots b")) {
      return Promise.resolve([{ botId: "bot-ada", profile: "ada", model: "gpt-5.6-luna", reasoningEffort: null }]);
    }
    if (sql.includes("from runtimes")) {
      return Promise.resolve(state.runtime === undefined ? [runtime] : state.runtime ? [state.runtime] : []);
    }
    if (sql.includes("from thread_compactions")) return Promise.resolve([]);
    if (sql.includes("insert into thread_compactions")) {
      log.inserts.push(values);
      return Promise.resolve([]);
    }
    if (sql.includes("group_id as")) return Promise.resolve([{ groupId: "group-1" }]);
    if (sql.includes("from messages m")) {
      // Les valeurs, dans l'ordre : org, thread, runId x2, après, avant x2, newest x3.
      if (!inTransaction || tenant === null) return Promise.resolve([]);
      const after = Number(values[4]);
      const before = values[5] === null ? Infinity : Number(values[5]);
      const newest = Number(values[7]);
      const rows = (state.messages ?? longRoom).filter((row) => row.sequence > after && row.sequence < before);
      return Promise.resolve(newest > 0 ? rows.slice(-newest) : rows.slice(0, 500));
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (tx as unknown as { begin: (work: (inner: unknown) => Promise<unknown>) => Promise<unknown> }).begin = async (work) => {
    inTransaction = true;
    tenant = null;
    try {
      return await work(tx);
    } finally {
      inTransaction = false;
      tenant = null;
    }
  };
  const links: RuntimeLinks = {
    connected: () => true,
    dial: () => () => Promise.reject(new Error("unused")),
    revoke: () => false,
    notifyRotation: () => false,
    close: () => false,
  };
  const output = state.output === undefined ? "# Room state\n- ok" : state.output;
  const client: CompactHermes = {
    ensureSession: async () => undefined,
    createRun: async (body) => {
      log.runBodies.push({ model: body.model, provider: body.provider });
      return "hermes-compact-1";
    },
    getRunStatus: async () => ({
      id: "hermes-compact-1", status: output ? "completed" : "failed", output, error: null,
    }) as never,
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", { ...owner, role: state.role ?? "owner" });
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
  app.route("/", threadCompactRoutes(tx, { billingEnforced: state.billingEnforced === true } as ApiConfig, {
    links,
    locator: { locate: async () => ({ kind: "local" }) } as never,
    clientFactory: (config) => {
      log.configs.push(config);
      return client;
    },
    now: () => new Date("2026-10-14T10:00:00Z"),
  }));
  return { app, log };
}

const post = (app: Hono<{ Variables: AppVariables }>, id = THREAD) =>
  app.request(`/${id}/compact`, { method: "POST" });

describe("POST /:threadId/compact", () => {
  test("refuse un membre avant toute lecture en base", async () => {
    const mounted = mount({ role: "member" });
    const response = await post(mounted.app);
    expect(response.status).toBe(403);
    expect(mounted.log.queries).toBe(0);
  });

  test("404 pour un identifiant invalide ou un fil inconnu", async () => {
    expect((await post(mount().app, "pas-un-uuid")).status).toBe(404);
    const response = await post(mount({ threadFound: false }).app);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "THREAD_NOT_FOUND" } });
  });

  test("404 THREAD_NOT_ROOM pour un fil hors salon", async () => {
    const mounted = mount({ group: false });
    const response = await post(mounted.app);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "THREAD_NOT_ROOM" } });
    expect(mounted.log.configs).toHaveLength(0);
  });

  test("409 tant qu'un run du fil est en cours, sans toucher au runtime", async () => {
    const mounted = mount({ activeRun: true });
    const response = await post(mounted.app);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "RUN_IN_PROGRESS" } });
    expect(mounted.log.configs).toHaveLength(0);
  });

  test("422 sous le seuil : tout tient dans la queue récente", async () => {
    const mounted = mount({ messages: longRoom.slice(0, 2) });
    const response = await post(mounted.app);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "COMPACTION_BELOW_THRESHOLD" } });
    expect(mounted.log.configs).toHaveLength(0);
  });

  test("409 RUNTIME_REQUIRED sans runtime actif", async () => {
    const response = await post(mount({ runtime: null }).app);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "RUNTIME_REQUIRED" } });
  });

  test("refuse quand l'abonnement est inactif et le billing appliqué", async () => {
    const mounted = mount({ billingEnforced: true, subscription: "canceled" });
    expect((await post(mounted.app)).status).toBe(403);
    expect(mounted.log.configs).toHaveLength(0);
  });

  test("succès : plie tout sauf la queue sur le modèle et le profil du dernier à avoir parlé", async () => {
    const mounted = mount();
    const response = await post(mounted.app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      compacted: true,
      summarizedCount: 3,
      compactedThroughSequence: 3,
      compactedAt: "2026-10-14T10:00:00.000Z",
    });
    expect(mounted.log.inserts).toHaveLength(1);
    // Le modèle propre du membre l'emporte (organisation en `per_bot`), et un
    // lien connecteur sert son profil Hermes.
    expect(mounted.log.runBodies[0]).toMatchObject({ model: "gpt-5.6-luna" });
    expect((mounted.log.configs[0] as { profile?: string | null }).profile).toBe("ada");
  });

  test("502 COMPACTION_FAILED quand le résumeur échoue, rien n'est écrit", async () => {
    const mounted = mount({ output: null });
    const response = await post(mounted.app);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "COMPACTION_FAILED" } });
    expect(mounted.log.inserts).toHaveLength(0);
  });
});
