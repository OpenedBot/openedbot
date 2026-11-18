import type { SQL } from "bun";
import { runKeySigningSecret } from "@openedbot/platform-config/internal-secrets";
import { fitHermesRunImages, type HermesClient } from "@openedbot/hermes";
import type { RunTrace } from "@openedbot/platform-observability/run-trace";
import { imageNotSentNote } from "@openedbot/conversation/domain/attachments";
import { buildCompactionInstructions } from "@openedbot/conversation/domain/thread-compaction";
import { withAutonomousStepLimits } from "@openedbot/roster/domain/autonomous-workflow";
import { withBotModeInstructions } from "@openedbot/roster/domain/bot-mode";
import {
  buildLearnInput,
  buildLearningBlock,
  isLearnRequest,
  runtimeCanLearn,
} from "@openedbot/roster/domain/bot-learning";
import { buildPersonaDraftInstructions } from "@openedbot/roster/domain/persona-draft";
import { withTurnBoundary } from "@openedbot/conversation/domain/history-framing";
import { BOT_SETTINGS_TOOL_RUNTIME_NAME, botSettingsToolMetadata } from "../../domain/bot-settings-tool";
import { ROUTINE_TOOL_RUNTIME_NAME, routineToolMetadata } from "../../domain/routine-tool";
import { isServiceStepKind } from "../../domain/run-step";
import { recordCreatingRunModel } from "../../sql/run-columns";
import { signBotSettingsRunKey } from "../bot-settings-run-key";
import { fallbackIdempotencyKey } from "../provider-fallback";
import { signRoutineRunKey } from "../routine-run-key";
import { takeWarmOrSelectModel } from "../warm-model-selection";
import type { WorkerConfig } from "../worker-config";
import { retiredServiceStep, settleOrphanCreate } from "./failure";
import { conversationHistory, loadRunImages } from "./history";
import { type DmStepPrompt, assignedPlaybookBlock, dmInstructions, machineBlock, withTurnGuidance } from "./instructions";
import { confirmFirstCreate, heldLease, runKey } from "./lease-transitions";
import { persistUnnumberedEvents } from "./persist";
import type { RunPreflight } from "./preflight";
import {
  type ResolvedRunSelection,
  failWithoutUsableProvider,
  fallbackAwareError,
  persistResolvedRunModel,
  providerAuthRequiredError,
  recoverProviderFailure,
  resolveSelectionForNewRun,
} from "./provider-recovery";
import { type GroupTurn, groupSendState, prepareGroupTurn } from "./rooms";
import { packRoomHistory } from "./room-pack";
import type { RunCreateArgs, RunState } from "./run-state";
import { readWorkflowSessionCounters } from "./workflows";
import type { RunContext } from "./types";

type SpeakingTurn = Exclude<GroupTurn, { kind: "silent" } | null>;

/** The prompt of a new run, before its images: what `createRun` sends and what the run row confirms. */
export type RunRequest = {
  history: Array<{ role: string; content: string }>;
  instructions: string;
  /** The input the run row records once created (`confirmFirstCreate`). */
  input: string;
  /** `input` with its turn guidance (plan block, playbooks), sent to Hermes. */
  turnInput: string;
};

/**
 * Création: builds the turn of a new run, persists its model (the durable
 * intent: `creating`), then POSTs it, falling back to another provider while
 * the POST is refused, and confirms the Hermes id under the lease. Returns
 * that id, or null once the run is settled here (silent room turn, no usable
 * provider, lease lost, orphan creation). A refused creation throws, wrapped
 * by `fallbackAwareError`. Writes `context.externalState` (`creating` then
 * `streaming`), `context.provider`, `context.model`,
 * `context.sessionCountersBefore`, and `state.hermesRunId`,
 * `state.selection`, `state.retryState`, `state.createArgs`.
 */
export async function createRunOnHermes(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
  trace: RunTrace,
  preflight: Pick<RunPreflight, "warmModelKey" | "warmSelection" | "modelCatalog" | "toolsetInventory">,
): Promise<string | null> {
  const signal = state.controller.signal;
  // Tour de salon : entrée = le journal non lu du membre, attribué ; rien
  // de neuf → silence implicite, sans dépenser un appel à Hermes.
  const turn = groupSendState(context)
    ? await trace.span("preflight.group_turn", () => prepareGroupTurn(db, context, config.blob))
    : null;
  if (turn?.kind === "silent") {
    await completeGroupTurnWithoutHermes(db, config, context);
    return null;
  }
  const selection = await takeWarmOrSelectModel(preflight.warmSelection, () => trace.span(
    "preflight.model_selection",
    () => resolveSelectionForNewRun(db, client, context, preflight.modelCatalog, preflight.warmModelKey),
  ));
  if (!selection) {
    await failWithoutUsableProvider(db, config, context);
    return null;
  }
  const request = await composeRunRequest(db, config, context, client, signal, trace, {
    turn,
    selection,
    toolsetInventory: preflight.toolsetInventory,
  });
  const creating = await trace.span("preflight.persist_model", () => persistResolvedRunModel(db, config, context, selection.model));
  if (!creating) return null;
  context.externalState = "creating";
  // Seul un workflow porte un budget de jetons : on n'ajoute cette lecture
  // qu'aux étapes qui la consomment, jamais aux DM ordinaires.
  if (context.workflowId) {
    context.sessionCountersBefore = await trace.span(
      "preflight.session_counters",
      () => readWorkflowSessionCounters(context, client, signal),
    );
  }
  state.selection = selection;
  state.retryState = {
    fallbackAttempted: false,
    extraModelTried: false,
    fromProvider: selection.provider,
    fallback: null,
  };
  // Les images du tour partent en parts `image_url`, dans la borne du
  // lien ; celle qui n'y tient pas est nommée au modèle, jamais tue.
  const turnImages = turn
    ? { images: turn.images, missing: [] }
    : isServiceStepKind(context.stepKind)
      ? { images: [], missing: [] }
      : await trace.span("preflight.images", () => loadRunImages(db, context, config.blob));
  const fitted = fitHermesRunImages({
    input: request.turnInput,
    images: turnImages.images,
    instructions: request.instructions,
    sessionId: context.sessionId,
    conversationHistory: request.history,
  });
  const sentInput = [
    request.turnInput,
    ...turnImages.missing.map((name) => imageNotSentNote(name, "missing")),
    ...fitted.dropped.map((image) => imageNotSentNote(image.name, "too_large")),
  ].join("\n\n");
  const createArgs: RunCreateArgs = { input: sentInput, images: fitted.images, instructions: request.instructions, history: request.history };
  state.createArgs = createArgs;
  const { hermesRunId, selection: created } = await postCreateRun(db, config, context, client, state, trace, selection, createArgs);
  trace.mark("hermes.run_created");
  context.provider = created.provider;
  context.model = created.model;
  if (!await confirmFirstCreate(db, config, context, hermesRunId, request.input)) {
    await settleOrphanCreate(db, context, client, hermesRunId);
    return null;
  }
  context.externalState = "streaming";
  return hermesRunId;
}

/**
 * The first POST of a run, idempotent on the run's id, then on a fallback
 * key per attempt. A refusal the provider recovery cannot route elsewhere
 * throws. Writes `state.hermesRunId`, `state.selection`, `state.retryState`.
 */
async function postCreateRun(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
  trace: Pick<RunTrace, "mark">,
  selection: ResolvedRunSelection,
  args: RunCreateArgs,
): Promise<{ hermesRunId: string; selection: ResolvedRunSelection }> {
  let current = selection;
  let createKey = context.id;
  while (!state.hermesRunId) {
    try {
      trace.mark("hermes.post_sent");
      state.hermesRunId = await client.createRun({
        input: args.input,
        images: args.images,
        instructions: args.instructions,
        sessionId: context.sessionId,
        model: current.model,
        provider: current.provider,
        reasoningEffort: current.reasoningEffort,
        fast: current.fastMode === true,
        promptCacheTtl: context.promptCacheTtl,
        conversationHistory: args.history,
        idempotencyKey: createKey,
        signal: state.controller.signal,
      });
    } catch (error) {
      const recovered = await recoverProviderFailure(
        db, config, client, context, error, current, state.retryState,
      );
      if (recovered.action === "auth_required") {
        throw fallbackAwareError(providerAuthRequiredError(recovered.provider), state.retryState);
      }
      if (recovered.action !== "retry") {
        throw fallbackAwareError(error, state.retryState);
      }
      current = recovered.selection;
      state.selection = current;
      state.retryState = recovered.state;
      createKey = fallbackIdempotencyKey(context.id, state.retryState.extraModelTried);
      await recordCreatingRunModel(db, runKey(context), heldLease(config, context), current.model);
    }
  }
  return { hermesRunId: state.hermesRunId, selection: current };
}

/**
 * The prompt of a new run, from its history, its instructions and its
 * input. Les instructions sont le PRÉFIXE que le fournisseur peut mettre en
 * cache : la part variable du cadrage (profondeur, budget restant) est portée
 * par l'entrée, jamais par elles. Reads only (history, instructions,
 * playbooks), in this order; writes nothing.
 */
export async function composeRunRequest(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  signal: AbortSignal,
  trace: Pick<RunTrace, "span">,
  inputs: {
    turn: SpeakingTurn | null;
    selection: ResolvedRunSelection;
    toolsetInventory: RunPreflight["toolsetInventory"];
  },
): Promise<RunRequest> {
  const { turn, selection } = inputs;
  const memoryToolEnabled = context.memoryToolEnabled === true;
  const packed = isServiceStepKind(context.stepKind)
    ? { history: [] as Array<{ role: string; content: string }>, packInstructions: null }
    : turn
      ? await trace.span("preflight.history", () => packRoomHistory(db, {
          ...context,
          model: selection.model,
          provider: selection.provider,
          reasoningEffort: selection.reasoningEffort,
        }, turn, { client, signal }))
      : await trace.span("preflight.history", () => conversationHistory(db, {
          ...context,
          model: selection.model,
          provider: selection.provider,
          reasoningEffort: selection.reasoningEffort,
        }, { client, signal }));
  // Le résumé vit dans `conversation_history` ; les règles du pack, stables,
  // rejoignent le préfixe dès qu'un compact existe.
  const prompt: DmStepPrompt = isServiceStepKind(context.stepKind)
    ? {
        instructions: context.stepKind === "persona_draft"
          ? buildPersonaDraftInstructions(context.botName || "the new bot")
          : context.stepKind === "compaction"
            ? buildCompactionInstructions()
            : retiredServiceStep(context.stepKind),
        limitsLine: null,
      }
    : turn
      ? { instructions: turn.instructions, limitsLine: null }
      : await trace.span("preflight.instructions", () => dmInstructions(db, context));
  if (packed.packInstructions) {
    prompt.instructions = withBotModeInstructions(prompt.instructions, packed.packInstructions);
  }
  if (!isServiceStepKind(context.stepKind)) {
    prompt.instructions = withBotModeInstructions(
      prompt.instructions,
      machineBlock({ name: context.runtimeName, engine: context.runtimeEngine }),
    );
  }
  const routing = groupSendState(context)?.phase === "route";
  // L'apprentissage passe par les skills du runtime, jamais par une ligne
  // de mémoire : le bloc et la réécriture « /learn » n'existent que si
  // l'hôte annonce le toolset `skills` actif (bot-learning.ts).
  // Le routeur n'a pas d'outils : on ne lui annonce ni skills ni playbooks.
  const canLearn = !routing && !isServiceStepKind(context.stepKind) && runtimeCanLearn(inputs.toolsetInventory);
  if (canLearn) {
    prompt.instructions = withBotModeInstructions(
      prompt.instructions,
      buildLearningBlock({ memoryToolEnabled }),
    );
  }
  const rawInput = canLearn && !turn && isLearnRequest(context.input) ? buildLearnInput(context.input) : context.input;
  const steppedInput = turn ? turn.input : withAutonomousStepLimits(rawInput, prompt.limitsLine);
  // A run key travels only with the bot-mode block that announces its tool:
  // no room turn, workflow step or inbound mail receives one, and the API
  // refuses a bot that is not enabled anyway. Keys and the user's timezone go
  // in the platform note that closes the history, never in the user's text
  // (2026-11-16: the appended lines named the tool on a mere « re »).
  const metadata: string[] = [];
  if (context.routineToolEnabled && prompt.instructions.includes(ROUTINE_TOOL_RUNTIME_NAME)) {
    metadata.push(routineToolMetadata(signRoutineRunKey(runKeySigningSecret(config.internalSecrets), context.id), context.routineUserTimezone ?? null));
  }
  if (context.botSettingsToolEnabled && prompt.instructions.includes(BOT_SETTINGS_TOOL_RUNTIME_NAME)) {
    metadata.push(botSettingsToolMetadata(signBotSettingsRunKey(runKeySigningSecret(config.internalSecrets), context.id)));
  }
  const input = steppedInput;
  // Only a direct conversation replays its thread as history: a room turn
  // carries its journal in the input, a service step has no history.
  const history = !turn && !isServiceStepKind(context.stepKind)
    ? withTurnBoundary(packed.history, metadata)
    : [...packed.history, ...withTurnBoundary([], metadata)];
  // Playbooks et « plan d'abord » dépendent du message : Hermes pose les
  // instructions en fin de prompt système, sous son point de cache, et
  // les y changer d'un tour à l'autre réécrivait tout le préfixe (outils
  // compris). Ils précèdent l'entrée, comme la ligne de limites.
  const turnScoped = !routing && !isServiceStepKind(context.stepKind);
  const playbooks = turnScoped
    ? await trace.span("preflight.playbooks", () => assignedPlaybookBlock(db, context, input))
    : "";
  const turnInput = withTurnGuidance(input, [turnScoped ? context.planTurnBlock : null, playbooks]);
  return { history, instructions: prompt.instructions, input, turnInput };
}

/**
 * Silence implicite : rien de neuf pour ce membre. On termine le run par un
 * run.completed synthétique SANS sortie, via persistEvents : le fil voit la
 * fin du run, l'avis de pass, et l'envoi avance, exactement comme un `pass`
 * répondu par Hermes.
 */
async function completeGroupTurnWithoutHermes(db: SQL, config: WorkerConfig, context: RunContext): Promise<void> {
  await persistUnnumberedEvents(db, config, context, context.lastHermesSequence, [{
    type: "run.completed",
    occurredAt: new Date(),
    payload: { output: "" },
  }]);
}
