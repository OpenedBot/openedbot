import { effectivePermissionModeTx } from "@openedbot/runtimes/application/approval-reviewer";
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
  routineCreateTwin,
  readRoutineToolArgs,
  routineScheduleNeedsTimezone,
  routineToolWriteRight,
  scheduleRespectsMinimumInterval,
  type RoutineToolArgs,
} from "@openedbot/execution/domain/routine-tool";
import { readRoutineRunKeyWith } from "@openedbot/execution/application/routine-run-key";
import { routineToolCallerState } from "@openedbot/execution/application/routine-tool-state";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { AppVariables } from "../identity/auth";
import { runKeyCohortAllows, runKeyVerifiers, type InternalSecretsWith } from "@openedbot/platform-config/internal-secrets";
import { internalAuthMetrics } from "@openedbot/platform-observability/internal-auth";
import { HttpError, jsonBody } from "../../interfaces/http/http-error";
import { readBearer } from "../../interfaces/http/request-readers";
import { lockRoutineQuota, publicRoutine, validatedRoutineInput } from "./routine-routes";
import { editedClock } from "./routine-input";

/**
 * The MCP server `openedbot_routines`: the `routine_manage` tool (DEV-209), called
 * by the host's Hermes gateway during a run, over https, never by a
 * browser.
 *
 * Two proofs, two scopes:
 *   - the bearer, set in the host's MCP config at installation, proves the
 *     RUNTIME (a row of `runtime_routine_tools`, hashed in the database);
 *   - `run_key`, signed by the worker for the run in progress, says WHICH bot
 *     is calling and from which run (`routine-run-key.ts`).
 * A bot therefore touches only its own routines, and only during a live
 * run, and only while the tool is proven on its profile for this runtime and
 * not switched off by the operator (`bot_routine_tools`, 0187).
 *
 * Transport: MCP « Streamable HTTP », plain JSON responses (the client
 * accepts `application/json`), with no session and no server stream. The GET of an
 * event stream receives 405, which the specification allows.
 *
 * The bot's policy (the agent editor's permission mode):
 *   - `auto` / `bypass`: the write is done immediately;
 *   - `manual`: a created routine is created PAUSED, and `resume` / `remove`
 *     are refused: the operator activates or deletes it in « Routines… »;
 *   - `plan`: no write;
 *   - any other mode: like `manual` (`routineToolWriteRight`, PERM2-9).
 * A run triggered by a routine neither creates nor modifies a routine. A
 * routine created by the bot is born with « Ne jamais attendre » (PERM2-9).
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
  createdAt: Date;
  botId: string | null;
  status: string;
  permissionMode: string | null;
  fromRoutine: boolean;
  userTimeZone: string | null;
};

type RoutineRow = Parameters<typeof publicRoutine>[0];

export function routineToolSecretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function routineToolMcpRoutes(
  db: Db,
  internal: InternalSecretsWith<"runKey">,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:organizationId", (context) => context.body(null, 405, { Allow: "POST" }));
  routes.delete("/:organizationId", (context) => context.body(null, 405, { Allow: "POST" }));

  routes.post("/:organizationId", async (context) => {
    const organizationId = readUuid(context.req.param("organizationId"));
    const secret = readBearer(context.req.header("Authorization"));
    if (!organizationId || !secret) unauthorized();
    const known = await withTenant(db, organizationId, (tx) => tx<Array<{ runtimeId: string }>>`
      select runtime_id as "runtimeId" from runtime_routine_tools
       where organization_id = ${organizationId} and secret_hash = ${routineToolSecretHash(secret)}
    `);
    if (!known[0]) {
      // A refused bearer may be the host's own, out of step (restored host,
      // profile token copy): the sweep verifies the host. Anyone can send a
      // wrong bearer, so this marks at most every 10 minutes and never writes
      // to the host by itself.
      await withTenant(db, organizationId, (tx) => tx`
        update runtime_routine_tools set auth_failed_at = now()
         where organization_id = ${organizationId} and installed_at is not null
           and (auth_failed_at is null or auth_failed_at < now() - interval '10 minutes')
      `);
      unauthorized();
    }
    const runtimeId = known[0].runtimeId;

    const body = await jsonBody(context.req.raw, MAX_BODY_BYTES);
    const method = typeof body.method === "string" ? body.method : "";
    const hasId = Object.hasOwn(body, "id");
    const id = readId(body.id);
    // A notification (`notifications/initialized`…) does not expect a response.
    if (!hasId) return context.body(null, 202);
    const response = await answer(db, internal, { organizationId, runtimeId }, id, method, body.params);
    return context.json(response);
  });

  return routes;
}

type ToolScope = { organizationId: string; runtimeId: string };

async function answer(
  db: Db,
  internal: InternalSecretsWith<"runKey">,
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
    const outcome = await callRoutineTool(db, internal, scope, params.arguments);
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
  internal: InternalSecretsWith<"runKey">,
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
  const read = readRoutineRunKeyWith(runKeyVerifiers(internal), args.runKey);
  if (!read) {
    internalAuthMetrics.recordRunKey("routine", "refused");
    return fail("run_key is not valid: copy it exactly from your instructions.");
  }
  const runId = read.runId;

  try {
    return await withTenant(db, organizationId, async (tx) => {
      const caller = (await tx<CallerRow[]>`
        select r.id as "runId", r.created_at as "createdAt", r.bot_id as "botId", r.status,
               -- A plan-only turn (0155) is a plan run whatever the bot's mode.
               case when r.plan_only or coalesce(w.plan_only, false) then 'plan' else b.permission_mode end as "permissionMode",
               r.user_time_zone as "userTimeZone",
               exists(
                 select 1 from routine_executions re
                  where re.organization_id = r.organization_id and re.run_id = r.id
               ) as "fromRoutine"
          from runs r
          left join bots b on b.organization_id = r.organization_id and b.id = r.bot_id
          left join workflows w on w.organization_id = r.organization_id and w.id = r.workflow_id
         where r.organization_id = ${organizationId} and r.id = ${runId}
      `)[0];
      if (!caller || !caller.botId) {
        internalAuthMetrics.recordRunKey("routine", "refused");
        return fail("run_key does not match a run of yours.");
      }
      // A key read through the previous secret is valid only for the runs created before its bound.
      if (!runKeyCohortAllows(read.verifier, new Date(caller.createdAt))) {
        internalAuthMetrics.recordRunKey("routine", "refused");
        return fail("run_key is not valid: copy it exactly from your instructions.");
      }
      internalAuthMetrics.recordRunKey("routine", read.verifier.via);
      const tool = await routineToolCallerState(tx, organizationId, caller.botId, scope.runtimeId);
      if (tool.switchedOff) {
        return fail("routine_manage is switched off for you: the operator can switch \"Programmer depuis le chat\" back on in \"Routines…\".");
      }
      if (!tool.usable) return fail("routine_manage is not set up for you yet: the user can create the routine in \"Routines…\".");
      if (!LIVE_RUN_STATUSES.includes(caller.status)) return fail("run_key belongs to a run that has ended.");
      const botId = caller.botId;
      // PERM2-7: `auto` without a ready reviewer IS `manual` (paused, then asked).
      caller.permissionMode = await effectivePermissionModeTx(tx, organizationId, caller.permissionMode);
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
        // A time of day is never read in a zone the user did not give: no UTC fallback.
        if (!args.timezone && routineScheduleNeedsTimezone(args.schedule!)) return fail(TIMEZONE_REQUIRED);
        // An absolute instant shows in the zone the person's client sent, for display only.
        const timezone = args.timezone ?? caller.userTimeZone ?? "UTC";
        const schedule = readSchedule(args.schedule!, timezone, now());
        if (typeof schedule !== "string") return schedule;
        // Creation is active by default in every supported writing mode.
        // Manual-mode restrictions on resuming/removing existing routines stay separate.
        const enabled = caller.permissionMode === "manual" || right === "active";
        // PERM2-9: a routine the bot creates never waits for a person; the
        // operator may switch that off in "Routines…".
        const input = validatedRoutineInput({
          name: args.name,
          schedule,
          timezone,
          message: args.prompt,
          enabled,
          neverWait: true,
        });
        // The per-bot lock serializes this check and the insert below with
        // any other create of the bot: two identical creates racing yield one row.
        await lockRoutineQuota(tx, organizationId, botId);
        const existing = await readBotRoutines(tx, organizationId, botId);
        const twin = routineCreateTwin(input, existing, now());
        if (twin) {
          return ok({
            existing: toolView(twin),
            already_existed: true,
            note: twin.enabled
              ? "A routine with this name, schedule and timezone already exists: nothing was created and its prompt is unchanged. Do not create it again; use update to change its prompt."
              : "A routine with this name, schedule and timezone already exists but is PAUSED: nothing was created and its prompt is unchanged. Do not create it again; tell the user it is paused.",
          });
        }
        if (existing.length >= ROUTINE_LIMITS.maxPerBot) {
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
            : `The routine is saved PAUSED. Tell the user to switch it on in "Routines…". ${unattended}`,
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
      // A new time of day is read in a zone the bot states: the stored one may
      // be the UTC a routine got before 0187, and "9 h" must mean the user's 9 h.
      if (args.action === "update" && args.schedule && !args.timezone && routineScheduleNeedsTimezone(args.schedule)) {
        return fail(TIMEZONE_REQUIRED);
      }
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
      }, { requireOccurrence: false });
      // The row is held `for update`, as the tick holds it: a rename keeps the clock.
      const clock = editedClock(current, merged, now());
      const rows = await tx<RoutineRow[]>`
        update routines set
          name = ${merged.name}, schedule = ${merged.schedule}, timezone = ${merged.timezone},
          message = ${merged.message}, enabled = ${merged.enabled},
          next_run_at = case when ${clock === null}::boolean then next_run_at else ${clock?.nextRunAt ?? null}::timestamptz end,
          busy_retries = case when ${clock === null}::boolean then busy_retries else 0 end,
          updated_at = now()
         where organization_id = ${organizationId} and id = ${current.id}
        returning ${routineColumns(tx)}
      `;
      return ok({ [args.action === "update" ? "updated" : args.action === "pause" ? "paused" : "resumed"]: toolView(rows[0]!) });
    });
  } catch (error) {
    // The validation shared with the Routines routes speaks to a human; here
    // the message goes to the model, which corrects its call.
    if (error instanceof HttpError && error.status < 500) return fail(error.message);
    throw error;
  }
}

const LOCAL_ONE_SHOT_FORM = /^at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const TIMEZONE_REQUIRED = "timezone is required for a time of day: pass the user's IANA timezone (from the [routine_manage user timezone: …] line). If it says unknown, ask the user for their timezone; never guess.";

function readSchedule(raw: string, timezone: string, now: Date): string | ToolOutcome {
  const schedule = normalizeRoutineSchedule(raw, now, timezone);
  if (!schedule && LOCAL_ONE_SHOT_FORM.test(raw.trim())) {
    return fail(`at ${raw.trim().slice(3)} does not exist in ${timezone}: the date is invalid, or the clocks skip that hour (daylight saving). Ask the user for another time.`);
  }
  if (!schedule) {
    return fail("schedule is not understood. For a one-shot reminder use in 2m, in 1h, at YYYY-MM-DDTHH:mm (local, with timezone), or at followed by a UTC ISO-8601 instant. For recurring routines use a 5-field cron or hourly, every 2h, every 30m, daily at 9am, weekdays at 9:30, every monday at 8am.");
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

/** What the bot reads of a routine's message: enough to recognize it, never all of it. */
export const ROUTINE_TOOL_PROMPT_EXCERPT_CHARS = 120;

/**
 * What the model reads: its field names, never the internal columns. Not the
 * whole message: `list` passes without an approval, and a bot steered by what
 * it read could otherwise pass on what another member wrote in a routine.
 */
export function toolView(row: RoutineRow) {
  const routine = publicRoutine(row);
  const points = [...routine.message];
  return {
    job_id: routine.id,
    name: routine.name,
    prompt_excerpt: points.length > ROUTINE_TOOL_PROMPT_EXCERPT_CHARS
      ? `${points.slice(0, ROUTINE_TOOL_PROMPT_EXCERPT_CHARS - 1).join("")}…` : routine.message,
    prompt_chars: points.length,
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
