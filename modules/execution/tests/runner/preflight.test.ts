import { describe, expect, test } from "bun:test";
import { HermesClient, resetHermesPreflightCache, type HermesModelOptions } from "@openedbot/hermes";
import { RunTrace } from "@openedbot/platform-observability/run-trace";
import { gatherIndependentPreflight, missingRunProfile, preflightToolsets } from "../../src/application/runner/preflight";
import { readWorkflowSessionCounters } from "../../src/application/runner/workflows";

const counters = {
  inputTokens: 3,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

describe("préflight Hermes (OHB-114)", () => {
  test("les lectures sont parallèles, la session attend leur contrôle et chacun a son coût", async () => {
    let pending = 0;
    let maxPending = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const enter = async () => {
      pending += 1;
      maxPending = Math.max(maxPending, pending);
      await gate;
      pending -= 1;
    };
    const trace = new RunTrace();
    let sessionsCalled = 0;
    const done = gatherIndependentPreflight(trace, {
      toolsets: async () => {
        await enter();
        return [];
      },
      toolsetScope: async () => {
        await enter();
        return "runtime" as const;
      },
      ensureSession: async () => {
        sessionsCalled += 1;
        await enter();
      },
    });
    expect(maxPending).toBe(2);
    expect(sessionsCalled).toBe(0);
    release();
    await done;
    expect(sessionsCalled).toBe(1);
    const spans = trace.summary().spans;
    expect(typeof spans["preflight.toolsets"]).toBe("number");
    expect(typeof spans["preflight.toolset_scope"]).toBe("number");
    expect(typeof spans["preflight.ensure_session"]).toBe("number");
    expect(spans["preflight.model_selection"]).toBeUndefined();
    expect(spans["preflight.session_counters"]).toBeUndefined();
  });

  test("un DM ne lit aucun compteur et n'attend pas une sonde capabilities déjà en cache", async () => {
    resetHermesPreflightCache();
    let calls = 0;
    const client = {
      sessionCounters: async () => {
        calls += 1;
        return counters;
      },
    };
    const dm = { id: "run-dm", organizationId: "org-dm", sessionId: "sess-dm", workflowId: null };
    expect(await readWorkflowSessionCounters(dm, client)).toBeNull();
    expect(calls).toBe(0);

    const workflow = { ...dm, workflowId: "wf-1" };
    expect(await readWorkflowSessionCounters(workflow, client)).toEqual(counters);
    expect(calls).toBe(1);

    const down = {
      sessionCounters: async () => {
        calls += 1;
        throw new Error("compteurs injoignables");
      },
    };
    expect(await readWorkflowSessionCounters(workflow, down)).toBeNull();
    expect(calls).toBe(2);

    const scope = { organizationId: "org-dm-probe", runtimeId: "rt-dm-probe" };
    const warm = new HermesClient({
      profile: "neo",
      transport: {
        kind: "direct",
        send: async () => Response.json({ features: { event_replay: true } }),
      },
    });
    expect(await warm.eventReplaySupported(scope)).toBe(true);

    let probes = 0;
    const cold = new HermesClient({
      profile: "neo",
      transport: {
        kind: "direct",
        send: () => {
          probes += 1;
          return new Promise<Response>(() => {});
        },
      },
    });
    const raced = await Promise.race([
      cold.eventReplaySupported(scope),
      Bun.sleep(80).then(() => "hung" as const),
    ]);
    expect(raced).toBe(true);
    expect(probes).toBe(0);
    resetHermesPreflightCache();
  });

  test("the replay probe starts at the gate, before the session and run creation resolve (OHB-137)", async () => {
    const trace = new RunTrace();
    const order: string[] = [];
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
    let releaseProbe!: (supported: boolean) => void;
    const probeAnswer = new Promise<boolean>((resolve) => { releaseProbe = resolve; });
    let probedInventory: unknown = undefined;
    const inventory = [{ name: "web", label: "Web", description: null, configured: true, enabled: true, tools: [] }];
    const done = gatherIndependentPreflight(trace, {
      toolsets: async () => inventory,
      toolsetScope: async () => "runtime" as const,
      ensureSession: async () => {
        order.push("session");
        await sessionGate;
      },
      replayProbe: (toolsets) => {
        order.push("probe");
        probedInventory = toolsets;
        return probeAnswer;
      },
    });
    await Bun.sleep(0);
    expect(order).toEqual(["probe", "session"]);
    expect(probedInventory).toBe(inventory);
    releaseSession();
    const preflight = await done;
    // Preflight (and the run POST after it) no longer waits for the probe.
    let settled = false;
    void preflight.replayProbe.then(() => { settled = true; });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(trace.summary().spans["hermes.replay_probe"]).toBeUndefined();
    releaseProbe(true);
    expect(await preflight.replayProbe).toBe(true);
    expect(typeof trace.summary().spans["hermes.replay_probe"]).toBe("number");

    const failing = await gatherIndependentPreflight(new RunTrace(), {
      toolsets: async () => inventory,
      toolsetScope: async () => "runtime" as const,
      ensureSession: async () => undefined,
      replayProbe: async () => { throw new Error("capabilities down"); },
    });
    expect(await failing.replayProbe).toBe(false);
  });

  test("the model catalogue read runs with the inventory and never fails the preflight (OHB-137)", async () => {
    let pending = 0;
    let maxPending = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const enter = async () => {
      pending += 1;
      maxPending = Math.max(maxPending, pending);
      await gate;
      pending -= 1;
    };
    const catalog = { provider: "xai", model: "grok-4", providers: [] } as unknown as HermesModelOptions;
    const done = gatherIndependentPreflight(new RunTrace(), {
      toolsets: async () => { await enter(); return []; },
      toolsetScope: async () => { await enter(); return "runtime" as const; },
      ensureSession: async () => undefined,
      modelCatalog: async () => { await enter(); return catalog; },
    });
    await Bun.sleep(0);
    expect(maxPending).toBe(3);
    release();
    const preflight = await done;
    expect(await preflight.modelCatalog).toBe(catalog);

    const down = await gatherIndependentPreflight(new RunTrace(), {
      toolsets: async () => [],
      toolsetScope: async () => "runtime" as const,
      ensureSession: async () => undefined,
      modelCatalog: async () => { throw new Error("catalogue down"); },
    });
    expect(await down.modelCatalog).toBeNull();
  });

  test("un inventaire absent, interdit ou en erreur ne crée aucune session", async () => {
    for (const inventory of [null, [{ name: "cronjob", label: "Cron", description: null, configured: true, enabled: true, tools: [] }]]) {
      const trace = new RunTrace();
      let sessionsCalled = 0;
      let probes = 0;
      await expect(gatherIndependentPreflight(trace, {
        toolsets: async () => inventory,
        toolsetScope: async () => "runtime" as const,
        ensureSession: async () => { sessionsCalled += 1; },
        modelCatalog: async () => null,
        replayProbe: async () => { probes += 1; return true; },
      })).rejects.toThrow();
      expect(sessionsCalled).toBe(0);
      expect(probes).toBe(0);
      expect(trace.summary().spans["preflight.ensure_session"]).toBeUndefined();
    }
    let sessionsCalled = 0;
    await expect(gatherIndependentPreflight(new RunTrace(), {
      toolsets: async () => { throw new Error("inventory unavailable"); },
      toolsetScope: async () => "runtime" as const,
      ensureSession: async () => { sessionsCalled += 1; },
    })).rejects.toThrow("inventory unavailable");
    expect(sessionsCalled).toBe(0);
  });

  test("a cached inventory still meets the gate: a forbidden toolset blocks every run (OHB-138)", async () => {
    resetHermesPreflightCache();
    let reads = 0;
    const client = new HermesClient({
      profile: "nova",
      transport: {
        kind: "direct",
        send: async () => {
          reads += 1;
          return Response.json({ data: [{ name: "cronjob", label: "Cron", enabled: true, configured: true, tools: [] }] });
        },
      },
    });
    const context = {
      organizationId: "org-gate",
      runtimeId: "rt-gate",
      reachability: "connector" as const,
      linkConnectedAt: "2026-10-06T08:00:00.000Z",
      toolsetEpoch: "7",
    };
    for (let run = 0; run < 2; run += 1) {
      let sessionsCalled = 0;
      const trace = new RunTrace();
      await expect(gatherIndependentPreflight(trace, {
        toolsets: () => preflightToolsets(client, context),
        toolsetScope: async () => "runtime" as const,
        ensureSession: async () => { sessionsCalled += 1; },
      })).rejects.toThrow();
      expect(sessionsCalled).toBe(0);
      expect(typeof trace.summary().spans["preflight.toolsets"]).toBe("number");
    }
    // The second run was served from the cache and still refused.
    expect(reads).toBe(1);
    // A direct runtime, or a context without an epoch, always reads live.
    await preflightToolsets(client, { ...context, reachability: "direct" }).catch(() => null);
    await preflightToolsets(client, { ...context, toolsetEpoch: null }).catch(() => null);
    expect(reads).toBe(3);
    resetHermesPreflightCache();
  });

  test("un profil absent de l'hôte est nommé comme tel, pas comme un inventaire manquant", async () => {
    let sessionsCalled = 0;
    const failure = await gatherIndependentPreflight(new RunTrace(), {
      toolsets: async () => null,
      toolsetScope: async () => "runtime" as const,
      ensureSession: async () => { sessionsCalled += 1; },
      missingProfile: () => missingRunProfile({ probeProfileIsolation: async () => "missing" as const }, { hermesProfile: "nova" }),
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "HERMES_PROFILE_MISSING" });
    expect(String((failure as Error).message)).toContain("« nova »");
    expect(sessionsCalled).toBe(0);
    expect(await missingRunProfile({ probeProfileIsolation: async () => "isolated" as const }, { hermesProfile: "nova" })).toBeNull();
    expect(await missingRunProfile({ probeProfileIsolation: async () => { throw new Error("down"); } }, { hermesProfile: "nova" })).toBeNull();
    expect(await missingRunProfile({ probeProfileIsolation: async () => "missing" as const }, { hermesProfile: "nova", reachability: "direct" })).toBeNull();
  });
});
