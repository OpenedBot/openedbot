import { Hono } from "hono";
import { canOperateWorkspace } from "@openedbot/contracts-api";
import {
  readCreateBotInput,
  readPersonaDraftHash,
  readUpdateBotInput,
} from "@openedbot/roster/domain/bot-input";
import {
  readCapabilityEnabled,
  readMcpServerName,
  readProfileDisplayName,
  readProfileRepairModel,
  readSkillName,
  readToolsetName,
  parseRuntimeMemoryWrite,
} from "@openedbot/roster/domain/bot-capabilities";
import { readSectionName, readSectionOrder, readSectionPatch, readSectionsOrder } from "@openedbot/roster/domain/section-input";
import { readSectionId } from "@openedbot/roster/domain/section-id";
import { readToolErrorCursor, readToolErrorLimit } from "@openedbot/roster/domain/tool-errors";
import { createBot, deleteBot, listRoster, resolveBotDeps, updateBot, type BotRouteDeps } from "@openedbot/roster/application/bots";
import { botRuns } from "@openedbot/execution/application/bot-runs";
import {
  createBotProfile,
  readBotCapabilitiesView,
  readBotProfileStatus,
  readBotRuntimeMemory,
  readBotToolErrors,
  repairBotProfile,
  setBotCapability,
  setBotCredential,
  writeBotRuntimeMemory,
} from "@openedbot/roster/application/bot-profiles";
import {
  confirmPersonaDraft,
  queuePersonaDraft,
  readLatestPersonaDraft,
} from "@openedbot/roster/application/persona-drafts";
import { createSection, deleteSection, orderPins, orderSection, orderSections, patchSection } from "@openedbot/roster/application/sections";
import { providerApiKey, providerSlug } from "@openedbot/runtimes/domain/runtime/provider-credentials";
import type { Db } from "@openedbot/platform-db";
import type { AppVariables } from "../identity/auth";
import { requireOperator } from "../identity/auth";
import { retryBotProfileProvision } from "@openedbot/roster/application/profile-provisions";
import { profileModelSync, resetBotModelOverrides } from "@openedbot/roster/application/bot-model-reset";
import { retryBotHostCleanup } from "@openedbot/roster/application/bot-host-cleanups";
import { readBotToolPoliciesView, setBotToolPolicies } from "@openedbot/roster/application/tool-policies";
import { readToolPolicyWrites } from "@openedbot/roster/domain/tool-policy-input";
import type { ApiConfig } from "../../infrastructure/config";
import { jsonBody } from "../../interfaces/http/http-error";

/** `?purge=1`, `?purge=true`, `?purge`: everything else is false. */
function isTruthyFlag(raw: string | undefined): boolean {
  return raw !== undefined && (raw === "" || raw === "1" || raw.toLowerCase() === "true");
}

export function botRoutes(db: Db, config: ApiConfig, routeDeps: BotRouteDeps = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const deps = resolveBotDeps(config, botRuns, routeDeps);

  routes.get("/", async (context) => {
    const auth = context.get("auth");
    // The normal roster excludes hidden preferences. Only the explicit
    // recovery view asks for the rows with their `hidden` marker.
    const includeHidden = context.req.query("includeHidden") === "true";
    return context.json(await listRoster(db, auth.organizationId, auth.userId, includeHidden));
  });

  routes.post("/", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const bot = await createBot(db, deps, auth.organizationId, readCreateBotInput(body), {
      greeting: { initiatorUserId: auth.userId },
    });
    // A replayed `clientRequestId` answers the bot already created: 200, not 201.
    return context.json(bot, bot.creationReplayed ? 200 : 201);
  });

  // Before the `/:botId/*` routes: `model-overrides` is not a bot id.
  routes.post("/model-overrides/reset", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    return context.json(await resetBotModelOverrides(db, deps, auth.organizationId), 202);
  });

  routes.get("/model-overrides/sync", (context) => {
    const auth = context.get("auth");
    return context.json({ sync: profileModelSync(auth.organizationId) });
  });

  routes.get("/:botId/capabilities", async (context) => {
    const auth = context.get("auth");
    return context.json(await readBotCapabilitiesView(db, deps, {
      organizationId: auth.organizationId,
      botId: context.req.param("botId"),
      canWrite: canOperateWorkspace(auth.role),
      usageWindowDays: config.runEventsRetentionDays,
    }));
  });

  routes.post("/:botId/profile", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const displayName = readProfileDisplayName(body);
    return context.json(await createBotProfile(db, deps, auth.organizationId, context.req.param("botId"), displayName));
  });

  routes.post("/:botId/profile-provision/retry", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    return context.json(await retryBotProfileProvision(db, auth.organizationId, context.req.param("botId")));
  });

  routes.post("/:botId/host-cleanup/retry", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const bot = await retryBotHostCleanup(db, auth.organizationId, context.req.param("botId"));
    return bot ? context.json(bot) : context.body(null, 204);
  });

  routes.get("/:botId/profile/status", async (context) => {
    const auth = context.get("auth");
    return context.json(await readBotProfileStatus(db, deps, auth.organizationId, context.req.param("botId")));
  });

  for (const mode of ["transfer", "reset"] as const) {
    routes.post(`/:botId/profile/${mode}`, async (context) => {
      const auth = context.get("auth");
      requireOperator(auth);
      const pick = readProfileRepairModel(await jsonBody(context.req.raw));
      return context.json(await repairBotProfile(db, deps, auth.organizationId, context.req.param("botId"), mode, pick));
    });
  }

  routes.post("/:botId/capabilities/toolsets/:name", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const name = readToolsetName(context.req.param("name"));
    const enabled = readCapabilityEnabled(await jsonBody(context.req.raw));
    return context.json(await setBotCapability(db, deps, auth.organizationId, context.req.param("botId"), { kind: "toolset", name, enabled }));
  });

  routes.post("/:botId/capabilities/mcp/:name", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const name = readMcpServerName(context.req.param("name"));
    const enabled = readCapabilityEnabled(await jsonBody(context.req.raw));
    return context.json(await setBotCapability(db, deps, auth.organizationId, context.req.param("botId"), { kind: "mcp", name, enabled }));
  });

  routes.post("/:botId/capabilities/skills/:name", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const name = readSkillName(context.req.param("name"));
    const enabled = readCapabilityEnabled(await jsonBody(context.req.raw));
    return context.json(await setBotCapability(db, deps, auth.organizationId, context.req.param("botId"), { kind: "skill", name, enabled }));
  });

  routes.post("/:botId/credentials/:provider", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const provider = providerSlug(context.req.param("provider"));
    const body = await jsonBody(context.req.raw);
    const apiKey = providerApiKey(body.apiKey);
    const label = typeof body.label === "string" ? body.label : undefined;
    return context.json(await setBotCredential(db, deps, auth.organizationId, context.req.param("botId"), { provider, apiKey, label }));
  });

  routes.delete("/:botId/credentials/:provider", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const provider = providerSlug(context.req.param("provider"));
    return context.json(await setBotCredential(db, deps, auth.organizationId, context.req.param("botId"), { provider, remove: true }));
  });

  // PERM2-5: every member reads the per-tool policies; owner and admin write them.
  routes.get("/:botId/tool-policies", async (context) => {
    const auth = context.get("auth");
    return context.json(await readBotToolPoliciesView(db, auth.organizationId, context.req.param("botId"), canOperateWorkspace(auth.role)));
  });

  routes.patch("/:botId/tool-policies", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const entries = readToolPolicyWrites(await jsonBody(context.req.raw));
    return context.json(await setBotToolPolicies(db, deps, {
      organizationId: auth.organizationId,
      botId: context.req.param("botId"),
      actor: { userId: auth.userId },
      entries,
    }));
  });

  routes.get("/:botId/tool-errors", async (context) => {
    const auth = context.get("auth");
    const url = new URL(context.req.url);
    const limit = readToolErrorLimit(url.searchParams.get("limit"));
    const cursor = readToolErrorCursor(url.searchParams.get("cursor"));
    return context.json(await readBotToolErrors(db, auth.organizationId, context.req.param("botId"), { limit, cursor }));
  });

  routes.get("/:botId/runtime-memory", async (context) => {
    const auth = context.get("auth");
    // `USER.md` holds personal facts about the owner, not
    // settings: this read is not of the same class as the other
    // capabilities, and lines up with the write rather than with them.
    requireOperator(auth);
    return context.json(await readBotRuntimeMemory(db, deps, auth.organizationId, context.req.param("botId")));
  });

  routes.post("/:botId/runtime-memory", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const write = parseRuntimeMemoryWrite(body);
    return context.json(await writeBotRuntimeMemory(db, deps, auth.organizationId, context.req.param("botId"), write));
  });

  routes.post("/:botId/persona-drafts", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    return context.json(await queuePersonaDraft(db, botRuns, auth.organizationId, context.req.param("botId")), 202);
  });

  routes.get("/:botId/persona-drafts/latest", async (context) => {
    const auth = context.get("auth");
    return context.json(await readLatestPersonaDraft(db, auth.organizationId, context.req.param("botId")));
  });

  routes.post("/:botId/persona-drafts/:runId/confirm", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const expected = readPersonaDraftHash(body);
    return context.json(await confirmPersonaDraft(
      db,
      auth.organizationId,
      context.req.param("botId"),
      context.req.param("runId"),
      expected,
    ));
  });

  routes.patch("/:botId", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    return context.json(await updateBot(db, deps, auth.organizationId, context.req.param("botId"), readUpdateBotInput(body)));
  });

  routes.delete("/:botId", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    return context.json(await deleteBot(db, deps, auth.organizationId, context.req.param("botId"), {
      purge: isTruthyFlag(context.req.query("purge")),
      force: isTruthyFlag(context.req.query("force")),
    }));
  });

  return routes;
}

export function sectionRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.post("/", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    return context.json(await createSection(db, auth.organizationId, readSectionName(body)), 201);
  });
  // Before `/:sectionId/…`: « pinned » and « order » are not sections.
  routes.put("/order", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    await orderSections(db, auth.organizationId, readSectionsOrder(body.order));
    return context.body(null, 204);
  });
  routes.put("/pinned/order", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    await orderPins(db, auth.organizationId, readSectionOrder(body.order));
    return context.body(null, 204);
  });
  routes.patch("/:sectionId", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const patch = readSectionPatch(body);
    return context.json(await patchSection(db, auth.organizationId, context.req.param("sectionId"), patch));
  });
  routes.put("/:sectionId/order", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const body = await jsonBody(context.req.raw);
    const sectionId = readSectionId(context.req.param("sectionId"));
    const order = readSectionOrder(body.order);
    await orderSection(db, auth.organizationId, sectionId, order);
    return context.body(null, 204);
  });
  routes.delete("/:sectionId", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    await deleteSection(db, auth.organizationId, context.req.param("sectionId"));
    return context.body(null, 204);
  });
  return routes;
}
