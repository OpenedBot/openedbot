import {
  type HermesClient,
  HermesClientError,
  type HermesModelOptions,
  hermesToolsetFingerprint,
  noteHermesPreflightLink,
} from "@openedbot/hermes";
import {
  runtimeToolsetContractMessage,
  runtimeToolsetContractViolation,
} from "@openedbot/runtimes/domain/runtime-contract";
import { BOT_PROFILE_MISSING_CODE, botProfileMissingMessage } from "@openedbot/roster/domain/bot-profile-transfer";
import { withBotModeInstructions } from "@openedbot/roster/domain/bot-mode";
import { buildRuntimeMemoryBlock } from "@openedbot/roster/domain/bot-memory";
import type { RunTrace } from "@openedbot/platform-observability/run-trace";
import { type WarmModelSelection, readWarmModelSelection, warmModelSelectionKey } from "../warm-model-selection";
import { NamedRunError } from "./failure";
import type { RunContext } from "./types";

/**
 * Read inventory and scope concurrently, then gate the session mutation.
 * Each operation keeps its own run latency span.
 *
 * Two reads leave the serial path. `modelCatalog` (a pure read) starts
 * with the inventory and is handed back unresolved: the selection that may
 * WRITE the profile model still runs after the gate. `replayProbe` starts as
 * soon as the gate passes, alongside `ensure_session`, and is awaited only
 * where the event stream needs it. Neither promise ever rejects; a failed
 * gate starts no probe and creates no session.
 */
export async function gatherIndependentPreflight<
  TToolsets extends Awaited<ReturnType<HermesClient["toolsets"]>>,
  TScope extends "runtime" | "profile",
>(
  trace: Pick<RunTrace, "span">,
  work: {
    toolsets: () => Promise<TToolsets>;
    toolsetScope: () => Promise<TScope>;
    ensureSession: () => Promise<unknown>;
    /**
     * Sous `/p/<slug>/`, un 404 dit « profil inconnu », pas « endpoint absent ».
     * Lu seulement quand l'inventaire manque, pour nommer la vraie panne.
     */
    missingProfile?: () => Promise<string | null>;
    /** Read-only model catalogue for the selection. A failure resolves `null`. */
    modelCatalog?: () => Promise<HermesModelOptions | null>;
    /** Event replay capability, fail-closed: a failure resolves `false`. */
    replayProbe?: (toolsets: TToolsets) => Promise<boolean>;
    /**
     * Cached replay answer for this inventory. A boolean skips the probe
     * (the stream still honours it). `undefined` falls through to `replayProbe`.
     */
    replayCached?: (toolsets: TToolsets) => boolean | undefined;
  },
): Promise<{
  toolsets: TToolsets;
  toolsetScope: TScope;
  modelCatalog: Promise<HermesModelOptions | null> | null;
  replayProbe: Promise<boolean>;
}> {
  const modelCatalog = work.modelCatalog
    ? Promise.resolve().then(work.modelCatalog).catch(() => null)
    : null;
  const [toolsets, toolsetScope] = await Promise.all([
    trace.span("preflight.toolsets", work.toolsets),
    trace.span("preflight.toolset_scope", work.toolsetScope),
  ]);
  const missing = toolsets === null && work.missingProfile ? await work.missingProfile() : null;
  if (missing) throw new NamedRunError(BOT_PROFILE_MISSING_CODE, botProfileMissingMessage(missing));
  const violation = runtimeToolsetContractViolation(toolsets, { scope: toolsetScope });
  if (violation) throw new NamedRunError(violation.code, runtimeToolsetContractMessage(violation));
  const knownReplay = work.replayCached?.(toolsets);
  const probe = work.replayProbe;
  const replayProbe = knownReplay !== undefined
    ? Promise.resolve(knownReplay)
    : probe
      ? trace.span("hermes.replay_probe", () => probe(toolsets)).catch(() => false)
      : Promise.resolve(false);
  await trace.span("preflight.ensure_session", work.ensureSession);
  return { toolsets, toolsetScope, modelCatalog, replayProbe };
}

/**
 * The inventory the gate checks. A connector runtime with a live
 * link instant and an epoch reuses the inventory read by an earlier run on
 * the same link, profile and `toolset_epoch`, for at most
 * `HERMES_TOOLSET_INVENTORY_TTL_MS` (60 s, the staleness bound for host-side
 * changes openedbot cannot see). Anything else reads live. Either way the result
 * goes through the same fail-closed gate in `gatherIndependentPreflight`.
 */
export function preflightToolsets(
  client: Pick<HermesClient, "toolsets" | "cachedToolsets">,
  context: Pick<RunContext, "organizationId" | "runtimeId" | "reachability" | "linkConnectedAt" | "toolsetEpoch">,
): ReturnType<HermesClient["toolsets"]> {
  const linkConnectedAt = linkInstant(context.linkConnectedAt);
  const toolsetEpoch = context.toolsetEpoch;
  if (context.reachability !== "connector" || !linkConnectedAt || toolsetEpoch == null || toolsetEpoch === "") {
    return client.toolsets();
  }
  return client.cachedToolsets({
    organizationId: context.organizationId,
    runtimeId: context.runtimeId,
    linkConnectedAt,
    toolsetEpoch: String(toolsetEpoch),
  });
}

/** Un instant du lien (`link_connected_at`, `inventory_changed_at`) en ISO. Un heartbeat ne change pas cette chaîne. */
export function linkInstant(value: Date | string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function resolveToolsetScope(
  client: Pick<HermesClient, "probeProfileIsolation">,
  context: Pick<RunContext, "hermesProfile" | "hermesProfileManaged"> & Partial<Pick<RunContext, "reachability">>,
): Promise<"profile" | "runtime"> {
  if (context.reachability === "direct" || !context.hermesProfile) return "runtime";
  try {
    const isolation = await client.probeProfileIsolation(context.hermesProfile);
    return isolation === "isolated" ? "profile" : "runtime";
  } catch (error) {
    // A gateway restarting (draining, or not listening yet) cannot say
    // whether the profile is isolated. Falling back to "runtime" then refused
    // a profile's own memory toolsets for good; the run waits for it instead.
    if (error instanceof HermesClientError && (error.code === "HERMES_GATEWAY_DRAINING" || error.code === "HERMES_UNREACHABLE")) throw error;
    return "runtime";
  }
}

/** Le slug du profil nommé quand l'hôte prouve qu'il ne l'a pas ; `null` sinon. */
export async function missingRunProfile(
  client: Pick<HermesClient, "probeProfileIsolation">,
  context: Pick<RunContext, "hermesProfile"> & Partial<Pick<RunContext, "reachability">>,
): Promise<string | null> {
  if (context.reachability === "direct" || !context.hermesProfile) return null;
  try {
    return await client.probeProfileIsolation(context.hermesProfile) === "missing" ? context.hermesProfile : null;
  } catch {
    return null;
  }
}

export type RunPreflight = {
  /** The key a new run's model selection is remembered under; null for a resumed run. */
  warmModelKey: string | null;
  warmSelection: WarmModelSelection | null;
  toolsetInventory: Awaited<ReturnType<HermesClient["toolsets"]>>;
  /** Unresolved: the selection awaits it, after the gate. */
  modelCatalog: Promise<HermesModelOptions | null> | null;
  /** Unresolved and never rejected: the event stream awaits it. */
  replayProbe: Promise<boolean>;
};

/**
 * Préflight, second half, for a run that will create or follow a Hermes
 * run: the session's inventory and scope, its gate, the session itself, then
 * what the inventory tells the bot. `resumedHermesRunId` is the id the run
 * was claimed with (a resumed run never reads the catalogue again). Writes
 * `context.memoryToolEnabled`, `context.webToolsEnabled` and
 * `context.instructions`; a refused gate throws a `NamedRunError`.
 */
export async function gatherRunPreflight(
  client: HermesClient,
  context: RunContext,
  trace: Pick<RunTrace, "span">,
  signal: AbortSignal,
  resumedHermesRunId: string | null,
): Promise<RunPreflight> {
  // Inventory and scope reads run in parallel. Session creation waits for
  // their capability gate; model, history and createRun consume the result.
  // The model catalogue read rides with the inventory and the replay probe
  // starts at the gate: neither is serial before the event stream.
  const warmModelKey = resumedHermesRunId ? null : warmModelSelectionKey({
    organizationId: context.organizationId,
    runtimeId: context.runtimeId,
    profile: context.hermesProfile,
    provider: context.provider,
    model: context.model,
    reasoningEffort: context.reasoningEffort,
    fastMode: context.fastMode === true,
    linkConnectedAt: linkInstant(context.linkConnectedAt),
    inventoryChangedAt: linkInstant(context.inventoryChangedAt),
  });
  const warmSelection = readWarmModelSelection(warmModelKey, Date.now());
  const {
    toolsets: toolsetInventory,
    modelCatalog,
    replayProbe,
  } = await gatherIndependentPreflight(trace, {
    toolsets: () => preflightToolsets(client, context),
    toolsetScope: () => resolveToolsetScope(client, context),
    // Le titre d'une session de SALON est le nom du salon, pas celui du membre
    // dont c'est le tour : le premier orateur baptisait la session à son nom.
    ensureSession: () => client.ensureSession(
      context.sessionId,
      context.groupId ? context.threadTitle : context.botName,
      signal,
    ),
    missingProfile: () => missingRunProfile(client, context),
    // A resumed run, or a warm selection still inside its TTL, never reads
    // the catalogue again.
    ...(resumedHermesRunId || warmSelection ? {} : { modelCatalog: () => client.modelOptions() }),
    // Rejeu : un runtime `connector` qui annonce `features.event_replay` tient
    // un journal numéroté (docs/CONNECTOR.md). Keyed on the link instant, the
    // inventory fingerprint and the stored model, so consecutive turns on the
    // same link reuse the answer and skip the capabilities probe.
    ...(context.reachability === "connector"
      ? {
          replayCached: (inventory: Awaited<ReturnType<HermesClient["toolsets"]>>) => {
            const linkConnectedAt = linkInstant(context.linkConnectedAt);
            return client.peekCachedEventReplay({
              organizationId: context.organizationId,
              runtimeId: context.runtimeId,
              linkConnectedAt,
              toolsetFingerprint: hermesToolsetFingerprint(inventory),
              model: context.model,
            });
          },
          replayProbe: (inventory: Awaited<ReturnType<HermesClient["toolsets"]>>) => {
            const linkConnectedAt = linkInstant(context.linkConnectedAt);
            noteHermesPreflightLink({
              organizationId: context.organizationId,
              runtimeId: context.runtimeId,
              linkConnectedAt,
            });
            return client.eventReplaySupported({
              organizationId: context.organizationId,
              runtimeId: context.runtimeId,
              linkConnectedAt,
              toolsetFingerprint: hermesToolsetFingerprint(inventory),
              model: context.model,
            });
          },
        }
      : {}),
  });
  const memoryToolEnabled = toolsetInventory?.some((toolset) => toolset.name === "memory" && toolset.enabled) === true;
  context.memoryToolEnabled = memoryToolEnabled;
  // The web rule names `web_search` then `web_extract`: only a session
  // whose `web` toolset really announces both gets it.
  context.webToolsEnabled = toolsetInventory?.some((toolset) => toolset.name === "web" && toolset.enabled
    && toolset.tools?.includes("web_search") === true && toolset.tools.includes("web_extract")) === true;
  // La mémoire est celle du runtime : le bloc dit seulement au bot si son
  // outil `memory` existe dans cette session (toolset actif sur le profil).
  context.instructions = withBotModeInstructions(
    context.personaInstructions,
    buildRuntimeMemoryBlock({ toolEnabled: memoryToolEnabled }),
  );
  return { warmModelKey, warmSelection, toolsetInventory, modelCatalog, replayProbe };
}
