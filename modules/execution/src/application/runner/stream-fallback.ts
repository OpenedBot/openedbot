import type { SQL } from "bun";
import type { HermesClient, HermesEvent } from "@openedbot/hermes";
import type { HermesEventNormalizer } from "../../domain/hermes-events";
import { fallbackIdempotencyKey } from "../provider-fallback";
import type { WorkerConfig } from "../worker-config";
import { settleOrphanCreate } from "./failure";
import { confirmFallbackCreate, markFallbackCreateIntent } from "./lease-transitions";
import { type ResolvedRunSelection, recoverProviderFailure } from "./provider-recovery";
import type { RunCreateArgs, RunState } from "./run-state";
import type { RunContext } from "./types";

export type StreamFallback =
  /** No other provider to try: the failure frame goes on to the normalizer. */
  | { kind: "none" }
  /** The run's own provider refused its login: its `run.error` must name it. */
  | { kind: "auth_required"; provider: string }
  /** A new Hermes run is created and confirmed: the stream restarts on it. */
  | { kind: "restarted" }
  /** The lease was lost, or the new run could not be confirmed: nothing else happens. */
  | { kind: "settled" };

/**
 * Repli de fournisseur, during the stream: a `run.failed` or `run.error`
 * frame the provider recovery can route elsewhere creates a new Hermes run
 * with the same request only before tools, while the observed stream is
 * complete. Otherwise the failure is persisted without replaying effects.
 * The durable intent is written BEFORE the POST:
 * a worker lost during this creation leaves `creating` without an id, an
 * ambiguous outcome to reconcile, never the old run followed while the new
 * one runs unwatched. Writes `state.selection`, `state.retryState`,
 * `state.hermesRunId` (null while it creates), `context.externalState`,
 * `context.lastHermesSequence`, `context.provider` and `context.model`.
 */
export async function fallBackAfterRunFailure(
  db: SQL,
  config: WorkerConfig,
  context: RunContext,
  client: HermesClient,
  state: RunState,
  normalizer: Pick<HermesEventNormalizer, "skipPast">,
  raw: HermesEvent,
  attempt: { selection: ResolvedRunSelection; createArgs: RunCreateArgs },
): Promise<StreamFallback> {
  const { createArgs } = attempt;
  // Also consult durable events: a previous consumer may have observed tools
  // whose frames this stream skips. Completed tools are just as unsafe to repeat.
  const priorTools = await db<Array<{ cursor: number }>>`
    select cursor from run_events
     where organization_id = ${context.organizationId} and run_id = ${context.id}
       and type in ('tool.call', 'tool.result', 'tool.result.attached')
     limit 1
  `;
  state.providerFallbackUnsafe ||= priorTools.length > 0;
  const recovered = await recoverProviderFailure(
    db, config, client, context, raw, attempt.selection, state.retryState,
    !state.providerFallbackUnsafe,
  );
  if (recovered.action === "auth_required") return { kind: "auth_required", provider: recovered.provider };
  if (recovered.action !== "retry") return { kind: "none" };
  if (recovered.fallbackSequence !== null) normalizer.skipPast(recovered.fallbackSequence);
  const selection = recovered.selection;
  state.selection = selection;
  state.retryState = recovered.state;
  // Bail perdu avant tout envoi : le repreneur réconcilie l'ancien run.
  if (!await markFallbackCreateIntent(db, config, context, selection.model)) return { kind: "settled" };
  state.hermesRunId = null;
  context.externalState = "creating";
  context.lastHermesSequence = 0;
  const nextId = await client.createRun({
    input: createArgs.input,
    images: createArgs.images,
    instructions: createArgs.instructions,
    sessionId: context.sessionId,
    model: selection.model,
    provider: selection.provider,
    reasoningEffort: selection.reasoningEffort,
    promptCacheTtl: context.promptCacheTtl,
    conversationHistory: createArgs.history,
    idempotencyKey: fallbackIdempotencyKey(context.id, state.retryState.extraModelTried),
    signal: state.controller.signal,
  });
  state.hermesRunId = nextId;
  if (!await confirmFallbackCreate(db, config, context, nextId, selection.model)) {
    await settleOrphanCreate(db, context, client, nextId);
    return { kind: "settled" };
  }
  context.externalState = "streaming";
  context.provider = selection.provider;
  context.model = selection.model;
  return { kind: "restarted" };
}
