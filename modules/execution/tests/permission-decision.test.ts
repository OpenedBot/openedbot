import { describe, expect, test } from "bun:test";
import { workerMayApproveGate } from "@openedbot/roster/domain/editor-directives";
import {
  commandMatchesBlocklist,
  decidePermission,
  effectivePermissionMode,
  humanChoiceStillAllowed,
  unattendedDecision,
  type PermissionCeiling,
  type PermissionDecision,
  type PermissionGate,
  type PermissionPolicy,
} from "../src/domain/permission-decision";
import type { GateDescriptor } from "../src/domain/gate-identity";
import { YOLO_DEFAULT_PROTECT } from "../src/domain/yolo-hardline";

const CHOICES = ["once", "session", "always", "deny"];
const DIGEST = "0".repeat(64);

function plugin(toolKey: string, descriptor: Partial<GateDescriptor>, choices = CHOICES): PermissionGate {
  return {
    kind: "plugin_tool",
    toolKey,
    descriptor: { tool: toolKey, deletes: "no", opaque: false, digest: DIGEST, args: {}, ...descriptor },
    command: null,
    choices,
  };
}

function terminal(command: string | null, choices = CHOICES): PermissionGate {
  return { kind: "terminal_danger", toolKey: null, descriptor: null, command, choices };
}

const GATES: Record<string, PermissionGate> = {
  write: plugin("write_file", { args: { path: "notes/todo.md", size: 4 } }),
  writeSensitive: plugin("write_file", { args: { path: "/root/.ssh/authorized_keys", size: 4 } }),
  writeEmpties: plugin("write_file", { deletes: "yes", args: { path: "notes/todo.md", size: 0 } }),
  patchDeletes: plugin("patch", { deletes: "yes", args: { paths: ["src/a.py"], ops: ["delete"] } }),
  patchEnv: plugin("patch", { args: { paths: ["src/a.py", "app/.env"], ops: ["update"] } }),
  mcp: plugin("mcp:linear:create_issue", { deletes: "unknown", args: { server: "linear", tool: "create_issue", arguments: {} } }),
  executeCode: plugin("execute_code", { deletes: "unknown", opaque: true, args: { language: "python", size: 12 } }),
  cronjob: plugin("cronjob", { deletes: "unknown", args: {} }),
  writeNoOnce: plugin("write_file", { args: { path: "notes/todo.md", size: 4 } }, ["deny"]),
  chmod: terminal("chmod -R 777 build"),
  rm: terminal("rm -rf ./build"),
  rmRoot: terminal("rm -rf /"),
  push: terminal("git push --force origin main"),
  sudoPush: terminal("FOO=1 sudo /usr/bin/git push --force"),
  unreadable: terminal(null),
  unbalanced: terminal("echo 'unterminated && git push --force"),
  unknown: { kind: "unknown", toolKey: null, descriptor: null, command: null, choices: CHOICES },
};

const MODES = ["manual", "plan", "auto", "bypass", "superuser"];
const CEILINGS: Array<PermissionCeiling | null> = [null, "manual", "auto", "bypass"];
const TOOL_POLICIES = [null, "inherit", "always", "ask", "block", "bogus"];
const BLOCKLISTS: string[][] = [[], ["git push"]];
const BOOLS = [false, true];

type Row = { gate: string; policy: PermissionPolicy; decision: PermissionDecision };

function* everyRow(): Generator<Row> {
  for (const gate of Object.keys(GATES)) for (const mode of MODES) for (const ceiling of CEILINGS)
    for (const enforceReview of BOOLS) for (const reviewProven of BOOLS) for (const toolPolicy of TOOL_POLICIES)
      for (const grantActive of BOOLS) for (const terminalAlways of BOOLS) for (const commandBlocklist of BLOCKLISTS) {
        const policy = { mode, ceiling, enforceReview, reviewProven, toolPolicy, grantActive, terminalAlways, commandBlocklist };
        yield { gate, policy, decision: decidePermission(GATES[gate]!, policy) };
      }
}

const ROWS = [...everyRow()];
const RANK = { deny: 0, human: 1, review: 2, once: 3 } as const;
const WRITE_GATES = new Set(["write", "writeSensitive", "writeEmpties", "patchDeletes", "patchEnv", "mcp", "executeCode", "cronjob", "writeNoOnce"]);
const BLOCKLISTED_OR_UNREADABLE = new Set(["push", "sudoPush", "unreadable", "unbalanced"]);

function isForbidden(row: Row): boolean {
  const plug = WRITE_GATES.has(row.gate);
  const block = plug && row.policy.toolPolicy === "block";
  return block
    || (plug && row.policy.mode === "plan")
    || row.gate === "cronjob"
    || (row.policy.commandBlocklist.length > 0 && BLOCKLISTED_OR_UNREADABLE.has(row.gate));
}

describe("permission pipeline, every combination", () => {
  test("covers the whole product of the dimensions", () => {
    expect(ROWS.length).toBe(Object.keys(GATES).length * 5 * 4 * 2 * 2 * 6 * 2 * 2 * 2);
  });

  test("an interdiction is a deny, whatever the rights", () => {
    for (const row of ROWS) {
      if (isForbidden(row)) expect({ row: row.gate, ...row.decision }).toMatchObject({ outcome: "deny", stage: "forbidden" });
      else expect(row.decision.outcome).not.toBe("deny");
    }
  });

  test("the floor goes to a human in every mode, bypass included", () => {
    for (const row of ROWS) {
      if (isForbidden(row)) continue;
      if (["writeSensitive", "patchEnv", "rmRoot", "unreadable", "unknown", "writeNoOnce"].includes(row.gate)) {
        expect({ row: row.gate, ...row.decision }).toMatchObject({ outcome: "human", stage: "floor" });
      }
    }
  });

  test("a gate without a once choice is never answered automatically", () => {
    for (const row of ROWS) {
      if (!GATES[row.gate]!.choices.includes("once")) expect(row.decision.outcome).not.toBe("once");
    }
  });

  test("once only in bypass, or in auto through a pre-approval without enforce_review", () => {
    for (const row of ROWS) {
      if (row.decision.outcome !== "once") continue;
      const mode = row.decision.effectiveMode;
      expect(mode === "bypass" || (mode === "auto" && !row.policy.enforceReview)).toBe(true);
    }
  });

  test("manual and plan never answer automatically, review lives only in auto", () => {
    for (const row of ROWS) {
      const mode = row.decision.effectiveMode;
      if (mode === "manual" || mode === "plan") expect(["deny", "human"]).toContain(row.decision.outcome);
      if (row.decision.outcome === "review") expect(mode).toBe("auto");
    }
  });

  test("a deletion or an opaque operation goes to a human outside bypass", () => {
    for (const row of ROWS) {
      if (isForbidden(row) || row.decision.stage === "floor" || row.decision.effectiveMode === "bypass") continue;
      if (["writeEmpties", "patchDeletes", "mcp", "executeCode", "rm"].includes(row.gate)) expect(row.decision.outcome).toBe("human");
    }
  });

  test("a right never makes a decision stricter", () => {
    for (const row of ROWS) {
      const looser = decidePermission(GATES[row.gate]!, { ...row.policy, grantActive: true, terminalAlways: true });
      expect(RANK[looser.outcome]).toBeGreaterThanOrEqual(RANK[row.decision.outcome]);
    }
  });

  test("a lowered mode always says why, an unlowered one never does", () => {
    for (const row of ROWS) {
      const stored = ["plan", "auto", "bypass"].includes(row.policy.mode ?? "") ? row.policy.mode : "manual";
      const effective = effectivePermissionMode(row.policy);
      expect(effective.mode).toBe(row.decision.effectiveMode);
      if (effective.mode === stored) expect(effective.reason).toBeNull();
      else expect(["ceiling", "enforce_review", "review_unproven"]).toContain(effective.reason!);
    }
  });

  test("the effective mode never exceeds the ceiling, enforce_review or an unproven reviewer", () => {
    for (const row of ROWS) {
      const mode = row.decision.effectiveMode;
      if (row.policy.mode === "plan") { expect(mode).toBe("plan"); continue; }
      if (row.policy.ceiling === "manual") expect(mode).toBe("manual");
      if (row.policy.ceiling === "auto" || row.policy.enforceReview) expect(mode).not.toBe("bypass");
      if (!row.policy.reviewProven) expect(mode).not.toBe("auto");
    }
  });
});

describe("permission pipeline, named rows", () => {
  const base: PermissionPolicy = { mode: "manual", ceiling: null, enforceReview: false, reviewProven: true, toolPolicy: null, grantActive: false, terminalAlways: false, commandBlocklist: [] };
  const decide = (gate: keyof typeof GATES, policy: Partial<PermissionPolicy>) => decidePermission(GATES[gate]!, { ...base, ...policy });

  test.each([
    ["write", { mode: "manual" }, "human", "human"],
    ["write", { mode: "auto" }, "review", "review"],
    ["write", { mode: "auto", reviewProven: false }, "human", "human"],
    ["write", { mode: "auto", grantActive: true }, "once", "grant"],
    ["write", { mode: "auto", toolPolicy: "always" }, "once", "tool_policy"],
    ["write", { mode: "auto", toolPolicy: "always", enforceReview: true }, "review", "review"],
    ["write", { mode: "manual", toolPolicy: "always" }, "human", "human"],
    ["write", { mode: "bypass" }, "once", "full"],
    ["write", { mode: "bypass", toolPolicy: "ask" }, "human", "tool_policy"],
    ["write", { mode: "bypass", toolPolicy: "bogus" }, "human", "tool_policy"],
    ["write", { mode: "bypass", toolPolicy: "block", grantActive: true }, "deny", "forbidden"],
    ["write", { mode: "bypass", ceiling: "auto", reviewProven: false }, "human", "human"],
    ["write", { mode: "plan" }, "deny", "forbidden"],
    ["writeSensitive", { mode: "bypass", grantActive: true, toolPolicy: "always" }, "human", "floor"],
    ["patchDeletes", { mode: "auto", grantActive: true }, "human", "deletion"],
    ["patchDeletes", { mode: "bypass" }, "once", "full"],
    ["mcp", { mode: "auto", grantActive: true }, "human", "deletion"],
    ["executeCode", { mode: "auto", grantActive: true }, "human", "opaque"],
    ["executeCode", { mode: "bypass" }, "once", "full"],
    ["cronjob", { mode: "bypass" }, "deny", "forbidden"],
    ["chmod", { mode: "auto", terminalAlways: true }, "once", "grant"],
    ["chmod", { mode: "auto", grantActive: true }, "review", "review"],
    ["rm", { mode: "auto", terminalAlways: true }, "human", "deletion"],
    ["rm", { mode: "bypass" }, "once", "full"],
    ["rmRoot", { mode: "bypass", terminalAlways: true }, "human", "floor"],
    ["push", { mode: "bypass", terminalAlways: true, commandBlocklist: ["git push"] }, "deny", "forbidden"],
    ["sudoPush", { mode: "bypass", commandBlocklist: ["git push --force"] }, "deny", "forbidden"],
    ["unbalanced", { mode: "bypass", commandBlocklist: ["npm publish"] }, "deny", "forbidden"],
    ["chmod", { mode: "plan" }, "human", "human"],
    ["unknown", { mode: "bypass" }, "human", "floor"],
  ] as const)("%s %o -> %s (%s)", (gate, policy, outcome, stage) => {
    expect(decide(gate, policy as Partial<PermissionPolicy>)).toMatchObject({ outcome, stage });
  });

  test.each([
    [{ mode: "bypass", ceiling: "manual" }, "manual", "ceiling"],
    [{ mode: "bypass", enforceReview: true }, "auto", "enforce_review"],
    [{ mode: "auto", reviewProven: false }, "manual", "review_unproven"],
    [{ mode: "bypass", ceiling: "auto", reviewProven: false }, "manual", "review_unproven"],
  ] as const)("the downgrade %o is named: %s (%s)", (policy, mode, reason) => {
    expect(effectivePermissionMode({ ...base, ...policy })).toEqual({ mode, reason });
    expect(decide("write", policy as Partial<PermissionPolicy>)).toMatchObject({ effectiveMode: mode });
  });

  test("an unknown stored mode is manual", () => {
    expect(effectivePermissionMode({ mode: "superuser", ceiling: null, enforceReview: false, reviewProven: true })).toEqual({ mode: "manual", reason: null });
  });

  test("a human once is re-checked against the interdictions only", () => {
    expect(humanChoiceStillAllowed(GATES.write!, { ...base, mode: "plan" })).toEqual({ allowed: false, reason: "plan_write" });
    expect(humanChoiceStillAllowed(GATES.writeSensitive!, { ...base, mode: "manual" })).toEqual({ allowed: true });
    expect(humanChoiceStillAllowed(GATES.push!, { ...base, commandBlocklist: ["git push"] })).toEqual({ allowed: false, reason: "command_blocklisted" });
  });

  test("blocklist entries match word prefixes of each segment", () => {
    expect(commandMatchesBlocklist("cd repo && git push origin", ["git push"])).toBe(true);
    expect(commandMatchesBlocklist("git pushd", ["git push"])).toBe(false);
    expect(commandMatchesBlocklist("echo git push", ["git push"])).toBe(false);
    expect(commandMatchesBlocklist("echo 'open", ["git push"])).toBeNull();
  });
});

describe("a run nobody attends (PERM2-9), every combination", () => {
  test("never wider than an attended run, never a person's wait", () => {
    for (const row of ROWS) {
      const attended = unattendedDecision(row.decision, false);
      const alone = unattendedDecision(row.decision, true);
      expect(attended).toEqual(row.decision);
      expect(RANK[alone.outcome]).toBeLessThanOrEqual(RANK[row.decision.outcome]);
      expect(alone.outcome).not.toBe("human");
      expect(alone.effectiveMode).toBe(row.decision.effectiveMode);
    }
  });

  test("only a person's wait changes, into a refusal that names what held it", () => {
    for (const row of ROWS) {
      const alone = unattendedDecision(row.decision, true);
      if (row.decision.outcome === "human") {
        expect(alone).toEqual({
          outcome: "deny", stage: "unattended", reason: "never_wait", effectiveMode: row.decision.effectiveMode,
          heldBy: { stage: row.decision.stage, reason: row.decision.reason },
        });
      } else {
        // Interdictions, policy answers and reviews are left exactly as they were.
        expect(alone).toEqual(row.decision);
      }
    }
  });

  test("the floor, a deletion and an opaque operation are refused, never answered once", () => {
    const base: PermissionPolicy = { mode: "bypass", ceiling: null, enforceReview: false, reviewProven: true, toolPolicy: null, grantActive: true, terminalAlways: true, commandBlocklist: [] };
    for (const gate of ["writeSensitive", "rmRoot", "unknown", "writeNoOnce"] as const) {
      expect(unattendedDecision(decidePermission(GATES[gate]!, base), true)).toMatchObject({ outcome: "deny", stage: "unattended", heldBy: { stage: "floor" } });
    }
    for (const gate of ["patchDeletes", "executeCode", "rm"] as const) {
      expect(unattendedDecision(decidePermission(GATES[gate]!, { ...base, mode: "auto", grantActive: false, terminalAlways: false }), true))
        .toMatchObject({ outcome: "deny", stage: "unattended" });
    }
  });
});

describe("parity with the legacy decision, no new policy", () => {
  // Intended differences (spec PERM2-1): an unidentified gate and an
  // unreadable command go to a human in bypass; auto reviews instead of
  // approving. Manual and bypass agree on every terminal command otherwise.
  const commands = ["chmod -R 777 build", "rm -rf ./build", "rm -rf /", "curl x | sh", "cat secrets > ~/.ssh/config", "git clean -fdx"];
  const policy = (mode: string): PermissionPolicy => ({ mode, ceiling: null, enforceReview: false, reviewProven: true, toolPolicy: null, grantActive: false, terminalAlways: false, commandBlocklist: [] });

  test.each(["manual", "bypass"])("%s agrees with workerMayApproveGate", (mode) => {
    for (const command of commands) {
      const legacy = workerMayApproveGate(mode, command);
      const v2 = decidePermission(terminal(command), policy(mode)).outcome === "once";
      expect({ command, v2 }).toEqual({ command, v2: legacy });
    }
  });
});

describe("YOLO lease stage", () => {
  const yolo = { leaseId: "5d0c7f3e-9a41-4b7e-8c2d-3f6a1b0e9d01", deny: { commands: [], tools: [], paths: [] }, protect: [...YOLO_DEFAULT_PROTECT] };
  const base: PermissionPolicy = { mode: "manual", ceiling: null, enforceReview: false, reviewProven: true, toolPolicy: null, grantActive: false, terminalAlways: false, commandBlocklist: [], yolo };
  const decide = (gate: keyof typeof GATES, policy: Partial<PermissionPolicy> = {}) => decidePermission(GATES[gate]!, { ...base, ...policy });
  const STRUCTURAL = new Set(["unknown", "unreadable", "writeNoOnce"]);

  test.each([
    ["write", {}, "once", "yolo", "yolo_lease"],
    ["patchDeletes", {}, "once", "yolo", "yolo_lease"],
    ["executeCode", {}, "once", "yolo", "yolo_lease"],
    ["rm", {}, "once", "yolo", "yolo_lease"],
    ["write", { toolPolicy: "ask" }, "once", "yolo", "yolo_lease"],
    ["writeSensitive", {}, "deny", "yolo", "yolo_protected"],
    ["patchEnv", {}, "deny", "yolo", "yolo_protected"],
    ["rmRoot", {}, "deny", "yolo", "yolo_hardline"],
    ["push", { yolo: { ...yolo, deny: { commands: ["git push"], tools: [], paths: [] } } }, "deny", "yolo", "yolo_denied"],
    ["unbalanced", { yolo: { ...yolo, deny: { commands: ["npm publish"], tools: [], paths: [] } } }, "deny", "yolo", "command_unreadable"],
    ["mcp", { yolo: { ...yolo, deny: { commands: [], tools: ["mcp:linear:create_issue"], paths: [] } } }, "deny", "yolo", "yolo_denied"],
    ["write", { yolo: { ...yolo, deny: { commands: [], tools: [], paths: ["notes"] } } }, "deny", "yolo", "yolo_denied"],
    ["cronjob", {}, "deny", "forbidden", "tool_forbidden"],
    ["write", { toolPolicy: "block" }, "deny", "forbidden", "tool_blocked"],
    ["push", { commandBlocklist: ["git push"] }, "deny", "forbidden", "command_blocklisted"],
    ["unknown", {}, "human", "floor", "gate_unidentified"],
    ["unreadable", {}, "human", "floor", "command_unreadable"],
    ["writeNoOnce", {}, "human", "floor", "no_once_choice"],
    ["write", { mode: "plan" }, "deny", "forbidden", "plan_write"],
    ["chmod", { mode: "plan" }, "human", "human", "plan_mode"],
    ["write", { ceiling: "auto" }, "human", "human", "manual_mode"],
    ["write", { mode: "bypass", enforceReview: true }, "review", "review", "review_enforced"],
    ["write", { yolo: null }, "human", "human", "manual_mode"],
  ] as const)("%s %o -> %s (%s, %s)", (gate, policy, outcome, stage, reason) => {
    expect(decide(gate, policy as Partial<PermissionPolicy>)).toMatchObject({ outcome, stage, reason });
  });

  test("an answer of the lease names it", () => {
    expect(decide("write")).toEqual({ outcome: "once", stage: "yolo", reason: "yolo_lease", effectiveMode: "manual", yoloLeaseId: yolo.leaseId });
    expect(decide("rmRoot")).toMatchObject({ yoloLeaseId: yolo.leaseId });
    expect(decide("cronjob")).not.toHaveProperty("yoloLeaseId");
  });

  test("every combination: an interdiction stays one, the lease answers or refuses, only what cannot be identified falls to the floor", () => {
    for (const row of ROWS) {
      const withLease = decidePermission(GATES[row.gate]!, { ...row.policy, yolo });
      const honored = row.decision.effectiveMode !== "plan" && (row.policy.ceiling === null || row.policy.ceiling === "bypass") && !row.policy.enforceReview;
      if (isForbidden(row)) expect(withLease).toEqual(row.decision);
      else if (!honored) expect(withLease).toEqual(row.decision);
      else if (STRUCTURAL.has(row.gate)) expect({ row: row.gate, ...withLease }).toMatchObject({ outcome: "human", stage: "floor" });
      else expect({ row: row.gate, ...withLease }).toMatchObject({ stage: "yolo" });
      if (["writeSensitive", "patchEnv", "rmRoot"].includes(row.gate)) expect(withLease.outcome).not.toBe("once");
    }
  });

  test("a run nobody attends keeps the lease's answers as they are", () => {
    expect(unattendedDecision(decide("write"), true)).toEqual(decide("write"));
    expect(unattendedDecision(decide("rmRoot"), true)).toEqual(decide("rmRoot"));
  });
});
