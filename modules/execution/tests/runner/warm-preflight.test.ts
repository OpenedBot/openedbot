import { describe, expect, test } from "bun:test";
import { HermesClient, resetHermesPreflightCache } from "@openedbot/hermes";
import { RunTrace } from "@openedbot/platform-observability/run-trace";
import { gatherIndependentPreflight } from "../../src/application/runner/preflight";
import {
  readWarmModelSelection,
  rememberWarmModelSelection,
  resetWarmModelSelection,
  takeWarmOrSelectModel,
  warmModelSelectionKey,
  warmModelSelectionSize,
  WARM_MODEL_SELECTION_MAX_ENTRIES,
  WARM_MODEL_SELECTION_TTL_MS,
} from "../../src/application/warm-model-selection";

const inventory = [{ name: "web", label: "Web", description: null, configured: true, enabled: true, tools: [] as string[] }];
const scope = {
  organizationId: "org-warm",
  runtimeId: "rt-warm",
  linkConnectedAt: "2026-10-09T00:00:00.000Z",
  toolsetFingerprint: "fp-web",
  model: "grok-4",
};

describe("warm preflight (DEV-214)", () => {
  test("a cached replay answer skips the probe, and a warm model skips selection", async () => {
    resetHermesPreflightCache();
    resetWarmModelSelection();
    let networkProbes = 0;
    const client = new HermesClient({
      profile: "neo",
      transport: {
        kind: "direct",
        send: async () => {
          networkProbes += 1;
          return Response.json({ features: { event_replay: true } });
        },
      },
    });
    expect(await client.eventReplaySupported(scope)).toBe(true);
    expect(networkProbes).toBe(1);

    let probeCalls = 0;
    const trace = new RunTrace();
    const preflight = await gatherIndependentPreflight(trace, {
      toolsets: async () => inventory,
      toolsetScope: async () => "runtime" as const,
      ensureSession: async () => undefined,
      replayCached: () => client.peekCachedEventReplay(scope),
      replayProbe: async () => {
        probeCalls += 1;
        return false;
      },
    });
    expect(probeCalls).toBe(0);
    expect(networkProbes).toBe(1);
    expect(await preflight.replayProbe).toBe(true);
    expect(trace.summary().spans["hermes.replay_probe"]).toBeUndefined();
    expect(trace.summary().spans["preflight.model_selection"]).toBeUndefined();

    const key = warmModelSelectionKey({
      organizationId: scope.organizationId,
      runtimeId: scope.runtimeId,
      profile: "neo",
      provider: "xai",
      model: "grok-4",
      reasoningEffort: null,
      linkConnectedAt: scope.linkConnectedAt,
    });
    rememberWarmModelSelection(key, { provider: "xai", model: "grok-4", reasoningEffort: null }, 1_000);
    let selects = 0;
    const selected = await takeWarmOrSelectModel(
      readWarmModelSelection(key, 1_000 + 10),
      async () => {
        selects += 1;
        return null;
      },
    );
    expect(selected).toEqual({ provider: "xai", model: "grok-4", reasoningEffort: null });
    expect(selects).toBe(0);
    resetHermesPreflightCache();
    resetWarmModelSelection();
  });

  test("a cache miss still probes, and an expired model selection is resolved again", async () => {
    resetHermesPreflightCache();
    resetWarmModelSelection();
    const client = new HermesClient({
      profile: "neo",
      transport: {
        kind: "direct",
        send: async () => Response.json({ features: { event_replay: true } }),
      },
    });
    expect(await client.eventReplaySupported(scope)).toBe(true);
    expect(client.peekCachedEventReplay({ ...scope, toolsetFingerprint: "fp-other" })).toBeUndefined();

    let probeCalls = 0;
    const preflight = await gatherIndependentPreflight(new RunTrace(), {
      toolsets: async () => inventory,
      toolsetScope: async () => "runtime" as const,
      ensureSession: async () => undefined,
      replayCached: () => undefined,
      replayProbe: async () => {
        probeCalls += 1;
        return true;
      },
    });
    expect(probeCalls).toBe(1);
    expect(await preflight.replayProbe).toBe(true);

    const key = warmModelSelectionKey({
      organizationId: "org-warm",
      runtimeId: "rt-warm",
      profile: "neo",
      provider: "xai",
      model: "grok-4",
      reasoningEffort: "low",
      linkConnectedAt: null,
    });
    rememberWarmModelSelection(key, { provider: "xai", model: "grok-4", reasoningEffort: "low" }, 5_000);
    expect(readWarmModelSelection(key, 5_000 + WARM_MODEL_SELECTION_TTL_MS)).toBeNull();
    let selects = 0;
    const selected = await takeWarmOrSelectModel(readWarmModelSelection(key, 5_000 + WARM_MODEL_SELECTION_TTL_MS), async () => {
      selects += 1;
      return { provider: "xai", model: "grok-4", reasoningEffort: "low" };
    });
    expect(selects).toBe(1);
    expect(selected?.model).toBe("grok-4");
    expect(warmModelSelectionKey({
      organizationId: "org-warm",
      runtimeId: "rt-warm",
      profile: "neo",
      provider: null,
      model: "  ",
      reasoningEffort: null,
      linkConnectedAt: null,
    })).toBeNull();
    resetHermesPreflightCache();
    resetWarmModelSelection();
  });

  test("a denied toolset still fails closed and never starts the replay probe", async () => {
    let cachedReads = 0;
    let probeCalls = 0;
    const attempt = gatherIndependentPreflight(new RunTrace(), {
      toolsets: async () => [{
        name: "cronjob",
        label: "Cron",
        description: null,
        configured: true,
        enabled: true,
        tools: ["cronjob"],
      }],
      toolsetScope: async () => "runtime" as const,
      ensureSession: async () => undefined,
      replayCached: () => {
        cachedReads += 1;
        return true;
      },
      replayProbe: async () => {
        probeCalls += 1;
        return true;
      },
    });
    await expect(attempt).rejects.toMatchObject({ code: "HERMES_FORBIDDEN_TOOLSETS_ACTIVE" });
    expect(cachedReads).toBe(0);
    expect(probeCalls).toBe(0);
  });

  test("expired selections leave the cache on the next write, even if their key is never read again", () => {
    resetWarmModelSelection();
    const key = (connectedAt: string) => warmModelSelectionKey({ ...scope, profile: "neo", provider: null, reasoningEffort: null, linkConnectedAt: connectedAt });
    const selection = { provider: null, model: "grok-4", reasoningEffort: null };
    // A reconnection changes the key: the previous one is never read again.
    rememberWarmModelSelection(key("2026-10-09T00:00:00.000Z"), selection, 0);
    rememberWarmModelSelection(key("2026-10-09T01:00:00.000Z"), selection, 1_000);
    expect(warmModelSelectionSize()).toBe(2);
    rememberWarmModelSelection(key("2026-10-09T02:00:00.000Z"), selection, WARM_MODEL_SELECTION_TTL_MS + 500);
    expect(warmModelSelectionSize()).toBe(2);
    expect(readWarmModelSelection(key("2026-10-09T01:00:00.000Z"), WARM_MODEL_SELECTION_TTL_MS + 500)).toEqual({ provider: null, model: "grok-4", reasoningEffort: null });
    resetWarmModelSelection();
  });

  test("the cache never grows past its cap; the oldest write goes first", () => {
    resetWarmModelSelection();
    const key = (index: number) => warmModelSelectionKey({ ...scope, runtimeId: `rt-${index}`, profile: null, provider: null, reasoningEffort: null });
    const selection = { provider: null, model: "grok-4", reasoningEffort: null };
    for (let index = 0; index <= WARM_MODEL_SELECTION_MAX_ENTRIES; index += 1) rememberWarmModelSelection(key(index), selection, 10);
    expect(warmModelSelectionSize()).toBe(WARM_MODEL_SELECTION_MAX_ENTRIES);
    expect(readWarmModelSelection(key(0), 10)).toBeNull();
    expect(readWarmModelSelection(key(1), 10)).not.toBeNull();
    expect(readWarmModelSelection(key(WARM_MODEL_SELECTION_MAX_ENTRIES), 10)).not.toBeNull();
    // Rewriting a key moves it to the back: it survives the next eviction.
    rememberWarmModelSelection(key(1), selection, 10);
    rememberWarmModelSelection(key(WARM_MODEL_SELECTION_MAX_ENTRIES + 1), selection, 10);
    expect(readWarmModelSelection(key(1), 10)).not.toBeNull();
    expect(readWarmModelSelection(key(2), 10)).toBeNull();
    resetWarmModelSelection();
  });
});
