import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import type { RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import {
  ExecutionCommandError,
  type ExecutionCommandRow,
} from "@openedbot/execution/application/execution-commands";
import type { ApiConfig } from "../src/infrastructure/config";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { threadCompactRoutes, type ThreadCompactCommands } from "../src/routes/conversation/thread-compact-routes";
import type { RuntimeRow } from "../src/routes/runtimes/runtime-routes";
import { tableSubscriptionPort } from "./fixtures/table-subscription-port";
import { installSubscriptionPort } from "@openedbot/platform-db/subscription-port";

// The subscription reads go through the port, as the API installs it.
beforeAll(() => installSubscriptionPort(tableSubscriptionPort));
afterAll(() => installSubscriptionPort(null));

/**
 * `POST /api/threads/:threadId/compact` (DEV-332). La base est un faux `tx` qui
 * répond selon le texte de la requête ; il applique aussi la règle de la vraie
 * base pour `openedbot_api` : `messages` ne rend aucune ligne hors d'une transaction
 * dont `app.organization_id` est posé (RLS), sans erreur.
 *
 * Depuis S3 (ADR 0001), la route garde puis enregistre une commande que le
 * worker exécute : les commandes sont ici un faux port, et le résumé lui-même
 * (modèle, profil, écriture) est prouvé par `tests/integration/execution-commands.ts`.
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
  /** Ce que la commande devient une fois attendue. */
  outcome?: Partial<ExecutionCommandRow> | null;
  /** La commande déjà enregistrée sous la clé d'idempotence. */
  replay?: Partial<ExecutionCommandRow> | null;
  /** Enregistrée sous la même clé par une requête concurrente, après la première lecture. */
  lateReplay?: Partial<ExecutionCommandRow>;
  /** L'enregistrement échoue : une commande active tient le fil. */
  inProgress?: boolean;
};

function command(fields: Partial<ExecutionCommandRow> = {}): ExecutionCommandRow {
  return {
    id: "command-1", organizationId: "org-1", kind: "thread.compact", threadId: THREAD, runtimeId: "runtime-1",
    requestedByUserId: "u", idempotencyKey: null, status: "queued", attempts: 0, cancelRequestedAt: null,
    leaseOwner: null, leaseGeneration: 0, leaseExpiresAt: null, progress: null, hermesRun: null, result: null, errorCode: null,
    createdAt: new Date(), startedAt: null, finishedAt: null, ...fields,
  };
}

const succeeded = command({
  status: "succeeded",
  result: { summarizedCount: 3, compactedThroughSequence: 3, compactedAt: "2026-10-14T10:00:00.000Z" },
  finishedAt: new Date(),
});

function mount(state: State = {}) {
  const log = {
    queries: 0,
    submitted: [] as Array<Parameters<ThreadCompactCommands["submit"]>[1]>,
    waited: [] as string[],
    replays: [] as string[],
    cancelled: [] as string[],
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
  const commands: ThreadCompactCommands = {
    replay: async (_db, input) => {
      log.replays.push(input.idempotencyKey);
      if (state.replay?.threadId && state.replay.threadId !== input.threadId) {
        throw new ExecutionCommandError("IDEMPOTENCY_KEY_REUSED");
      }
      if (state.lateReplay && log.replays.length > 1) return command(state.lateReplay);
      return state.replay ? command(state.replay) : null;
    },
    submit: async (_db, input) => {
      log.submitted.push(input);
      if (state.inProgress) throw new ExecutionCommandError("COMMAND_IN_PROGRESS", command({ status: "running" }));
      return { command: command({ idempotencyKey: input.idempotencyKey }), replayed: false };
    },
    wait: async (_db, _organizationId, commandId) => {
      log.waited.push(commandId);
      return state.outcome === null ? null : command(state.outcome ?? succeeded);
    },
    cancel: async (_db, _organizationId, threadId) => {
      log.cancelled.push(threadId);
      return state.outcome === null ? null : command({ status: "cancelled", errorCode: "COMMAND_CANCELLED" });
    },
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
    commands,
  }));
  return { app, log };
}

const post = (app: Hono<{ Variables: AppVariables }>, id = THREAD, key?: string) =>
  app.request(`/${id}/compact`, { method: "POST", headers: key ? { "Idempotency-Key": key } : {} });
const KEY = "22222222-2222-4222-8222-222222222222";

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
    expect(mounted.log.submitted).toHaveLength(0);
  });

  test("409 tant qu'un run du fil est en cours, sans toucher au runtime", async () => {
    const mounted = mount({ activeRun: true });
    const response = await post(mounted.app);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "RUN_IN_PROGRESS" } });
    expect(mounted.log.submitted).toHaveLength(0);
  });

  test("422 sous le seuil : tout tient dans la queue récente", async () => {
    const mounted = mount({ messages: longRoom.slice(0, 2) });
    const response = await post(mounted.app);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "COMPACTION_BELOW_THRESHOLD" } });
    expect(mounted.log.submitted).toHaveLength(0);
  });

  test("409 RUNTIME_REQUIRED sans runtime actif", async () => {
    const response = await post(mount({ runtime: null }).app);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "RUNTIME_REQUIRED" } });
  });

  test("refuse quand l'abonnement est inactif et le billing appliqué", async () => {
    const mounted = mount({ billingEnforced: true, subscription: "canceled" });
    expect((await post(mounted.app)).status).toBe(403);
    expect(mounted.log.submitted).toHaveLength(0);
  });

  test("succès : enregistre la commande sur le runtime actif, attend le worker et rend son résultat", async () => {
    const mounted = mount();
    const response = await post(mounted.app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      compacted: true,
      summarizedCount: 3,
      compactedThroughSequence: 3,
      compactedAt: "2026-10-14T10:00:00.000Z",
    });
    expect(mounted.log.submitted).toEqual([{
      organizationId: "org-1", threadId: THREAD, runtimeId: "runtime-1", userId: "u", idempotencyKey: null,
    }]);
    expect(mounted.log.waited).toEqual(["command-1"]);
  });

  test("502 COMPACTION_FAILED quand le worker n'a produit aucun résumé", async () => {
    for (const errorCode of ["COMPACTION_FAILED", "COMMAND_ATTEMPTS_EXHAUSTED", "COMMAND_FAILED"]) {
      const response = await post(mount({ outcome: { status: "failed", errorCode, finishedAt: new Date() } }).app);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: { code: "COMPACTION_FAILED" } });
    }
  });

  test("le refus constaté par le worker garde le code de la route", async () => {
    const cases: Array<[string, number, string]> = [
      ["RUN_IN_PROGRESS", 409, "RUN_IN_PROGRESS"],
      ["COMPACTION_BELOW_THRESHOLD", 422, "COMPACTION_BELOW_THRESHOLD"],
      ["THREAD_NOT_ROOM", 404, "THREAD_NOT_ROOM"],
      ["RUNTIME_REQUIRED", 409, "RUNTIME_REQUIRED"],
    ];
    for (const [errorCode, status, code] of cases) {
      const response = await post(mount({ outcome: { status: "failed", errorCode, finishedAt: new Date() } }).app);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code } });
    }
  });

  test("409 COMPACTION_IN_PROGRESS quand une commande active tient déjà le salon", async () => {
    const mounted = mount({ inProgress: true });
    const response = await post(mounted.app);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "COMPACTION_IN_PROGRESS" } });
    expect(mounted.log.waited).toHaveLength(0);
  });

  test("une commande encore active à l'échéance répond 504, une jamais réclamée 503, une annulée 409", async () => {
    const running = await post(mount({ outcome: { status: "running" } }).app);
    expect(running.status).toBe(504);
    expect(await running.json()).toEqual({ error: { code: "COMPACTION_STILL_RUNNING" } });
    const withdrawn = await post(mount({ outcome: { status: "cancelled", errorCode: "COMMAND_NOT_STARTED", finishedAt: new Date() } }).app);
    expect(withdrawn.status).toBe(503);
    expect(await withdrawn.json()).toEqual({ error: { code: "COMPACTION_NOT_STARTED" } });
    const cancelled = await post(mount({ outcome: { status: "cancelled", errorCode: "COMMAND_CANCELLED", finishedAt: new Date() } }).app);
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toEqual({ error: { code: "COMPACTION_CANCELLED" } });
    const gone = await post(mount({ outcome: null }).app);
    expect(gone.status).toBe(404);
  });

  test("Idempotency-Key : le rejeu rend la commande enregistrée avant toute garde, même sous le seuil", async () => {
    const mounted = mount({ replay: { ...succeeded, idempotencyKey: KEY }, messages: longRoom.slice(0, 2) });
    const response = await post(mounted.app, THREAD, KEY);
    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await response.json()).summarizedCount).toBe(3);
    expect(mounted.log.submitted).toHaveLength(0);
    // Déjà réglée : rien à attendre.
    expect(mounted.log.waited).toHaveLength(0);
  });

  test("Idempotency-Key : une requête concurrente sous la même clé a résumé entre-temps, la garde rejoue sa commande", async () => {
    const mounted = mount({ lateReplay: { ...succeeded, idempotencyKey: KEY }, messages: longRoom.slice(0, 2) });
    const response = await post(mounted.app, THREAD, KEY);
    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(mounted.log.replays).toEqual([KEY, KEY]);
    expect(mounted.log.submitted).toHaveLength(0);
    // Sans clé, le refus reste celui de la garde.
    expect((await post(mount({ messages: longRoom.slice(0, 2) }).app)).status).toBe(422);
  });

  test("Idempotency-Key : une clé neuve enregistre, une clé d'un autre salon est refusée, une clé invalide aussi", async () => {
    const fresh = mount();
    expect((await post(fresh.app, THREAD, KEY)).status).toBe(200);
    expect(fresh.log.submitted[0]?.idempotencyKey).toBe(KEY);
    const reused = await post(mount({ replay: { threadId: "33333333-3333-4333-8333-333333333333" } }).app, THREAD, KEY);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({ error: { code: "IDEMPOTENCY_KEY_REUSED" } });
    expect((await post(mount().app, THREAD, "not-a-uuid")).status).toBe(400);
  });
});

describe("DELETE /:threadId/compact", () => {
  test("arrête le résumé en cours, 404 s'il n'y en a aucun, refuse un membre", async () => {
    const mounted = mount();
    const stopped = await mounted.app.request(`/${THREAD}/compact`, { method: "DELETE" });
    expect(stopped.status).toBe(204);
    expect(mounted.log.cancelled).toEqual([THREAD]);
    expect((await mount({ outcome: null }).app.request(`/${THREAD}/compact`, { method: "DELETE" })).status).toBe(404);
    const member = mount({ role: "member" });
    expect((await member.app.request(`/${THREAD}/compact`, { method: "DELETE" })).status).toBe(403);
    expect(member.log.cancelled).toHaveLength(0);
  });
});
