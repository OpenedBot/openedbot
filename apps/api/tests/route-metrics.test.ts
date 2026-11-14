import { describe, expect, test } from "bun:test";
import { hostMetricPath, relayMetricPath } from "../src/interfaces/http/route-metrics";
import { ApiRuntimeMetrics, TrafficCounters } from "../src/routes/platform/metrics-routes";

const RUNTIME = "eff1a0ff-9ab4-4e93-8de2-fa1ce042bf41";

describe("relayMetricPath", () => {
  test("folds profile, run, session and named sub-resources", () => {
    const at = (path: string) => relayMetricPath(`/internal/runtime-links/${RUNTIME}/proxy${path}`)?.path;
    expect(at("/hermes-setup/profiles/atlas/approval-policy")).toBe("/hermes-setup/profiles/:profile/approval-policy");
    expect(at("/p/openedbot-control-f11dd8a7db03/health")).toBe("/p/:profile/health");
    expect(at("/p/atlas/v1/runs/run_123/events")).toBe("/p/:profile/v1/runs/:run/events");
    expect(at("/hermes-setup/profiles/atlas/toolsets/web")).toBe("/hermes-setup/profiles/:profile/toolsets/:name");
    expect(at("/hermes-setup/mcp/servers")).toBe("/hermes-setup/mcp/servers");
    expect(relayMetricPath(`/internal/runtime-links/${RUNTIME}/proxy/v1/models`)?.runtimeId).toBe(RUNTIME);
    expect(relayMetricPath("/api/runtime")).toBeNull();
  });
});

describe("TrafficCounters", () => {
  test("counts, sums and keeps the max per key, sorted by count", () => {
    const counters = new TrafficCounters();
    counters.record("a", 10);
    counters.record("b", 5);
    counters.record("b", 15);
    expect(counters.snapshot()).toEqual([
      { key: "b", count: 2, totalMs: 20, maxMs: 15 },
      { key: "a", count: 1, totalMs: 10, maxMs: 10 },
    ]);
  });

  test("past the bound, new keys fold into (other)", () => {
    const counters = new TrafficCounters(2);
    for (const key of ["a", "b", "c", "d", "a"]) counters.record(key, 1);
    expect(counters.snapshot().map((counter) => [counter.key, counter.count])).toEqual([["a", 2], ["(other)", 2], ["b", 1]]);
  });
});

describe("ApiRuntimeMetrics", () => {
  test("route keys carry the method, pattern and status class; host calls the runtime", () => {
    const metrics = new ApiRuntimeMetrics();
    metrics.recordRoute("GET", "/api/runtime", 200, 8);
    metrics.recordRoute("GET", "/api/runtime", 304, 2);
    metrics.recordHostCall({ method: "GET", path: "/hermes-setup/profiles/atlas", runtimeId: RUNTIME, status: 503, durationMs: 3 });
    metrics.recordHostCall({ method: "GET", path: "/hermes-setup/profiles/veille", runtimeId: RUNTIME, status: null, durationMs: 60_000 });
    const snapshot = metrics.snapshot();
    expect(snapshot.routes.map((counter) => counter.key)).toEqual(["GET /api/runtime 2xx", "GET /api/runtime 3xx"]);
    expect(snapshot.hostCalls.map((counter) => counter.key)).toEqual([
      `GET /hermes-setup/profiles/:profile 5xx ${RUNTIME}`,
      `GET /hermes-setup/profiles/:profile failed ${RUNTIME}`,
    ]);
  });

  test("hostMetricPath drops the query and folds names", () => {
    expect(hostMetricPath("/hermes-setup/profiles/atlas/toolsets?x=1")).toBe("/hermes-setup/profiles/:profile/toolsets");
    expect(hostMetricPath("/v1/models")).toBe("/v1/models");
  });

  // Codex: operation and OAuth session ids made one counter per operation.
  test("hostMetricPath folds every dynamic segment of the allowlist, keeps the fixed ones", () => {
    expect(hostMetricPath("/hermes-setup/profiles/atlas/skills/hub/operations/7f1c2b3a-0000-4000-8000-000000000000"))
      .toBe("/hermes-setup/profiles/:profile/skills/hub/operations/:operation");
    expect(hostMetricPath("/hermes-setup/providers/anthropic/oauth/sess_abc123")).toBe("/hermes-setup/providers/:provider/oauth/:oauth");
    expect(hostMetricPath("/hermes-setup/mcp/servers/linear/oauth/callback")).toBe("/hermes-setup/mcp/servers/:name/oauth/callback");
    expect(hostMetricPath("/hermes-setup/profiles/models")).toBe("/hermes-setup/profiles/models");
    expect(hostMetricPath("/api/sessions/openedbot%3Aabc/messages")).toBe("/api/sessions/:session/messages");
    expect(hostMetricPath("/hermes-setup/a2a/peers/acme.example/token")).toBe("/hermes-setup/a2a/peers/:peer/token");
    expect(hostMetricPath("/hermes-setup/workspace/files/report.pdf")).toBe("/hermes-setup/workspace/files/:file");
    expect(hostMetricPath("/hermes-setup/gateway/restart/op-1")).toBe("/hermes-setup/gateway/restart/:restart");
  });
});
