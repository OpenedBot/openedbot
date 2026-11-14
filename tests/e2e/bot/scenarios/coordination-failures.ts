import type { BotDto } from "@openedbot/contracts-api";
import type { Scenario, ScenarioContext } from "../kit/scenario";
import { completed, invariant, keyedPost, noTools, poll, readyBot, settledWorkflow, toolEvents, toolset, type Workflow } from "../kit/p1-evidence";

type Admission = { runId: string; workflowId: string | null };

async function refusal(context: ScenarioContext, runId: string, reason: string): Promise<void> {
  const events = await toolEvents(context, runId);
  invariant(events.some((event) => event.type === "system.notice" && event.payload.kind === "workflow.delegation_refused" && event.payload.reason === reason), `The refusal ${reason} was not persisted as an operator-visible notice.`);
}

async function noOrphans(context: ScenarioContext, workflowId: string): Promise<number> {
  const rows = await context.lab.db<Array<{ id: string; status: string }>>`select id, status from runs
    where organization_id = ${context.session.organizationId} and workflow_id = ${workflowId}`;
  invariant(rows.length > 0 && rows.every((row) => ["completed", "failed", "cancelled"].includes(row.status)), "The settled workflow left active, ambiguous or orphaned steps.");
  return rows.length;
}

export const coordinationFailures: Scenario = {
  id: "coordination-failures",
  title: "Coordination : refus, boucles, annulation et délai",
  summary: "Un spécialiste absent est refusé, une boucle A/B/A et un budget nul ne créent pas de travail sans borne ; annulation et timeout d'une étape sont visibles et le fil repart.",
  async run(context) {
    const { lab, session, rec, config } = context;
    let root!: BotDto;
    let specialist!: BotDto;
    let activeWorkflow: string | null = null;
    const setRoot = (instructions: string, maxHandoffs = 2, timeoutSeconds = 120) => session.api("PATCH", `/api/bots/${root.id}`, {
      instructions, autonomy: { enabled: true, maxDepth: 2, maxSteps: 4, maxHandoffs, timeoutSeconds, tokenBudget: 120000 },
    });
    const admit = async (input: string): Promise<Admission> => {
      const result = await keyedPost<Admission>(session, `/api/threads/${root.threadId}/messages`, crypto.randomUUID(), { input });
      invariant(result.body.workflowId, "The coordinator's root turn has no durable workflow.");
      activeWorkflow = result.body.workflowId;
      return result.body;
    };
    try {
      await rec.step("Deux profils jetables avec budgets bornés", async () => {
        root = await readyBot(context, "E2E Failure coordinator");
        specialist = await readyBot(context, "E2E Failure specialist");
        await noTools(session, root); await noTools(session, specialist);
        await session.api("PATCH", `/api/bots/${specialist.id}`, { autonomy: { enabled: true } });
      });
      await rec.step("Spécialiste inexistant : refus visible sans étape fantôme", async () => {
        const missing = `e2e-missing-${lab.tag}`;
        await setRoot(`For this acceptance test reply with exactly this single line, no other text: @${missing} Review the acceptance proof.`);
        const admitted = await admit("Send the acceptance proof to the named specialist now.");
        const turn = await lab.follow(admitted.runId, Date.now());
        invariant(turn.run?.status === "completed" && turn.marks?.terminalType === "run.completed", "The root delegation attempt did not complete.");
        const state = await settledWorkflow(context, activeWorkflow!);
        invariant(state.status === "failed" && state.errorCode === "WORKFLOW_DELEGATION_REFUSED_EMPTY", "An unavailable specialist was not reported as a bounded delegation failure.");
        await refusal(context, admitted.runId, "TARGET_INACTIVE");
        invariant(await noOrphans(context, activeWorkflow!) === 1, "A run was created for the unavailable specialist.");
        activeWorkflow = null;
      });
      await rec.step("Boucle A/B/A : arrêt au retour dans la pile", async () => {
        await setRoot(`For a new user request, reply exactly: @${specialist.slug} Pass this acceptance task back to @${root.slug}. If the platform asks you to resume after a specialist, reply exactly RECOVERED and never delegate again.`);
        await session.api("PATCH", `/api/bots/${specialist.id}`, { instructions: `Reply with exactly this single line, no preamble: @${root.slug} Continue the same acceptance task.` });
        const admitted = await admit("Start the explicitly requested loop test now.");
        const state = await settledWorkflow(context, activeWorkflow!);
        invariant(state.status === "failed" && state.errorCode === "WORKFLOW_DELEGATION_REFUSED_EMPTY", `The call cycle ended ${state.status}/${String(state.errorCode)}.`);
        const children = await lab.db<Array<{ id: string; botId: string }>>`select id, bot_id as "botId" from runs
          where organization_id = ${session.organizationId} and workflow_id = ${activeWorkflow} and step_kind = 'delegated'`;
        invariant(children.length === 1 && children[0]!.botId === specialist.id, "The call cycle created an unexpected delegation chain.");
        await refusal(context, children[0]!.id, "CALL_CYCLE");
        invariant(await noOrphans(context, activeWorkflow!) === 2, "The cycle left a continuation or background step.");
        activeWorkflow = null;
        return { runId: admitted.runId, delegatedSteps: children.length };
      });
      await rec.step("Budget de handoff nul : aucune délégation", async () => {
        await setRoot(`Reply with exactly this single line, no preamble: @${specialist.slug} Review the acceptance proof.`, 0);
        const admitted = await admit("Delegate this bounded acceptance request now.");
        const state = await settledWorkflow(context, activeWorkflow!);
        invariant(state.status === "failed", "The exhausted delegation budget did not fail explicitly.");
        await refusal(context, admitted.runId, "HANDOFF_LIMIT");
        invariant(await noOrphans(context, activeWorkflow!) === 1, "An exhausted handoff budget still created a child step.");
        activeWorkflow = null;
      });
      await rec.step("Annulation d'une étape réellement en cours", async () => {
        await toolset(session, root, "terminal", true);
        await setRoot("For this disposable acceptance test, call terminal with the read-only command `sleep 90`. Wait for its actual completion, then reply SLEPT. Do not start background jobs, write files or delegate.", 0, 120);
        const admitted = await admit("Execute the read-only sleep now; the operator will cancel this running step.");
        await poll(() => toolEvents(context, admitted.runId), (events) => events.some((event) => event.type === "tool.call" && event.payload.tool === "terminal"), config.runTimeoutMs, "Running terminal call");
        await session.api("POST", `/api/workflows/${activeWorkflow}/cancel`, undefined, 204);
        const state = await settledWorkflow(context, activeWorkflow!);
        invariant(state.status === "cancelled", `Cancellation ended ${state.status}.`);
        await noOrphans(context, activeWorkflow!);
        activeWorkflow = null;
        return { runId: admitted.runId, cancelledWhileToolRunning: true };
      });
      await rec.step("Délai dépassé : erreur bornée et aucun travail orphelin", async () => {
        await setRoot("Call terminal with the read-only command `sleep 90`, await its result, then reply SLEPT. Never use a background job, write a file or delegate.", 0, 60);
        const admitted = await admit("Execute the read-only sleep and wait for its result.");
        await poll(() => toolEvents(context, admitted.runId), (events) => events.some((event) => event.type === "tool.call" && event.payload.tool === "terminal"), config.runTimeoutMs, "Timeout terminal call");
        const state = await settledWorkflow(context, activeWorkflow!);
        invariant(state.status === "expired" && state.errorCode === "WORKFLOW_DEADLINE_EXCEEDED", `Timeout ended ${state.status}/${String(state.errorCode)} instead of an explicit deadline failure.`);
        await noOrphans(context, activeWorkflow!);
        activeWorkflow = null;
        return { runId: admitted.runId, timeoutSeconds: 60 };
      });
      await rec.step("Le message suivant repart après les échecs", async () => {
        await noTools(session, root);
        await setRoot("Reply exactly the user's requested marker, without tools or delegation.");
        const proof = `RECOVERED_${lab.tag}`;
        completed(await lab.send(root.threadId, `Reply exactly ${proof}.`), proof);
      });
    } finally {
      if (activeWorkflow) {
        await session.api("POST", `/api/workflows/${activeWorkflow}/cancel`, undefined, 204);
        await poll(() => session.api<Workflow>("GET", `/api/workflows/${activeWorkflow}`), (state) => ["completed", "failed", "expired", "cancelled"].includes(state.status), config.runTimeoutMs, "Owned failure-test cancellation");
      }
    }
  },
};
