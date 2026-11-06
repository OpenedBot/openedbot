import { describe, expect, test } from "bun:test";
import { DEFAULT_BOT_TOOLSETS, FORBIDDEN_TOOLSETS } from "@openedbot/runtimes/domain/runtime-contract";
import {
  BASELINE_ENABLED_TOOLSETS,
  BASELINE_GATE_PROOF_MAX_AGE_MS,
  BASELINE_REQUIRED_FEATURES,
  CAPABILITY_BASELINE_VERSION,
  baselineEnabledToolsets,
  baselineGate,
  baselineToolsetPlan,
  baselineToolsetWrites,
} from "../src/domain/capability-baseline";
import { RELAY_FEATURE_PROFILE_BUNDLED_SKILLS, RELAY_FEATURE_PROFILE_CAPABILITIES } from "@openedbot/contracts-connector/features";

/** Every name the tests use, plus the forbidden ones: what a full host accepts to write. */
const SETTABLE = new Set([
  "web", "terminal", "skills", "file", "code_execution", "vision", "image_gen", "todo",
  ...FORBIDDEN_TOOLSETS,
]);
const writesFor = (inventory: Parameters<typeof baselineToolsetWrites>[0]) => baselineToolsetWrites(inventory, SETTABLE);

describe("socle de capacités d'un bot léger", () => {
  test("la version courante, les toolsets du socle et les verbes exigés", () => {
    // Version 2 (operator, 2026-10-25): bots stamped at 1 get the default tools.
    expect(CAPABILITY_BASELINE_VERSION).toBe(2);
    expect([...BASELINE_ENABLED_TOOLSETS]).toEqual(["web", "terminal", "skills"]);
    expect(BASELINE_REQUIRED_FEATURES).toEqual([RELAY_FEATURE_PROFILE_CAPABILITIES, RELAY_FEATURE_PROFILE_BUNDLED_SKILLS]);
    expect(RELAY_FEATURE_PROFILE_BUNDLED_SKILLS).toBe("profile_bundled_skills");
  });

  test("un profil déjà au socle ne reçoit aucune écriture", () => {
    expect(writesFor([
      { name: "web", enabled: true },
      { name: "terminal", enabled: true },
      { name: "skills", enabled: true },
      { name: "file", enabled: false },
      { name: "vision", enabled: false },
    ])).toEqual([]);
  });

  test("un inventaire mixte éteint d'abord, allume ensuite, et `skills` passe en dernier", () => {
    expect(writesFor([
      { name: "skills", enabled: false },
      { name: "file", enabled: true },
      { name: "web", enabled: true },
      { name: "terminal", enabled: false },
      { name: "code_execution", enabled: true },
      { name: "vision", enabled: false },
      { name: "image_gen", enabled: true },
      { name: "todo", enabled: true },
    ])).toEqual([
      { name: "file", enabled: false },
      { name: "code_execution", enabled: false },
      { name: "image_gen", enabled: false },
      { name: "todo", enabled: false },
      { name: "terminal", enabled: true },
      { name: "skills", enabled: true },
    ]);
  });

  test("un toolset interdit listé comme actif est éteint, jamais allumé", () => {
    const writes = writesFor([
      { name: "web", enabled: true },
      ...[...FORBIDDEN_TOOLSETS].map((name) => ({ name, enabled: true })),
      { name: "terminal", enabled: false },
    ]);
    for (const name of FORBIDDEN_TOOLSETS) expect(writes).toContainEqual({ name, enabled: false });
    expect(writes.filter((write) => write.enabled)).toEqual([
      { name: "terminal", enabled: true },
      { name: "skills", enabled: true },
    ]);
    expect(writes.filter((write) => FORBIDDEN_TOOLSETS.has(write.name) && write.enabled)).toEqual([]);
  });

  test("un nom du socle absent de l'inventaire est éteint : il s'allume ; un autre absent est ignoré", () => {
    // L'hôte ne liste souvent que les toolsets actifs (`profile_toolset_flags`).
    expect(writesFor([])).toEqual([
      { name: "web", enabled: true },
      { name: "terminal", enabled: true },
      { name: "skills", enabled: true },
    ]);
    expect(writesFor([
      { name: "web", enabled: true },
      { name: "terminal", enabled: true },
      { name: "skills", enabled: true },
      { name: "file", enabled: false },
    ])).toEqual([]);
  });

  test("un nom que l'hôte ne sait pas écrire n'est jamais touché (bfl, lab 23-10-2026)", () => {
    expect(baselineToolsetWrites([
      { name: "bfl", enabled: true },
      { name: "web", enabled: true },
      { name: "terminal", enabled: true },
      { name: "todo", enabled: true },
    ], new Set(["web", "terminal", "todo"]))).toEqual([{ name: "todo", enabled: false }]);
  });

  test("un nom listé deux fois compte une seule fois", () => {
    expect(writesFor([
      { name: "file", enabled: true },
      { name: "file", enabled: true },
    ])).toEqual([
      { name: "file", enabled: false },
      { name: "web", enabled: true },
      { name: "terminal", enabled: true },
      { name: "skills", enabled: true },
    ]);
  });
});

const NOW = 1_800_000_000_000;
const gateOf = (overrides: Partial<Parameters<typeof baselineGate>[0]> = {}) => baselineGate({
  hostHoldsPolicy: true,
  permissionMode: "manual",
  pipeline: "legacy",
  approvalPolicyMode: "ask_writes",
  approvalPolicyEffectiveAt: new Date(NOW - 60_000),
  ...overrides,
}, NOW);

describe("capability baseline gate and default set (version 2)", () => {
  test("a host policy proven lately in a mode that raises a gate opens the gate", () => {
    expect(gateOf()).toBe("gated");
    expect(gateOf({ permissionMode: "plan", approvalPolicyMode: "block_writes" })).toBe("gated");
    // Under v2 every write of `auto` raises a gate the pipeline answers.
    expect(gateOf({ permissionMode: "auto", pipeline: "v2" })).toBe("gated");
  });

  test("a host without the policy, or a mode that wants no host gate, keeps the light set", () => {
    expect(gateOf({ hostHoldsPolicy: false })).toBe("ungated");
    expect(gateOf({ hostHoldsPolicy: false, approvalPolicyEffectiveAt: null })).toBe("ungated");
    expect(gateOf({ permissionMode: "auto" })).toBe("ungated");
    expect(gateOf({ permissionMode: "bypass", approvalPolicyMode: null, approvalPolicyEffectiveAt: null })).toBe("ungated");
  });

  test("a missing, stale or mismatched proof waits instead of stamping", () => {
    expect(gateOf({ approvalPolicyEffectiveAt: null })).toBe("pending");
    expect(gateOf({ approvalPolicyEffectiveAt: new Date(NOW - BASELINE_GATE_PROOF_MAX_AGE_MS) })).toBe("pending");
    expect(gateOf({ approvalPolicyEffectiveAt: new Date(NOW - BASELINE_GATE_PROOF_MAX_AGE_MS + 1) })).toBe("gated");
    expect(gateOf({ approvalPolicyMode: null })).toBe("pending");
    expect(gateOf({ approvalPolicyMode: "off" })).toBe("pending");
    // `plan` wants `block_writes`; a fresh `ask_writes` proof is not its gate.
    expect(gateOf({ permissionMode: "plan" })).toBe("pending");
  });

  test("behind a gate a bot gets the default tools, the profile-only stores on a proven isolation only", () => {
    expect(baselineEnabledToolsets({ gated: false, isolated: true })).toEqual(BASELINE_ENABLED_TOOLSETS);
    expect(baselineEnabledToolsets({ gated: true, isolated: true })).toEqual(DEFAULT_BOT_TOOLSETS);
    expect(baselineEnabledToolsets({ gated: true, isolated: false }))
      .toEqual(DEFAULT_BOT_TOOLSETS.filter((name) => name !== "memory" && name !== "session_search"));
    for (const isolated of [true, false]) {
      for (const name of ["cronjob", "delegation"]) {
        expect(baselineEnabledToolsets({ gated: true, isolated })).not.toContain(name);
      }
    }
  });

  const FULL = new Set([...SETTABLE, "browser", "tts"]);
  const gatedIsolated = baselineEnabledToolsets({ gated: true, isolated: true });
  const lightBotSince = [
    { name: "web", enabled: true },
    { name: "terminal", enabled: true },
    { name: "skills", enabled: true },
    { name: "tts", enabled: true },
    { name: "file", enabled: false },
  ];

  test("the additive replay of a bot stamped at 1 turns on what is missing and keeps what the operator turned on", () => {
    const plan = baselineToolsetPlan(lightBotSince, FULL, gatedIsolated, { isolated: true, additive: true });
    expect(plan).toEqual({
      writes: [
        { name: "file", enabled: true },
        { name: "code_execution", enabled: true },
        { name: "browser", enabled: true },
        { name: "vision", enabled: true },
        { name: "image_gen", enabled: true },
        { name: "todo", enabled: true },
        { name: "memory", enabled: true },
        { name: "session_search", enabled: true },
      ],
      unavailable: [],
      required: [],
    });
    // The full replay (a recreated profile, version 0) turns the extra one off.
    expect(baselineToolsetPlan(lightBotSince, FULL, gatedIsolated, { isolated: true }).writes[0])
      .toEqual({ name: "tts", enabled: false });
  });

  test("the additive replay still turns off what the run contract refuses on the profile", () => {
    const forbidden = baselineToolsetPlan([
      ...lightBotSince,
      { name: "cronjob", enabled: true },
      { name: "delegation", enabled: true },
    ], FULL, gatedIsolated, { isolated: true, additive: true });
    expect(forbidden.writes.slice(0, 2)).toEqual([
      { name: "cronjob", enabled: false },
      { name: "delegation", enabled: false },
    ]);
    expect(forbidden.writes.filter((write) => FORBIDDEN_TOOLSETS.has(write.name) && write.enabled))
      .toEqual([{ name: "memory", enabled: true }, { name: "session_search", enabled: true }]);
    expect(forbidden.writes).not.toContainEqual({ name: "tts", enabled: false });

    // Off an isolated profile, `memory` is refused: off, never on.
    const shared = baselineToolsetPlan([
      ...lightBotSince,
      { name: "memory", enabled: true },
    ], FULL, baselineEnabledToolsets({ gated: true, isolated: false }), { isolated: false, additive: true });
    expect(shared.writes[0]).toEqual({ name: "memory", enabled: false });
    expect(shared.writes.filter((write) => FORBIDDEN_TOOLSETS.has(write.name) && write.enabled)).toEqual([]);
  });

  test("a wanted toolset the host cannot set is named; one of the light set is required", () => {
    const withoutBrowser = new Set([...FULL].filter((name) => name !== "browser"));
    expect(baselineToolsetPlan(lightBotSince, withoutBrowser, gatedIsolated, { isolated: true, additive: true }))
      .toMatchObject({ unavailable: ["browser"], required: [] });
    const withoutTerminal = new Set([...FULL].filter((name) => name !== "terminal"));
    expect(baselineToolsetPlan([], withoutTerminal, gatedIsolated, { isolated: true }))
      .toMatchObject({ unavailable: ["terminal"], required: ["terminal"] });
  });
});
