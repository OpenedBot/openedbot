import type { BotDto, BotRoutineToolDto, RoutineDto, RoutineExecutionPageDto } from "@openedbot/contracts-api";
import type { Scenario } from "../kit/scenario";
import { completed, invariant, matchingToolResult, noTools, poll, readyBot, toolEvents } from "../kit/p1-evidence";

export const chatReminders: Scenario = {
  id: "chat-reminders",
  title: "Rappel demandé dans le chat : création et déclenchement unique",
  summary: "En mode Manuel, un vrai appel routine_manage crée un rappel actif dans deux minutes ; une seule occurrence répond dans le fil puis désactive le rappel.",
  async run(context) {
    const { session, lab, rec, config } = context;
    let bot: BotDto | undefined;
    let enabled = false;
    let routine: RoutineDto | undefined;
    const marker = `CHAT_REMINDER_${lab.tag}`;
    try {
      await rec.step("Outil de routines actif sur un profil Manuel isolé", async () => {
        bot = await readyBot(context, "E2E chat reminder");
        await noTools(session, bot);
        await session.api("PATCH", `/api/bots/${bot.id}`, { permissionMode: "manual" });
        const state = await session.api<BotRoutineToolDto>("PUT", `/api/bots/${bot.id}/routine-tool`, { enabled: true });
        enabled = state.enabled;
        invariant(state.available && enabled && !state.restartPending, "The routine tool must be installed and usable without an unperformed restart.");
        // On by default (0187): the tool is announced to runs only once the
        // gateway's MCP reload window has passed (`active`). The next step
        // still requires a real paired call/result.
        // Each read asks the host: every 5 s, not at the poll's pace.
        const active = await poll(async () => { await Bun.sleep(5_000); return session.api<BotRoutineToolDto>("GET", `/api/bots/${bot!.id}/routine-tool`); },
          (value) => value.status === "active", 120_000, "Routine tool active after the MCP reload window");
        return { botId: bot.id, permissionMode: "manual", toolEnabled: true, status: active.status };
      });
      await rec.step("Une demande naturelle crée un rappel actif dans deux minutes", async () => {
        const before = Date.now();
        const { runId } = await session.api<{ runId: string }>("POST", `/api/threads/${bot!.threadId}/messages`, {
          input: `Crée un rappel dans 2 minutes intitulé Test rappel ${lab.tag}. Son message doit être : Réponds exactement ${marker}, sans outil. Utilise l'outil de routines, puis confirme la création.`,
        }, 202);
        let approved: string | null = null;
        await poll(async () => {
          const gates = await lab.db<Array<{ id: string; tool: string; args: { args?: { arguments?: Record<string, unknown> } }; status: string }>>`
            select a.id, a.tool_key as tool, a.gate_args as args, a.status
              from approval_requests a join runs r on r.id = a.run_id and r.organization_id = a.organization_id
             where a.organization_id = ${session.organizationId} and a.run_id = ${runId}
               and r.bot_id = ${bot!.id} and r.thread_id = ${bot!.threadId} order by a.gate_ordinal`;
          invariant(gates.length <= 1, "An additional reminder approval gate is forbidden.");
          const gate = gates[0];
          if (gate && !approved) {
            const args = gate.args.args?.arguments;
            invariant(gate.tool === "mcp:openedbot_routines:routine_manage" && gate.status === "pending"
              && args?.action === "create" && args.name === `Test rappel ${lab.tag}`
              && args.prompt === `Réponds exactement ${marker}, sans outil.` && args.schedule === "in 2m",
              "Only the exact owned reminder create call may receive a once approval.");
            approved = gate.id; // Never retry an unconfirmed approval response.
            await session.api("POST", `/api/approvals/${gate.id}/respond`, { choice: "once" }, 202);
          }
          return (await lab.run(runId))?.status;
        }, (status) => Boolean(status && ["completed", "failed", "cancelled", "unknown"].includes(status)),
        config.runTimeoutMs, "Owned reminder create and optional once approval");
        const turn = await lab.follow(runId, before);
        completed(turn);
        matchingToolResult(await toolEvents(context, turn.runId), "mcp__openedbot_routines__routine_manage");
        const { routines: rows } = await session.api<{ routines: RoutineDto[] }>("GET", `/api/bots/${bot!.id}/routines`);
        invariant(rows.length === 1, "The chat request must create exactly one owned reminder.");
        routine = rows[0]!;
        const next = Date.parse(routine.nextRunAt ?? "");
        invariant(routine.enabled && routine.schedule.startsWith("at ") && next >= before + 120_000 && next <= Date.now() + 120_000,
          "The reminder must be active with an absolute two-minute occurrence.");
        return { runId: turn.runId, onceApproval: approved !== null, routineId: routine.id, nextRunAt: routine.nextRunAt };
      });
      await rec.step("Le rappel répond une fois dans le fil et se désactive", async () => {
        const executions = () => session.api<RoutineExecutionPageDto>("GET", `/api/routines/${routine!.id}/executions?limit=100`);
        const page = await poll(executions, (value) => value.executions.some((e) => e.trigger === "scheduled" && e.outcome === "fired"),
          Math.max(config.runTimeoutMs, 180_000), "Two-minute chat reminder");
        const fired = page.executions.filter((e) => e.trigger === "scheduled" && e.outcome === "fired");
        invariant(fired.length === 1 && fired[0]?.runId, "A unique scheduled run is required.");
        const runId = fired[0].runId;
        completed(await lab.follow(runId, Date.now()), marker);
        invariant(await lab.answered(bot!.threadId, runId), "The reminder answer is missing from its conversation.");
        const { routines: [after] } = await session.api<{ routines: RoutineDto[] }>("GET", `/api/bots/${bot!.id}/routines`);
        invariant(after && !after.enabled && after.nextRunAt === null, "The one-shot reminder remained scheduled.");
        // Cross another minute boundary to catch an accidentally recurring schedule.
        const deadline = Math.floor(Date.now() / 60_000) * 60_000 + 62_000;
        await poll(async () => {
          invariant((await executions()).executions.length === 1, "The one-shot reminder fired again.");
          return Date.now() >= deadline;
        }, Boolean, deadline - Date.now() + 2_000, "No repeated reminder");
        return { runId, scheduledOccurrences: 1, disabledAfterFire: true };
      });
    } finally {
      if (bot) {
        // Discover all reminders owned by this disposable bot, even if creation
        // succeeded but its answer or evidence validation failed.
        try {
          const { routines: rows } = await session.api<{ routines: RoutineDto[] }>("GET", `/api/bots/${bot.id}/routines`);
          for (const row of rows) await session.api("DELETE", `/api/routines/${row.id}`, undefined, 204);
        } finally {
          if (enabled) await session.api("PUT", `/api/bots/${bot.id}/routine-tool`, { enabled: false });
        }
      }
    }
  },
};
