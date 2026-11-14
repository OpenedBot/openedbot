import { describe, expect, test } from "bun:test";
import { isRoutineRequest } from "../src/interfaces/http/routine-requests";

const RELAY = "/internal/runtime-links/:runtimeId/proxy/*";
const RUNTIME = "eff1a0ff-9ab4-4e93-8de2-fa1ce042bf41";

describe("isRoutineRequest", () => {
  test("a successful read of a polled route is routine", () => {
    expect(isRoutineRequest({ method: "GET", route: "/api/runtime", path: "/api/runtime", status: 200 })).toBe(true);
    expect(isRoutineRequest({ method: "GET", route: RELAY, path: `/internal/runtime-links/${RUNTIME}/proxy/hermes-setup/profiles`, status: 200 })).toBe(true);
  });

  test("a failed poll, a write or another route is not", () => {
    expect(isRoutineRequest({ method: "GET", route: "/api/runtime", path: "/api/runtime", status: 401 })).toBe(false);
    expect(isRoutineRequest({ method: "GET", route: RELAY, path: `/internal/runtime-links/${RUNTIME}/proxy/hermes-setup/profiles`, status: 503 })).toBe(false);
    expect(isRoutineRequest({ method: "POST", route: RELAY, path: `/internal/runtime-links/${RUNTIME}/proxy/v1/runs`, status: 200 })).toBe(false);
    expect(isRoutineRequest({ method: "GET", route: "/api/bots/:botId", path: "/api/bots/x", status: 200 })).toBe(false);
  });

  // The isolation probe asks a profile nobody owns: 404 is the proof, a 200
  // would mean the gateway does not partition profiles and must stay visible.
  test("the control probe's 404 is routine, its 200 is not", () => {
    const path = `/internal/runtime-links/${RUNTIME}/proxy/p/openedbot-control-f11dd8a7db03/health`;
    expect(isRoutineRequest({ method: "GET", route: RELAY, path, status: 404 })).toBe(true);
    expect(isRoutineRequest({ method: "GET", route: RELAY, path, status: 200 })).toBe(false);
    expect(isRoutineRequest({ method: "GET", route: RELAY, path: `/internal/runtime-links/${RUNTIME}/proxy/p/atlas/health`, status: 404 })).toBe(false);
  });
});
