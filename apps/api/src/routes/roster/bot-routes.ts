import { Hono } from "hono";
import {
  readCreateBotInput,
  readCreationDraftRequest,
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
import { readSectionName, readSectionOrder, readSectionPatch } from "@openedbot/roster/domain/section-input";
import { readSectionId } from "@openedbot/roster/domain/section-id";
import { readToolErrorCursor, readToolErrorLimit } from "@openedbot/roster/domain/tool-errors";
import { createBot, deleteBot, listRoster, resolveBotDeps, updateBot, type BotRouteDeps } from "@openedbot/roster/application/bots";
import { withEffectivePermissions } from "@openedbot/roster/application/bot-effective-permission";
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
  readCreationPersonaDraft,
  readLatestPersonaDraft,
  requestCreationPersonaDraft,
} from "@openedbot/roster/application/persona-drafts";
import { createSection, deleteSection, orderSection, patchSection } from "@openedbot/roster/application/sections";
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

/** `?purge=1`, `?purge=true`, `?purge` : tout le reste est faux. */
function isTruthyFlag(raw: string | undefined): boolean {
  return raw !== undefined && (raw === "" || raw === "1" || raw.toLowerCase() === "true");
}

/** Les rôles qui peuvent écrire les capacités du profil d'un bot. */
function canWriteCapabilities(role: string): boolean {
  return role === "owner" || role === "admin" || role === "agency";
}

export function botRoutes(db: Db, config: ApiConfig, routeDeps: BotRouteDeps = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const deps = resolveBotDeps(config, routeDeps);

  routes.get("/", async (context) => {
    const auth = context.get("auth");
    // Le roster normal exclut les préférences masquées. Seule la vue de
    // récupération explicite demande les lignes avec leur marqueur `hidden`.
    const includeHidden = context.req.query("includeHidden") === "true";
    const roster = await listRoster(db, auth.organizationId, auth.userId, includeHidden);
    return context.json({ ...roster, bots: await withEffectivePermissions(db, auth.organizationId, roster.bots) });
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

  // Avant les routes `/:botId/*` : `model-overrides` n'est pas un id de bot.
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
      canWrite: canWriteCapabilities(auth.role),
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

  // PERM2-5: every member reads the per-tool policies; owner, admin and a
  // mandated agency write them.
  routes.get("/:botId/tool-policies", async (context) => {
    const auth = context.get("auth");
    return context.json(await readBotToolPoliciesView(db, auth.organizationId, context.req.param("botId"), canWriteCapabilities(auth.role)));
  });

  routes.patch("/:botId/tool-policies", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const entries = readToolPolicyWrites(await jsonBody(context.req.raw));
    return context.json(await setBotToolPolicies(db, deps, {
      organizationId: auth.organizationId,
      botId: context.req.param("botId"),
      actor: { userId: auth.userId, kind: auth.actingFleetId ? "agency" : "member", agencyOrganizationId: auth.actingFleetId ?? null },
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
    // `USER.md` tient des faits personnels sur le propriétaire, pas des
    // réglages : cette lecture n'est pas de la même classe que les autres
    // capacités, et s'aligne sur l'écriture plutôt que sur elles.
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
    return context.json(await queuePersonaDraft(db, auth.organizationId, context.req.param("botId")), 202);
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

export function personaDraftRoutes(db: Db, config: ApiConfig, routeDeps: BotRouteDeps = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const deps = resolveBotDeps(config, routeDeps);

  routes.post("/", async (context) => {
    const auth = context.get("auth");
    requireOperator(auth);
    const created = await requestCreationPersonaDraft(db, deps, auth.organizationId, async () =>
      readCreationDraftRequest(await jsonBody(context.req.raw)));
    return context.json(created, 202);
  });

  routes.get("/:runId", async (context) => {
    const auth = context.get("auth");
    return context.json(await readCreationPersonaDraft(db, auth.organizationId, context.req.param("runId")));
  });

  return routes;
}
