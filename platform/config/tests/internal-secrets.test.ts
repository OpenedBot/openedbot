import { describe, expect, test } from "bun:test";
import {
  DEV_INTERNAL_SECRETS,
  describeInternalSecrets,
  internalBearer,
  matchInternalBearer,
  readInternalSecrets,
  runKeyCohortAllows,
  runKeySigningSecret,
  runKeyVerifiers,
} from "../src/internal-secrets";

const split = {
  EVENTS_INTERNAL_TOKEN: "e".repeat(64),
  RELAY_INTERNAL_TOKEN: "r".repeat(64),
  INVENTORY_INTERNAL_TOKEN: "i".repeat(64),
  RUN_KEY_SECRET: "k".repeat(64),
};
const LEGACY = "l".repeat(64);

describe("readInternalSecrets", () => {
  test("outside production every role has its own development value, never a shared one", () => {
    const secrets = readInternalSecrets("api", "development", {});
    expect(secrets.roles.events.value).toBe(DEV_INTERNAL_SECRETS.events);
    expect(secrets.roles.relay.value).toBe(DEV_INTERNAL_SECRETS.relay);
    expect(new Set(Object.values(secrets.roles).map((secret) => secret.value)).size).toBe(4);
    expect(secrets.emit).toBe("split");
    expect(secrets.legacy).toBeNull();
  });

  test("a process holds only its roles", () => {
    const gateway = readInternalSecrets("link-gateway", "production", { RELAY_INTERNAL_TOKEN: split.RELAY_INTERNAL_TOKEN, INVENTORY_INTERNAL_TOKEN: split.INVENTORY_INTERNAL_TOKEN });
    expect(Object.keys(gateway.roles).sort()).toEqual(["inventory", "relay"]);
    const worker = readInternalSecrets("worker", "production", { EVENTS_INTERNAL_TOKEN: split.EVENTS_INTERNAL_TOKEN, RELAY_INTERNAL_TOKEN: split.RELAY_INTERNAL_TOKEN, RUN_KEY_SECRET: split.RUN_KEY_SECRET });
    expect(Object.keys(worker.roles).sort()).toEqual(["events", "relay", "runKey"]);
  });

  test("an unmigrated host starts as before: every role falls back on WORKER_INTERNAL_TOKEN", () => {
    const secrets = readInternalSecrets("api", "production", { WORKER_INTERNAL_TOKEN: LEGACY });
    for (const secret of Object.values(secrets.roles)) expect(secret).toEqual({ value: LEGACY, source: "legacy" });
    expect(internalBearer(secrets, "events")).toBe(`Bearer ${LEGACY}`);
    expect(describeInternalSecrets(secrets)).toEqual({
      process: "api", emit: "split", legacyAccepted: true,
      roles: { events: "legacy", relay: "legacy", inventory: "legacy", runKey: "legacy" },
      runKeyPreviousCreatedBefore: null,
    });
  });

  test("production requires every role of the process, without dev values, distinct", () => {
    expect(() => readInternalSecrets("worker", "production", {})).toThrow(/EVENTS_INTERNAL_TOKEN is required/);
    expect(() => readInternalSecrets("api", "production", { ...split, RELAY_INTERNAL_TOKEN: DEV_INTERNAL_SECRETS.relay })).toThrow(/development default/);
    expect(() => readInternalSecrets("api", "production", { WORKER_INTERNAL_TOKEN: "openedbot-worker-dev-token" })).toThrow(/development default/);
    expect(() => readInternalSecrets("api", "production", { ...split, INVENTORY_INTERNAL_TOKEN: split.EVENTS_INTERNAL_TOKEN })).toThrow(/distinct/);
    expect(() => readInternalSecrets("api", "production", { ...split, METRICS_INTERNAL_TOKEN: split.RUN_KEY_SECRET })).toThrow(/METRICS_INTERNAL_TOKEN/);
    expect(() => readInternalSecrets("api", "production", { ...split, WORKER_INTERNAL_TOKEN: split.RELAY_INTERNAL_TOKEN, INTERNAL_TOKENS_EMIT: "split" })).toThrow(/differ from WORKER_INTERNAL_TOKEN/);
  });

  test("the phase is never inferred while both kinds of secret are set in production", () => {
    expect(() => readInternalSecrets("api", "production", { ...split, WORKER_INTERNAL_TOKEN: LEGACY })).toThrow(/INTERNAL_TOKENS_EMIT must be set/);
    expect(() => readInternalSecrets("api", "production", { ...split, INTERNAL_TOKENS_EMIT: "legacy" })).toThrow(/requires WORKER_INTERNAL_TOKEN/);
    expect(() => readInternalSecrets("api", "development", { INTERNAL_TOKENS_EMIT: "both" })).toThrow(/legacy or split/);
  });

  test("run-key previous secret: API only, with its bound, distinct from the current one", () => {
    const before = "2026-11-07T12:00:00.000Z";
    const api = readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: LEGACY, RUN_KEY_PREVIOUS_CREATED_BEFORE: before });
    expect(api.runKeyPrevious).toEqual({ secret: LEGACY, createdBefore: new Date(before) });
    expect(api.legacy).toBeNull();
    expect(() => readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: LEGACY })).toThrow(/set together/);
    for (const bound of ["yesterday", "2026-11-07T12:00:00", "2026-11-07T12:00:00+01:00", "2026-02-30T12:00:00Z", "2026-11-07T24:00:00Z", "2026-11-07"]) {
      expect(() => readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: LEGACY, RUN_KEY_PREVIOUS_CREATED_BEFORE: bound })).toThrow(/UTC instant/);
    }
    expect(readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: LEGACY, RUN_KEY_PREVIOUS_CREATED_BEFORE: "2026-11-07T12:00:00.5Z" }).runKeyPrevious?.createdBefore.toISOString()).toBe("2026-11-07T12:00:00.500Z");
    expect(() => readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: split.RUN_KEY_SECRET, RUN_KEY_PREVIOUS_CREATED_BEFORE: before })).toThrow(/differ/);
    expect(readInternalSecrets("worker", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: LEGACY, RUN_KEY_PREVIOUS_CREATED_BEFORE: before }).runKeyPrevious).toBeNull();
  });
});

describe("bearers", () => {
  test("phase P1 (legacy): emitters send the former secret, verifiers accept both", () => {
    const secrets = readInternalSecrets("api", "production", { ...split, WORKER_INTERNAL_TOKEN: LEGACY, INTERNAL_TOKENS_EMIT: "legacy" });
    expect(internalBearer(secrets, "relay")).toBe(`Bearer ${LEGACY}`);
    expect(matchInternalBearer(secrets, "relay", `Bearer ${LEGACY}`)).toEqual({ ok: true, via: "legacy" });
    expect(matchInternalBearer(secrets, "relay", `Bearer ${split.RELAY_INTERNAL_TOKEN}`)).toEqual({ ok: true, via: "role" });
  });

  test("phase P2 (split): emitters send the role's secret, the former one is still accepted", () => {
    const secrets = readInternalSecrets("api", "production", { ...split, WORKER_INTERNAL_TOKEN: LEGACY, INTERNAL_TOKENS_EMIT: "split" });
    expect(internalBearer(secrets, "events")).toBe(`Bearer ${split.EVENTS_INTERNAL_TOKEN}`);
    expect(matchInternalBearer(secrets, "events", `Bearer ${LEGACY}`)).toEqual({ ok: true, via: "legacy" });
  });

  test("phase P3: only the role's secret; another role's secret is refused everywhere", () => {
    const secrets = readInternalSecrets("api", "production", split);
    expect(matchInternalBearer(secrets, "events", `Bearer ${LEGACY}`)).toEqual({ ok: false });
    for (const role of ["events", "relay", "inventory"] as const) {
      for (const [name, value] of Object.entries(split)) {
        const expected = name.startsWith(role === "events" ? "EVENTS" : role === "relay" ? "RELAY" : "INVENTORY");
        expect(matchInternalBearer(secrets, role, `Bearer ${value}`).ok).toBe(expected);
      }
    }
    expect(matchInternalBearer(secrets, "relay", undefined)).toEqual({ ok: false });
    expect(matchInternalBearer(secrets, "relay", split.RELAY_INTERNAL_TOKEN)).toEqual({ ok: false });
  });
});

describe("run keys", () => {
  test("signed with the former secret under legacy, with the role's secret under split", () => {
    expect(runKeySigningSecret(readInternalSecrets("worker", "production", { ...split, WORKER_INTERNAL_TOKEN: LEGACY, INTERNAL_TOKENS_EMIT: "legacy" }))).toBe(LEGACY);
    expect(runKeySigningSecret(readInternalSecrets("worker", "production", { ...split, WORKER_INTERNAL_TOKEN: LEGACY, INTERNAL_TOKENS_EMIT: "split" }))).toBe(split.RUN_KEY_SECRET);
  });

  test("the previous secret reads only the cohort of runs created before its bound", () => {
    const before = new Date("2026-11-07T12:00:00.000Z");
    const secrets = readInternalSecrets("api", "production", { ...split, RUN_KEY_PREVIOUS_SECRET: LEGACY, RUN_KEY_PREVIOUS_CREATED_BEFORE: before.toISOString() });
    const verifiers = runKeyVerifiers(secrets);
    expect(verifiers.map((verifier) => verifier.via)).toEqual(["role", "previous"]);
    const previous = verifiers[1]!;
    expect(runKeyCohortAllows(previous, new Date(before.getTime() - 1))).toBe(true);
    expect(runKeyCohortAllows(previous, before)).toBe(false);
    expect(runKeyCohortAllows(verifiers[0]!, new Date(before.getTime() + 60_000))).toBe(true);
  });

  test("during the transition the former secret verifies run keys too; never twice the same secret", () => {
    expect(runKeyVerifiers(readInternalSecrets("api", "production", { ...split, WORKER_INTERNAL_TOKEN: LEGACY, INTERNAL_TOKENS_EMIT: "split" })).map((verifier) => verifier.via)).toEqual(["role", "legacy"]);
    expect(runKeyVerifiers(readInternalSecrets("api", "production", { WORKER_INTERNAL_TOKEN: LEGACY })).map((verifier) => verifier.via)).toEqual(["role"]);
  });
});
