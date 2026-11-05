import { isRecord, isUuid } from "@openedbot/contracts-primitives";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  ROUTINE_LIMITS,
  nextOccurrence,
} from "@openedbot/execution/domain/routines";
import {
  ROUTINE_TOOL_DESCRIPTION,
  ROUTINE_TOOL_INPUT_SCHEMA,
  ROUTINE_TOOL_MIN_INTERVAL_MINUTES,
  ROUTINE_TOOL_NAME,
  ROUTINE_TOOL_SERVER,
  RoutineToolInputError,
  normalizeRoutineSchedule,
  readRoutineToolArgs,
  routineToolWriteRight,
  scheduleRespectsMinimumInterval,
  type RoutineToolArgs,
} from "@openedbot/execution/domain/routine-tool";
import { readRoutineRunKey } from "@openedbot/execution/application/routine-run-key";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { AppVariables } from "../identity/auth";
import type { ApiConfig } from "../../infrastructure/config";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { readBearer } from "../../interfaces/http/request-readers";
import { lockRoutineQuota, publicRoutine, validatedRoutineInput } from "./routine-routes";

/**
 * Le serveur MCP `openedbot_routines` : l'outil `routine_manage` (DEV-209), appelé
 * par le gateway Hermes de l'hôte pendant un run, en https, jamais par un
 * navigateur.
 *
 * Deux preuves, deux portées :
 *   - le bearer, posé dans la config MCP de l'hôte à l'installation, prouve le
 *     RUNTIME (une ligne de `runtime_routine_tools`, haché en base) ;
 *   - `run_key`, signé par le worker pour le run en cours, dit QUEL bot
 *     appelle et depuis quel run (`routine-run-key.ts`).
 * Un bot ne touche donc que ses propres routines, et seulement pendant un run
 * vivant.
 *
 * Transport : MCP « Streamable HTTP », réponses JSON simples (le client
 * accepte `application/json`), sans session ni flux serveur. Le GET d'un
 * flux d'événements reçoit 405, ce que la spécification autorise.
 *
 * Politique du bot (mode de permission de l'éditeur d'agent) :
 *   - `auto` / `bypass` : l'écriture est faite tout de suite ;
 *   - `manual` : une routine créée l'est EN PAUSE, et `resume` / `remove`
 *     sont refusés : l'opérateur l'active ou la supprime dans « Routines… » ;
 *   - `plan` : aucune écriture ;
 *   - tout autre mode : comme `manual` (`routineToolWriteRight`, PERM2-9).
 * Un run déclenché par une routine ne crée ni ne modifie de routine. Une
 * routine créée par le bot naît avec « Ne jamais attendre » (PERM2-9).
 */
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
  status: string;
  permissionMode: string | null;
  fromRoutine: boolean;
};

type RoutineRow = Parameters<typeof publicRoutine>[0];

export function routineToolSecretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function routineToolMcpRoutes(
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
      select enabled_bot_ids::text[] as "enabledBotIds" from runtime_routine_tools
       where organization_id = ${organizationId} and secret_hash = ${routineToolSecretHash(secret)}
    `);
    if (!known[0]) unauthorized();
    const enabledBotIds = known[0].enabledBotIds ?? [];

    const body = await jsonBody(context.req.raw, MAX_BODY_BYTES);
    const method = typeof body.method === "string" ? body.method : "";
    const hasId = Object.hasOwn(body, "id");
    const id = readId(body.id);
    // Une notification (`notifications/initialized`…) n'attend pas de réponse.
    if (!hasId) return context.body(null, 202);
    const response = await answer(db, config, { organizationId, enabledBotIds }, id, method, body.params);
    return context.json(response);
  });

  return routes;
}

type ToolScope = { organizationId: string; enabledBotIds: readonly string[] };

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
        serverInfo: { name: ROUTINE_TOOL_SERVER, version: "1.0.0" },
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{ name: ROUTINE_TOOL_NAME, description: ROUTINE_TOOL_DESCRIPTION, inputSchema: ROUTINE_TOOL_INPUT_SCHEMA }],
      },
    };
  }
  if (method === "tools/call") {
    if (!isRecord(params) || params.name !== ROUTINE_TOOL_NAME) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool; this server only serves ${ROUTINE_TOOL_NAME}.` } };
    }
    const outcome = await callRoutineTool(db, config, scope, params.arguments);
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: outcome.text }], isError: outcome.isError },
    };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

type ToolOutcome = { text: string; isError: boolean };

const fail = (text: string): ToolOutcome => ({ text, isError: true });
const ok = (value: unknown): ToolOutcome => ({ text: JSON.stringify(value), isError: false });

export async function callRoutineTool(
  db: Db,
  config: Pick<ApiConfig, "workerInternalToken">,
  scope: ToolScope,
  rawArgs: unknown,
  now: () => Date = () => new Date(),
): Promise<ToolOutcome> {
  const { organizationId } = scope;
  let args: RoutineToolArgs;
  try {
    args = readRoutineToolArgs(rawArgs);
  } catch (error) {
    if (error instanceof RoutineToolInputError) return fail(error.message);
    throw error;
  }
  const runId = readRoutineRunKey(config.workerInternalToken, args.runKey);
  if (!runId) return fail("run_key is not valid: copy it exactly from your instructions.");

  try {
    return await withTenant(db, organizationId, async (tx) => {
      const caller = (await tx<CallerRow[]>`
        select r.id as "runId", r.bot_id as "botId", r.status,
               -- A plan-only turn (0155) is a plan run whatever the bot's mode.
               case when r.plan_only or coalesce(w.plan_only, false) then 'plan' else b.permission_mode end as "permissionMode",
               exists(
                 select 1 from routine_executions re
                  where re.organization_id = r.organization_id and re.run_id = r.id
               ) as "fromRoutine"
          from runs r
          left join bots b on b.organization_id = r.organization_id and b.id = r.bot_id
          left join workflows w on w.organization_id = r.organization_id and w.id = r.workflow_id
         where r.organization_id = ${organizationId} and r.id = ${runId}
      `)[0];
      if (!caller || !caller.botId) return fail("run_key does not match a run of yours.");
      if (!scope.enabledBotIds.includes(caller.botId)) {
        return fail("routine_manage is switched off for you: the user can switch it on in \"Routines…\".");
      }
      if (!LIVE_RUN_STATUSES.includes(caller.status)) return fail("run_key belongs to a run that has ended.");
      const botId = caller.botId;
      const right = routineToolWriteRight(caller.permissionMode);

      if (args.action === "list") {
        return ok({ routines: (await readBotRoutines(tx, organizationId, botId)).map(toolView) });
      }
      if (caller.fromRoutine) {
        return fail("This run was started by a routine: a routine cannot create or change routines. Report to the user instead.");
      }
      if (right === "refused") {
        return fail("Plan mode: no routine is written. Describe the routine in your plan and wait for the user to confirm.");
      }

      if (args.action === "create") {
        const schedule = readSchedule(args.schedule!, args.timezone ?? "UTC", now());
        if (typeof schedule !== "string") return schedule;
        const enabled = right === "active";
        // PERM2-9: a routine the bot creates never waits for a person; the
        // operator may switch that off in "Routines…".
        const input = validatedRoutineInput({
          name: args.name,
          schedule,
          timezone: args.timezone ?? "UTC",
          message: args.prompt,
          enabled,
          neverWait: true,
        });
        await lockRoutineQuota(tx, organizationId, botId);
        const count = await tx<Array<{ count: string | number }>>`
          select count(*) as count from routines where organization_id = ${organizationId} and bot_id = ${botId}
        `;
        if (Number(count[0]?.count ?? 0) >= ROUTINE_LIMITS.maxPerBot) {
          return fail(`You already have ${ROUTINE_LIMITS.maxPerBot} routines, the maximum. Update or remove one first.`);
        }
        const rows = await tx<RoutineRow[]>`
          insert into routines (
            id, organization_id, bot_id, group_id, created_by_user_id,
            name, schedule, timezone, message, enabled, next_run_at, never_wait
          )
          values (
            ${crypto.randomUUID()}, ${organizationId}, ${botId}, ${null}, ${null}, ${input.name}, ${input.schedule},
            ${input.timezone}, ${input.message}, ${input.enabled},
            ${input.enabled ? nextOccurrence(input.schedule, now(), input.timezone) : null}, ${input.neverWait}
          )
          returning ${routineColumns(tx)}
        `;
        const unattended = "Nobody answers approvals during its runs: an action that needs one is refused at once, so plan its prompt with that in mind.";
        return ok({
          created: toolView(rows[0]!),
          note: enabled
            ? `The routine is active. ${unattended}`
            : `Manual mode: the routine is saved PAUSED. Tell the user to switch it on in "Routines…". ${unattended}`,
        });
      }

      const current = (await tx<RoutineRow[]>`
        select ${routineColumns(tx)} from routines
         where organization_id = ${organizationId} and bot_id = ${botId} and id = ${readUuid(args.jobId!) ?? "00000000-0000-0000-0000-000000000000"}
         for update
      `)[0];
      if (!current) return fail("No routine of yours has this job_id: call list.");

      if (args.action === "remove") {
        if (right !== "active") {
          return fail("Manual mode: you cannot delete a routine. Ask the user to delete it in \"Routines…\" or to pause it.");
        }
        await tx`delete from routines where organization_id = ${organizationId} and id = ${current.id}`;
        return ok({ removed: current.id });
      }
      if (args.action === "resume" && right !== "active") {
        return fail("Manual mode: only the user can switch a routine on, in \"Routines…\".");
      }

      let schedule = current.schedule;
      const timezone = args.timezone ?? current.timezone;
      if (args.action === "update" && (args.schedule || args.timezone)) {
        const read = readSchedule(args.schedule ?? current.schedule, timezone, now());
        if (typeof read !== "string") return read;
        schedule = read;
      }
      const enabled = args.action === "pause" ? false : args.action === "resume" ? true : current.enabled;
      const merged = validatedRoutineInput({
        name: args.action === "update" && args.name ? args.name : current.name,
        schedule,
        timezone,
        message: args.action === "update" && args.prompt ? args.prompt : current.message,
        enabled,
        // Never written by the bot after creation: only the operator moves it.
        neverWait: current.neverWait,
      });
      const rows = await tx<RoutineRow[]>`
        update routines set
          name = ${merged.name}, schedule = ${merged.schedule}, timezone = ${merged.timezone},
          message = ${merged.message}, enabled = ${merged.enabled},
          next_run_at = ${merged.enabled ? nextOccurrence(merged.schedule, now(), merged.timezone) : null},
          updated_at = now()
         where organization_id = ${organizationId} and id = ${current.id}
        returning ${routineColumns(tx)}
      `;
      return ok({ [args.action === "update" ? "updated" : args.action === "pause" ? "paused" : "resumed"]: toolView(rows[0]!) });
    });
  } catch (error) {
    // La validation partagée avec les routes Routines parle à un humain ; ici
    // le message va au modèle, qui corrige son appel.
    if (error instanceof HttpError && error.status < 500) return fail(error.message);
    throw error;
  }
}

function readSchedule(raw: string, timezone: string, now: Date): string | ToolOutcome {
  const schedule = normalizeRoutineSchedule(raw);
  if (!schedule) {
    return fail("schedule is not understood. Use a 5-field cron (`0 9 * * 1-5`) or hourly, every 2h, every 30m, daily at 9am, weekdays at 9:30, every monday at 8am.");
  }
  if (!scheduleRespectsMinimumInterval(schedule, timezone, now)) {
    return fail(`schedule fires more often than every ${ROUTINE_TOOL_MIN_INTERVAL_MINUTES} minutes, or never. Choose a wider one.`);
  }
  return schedule;
}

function routineColumns(tx: TransactionDb) {
  return tx`id, bot_id as "botId", group_id as "groupId", name, schedule, timezone, message, enabled,
            next_run_at as "nextRunAt", last_run_at as "lastRunAt",
            missed_count as "missedCount", last_missed_at as "lastMissedAt",
            created_at as "createdAt", updated_at as "updatedAt", never_wait as "neverWait"`;
}

async function readBotRoutines(tx: TransactionDb, organizationId: string, botId: string): Promise<RoutineRow[]> {
  return tx<RoutineRow[]>`
    select ${routineColumns(tx)} from routines
     where organization_id = ${organizationId} and bot_id = ${botId}
     order by created_at asc
  `;
}

/** Ce que le modèle lit : ses noms de champs, jamais les colonnes internes. */
function toolView(row: RoutineRow) {
  const routine = publicRoutine(row);
  return {
    job_id: routine.id,
    name: routine.name,
    prompt: routine.message,
    schedule: routine.schedule,
    timezone: routine.timezone,
    enabled: routine.enabled,
    never_wait: routine.neverWait,
    next_run_at: routine.nextRunAt,
    last_run_at: routine.lastRunAt,
  };
}

function readUuid(value: string | undefined): string | null {
  return value && isUuid(value) ? value.toLowerCase() : null;
}

function readId(value: unknown): JsonRpcId {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function unauthorized(): never {
  throw new HttpError(401, "ROUTINE_TOOL_UNAUTHORIZED", "Identifiants du serveur de routines invalides.");
}
