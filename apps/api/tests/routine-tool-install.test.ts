import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { BotRoutineToolDto } from "@openedbot/contracts-api";
import { HttpError } from "../src/interfaces/http/http-error";
import type { AppVariables } from "../src/routes/identity/auth";
import { botRoutineToolRoutes, routineToolUsesDevelopmentCallback } from "../src/routes/execution/routine-tool-install-routes";
import { routineToolStatus, withRoutineToolReconcile, type RoutineToolBotRow } from "../src/routes/execution/routine-tool-install";

test("HTTP callbacks use an enrolled local link only in development; HTTPS keeps its normal path", () => {
  expect(routineToolUsesDevelopmentCallback({ environment: "development", publicUrl: "http://localhost:8790" })).toBe(true);
  expect(routineToolUsesDevelopmentCallback({ environment: "development", publicUrl: "https://api.example.test" })).toBe(false);
  expect(routineToolUsesDevelopmentCallback({ environment: "production", publicUrl: "http://localhost:8790" })).toBe(false);
  expect(routineToolUsesDevelopmentCallback({ environment: "production", publicUrl: "https://api.example.test" })).toBe(false);
  expect(routineToolUsesDevelopmentCallback({ environment: "test", publicUrl: "http://localhost:8790" })).toBe(false);
});

const RUNTIME = "91870000-0000-4000-8000-000000000004";
const NOW = new Date("2026-11-12T12:00:00Z");
const LIVE = ["mcp_management", "profile_capabilities", "mcp_live_reload"];
const bot = (patch: Partial<RoutineToolBotRow> = {}): RoutineToolBotRow => ({
  id: "bot", slug: "alpha", profile: "alpha", retired: false, provision: "succeeded", switchedOff: false, runtimeId: null, enabledAt: null,
  disabledAt: null, readyAt: null, restartPendingSince: null, blockedReason: null, nextAttemptAt: null, ...patch,
});
const proven = { runtimeId: RUNTIME, enabledAt: new Date("2026-11-12T11:00:00Z") };
const host = { block: null, runtimeId: RUNTIME, features: LIVE };

test("the dialog's status of one bot, rule by rule (0187)", () => {
  expect(routineToolStatus(bot({ ...proven, readyAt: new Date("2026-11-12T11:58:00Z") }), host, NOW))
    .toEqual({ enabled: true, available: true, restartPending: false, status: "active", reason: null });
  // Proven, inside the gateway's reload window.
  expect(routineToolStatus(bot({ ...proven, readyAt: new Date("2026-11-12T12:01:00Z") }), host, NOW).status).toBe("pending");
  expect(routineToolStatus(bot({ ...proven, restartPendingSince: NOW }), host, NOW))
    .toMatchObject({ status: "restart_pending", restartPending: true });
  // The operator's choice wins over everything, host problems included.
  expect(routineToolStatus(bot({ switchedOff: true }), { block: "host_unsupported", runtimeId: null, features: [] }, NOW))
    .toMatchObject({ status: "switched_off", enabled: false, available: false });
  // Proven on another runtime: not here.
  expect(routineToolStatus(bot({ ...proven, runtimeId: "other", readyAt: NOW }), host, NOW).status).toBe("pending");
  for (const block of ["https_required", "runtime_required", "host_unsupported"] as const) {
    expect(routineToolStatus(bot(), { block, runtimeId: null, features: [] }, NOW))
      .toMatchObject({ status: "unavailable", reason: block, available: false, enabled: true });
  }
  expect(routineToolStatus(bot(), { ...host, features: ["mcp_management", "mcp_live_reload"] }, NOW))
    .toMatchObject({ status: "unavailable", reason: "profile_unsupported" });
  expect(routineToolStatus(bot({ profile: null }), { ...host, features: ["mcp_management", "mcp_live_reload"] }, NOW).status).toBe("pending");
  // Waiting, with the cause when one is known.
  expect(routineToolStatus(bot(), { block: "host_offline", runtimeId: null, features: [] }, NOW))
    .toMatchObject({ status: "pending", reason: "host_offline", available: true });
  // Already installed and proven: the host being away does not make it « about to install ».
  const ready = { ...proven, readyAt: new Date("2026-11-12T11:58:00Z") };
  for (const offline of [{ block: "host_offline" as const, runtimeId: null, features: [] }, { block: "host_offline" as const, runtimeId: RUNTIME, features: [] }]) {
    expect(routineToolStatus(bot(ready), offline, NOW)).toMatchObject({ status: "active", reason: "host_offline", available: true });
  }
  // A profile whose creation failed, or a bot in the trash, is not « installed » because the host is away.
  expect(routineToolStatus(bot({ ...ready, provision: "failed" }), { block: "host_offline", runtimeId: null, features: [] }, NOW))
    .toMatchObject({ status: "unavailable", reason: "profile_failed" });
  expect(routineToolStatus(bot({ ...ready, retired: true }), { block: "host_offline", runtimeId: null, features: [] }, NOW).status).not.toBe("active");
  // Proven but not yet seen by the gateway, or proven elsewhere: still waiting to install.
  expect(routineToolStatus(bot({ ...proven, readyAt: new Date("2026-11-12T12:01:00Z") }), { block: "host_offline", runtimeId: null, features: [] }, NOW))
    .toMatchObject({ status: "pending", reason: "host_offline" });
  expect(routineToolStatus(bot({ ...ready, runtimeId: "other" }), { block: "host_offline", runtimeId: RUNTIME, features: [] }, NOW))
    .toMatchObject({ status: "pending", reason: "host_offline" });
  expect(routineToolStatus(bot({ blockedReason: "host_unreachable" }), host, NOW)).toMatchObject({ status: "pending", reason: "host_unreachable" });
  // A profile being created waits; one whose creation failed has its own, lasting, state.
  expect(routineToolStatus(bot({ provision: "running" }), host, NOW)).toMatchObject({ status: "pending", reason: "profile_preparing" });
  expect(routineToolStatus(bot({ provision: "failed" }), host, NOW)).toMatchObject({ status: "unavailable", reason: "profile_failed", available: false });
});

test("the host's inventory signal warms the inventory AND reconciles the organization's routine tool", () => {
  const warmed: string[] = [];
  const scheduled: string[] = [];
  const warmer = withRoutineToolReconcile(
    { warm: (organizationId: string, runtimeId: string) => { warmed.push(`${organizationId}/${runtimeId}`); }, idle: async () => {} },
    { schedule: (organizationId) => { scheduled.push(organizationId); } },
  );
  warmer.warm("org", "rt");
  expect(warmed).toEqual(["org/rt"]);
  expect(scheduled).toEqual(["org"]);
  expect(typeof warmer.idle).toBe("function");
});

function mountRoutes(role: "owner" | "member") {
  const calls: string[] = [];
  let switchedOff = false;
  const state = (): BotRoutineToolDto => ({ enabled: !switchedOff, available: true, status: switchedOff ? "switched_off" : "pending", reason: null, restartPending: false });
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", { sessionId: "s", organizationId: "org", userId: "user", role, kind: "web", credentialHash: "x" });
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ code: error.code }, error.status as 400)
    : context.json({ code: "INTERNAL", message: String(error) }, 500));
  app.route("/api/bots", botRoutineToolRoutes({
    status: async (_org, botId) => { calls.push(`status:${botId}`); return botId === "missing" ? null : state(); },
    setSwitchedOff: async (_org, botId, off, userId) => { calls.push(`switch:${botId}:${off}:${userId}`); switchedOff = off; },
    schedule: (org) => { calls.push(`schedule:${org}`); },
  }));
  return { app, calls };
}

test("GET reads the status without starting any host write", async () => {
  const { app, calls } = mountRoutes("member");
  const response = await app.request("/api/bots/b1/routine-tool");
  expect(response.status).toBe(200);
  expect((await response.json() as BotRoutineToolDto).status).toBe("pending");
  expect(calls).toEqual(["status:b1"]);
  expect((await app.request("/api/bots/missing/routine-tool")).status).toBe(404);
});

test("PUT records the operator's choice, schedules the pass and answers at once", async () => {
  const { app, calls } = mountRoutes("owner");
  const put = (body: unknown) => app.request("/api/bots/b1/routine-tool", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const off = await put({ enabled: false });
  expect(off.status).toBe(200);
  expect(await off.json()).toMatchObject({ enabled: false, status: "switched_off" });
  expect(calls).toEqual(["status:b1", "switch:b1:true:user", "schedule:org", "status:b1"]);
  expect((await put({ enabled: "yes" })).status).toBe(400);
});

test("PUT is for operators only", async () => {
  const { app, calls } = mountRoutes("member");
  const response = await app.request("/api/bots/b1/routine-tool", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
  });
  expect(response.status).toBe(403);
  expect(calls).toEqual([]);
});
