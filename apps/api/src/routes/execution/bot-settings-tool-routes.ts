import { isRecord, isUuid } from "@openedbot/contracts-primitives";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  BOT_SETTINGS_TOOL_DESCRIPTION,
  BOT_SETTINGS_TOOL_INPUT_SCHEMA,
  BOT_SETTINGS_TOOL_NAME,
  BOT_SETTINGS_TOOL_SERVER,
  BotSettingsToolInputError,
  readBotSettingsToolArgs,
  type BotSettingsToolArgs,
} from "@openedbot/execution/domain/bot-settings-tool";
import { readBotSettingsRunKey } from "@openedbot/execution/application/bot-settings-run-key";
import { proposeBotSettings } from "@openedbot/roster/application/bot-setting-proposals";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { AppVariables } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { readBearer } from "../../interfaces/http/request-readers";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LIVE_RUN_STATUSES = ["starting", "running", "awaiting_approval"];
const MAX_BODY_BYTES = 64 * 1024;

type JsonRpcId = string | number | null;
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };
type CallerRow = {
  runId: string;
  botId: string | null;
  threadId: string;
  status: string;
  permissionMode: string | null;
};
type ToolScope = { organizationId: string; enabledBotIds: readonly string[] };
type ToolOutcome = { text: string; isError: boolean };

export function botSettingsToolSecretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function botSettingsToolMcpRoutes(
  db: Db,
  config: Pick<ApiConfig, "workerInternalToken">,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.get("/:organizationId", (context) => context.body(null, 405, { Allow: "POST" }));
  routes.delete("/:organizationId", (context) => context.body(null, 405, { Allow: "POST" }));

  routes.post("/:organizationId", async (context) => {
    const organizationId = readUuid(context.req.param("organizationId"));
    const secret = readBearer(context.req.header("Authorization"));
    if (!organizationId || !secret) unauthorized();
    const known = await withTenant(db, organizationId, (tx) => tx<Array<{ enabledBotIds: string[] }>>`
      select enabled_bot_ids::text[] as "enabledBotIds" from runtime_bot_settings_tools
       where organization_id = ${organizationId} and secret_hash = ${botSettingsToolSecretHash(secret)}
    `);
    if (!known[0]) unauthorized();

    const body = await jsonBody(context.req.raw, MAX_BODY_BYTES);
    const method = typeof body.method === "string" ? body.method : "";
    const hasId = Object.hasOwn(body, "id");
    const id = readId(body.id);
    if (!hasId) return context.body(null, 202);
    const response = await answer(db, config, { organizationId, enabledBotIds: known[0].enabledBotIds ?? [] }, id, method, body.params);
    return context.json(response);
  });
  return routes;
}

async function answer(
  db: Db,
  config: Pick<ApiConfig, "workerInternalToken">,
  scope: ToolScope,
  id: JsonRpcId,
  method: string,
  params: unknown,
): Promise<JsonRpcResponse> {
  if (method === "initialize") {
    const requested = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: BOT_SETTINGS_TOOL_SERVER, version: "1.0.0" },
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{ name: BOT_SETTINGS_TOOL_NAME, description: BOT_SETTINGS_TOOL_DESCRIPTION, inputSchema: BOT_SETTINGS_TOOL_INPUT_SCHEMA }],
      },
    };
  }
  if (method === "tools/call") {
    if (!isRecord(params) || params.name !== BOT_SETTINGS_TOOL_NAME) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool; this server only serves ${BOT_SETTINGS_TOOL_NAME}.` } };
    }
    const outcome = await callBotSettingsTool(db, config, scope, params.arguments);
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: outcome.text }], isError: outcome.isError } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const fail = (text: string): ToolOutcome => ({ text, isError: true });

export async function callBotSettingsTool(
  db: Db,
  config: Pick<ApiConfig, "workerInternalToken">,
  scope: ToolScope,
  rawArgs: unknown,
): Promise<ToolOutcome> {
  let args: BotSettingsToolArgs;
  try {
    args = readBotSettingsToolArgs(rawArgs);
  } catch (error) {
    if (error instanceof BotSettingsToolInputError) return fail(error.message);
    throw error;
  }
  const runId = readBotSettingsRunKey(config.workerInternalToken, args.runKey);
  if (!runId) return fail("run_key is not valid: copy it exactly from your instructions.");

  try {
    return await withTenant(db, scope.organizationId, async (tx) => {
      const caller = (await tx<CallerRow[]>`
        select r.id as "runId", r.bot_id as "botId", r.thread_id as "threadId", r.status,
               -- A plan-only turn (0155) is a plan run whatever the bot's mode.
               case when r.plan_only or coalesce(w.plan_only, false) then 'plan' else b.permission_mode end as "permissionMode"
          from runs r
          left join bots b on b.organization_id = r.organization_id and b.id = r.bot_id
          left join workflows w on w.organization_id = r.organization_id and w.id = r.workflow_id
         where r.organization_id = ${scope.organizationId} and r.id = ${runId}
      `)[0];
      if (!caller?.botId) return fail("run_key does not match a run of yours.");
      if (!scope.enabledBotIds.includes(caller.botId)) {
        return fail("bot_settings_propose is switched off for you: the operator can enable self-edit proposals in the agent editor.");
      }
      if (!LIVE_RUN_STATUSES.includes(caller.status)) return fail("run_key belongs to a run that has ended.");
      if ((caller.permissionMode ?? "manual") === "plan") {
        return fail("plan mode: proposing setting changes is disabled");
      }
      const proposal = await proposeBotSettings(tx, {
        organizationId: scope.organizationId,
        botId: caller.botId,
        runId: caller.runId,
        threadId: caller.threadId,
        reason: args.reason,
        proposed: args.proposed,
      });
      return {
        text: `Proposal ${proposal.id} is waiting for the operator's approval in the thread. Nothing has changed yet.`,
        isError: false,
      };
    });
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) return fail(error.message);
    throw error;
  }
}

function readUuid(value: string | undefined): string | null {
  return value && isUuid(value) ? value.toLowerCase() : null;
}

function readId(value: unknown): JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : null;
}

function unauthorized(): never {
  throw new HttpError(401, "UNAUTHORIZED", "Unauthorized.");
}
