import type { HermesClient, HermesModelOptions } from "@openedbot/hermes";
import {
  runtimeToolsetContractMessage,
  runtimeToolsetContractViolation,
} from "@openedbot/runtimes/domain/runtime-contract";
import { BOT_PROFILE_MISSING_CODE, botProfileMissingMessage } from "@openedbot/roster/domain/bot-profile-transfer";
import type { RunTrace } from "@openedbot/platform-observability/run-trace";
import { NamedRunError } from "./failure";
import type { RunContext } from "./types";

/**
 * Read inventory and scope concurrently, then gate the session mutation.
 * Each operation keeps its own OHB-107 latency span.
 *
 * OHB-137: two reads leave the serial path. `modelCatalog` (a pure read) starts
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
 * The inventory the gate checks (OHB-138). A connector runtime with a live
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

/** `link_connected_at` normalisé. Un heartbeat ne change pas cette chaîne. */
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
  } catch {
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
