import { askUserRule } from "./ask-user";
import { operatorHandle, type BotIdentity, type OperatorIdentity } from "./bot-identity";

/**
 * Defaults are deliberately below the hard server ceilings, and delegation is
 * OFF until an operator turns it on. Un bot qui délègue engage un autre bot,
 * son budget et son runtime : c'est une capacité qu'on accorde, pas un état par
 * défaut. Une mention humaine `@slug` reste permise sans cette autorisation.
 */
export const AUTONOMY_DEFAULTS = {
  enabled: false,
  maxDepth: 3,
  maxSteps: 8,
  maxHandoffs: 4,
  timeoutSeconds: 1_800,
  // Un run Hermes porte un plancher d'entrée quasi constant : le prompt système
  // du profil et le catalogue d'outils, réinjectés à chaque appel. MESURÉ le
  // 25-08 (session vierge, entrée de 55 caractères) : 14 748 jetons
  // AVANT toute conversation, dont ~500 seulement viennent d'openedbot.
  //
  // Ce plancher est mis en cache par le fournisseur, et le worker impute
  // désormais le coût EFFECTIF (voir `WORKER_CACHED_INPUT_TOKEN_WEIGHT`) :
  //   étape à froid  : 14 748          étape à chaud : ~2 306
  // Le budget doit donc financer le pire cas: huit étapes toutes froides,
  // 117 984: sans quoi une chaîne légitime échouerait faute de budget. D'où
  // 120 000, sous le plafond serveur de 200 000. Un cas réaliste (trois bots
  // distincts, trois étapes froides et cinq chaudes) n'en consomme que ~55 800.
  tokenBudget: 120_000,
} as const;

export const AUTONOMY_CEILINGS = {
  maxDepth: 4,
  maxSteps: 12,
  maxHandoffs: 8,
  timeoutSeconds: 3_600,
  tokenBudget: 200_000,
} as const;

/** Public client bounds; the API remains the final authority. */
export const AUTONOMY_MINIMUMS = {
  maxDepth: 1,
  maxSteps: 1,
  maxHandoffs: 0,
  timeoutSeconds: 60,
  tokenBudget: 1_000,
} as const;

export type AutonomyPolicy = {
  enabled: boolean;
  maxDepth: number;
  maxSteps: number;
  maxHandoffs: number;
  timeoutSeconds: number;
  tokenBudget: number;
};

export type WorkflowBudget = Omit<AutonomyPolicy, "enabled"> & {
  usedSteps: number;
  usedHandoffs: number;
  usedTokens: number;
  deadlineAt: Date;
};

export type DelegationRefusal =
  | "AUTONOMY_DISABLED"
  | "TARGET_SELF"
  | "TARGET_INACTIVE"
  | "CALL_CYCLE"
  | "DEPTH_LIMIT"
  | "STEP_LIMIT"
  | "HANDOFF_LIMIT"
  | "TOKEN_BUDGET_EXHAUSTED"
  | "WORKFLOW_DEADLINE_EXCEEDED";

export type DelegationDecision =
  | { accepted: true; reservedSteps: number }
  | { accepted: false; reason: DelegationRefusal };

/**
 * A delegated leaf needs one run of its own plus one continuation for every
 * caller still on the stack. Reserving those runs before accepting the
 * directive prevents a workflow that can descend but can no longer unwind.
 */
export function minimumStepsToDelegate(stackDepth: number): number {
  return Math.max(0, stackDepth) + 2;
}

export function canDelegate(input: {
  policyEnabled: boolean;
  selfBotId: string;
  targetBotId: string;
  targetActive: boolean;
  activeCallStackBotIds: readonly string[];
  stackDepth: number;
  budget: WorkflowBudget;
  now?: Date;
}): DelegationDecision {
  if (!input.policyEnabled) return { accepted: false, reason: "AUTONOMY_DISABLED" };
  if (input.targetBotId === input.selfBotId) return { accepted: false, reason: "TARGET_SELF" };
  if (!input.targetActive) return { accepted: false, reason: "TARGET_INACTIVE" };
  if (input.activeCallStackBotIds.includes(input.targetBotId)) return { accepted: false, reason: "CALL_CYCLE" };
  if (input.stackDepth + 1 > input.budget.maxDepth) return { accepted: false, reason: "DEPTH_LIMIT" };
  const reservedSteps = minimumStepsToDelegate(input.stackDepth);
  if (input.budget.usedSteps + reservedSteps > input.budget.maxSteps) {
    return { accepted: false, reason: "STEP_LIMIT" };
  }
  if (input.budget.usedHandoffs + 1 > input.budget.maxHandoffs) {
    return { accepted: false, reason: "HANDOFF_LIMIT" };
  }
  // En DM le budget de jetons est une borne MOLLE : épuisé, il n'interdit que
  // d'élargir la chaîne (nouvelles délégations); les continuations et la
  // synthèse déjà dues vont au bout, sinon le travail partiel payé serait
  // perdu. Le salon applique lui une borne dure entre deux tours
  // (`groupWorkflowLimitOutcome`). Asymétrie assumée: MULTI_BOT.md.
  if (input.budget.usedTokens >= input.budget.tokenBudget) {
    return { accepted: false, reason: "TOKEN_BUDGET_EXHAUSTED" };
  }
  if ((input.now ?? new Date()).getTime() >= input.budget.deadlineAt.getTime()) {
    return { accepted: false, reason: "WORKFLOW_DEADLINE_EXCEEDED" };
  }
  return { accepted: true, reservedSteps };
}

export function normalizeAutonomyPolicy(value: Partial<AutonomyPolicy> | null | undefined): AutonomyPolicy {
  return {
    enabled: value?.enabled ?? AUTONOMY_DEFAULTS.enabled,
    maxDepth: bounded(value?.maxDepth, AUTONOMY_DEFAULTS.maxDepth, AUTONOMY_MINIMUMS.maxDepth, AUTONOMY_CEILINGS.maxDepth),
    maxSteps: bounded(value?.maxSteps, AUTONOMY_DEFAULTS.maxSteps, AUTONOMY_MINIMUMS.maxSteps, AUTONOMY_CEILINGS.maxSteps),
    maxHandoffs: bounded(value?.maxHandoffs, AUTONOMY_DEFAULTS.maxHandoffs, AUTONOMY_MINIMUMS.maxHandoffs, AUTONOMY_CEILINGS.maxHandoffs),
    timeoutSeconds: bounded(
      value?.timeoutSeconds,
      AUTONOMY_DEFAULTS.timeoutSeconds,
      AUTONOMY_MINIMUMS.timeoutSeconds,
      AUTONOMY_CEILINGS.timeoutSeconds,
    ),
    tokenBudget: bounded(value?.tokenBudget, AUTONOMY_DEFAULTS.tokenBudget, AUTONOMY_MINIMUMS.tokenBudget, AUTONOMY_CEILINGS.tokenBudget),
  };
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value === undefined) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

type Named = Pick<BotIdentity, "name" | "slug" | "description">;

const label = (bot: Named) =>
  `🤖 ${bot.name} (@${bot.slug})${bot.description?.trim() ? `: ${bot.description.trim()}` : ""}`;

/** En-tête de la ligne de budget, cité par les instructions pour que le bot sache où la lire. */
export const WORKFLOW_LIMITS_PREFIX = "[Workflow limits]";

/**
 * Prompt used only by durable autonomous workflow steps. Legacy couriers keep
 * their depth-one protocol.
 *
 * Ce bloc est le PRÉFIXE d'un appel Hermes, donc le seul morceau que le cache
 * du fournisseur peut réutiliser d'une étape à l'autre. Il ne contient donc que
 * ce qui est constant pour un couple (bot, workflow) : identité, appelant,
 * roster, PLAFONDS. Tout compteur qui bouge à chaque étape: profondeur
 * courante, étapes et handoffs restants: casserait le préfixe octet pour
 * octet et annulerait la remise ; il voyage dans l'entrée de l'étape, qui
 * change de toute façon (voir `autonomousStepLimitsLine`).
 */
export function buildAutonomousStepInstructions(input: {
  self: Named;
  others: Named[];
  operator: OperatorIdentity;
  budget: Pick<WorkflowBudget, "maxDepth" | "maxSteps" | "maxHandoffs">;
  caller?: Pick<BotIdentity, "name" | "slug"> | null;
}): string {
  const reachable = input.others.length
    ? ["Reachable bots:", ...input.others.map((bot) => `- ${label(bot)}`)]
    : ["No other bot is reachable for this step."];
  return [
    "## Durable bot workflow",
    "",
    `You are ${label(input.self)} executing one step of a durable workflow of at most `
      + `${input.budget.maxSteps} step(s), ${input.budget.maxHandoffs} handoff(s) and `
      + `${input.budget.maxDepth} level(s) of delegation.`,
    input.caller
      ? `Your result will return to 🤖 ${input.caller.name} (@${input.caller.slug}), which will resume and synthesize the answer.`
      : "You are the root bot and must synthesize the final answer after delegated results return.",
    ...reachable,
    "",
    `The \`${WORKFLOW_LIMITS_PREFIX}\` line at the top of this step's input states the current depth and the budget still available. The platform enforces these limits.`,
    "Rules:",
    "- Work now. If another listed bot is materially needed, end your reply with exactly one `@slug <specific task>` directive as its LAST line. Write that directive once and nowhere else.",
    "- Everything before that last line is a partial result. The platform stores it and resumes you after the delegated bot finishes.",
    "- Never delegate to yourself, a bot already in the active caller chain, or an unlisted bot. Never invent a bot handle.",
    "- A refused directive is not executed. In that case your partial result may become the answer, so always include useful work before delegating.",
    "- Never use delegate_task, async delegation, subagents, or background work. Only this visible platform protocol is durable.",
    askUserRule(operatorHandle(input.operator)),
  ].join("\n");
}

/**
 * Les compteurs qui bougent à chaque étape. Ils quittent les instructions mais
 * pas le prompt : le bot les lit en tête de son entrée, où leur variation ne
 * coûte rien puisque l'entrée n'est jamais réutilisable par un cache.
 */
export function autonomousStepLimitsLine(input: {
  stackDepth: number;
  budget: Pick<WorkflowBudget, "maxDepth" | "maxSteps" | "maxHandoffs" | "usedSteps" | "usedHandoffs">;
}): string {
  const remainingSteps = Math.max(0, input.budget.maxSteps - input.budget.usedSteps);
  const remainingHandoffs = Math.max(0, input.budget.maxHandoffs - input.budget.usedHandoffs);
  return `${WORKFLOW_LIMITS_PREFIX} step ${Math.max(1, input.budget.usedSteps)} of at most `
    + `${input.budget.maxSteps}, depth ${Math.max(0, input.stackDepth)}/${input.budget.maxDepth}, `
    + `${remainingSteps} step(s) and ${remainingHandoffs} handoff(s) remaining.`;
}

/** Pose la ligne de limites en tête d'entrée. `null` = étape non autonome, entrée inchangée. */
export function withAutonomousStepLimits(input: string, limitsLine: string | null): string {
  return limitsLine ? `${limitsLine}\n\n${input}` : input;
}

export const delegationRefusalMessage = (reason: DelegationRefusal): string => {
  const messages: Record<DelegationRefusal, string> = {
    AUTONOMY_DISABLED: "La coordination de ce bot est désactivée.",
    TARGET_SELF: "Un bot ne peut pas se déléguer une tâche à lui-même.",
    TARGET_INACTIVE: "Le bot cible est indisponible ou archivé.",
    CALL_CYCLE: "Cette délégation créerait une boucle entre bots.",
    DEPTH_LIMIT: "La profondeur maximale de délégation est atteinte.",
    STEP_LIMIT: "Le nombre d’étapes restant ne permet pas de terminer puis de remonter la chaîne.",
    HANDOFF_LIMIT: "Le nombre maximal de transmissions est atteint.",
    TOKEN_BUDGET_EXHAUSTED: "Le budget de jetons du workflow est épuisé.",
    WORKFLOW_DEADLINE_EXCEEDED: "La durée maximale du workflow est atteinte.",
  };
  return messages[reason];
};

/** Stable per workflow+bot session shared by delegated runs and their continuations. */
export function workflowSessionKey(organizationId: string, workflowId: string, botId: string): string {
  return `ohb:${organizationId}:workflow:${workflowId}:bot:${botId}`;
}
