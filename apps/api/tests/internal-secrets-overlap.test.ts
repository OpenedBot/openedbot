import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  internalBearer,
  readInternalSecrets,
  runKeyCohortAllows,
  runKeySigningSecret,
  runKeyVerifiers,
  type InternalProcess,
  type InternalSecrets,
} from "@openedbot/platform-config/internal-secrets";
import type { Db } from "@openedbot/platform-db";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { NO_RUNTIME_LINK_LOCATOR } from "@openedbot/runtime-link/application/instances";
import { readRoutineRunKeyWith, signRoutineRunKey } from "@openedbot/execution/application/routine-run-key";
import { internalEventRoutes } from "../src/routes/events/event-routes";
import { internalInventoryRoutes } from "../src/routes/runtimes/runtime-inventory-warm";
import { runtimeLinkInternalRoutes } from "../src/routes/runtimes/runtime-link-routes";

/**
 * S1b (ADR 0001, 4.7): a rolling update runs containers of two neighbouring
 * phases side by side. For every neighbouring pair, in both directions, what
 * an emitter of one phase sends must be accepted by a verifier of the other:
 * events (worker -> API), relay (worker or API -> relay routes), inventory
 * (gateway -> API) and run keys (worker signs, API reads). A skipped phase
 * (P1 straight to P3) must fail: that is what the barriers between phases
 * prevent.
 */
const split = {
  EVENTS_INTERNAL_TOKEN: "e".repeat(64),
  RELAY_INTERNAL_TOKEN: "r".repeat(64),
  INVENTORY_INTERNAL_TOKEN: "i".repeat(64),
  RUN_KEY_SECRET: "k".repeat(64),
};
const LEGACY = "l".repeat(64);
const BOUND = "2026-11-07T12:00:00.000Z";
const RUN = "5f0f8a3a-1111-4222-8333-444455556666";
const RUN_CREATED = new Date("2026-11-07T11:00:00.000Z");

const PHASES: Record<string, Record<string, string>> = {
  before: { WORKER_INTERNAL_TOKEN: LEGACY },
  P1: { ...split, WORKER_INTERNAL_TOKEN: LEGACY, INTERNAL_TOKENS_EMIT: "legacy" },
  P2: { ...split, WORKER_INTERNAL_TOKEN: LEGACY, INTERNAL_TOKENS_EMIT: "split" },
  P3: { ...split, RUN_KEY_PREVIOUS_SECRET: LEGACY, RUN_KEY_PREVIOUS_CREATED_BEFORE: BOUND },
  P4: { ...split },
};
const secrets = <P extends InternalProcess>(process: P, phase: string): InternalSecrets<P> =>
  readInternalSecrets(process, "production", PHASES[phase]!);

function verifierApp(api: InternalSecrets<"api">): Hono {
  const db = { begin: async () => [] } as unknown as Db;
  const routes = new Hono();
  routes.route("/internal/events", internalEventRoutes(db, api, new EventHub(), () => {}));
  routes.route("/internal/runtime-inventory", internalInventoryRoutes(api, { warm: () => {}, idle: async () => {} }));
  routes.route("/internal/runtime-links", runtimeLinkInternalRoutes(api, null, NO_RUNTIME_LINK_LOCATOR));
  routes.onError((error, context) => context.json({}, ((error as { status?: number }).status ?? 500) as 400));
  return routes;
}

async function accepted(app: Hono, path: string, authorization: string): Promise<boolean> {
  const response = await app.request(`http://localhost${path}`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: "{}",
  });
  return response.status !== 401;
}

async function compatible(emitterPhase: string, verifierPhase: string): Promise<Record<string, boolean>> {
  const worker = secrets("worker", emitterPhase);
  const gateway = secrets("link-gateway", emitterPhase);
  const apiEmitter = secrets("api", emitterPhase);
  const api = secrets("api", verifierPhase);
  const app = verifierApp(api);
  const key = signRoutineRunKey(runKeySigningSecret(worker), RUN);
  const read = readRoutineRunKeyWith(runKeyVerifiers(api), key);
  return {
    events: await accepted(app, "/internal/events/publish", internalBearer(worker, "events")),
    workerRelay: await accepted(app, `/internal/runtime-links/${RUN}/control`, internalBearer(worker, "relay")),
    apiHop: await accepted(app, `/internal/runtime-links/${RUN}/probe`, internalBearer(apiEmitter, "relay")),
    gatewayHop: await accepted(app, `/internal/runtime-links/${RUN}/control`, internalBearer(gateway, "relay")),
    inventory: await accepted(app, "/internal/runtime-inventory/changed", internalBearer(gateway, "inventory")),
    runKey: read !== null && read.runId === RUN && runKeyCohortAllows(read.verifier, RUN_CREATED),
  };
}

const ALL = { events: true, workerRelay: true, apiHop: true, gatewayHop: true, inventory: true, runKey: true };

describe("rolling update between neighbouring phases (S1b)", () => {
  for (const [older, newer] of [["before", "P1"], ["P1", "P2"], ["P2", "P3"], ["P3", "P4"]] as const) {
    test(`${older} and ${newer} side by side: every call accepted both ways`, async () => {
      expect(await compatible(older, newer)).toEqual(ALL);
      // From P4 on, a key signed under P3 (split) is read by the role's secret: the previous one is gone.
      expect(await compatible(newer, older)).toEqual(ALL);
    });
  }

  test("a skipped phase fails: P1 containers beside P3 ones are refused, hence the barriers", async () => {
    const result = await compatible("P1", "P3");
    expect(result.events).toBe(false);
    expect(result.workerRelay).toBe(false);
    expect(result.inventory).toBe(false);
    // The run key signed with the former secret is still read in P3, for the cohort only.
    expect(result.runKey).toBe(true);
  });

  test("P4 refuses a key signed with the former secret: the database proof must come first", async () => {
    expect((await compatible("P1", "P4")).runKey).toBe(false);
  });

  test("rollback P3 -> P2 needs the former secret back WITH an explicit EMIT", () => {
    expect(() => readInternalSecrets("api", "production", { ...split, WORKER_INTERNAL_TOKEN: LEGACY })).toThrow(/INTERNAL_TOKENS_EMIT must be set/);
    expect(readInternalSecrets("api", "production", { ...split, WORKER_INTERNAL_TOKEN: LEGACY, INTERNAL_TOKENS_EMIT: "split" }).emit).toBe("split");
  });
});
