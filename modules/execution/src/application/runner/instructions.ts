import type { SQL } from "bun";
import {
  buildBotModeInstructions,
  buildInboundReplyInstructions,
  withBotModeInstructions,
} from "@openedbot/roster/domain/bot-mode";
import { buildPlaybookBlock, selectPlaybooksForTurn, type PlaybookMatch } from "@openedbot/roster/domain/playbooks";
import {
  autonomousStepLimitsLine,
  buildAutonomousStepInstructions,
} from "@openedbot/roster/domain/autonomous-workflow";
import { withTenant } from "@openedbot/platform-db";
import { handoffEligible, handoffRoster, simpleDmStep } from "./handoff";
import type { RunContext } from "./types";
import { currentCoordinationEnabled, workflowAutonomyAllowsDelegation } from "./workflows";

/**
 * Les instructions d'un run DM : le bloc « bot mode » (identité, roster,
 * protocole `@slug`) s'ajoute à celles du bot : sauf sur un run entrant, qui
 * ne doit jamais apprendre à relayer (profondeur 1) et reçoit à la place le
 * bloc « réponse finale » (fais le travail maintenant, jamais de délégation
 * d'arrière-plan, jamais de promesse de revenir).
 *
 * `limitsLine` n'est posée que sur une étape de workflow autonome : c'est la
 * part VARIABLE du cadrage, sortie des instructions pour que leur préfixe
 * reste identique d'une étape à l'autre et donc réutilisable par le cache du
 * fournisseur. L'appelant la place en tête de l'entrée de l'étape.
 */
export type DmStepPrompt = { instructions: string; limitsLine: string | null };

export async function dmInstructions(
  db: SQL,
  context: Pick<RunContext, "organizationId" | "botId" | "botName" | "botSlug" | "botDescription"
    | "instructions" | "operator" | "groupId" | "groupTurnPosition" | "originRunId"> &
    Partial<Pick<RunContext,
      "workflowId" | "stepKind" | "stackDepth" | "callerBotId" | "autonomyEnabled" | "workflowAutonomyEnabled"
      | "memoryToolEnabled" | "routineToolEnabled" | "botSettingsToolEnabled" | "webToolsEnabled"
    >>,
): Promise<DmStepPrompt> {
  if (context.originRunId) {
    // Le bot d'origine est celui du fil où attend le courrier ; s'il a été
    // supprimé entre-temps, le bloc reste valable avec un libellé générique.
    const origins = await db<Array<{ name: string; slug: string }>>`
      select b.name, b.slug
        from runs courier
        join threads t on t.organization_id = courier.organization_id and t.id = courier.thread_id
        join bots b on b.organization_id = t.organization_id and b.id = t.bot_id
       where courier.organization_id = ${context.organizationId} and courier.id = ${context.originRunId}
    `;
    const origin = origins[0] ?? { name: "bot", slug: "bot" };
    return {
      instructions: withBotModeInstructions(context.instructions, buildInboundReplyInstructions(origin)),
      limitsLine: null,
    };
  }
  if (!handoffEligible(context)) return { instructions: context.instructions, limitsLine: null };
  if (simpleDmStep(context)) {
    // Autonomie coupée à l'envoi : aucun bot n'est joignable, et ni roster
    // ni compteurs de workflow ne sont lus.
    const block = buildBotModeInstructions({
      self: { name: context.botName, slug: context.botSlug, description: context.botDescription },
      others: [],
      operator: context.operator,
      memoryToolEnabled: context.memoryToolEnabled,
      routineToolEnabled: context.routineToolEnabled,
      botSettingsToolEnabled: context.botSettingsToolEnabled,
      webToolsEnabled: context.webToolsEnabled,
    });
    return { instructions: withBotModeInstructions(context.instructions, block), limitsLine: null };
  }
  const others = await handoffRoster(db, context.organizationId, context.botId);
  if (context.workflowId) {
    const workflows = await db<Array<{
      maxDepth: number;
      maxSteps: number;
      maxHandoffs: number;
      usedSteps: number;
      usedHandoffs: number;
    }>>`
      select max_depth as "maxDepth", max_steps as "maxSteps", max_handoffs as "maxHandoffs",
             used_steps as "usedSteps", used_handoffs as "usedHandoffs"
        from workflows where organization_id = ${context.organizationId} and id = ${context.workflowId}
    `;
    const workflow = workflows[0];
    if (workflow) {
      const callers = context.callerBotId
        ? await db<Array<{ name: string; slug: string }>>`
            select name, slug from bots
             where organization_id = ${context.organizationId} and id = ${context.callerBotId}
          `
        : [];
      const block = buildAutonomousStepInstructions({
        self: { name: context.botName, slug: context.botSlug, description: context.botDescription },
        others: workflowAutonomyAllowsDelegation(
          context.workflowAutonomyEnabled,
          await currentCoordinationEnabled(db, context.organizationId, context.botId),
        ) ? others : [],
        operator: context.operator,
        budget: workflow,
        caller: callers[0] ?? null,
      });
      return {
        instructions: withBotModeInstructions(context.instructions, block),
        limitsLine: autonomousStepLimitsLine({ stackDepth: context.stackDepth ?? 0, budget: workflow }),
      };
    }
  }
  const block = buildBotModeInstructions({
    self: { name: context.botName, slug: context.botSlug, description: context.botDescription },
    others,
    operator: context.operator,
    memoryToolEnabled: context.memoryToolEnabled,
    routineToolEnabled: context.routineToolEnabled,
    botSettingsToolEnabled: context.botSettingsToolEnabled,
      webToolsEnabled: context.webToolsEnabled,
  });
  return { instructions: withBotModeInstructions(context.instructions, block), limitsLine: null };
}

export async function loadAssignedPlaybooks(
  db: SQL,
  organizationId: string,
  botId: string,
): Promise<PlaybookMatch[]> {
  return withTenant(db, organizationId, (tx) => tx<PlaybookMatch[]>`
    select p.key, p.name, p.summary, p.triggers, p.instructions
      from bot_playbooks bp
      join playbooks p on p.organization_id = bp.organization_id and p.id = bp.playbook_id
     where bp.organization_id = ${organizationId} and bp.bot_id = ${botId}
     order by p.key
  `);
}

/** The playbooks this turn's message triggers, rendered; "" when none. */
export async function assignedPlaybookBlock(
  db: SQL,
  context: Pick<RunContext, "organizationId" | "botId">,
  input: string,
): Promise<string> {
  const assigned = await loadAssignedPlaybooks(db, context.organizationId, context.botId);
  return buildPlaybookBlock(selectPlaybooksForTurn(assigned, input));
}

/**
 * What only this turn needs (a one-message plan intent, the playbooks its
 * message triggers) rides at the head of the turn's input, never in the
 * instructions: they are the cached prefix and must stay byte-identical from
 * one turn to the next.
 */
export function withTurnGuidance(input: string, blocks: ReadonlyArray<string | null | undefined>): string {
  const guidance = blocks.filter((block): block is string => Boolean(block));
  return guidance.length ? [...guidance, input].join("\n\n") : input;
}
