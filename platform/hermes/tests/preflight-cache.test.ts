import { afterEach, describe, expect, test } from "bun:test";
import { HermesClient } from "../src/client";
import {
  HERMES_PREFLIGHT_LINK_TTL_MS,
  HERMES_PREFLIGHT_TTL_MS,
  HERMES_TOOLSET_INVENTORY_TTL_MS,
  hermesToolsetFingerprint,
  hermesToolsetInventoryWrite,
  invalidateHermesPreflightCache,
  noteHermesPreflightLink,
  useHermesPreflightCacheStore,
  useHermesToolsetCacheStore,
  type HermesPreflightCacheEntry,
  type HermesPreflightCacheStore,
  type HermesPreflightScope,
  type HermesToolsetCacheEntry,
  type HermesToolsetInventoryScope,
} from "../src/preflight-cache";

const toolset = {
  name: "memory",
  enabled: true,
  configured: true,
  tools: ["memory"],
};

function client(profile: string | null, onSend: (path: string) => Promise<Response> | Response) {
  const calls: string[] = [];
  const hermes = new HermesClient({
    profile,
    transport: {
      kind: "direct",
      send: async (path) => {
        calls.push(path);
        return onSend(path);
      },
    },
  });
  return { hermes, calls };
}

function jsonFeatures(eventReplay: boolean): Response {
  return Response.json({ features: { event_replay: eventReplay } });
}

describe("cache du préflight Hermes (OHB-114)", () => {
  afterEach(() => {
    useHermesPreflightCacheStore(null);
  });

  test("deux organisations, deux runtimes et deux profils ne partagent pas une réponse", async () => {
    const alpha = client("alpha", () => jsonFeatures(true));
    const beta = client("beta", () => jsonFeatures(false));
    const otherOrg = client("alpha", () => jsonFeatures(false));
    const otherRuntime = client("alpha", () => jsonFeatures(false));
    const scope = { organizationId: "org-a", runtimeId: "rt-a" };

    expect(await alpha.hermes.eventReplaySupported(scope)).toBe(true);
    expect(await alpha.hermes.eventReplaySupported(scope)).toBe(true);
    expect(alpha.calls).toHaveLength(1);

    expect(await beta.hermes.eventReplaySupported(scope)).toBe(false);
    expect(await beta.hermes.eventReplaySupported(scope)).toBe(false);
    expect(beta.calls).toHaveLength(1);

    expect(await otherOrg.hermes.eventReplaySupported({ ...scope, organizationId: "org-b" })).toBe(false);
    expect(otherOrg.calls).toHaveLength(1);

    expect(await otherRuntime.hermes.eventReplaySupported({ ...scope, runtimeId: "rt-b" })).toBe(false);
    expect(otherRuntime.calls).toHaveLength(1);

    expect(await alpha.hermes.eventReplaySupported(scope)).toBe(true);
    expect(alpha.calls).toHaveLength(1);
    expect(alpha.calls[0]).toContain("/p/alpha/");
    expect(beta.calls[0]).toContain("/p/beta/");
  });

  test("le TTL expire et une invalidation force la sonde", async () => {
    const probed = client("alpha", () => jsonFeatures(true));
    const start = Date.now();
    const scope: HermesPreflightScope = {
      organizationId: "org-ttl",
      runtimeId: "rt-ttl",
      nowMs: start,
    };

    expect(await probed.hermes.eventReplaySupported(scope)).toBe(true);
    expect(await probed.hermes.eventReplaySupported({ ...scope, nowMs: start + HERMES_PREFLIGHT_TTL_MS - 1 })).toBe(true);
    expect(probed.calls).toHaveLength(1);

    expect(await probed.hermes.eventReplaySupported({ ...scope, nowMs: start + HERMES_PREFLIGHT_TTL_MS })).toBe(true);
    expect(probed.calls).toHaveLength(2);

    invalidateHermesPreflightCache({ organizationId: "org-ttl", runtimeId: "rt-ttl" });
    expect(await probed.hermes.eventReplaySupported(scope)).toBe(true);
    expect(probed.calls).toHaveLength(3);
  });

  test("invalider un profil laisse l'autre, un hello jette tout le runtime", async () => {
    const alpha = client("alpha", () => jsonFeatures(true));
    const beta = client("beta", () => jsonFeatures(true));
    const scope = { organizationId: "org-inv", runtimeId: "rt-inv", linkConnectedAt: "2026-10-03T12:00:00.000Z" };

    expect(await alpha.hermes.eventReplaySupported(scope)).toBe(true);
    expect(await beta.hermes.eventReplaySupported(scope)).toBe(true);

    invalidateHermesPreflightCache({ organizationId: "org-inv", runtimeId: "rt-inv", profile: "alpha" });
    expect(await beta.hermes.eventReplaySupported(scope)).toBe(true);
    expect(beta.calls).toHaveLength(1);
    expect(await alpha.hermes.eventReplaySupported(scope)).toBe(true);
    expect(alpha.calls).toHaveLength(2);

    noteHermesPreflightLink({
      organizationId: "org-inv",
      runtimeId: "rt-inv",
      linkConnectedAt: "2026-10-03T12:01:00.000Z",
    });
    expect(await alpha.hermes.eventReplaySupported({ ...scope, linkConnectedAt: "2026-10-03T12:01:00.000Z" })).toBe(true);
    expect(await beta.hermes.eventReplaySupported({ ...scope, linkConnectedAt: "2026-10-03T12:01:00.000Z" })).toBe(true);
    expect(alpha.calls).toHaveLength(3);
    expect(beta.calls).toHaveLength(2);

    expect(await alpha.hermes.eventReplaySupported({ ...scope, linkConnectedAt: "2026-10-03T12:01:00.000Z" })).toBe(true);
    expect(alpha.calls).toHaveLength(3);
  });

  test("un toolset ou un modèle différent relit, le même couple non", async () => {
    const probed = client("alpha", () => jsonFeatures(true));
    const scope = {
      organizationId: "org-meta",
      runtimeId: "rt-meta",
      toolsetFingerprint: hermesToolsetFingerprint([toolset]),
      model: "grok-4",
    };
    expect(await probed.hermes.eventReplaySupported(scope)).toBe(true);
    expect(await probed.hermes.eventReplaySupported(scope)).toBe(true);
    expect(probed.calls).toHaveLength(1);

    const changed = hermesToolsetFingerprint([{ ...toolset, enabled: false }]);
    expect(changed).not.toBe(scope.toolsetFingerprint);
    expect(await probed.hermes.eventReplaySupported({ ...scope, toolsetFingerprint: changed })).toBe(true);
    expect(probed.calls).toHaveLength(2);

    expect(await probed.hermes.eventReplaySupported({ ...scope, toolsetFingerprint: changed, model: "gpt-5" })).toBe(true);
    expect(probed.calls).toHaveLength(3);
    expect(await probed.hermes.eventReplaySupported({ ...scope, toolsetFingerprint: changed, model: "gpt-5" })).toBe(true);
    expect(probed.calls).toHaveLength(3);
  });

  test("une sonde en erreur est fail-closed et n'est pas mémorisée", async () => {
    let mode: "down" | "up" = "down";
    const probed = client("alpha", () => {
      if (mode === "down") return new Response("nope", { status: 503 });
      return jsonFeatures(true);
    });
    const scope = { organizationId: "org-fail", runtimeId: "rt-fail" };

    expect(await probed.hermes.eventReplaySupported(scope)).toBe(false);
    expect(await probed.hermes.eventReplaySupported(scope)).toBe(false);
    expect(probed.calls).toHaveLength(2);

    mode = "up";
    expect(await probed.hermes.eventReplaySupported(scope)).toBe(true);
    expect(await probed.hermes.eventReplaySupported(scope)).toBe(true);
    expect(probed.calls).toHaveLength(3);
  });

  test("un faux définitif reste en cache, un cache illisible retombe sur la sonde", async () => {
    const quiet = client("alpha", () => Response.json({ features: {} }));
    const scope = { organizationId: "org-false", runtimeId: "rt-false" };
    expect(await quiet.hermes.eventReplaySupported(scope)).toBe(false);
    expect(await quiet.hermes.eventReplaySupported(scope)).toBe(false);
    expect(quiet.calls).toHaveLength(1);

    const map = new Map<string, HermesPreflightCacheEntry>();
    let failRead = false;
    const backing: HermesPreflightCacheStore = {
      get: (key) => {
        if (failRead) throw new Error("cache down");
        return map.get(key);
      },
      set: (key, value) => { map.set(key, value); },
      delete: (key) => { map.delete(key); },
      entries: () => map.entries(),
      clear: () => { map.clear(); },
    };
    useHermesPreflightCacheStore(backing);
    let supported = true;
    const probed = client("alpha", () => jsonFeatures(supported));
    const broken = { organizationId: "org-broken", runtimeId: "rt-broken" };
    expect(await probed.hermes.eventReplaySupported(broken)).toBe(true);
    expect(probed.calls).toHaveLength(1);

    failRead = true;
    supported = false;
    expect(await probed.hermes.eventReplaySupported(broken)).toBe(false);
    expect(probed.calls).toHaveLength(2);
  });

  test("une réponse en cache ne fait pas attendre une sonde froide", async () => {
    const warm = client("neo", () => jsonFeatures(true));
    const scope = { organizationId: "org-warm", runtimeId: "rt-warm" };
    expect(await warm.hermes.eventReplaySupported(scope)).toBe(true);

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
  });

  test("consecutive turns on the same link reuse the answer well past the short TTL (OHB-137)", async () => {
    const probed = client("alpha", () => jsonFeatures(true));
    const start = Date.now();
    const scope: HermesPreflightScope = {
      organizationId: "org-link",
      runtimeId: "rt-link",
      linkConnectedAt: "2026-10-06T08:00:00.000Z",
      toolsetFingerprint: hermesToolsetFingerprint([toolset]),
      model: "grok-4",
      nowMs: start,
    };
    expect(await probed.hermes.eventReplaySupported(scope)).toBe(true);
    // A turn ten minutes later, then one just before the link TTL: no probe.
    expect(await probed.hermes.eventReplaySupported({ ...scope, nowMs: start + 10 * 60_000 })).toBe(true);
    expect(await probed.hermes.eventReplaySupported({ ...scope, nowMs: start + HERMES_PREFLIGHT_LINK_TTL_MS - 1 })).toBe(true);
    expect(probed.calls).toHaveLength(1);
    expect(HERMES_PREFLIGHT_LINK_TTL_MS).toBeGreaterThan(HERMES_PREFLIGHT_TTL_MS);
  });

  test("a new link instant in the scope probes again (OHB-137)", async () => {
    let supported = true;
    const probed = client("alpha", () => jsonFeatures(supported));
    const scope: HermesPreflightScope = {
      organizationId: "org-hello",
      runtimeId: "rt-hello",
      linkConnectedAt: "2026-10-06T08:00:00.000Z",
    };
    expect(await probed.hermes.eventReplaySupported(scope)).toBe(true);
    expect(await probed.hermes.eventReplaySupported(scope)).toBe(true);
    expect(probed.calls).toHaveLength(1);

    // The connector restarted without its journal: the new hello must not be
    // served the previous session's answer.
    supported = false;
    const rehello = { ...scope, linkConnectedAt: "2026-10-06T09:30:00.000Z" };
    expect(await probed.hermes.eventReplaySupported(rehello)).toBe(false);
    expect(probed.calls).toHaveLength(2);
    expect(await probed.hermes.eventReplaySupported(rehello)).toBe(false);
    expect(probed.calls).toHaveLength(2);
  });

  test("l'empreinte ignore l'ordre et distingue un inventaire absent", () => {
    const left = hermesToolsetFingerprint([
      { name: "skills", enabled: true, configured: false, tools: ["b", "a"] },
      toolset,
    ]);
    const right = hermesToolsetFingerprint([
      { ...toolset, tools: ["memory"] },
      { name: "skills", enabled: true, configured: false, tools: ["a", "b"] },
    ]);
    expect(left).toBe(right);
    expect(hermesToolsetFingerprint(null)).not.toBe(hermesToolsetFingerprint([]));
  });
});

describe("toolset inventory reused across runs on one link (OHB-138)", () => {
  afterEach(() => {
    useHermesToolsetCacheStore(null);
  });

  const inventoryBody = { data: [{ name: "memory", label: "Memory", enabled: true, configured: true, tools: ["memory"] }] };
  const base: HermesToolsetInventoryScope = {
    organizationId: "org-tools",
    runtimeId: "rt-tools",
    linkConnectedAt: "2026-10-06T08:00:00.000Z",
    toolsetEpoch: "4",
  };

  test("a warm entry serves the next run on the same link, profile and epoch", async () => {
    const alpha = client("alpha", () => Response.json(inventoryBody));
    const beta = client("beta", () => Response.json(inventoryBody));
    const first = await alpha.hermes.cachedToolsets(base);
    expect(first?.map((entry) => entry.name)).toEqual(["memory"]);
    const second = await alpha.hermes.cachedToolsets(base);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(alpha.calls).toEqual(["/p/alpha/v1/toolsets"]);
    // Another profile never shares the entry.
    await beta.hermes.cachedToolsets(base);
    expect(beta.calls).toHaveLength(1);
  });

  test("a bumped toolset epoch re-reads", async () => {
    const probed = client("alpha", () => Response.json(inventoryBody));
    await probed.hermes.cachedToolsets(base);
    await probed.hermes.cachedToolsets({ ...base, toolsetEpoch: "5" });
    expect(probed.calls).toHaveLength(2);
    await probed.hermes.cachedToolsets({ ...base, toolsetEpoch: "5" });
    expect(probed.calls).toHaveLength(2);
  });

  test("a new link instant re-reads", async () => {
    const probed = client("alpha", () => Response.json(inventoryBody));
    await probed.hermes.cachedToolsets(base);
    await probed.hermes.cachedToolsets({ ...base, linkConnectedAt: "2026-10-06T09:30:00.000Z" });
    expect(probed.calls).toHaveLength(2);
  });

  test("an entry older than the TTL re-reads", async () => {
    const probed = client("alpha", () => Response.json(inventoryBody));
    const start = Date.now();
    await probed.hermes.cachedToolsets({ ...base, nowMs: start });
    await probed.hermes.cachedToolsets({ ...base, nowMs: start + HERMES_TOOLSET_INVENTORY_TTL_MS - 1 });
    expect(probed.calls).toHaveLength(1);
    await probed.hermes.cachedToolsets({ ...base, nowMs: start + HERMES_TOOLSET_INVENTORY_TTL_MS });
    expect(probed.calls).toHaveLength(2);
    expect(HERMES_TOOLSET_INVENTORY_TTL_MS).toBe(60_000);
  });

  test("a cache read error and an absent inventory both read live", async () => {
    const map = new Map<string, HermesToolsetCacheEntry>();
    let failRead = false;
    useHermesToolsetCacheStore({
      get: (key) => {
        if (failRead) throw new Error("cache down");
        return map.get(key);
      },
      set: (key, value) => { map.set(key, value); },
      delete: (key) => { map.delete(key); },
      entries: () => map.entries(),
      clear: () => { map.clear(); },
    });
    const probed = client("alpha", () => Response.json(inventoryBody));
    await probed.hermes.cachedToolsets(base);
    failRead = true;
    expect((await probed.hermes.cachedToolsets(base))?.map((entry) => entry.name)).toEqual(["memory"]);
    expect(probed.calls).toHaveLength(2);

    const absent = client("ghost", () => new Response("not found", { status: 404 }));
    expect(await absent.hermes.cachedToolsets(base)).toBeNull();
    expect(await absent.hermes.cachedToolsets(base)).toBeNull();
    expect(absent.calls).toHaveLength(2);
  });

  test("only relayed inventory writes call for an epoch bump", () => {
    for (const [method, path] of [
      ["POST", "/hermes-setup/toolsets/web"],
      ["POST", "/hermes-setup/profiles/nova/toolsets/web"],
      ["POST", "/hermes-setup/mcp/servers"],
      ["DELETE", "/hermes-setup/mcp/servers/linear"],
      ["POST", "/hermes-setup/mcp/catalog/linear"],
      ["POST", "/hermes-setup/mcp/servers/linear/oauth/callback"],
      ["POST", "/hermes-setup/profiles/nova/mcp/servers/linear"],
      ["POST", "/hermes-setup/gateway/restart"],
      ["GET", "/hermes-setup/gateway/restart/job-1"],
      ["POST", "/hermes-setup/profiles"],
      ["DELETE", "/hermes-setup/profiles/nova"],
      ["POST", "/p/nova/hermes-setup/toolsets/web"],
    ] as const) {
      expect(hermesToolsetInventoryWrite(method, path)).toBe(true);
    }
    for (const [method, path] of [
      ["GET", "/v1/toolsets"],
      ["GET", "/hermes-setup/toolsets"],
      ["GET", "/hermes-setup/mcp/servers"],
      ["POST", "/hermes-setup/mcp/servers/linear/oauth"],
      ["DELETE", "/hermes-setup/mcp/servers/linear/oauth/session-1"],
      ["POST", "/v1/runs"],
      ["POST", "/hermes-setup/profiles/nova/model"],
      ["POST", "/hermes-setup/profiles/nova/memory"],
    ] as const) {
      expect(hermesToolsetInventoryWrite(method, path)).toBe(false);
    }
  });
});
