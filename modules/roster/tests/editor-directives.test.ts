import { describe, expect, test } from "bun:test";
import { autoApprovesPermission, buildEditorDirectivesBlock, buildPlanTurnBlock, hostApprovalPolicyProven, hostApprovalPolicyRequired, workerMayApproveGate } from "../src/domain/editor-directives";

describe("buildEditorDirectivesBlock", () => {
  test("adds nothing for the defaults when the host enforces approvals", () => {
    expect(buildEditorDirectivesBlock({ label: null, replyLanguage: "auto", permissionMode: "manual", hostEnforcesApprovals: true })).toBe("");
  });

  test("manual mode asks before changes only when the host cannot enforce it", () => {
    expect(buildEditorDirectivesBlock({ permissionMode: "manual" })).toContain("Manual mode: before any change on the server");
    expect(buildEditorDirectivesBlock({ permissionMode: "auto" })).not.toContain("Manual mode");
  });

  test("manual mode treats an explicit request in the current message as the approval", () => {
    const block = buildEditorDirectivesBlock({ permissionMode: "manual" });
    expect(block).toContain("CURRENT message");
    expect(block).toContain("An earlier refusal does not cancel a later explicit request.");
    expect(buildEditorDirectivesBlock({ permissionMode: "manual", hostEnforcesApprovals: true })).not.toContain("CURRENT message");
  });

  test("under v2 with a proven host, auto and bypass learn that a refusal is final", () => {
    const v2 = { permissionPipeline: "v2", hostEnforcesApprovals: true };
    const auto = buildEditorDirectivesBlock({ ...v2, permissionMode: "auto" });
    expect(auto).toContain("Your risky actions are checked before they run");
    expect(auto).not.toContain("stop and ask the operator before anything irreversible");
    expect(auto).toContain("do not try it again");
    expect(buildEditorDirectivesBlock({ ...v2, permissionMode: "bypass" })).toContain("do not try it again");
    expect(buildEditorDirectivesBlock({ ...v2, permissionMode: "manual" })).toBe("");
    // Legacy, or a host not proven: the old auto line, and no refusal line.
    for (const settings of [{ permissionPipeline: "legacy", hostEnforcesApprovals: true }, { permissionPipeline: "v2", hostEnforcesApprovals: false }]) {
      const block = buildEditorDirectivesBlock({ ...settings, permissionMode: "auto" });
      expect(block).toContain("stop and ask the operator before anything irreversible");
      expect(block).not.toContain("do not try it again");
    }
  });

  test("states the role, the reply language and plan mode", () => {
    const block = buildEditorDirectivesBlock({ label: "Security", replyLanguage: "fr", permissionMode: "plan" });
    expect(block.startsWith("## Operator settings")).toBe(true);
    expect(block).toContain("Your role on this team: Security.");
    expect(block).toContain("Always reply in French");
    expect(block).toContain("Plan mode:");
  });

  test("a one-message plan intent carries the same plan rules, scoped to that reply", () => {
    const turn = buildPlanTurnBlock();
    expect(turn.startsWith("## This message only: plan first")).toBe(true);
    expect(turn).toContain("for this reply only");
    for (const line of buildEditorDirectivesBlock({ permissionMode: "plan" }).split("\n").filter((l) => l.startsWith("- Plan mode") || l.startsWith("- Otherwise"))) {
      expect(turn).toContain(line);
    }
  });

  test("ignores an unknown language instead of naming it", () => {
    expect(buildEditorDirectivesBlock({ replyLanguage: "xx" })).toBe("");
  });
});

describe("autoApprovesPermission", () => {
  test("only auto and bypass answer approvals for the operator", () => {
    expect(autoApprovesPermission("auto")).toBe(true);
    expect(autoApprovesPermission("bypass")).toBe(true);
    expect(autoApprovesPermission("manual")).toBe(false);
    expect(autoApprovesPermission("plan")).toBe(false);
    expect(autoApprovesPermission(null)).toBe(false);
  });
});

describe("host approval policy proof", () => {
  const base = { linkFeatures: ["approval_policy"], managedProfile: true, permissionMode: "manual", permissionPipeline: "legacy", policyMode: "ask_writes", effectiveAt: "2026-10-22T00:00:00Z" };
  test("requires a managed profile, matching policy, and effective read-back", () => {
    expect(hostApprovalPolicyProven(base)).toBe(true);
    expect(hostApprovalPolicyProven({ ...base, managedProfile: false })).toBe(false);
    expect(hostApprovalPolicyProven({ ...base, effectiveAt: null })).toBe(false);
    expect(hostApprovalPolicyProven({ ...base, policyMode: "off" })).toBe(false);
    expect(hostApprovalPolicyProven({ ...base, linkFeatures: [] })).toBe(false);
  });
  test("an auto bot is proven by `off` under legacy and by `ask_writes` under v2", () => {
    const auto = { ...base, permissionMode: "auto" };
    expect(hostApprovalPolicyProven({ ...auto, policyMode: "off" })).toBe(true);
    expect(hostApprovalPolicyProven({ ...auto, permissionPipeline: "v2", policyMode: "off" })).toBe(false);
    expect(hostApprovalPolicyProven({ ...auto, permissionPipeline: "v2", policyMode: "ask_writes" })).toBe(true);
  });
});

describe("hostApprovalPolicyRequired", () => {
  const legacy = {
    permissionPipeline: "legacy",
    storedPermissionMode: "auto",
    effectivePermissionMode: "manual",
    managedProfile: true,
    linkFeatures: ["approval_policy"],
  };
  test("v2 always needs the host proof", () => {
    expect(hostApprovalPolicyRequired({ ...legacy, permissionPipeline: "v2", storedPermissionMode: "bypass", effectivePermissionMode: "bypass" })).toBe(true);
  });
  test("legacy needs it only for a stored auto decided as manual on a host that holds the policy", () => {
    expect(hostApprovalPolicyRequired(legacy)).toBe(true);
    // The reviewer is ready for this organization: auto stays auto, nothing to prove.
    expect(hostApprovalPolicyRequired({ ...legacy, effectivePermissionMode: "auto" })).toBe(false);
    // A bot stored in manual keeps today's legacy behavior.
    expect(hostApprovalPolicyRequired({ ...legacy, storedPermissionMode: "manual" })).toBe(false);
    // No host that could hold it: nothing to wait for.
    expect(hostApprovalPolicyRequired({ ...legacy, managedProfile: false })).toBe(false);
    expect(hostApprovalPolicyRequired({ ...legacy, linkFeatures: [] })).toBe(false);
  });
});

const ACTU_RM = "rm -rf /root/actu-ia && if [ ! -e /root/actu-ia ]; then printf 'supprimé\\n'; else printf 'échec\\n'; exit 1; fi";

describe("workerMayApproveGate", () => {
  test("auto holds the actu-ia deletion for the operator", () => {
    expect(workerMayApproveGate("auto", ACTU_RM)).toBe(false);
  });

  test("bypass still approves that deletion", () => {
    expect(workerMayApproveGate("bypass", ACTU_RM)).toBe(true);
    expect(workerMayApproveGate("bypass", "rm -rf /tmp/fixture")).toBe(true);
  });

  test("bypass holds filesystem root, home, cwd and protected paths", () => {
    expect(workerMayApproveGate("bypass", "rm -rf /")).toBe(false);
    expect(workerMayApproveGate("bypass", "rm -rf /*")).toBe(false);
    expect(workerMayApproveGate("bypass", "rm -rf ~")).toBe(false);
    expect(workerMayApproveGate("bypass", "rm -rf $HOME")).toBe(false);
    expect(workerMayApproveGate("bypass", "rm -rf .")).toBe(false);
    expect(workerMayApproveGate("bypass", "rm -rf -- /")).toBe(false);
    expect(workerMayApproveGate("bypass", "sudo rm -rf /")).toBe(false);
    expect(workerMayApproveGate("bypass", "echo x > .env")).toBe(false);
    expect(workerMayApproveGate("bypass", "tee .git/config")).toBe(false);
    expect(workerMayApproveGate("bypass", "rm .git/hooks/pre-commit")).toBe(false);
  });

  test("auto holds any deletion, and still approves a plain read", () => {
    expect(workerMayApproveGate("auto", "rm notes.txt")).toBe(false);
    expect(workerMayApproveGate("auto", "git clean -fd")).toBe(false);
    expect(workerMayApproveGate("auto", "find . -name '*.log' -delete")).toBe(false);
    expect(workerMayApproveGate("auto", "ls /tmp")).toBe(true);
    expect(workerMayApproveGate("auto", "python - <<'PY'\nprint(1)\nPY")).toBe(true);
  });

  test("manual and plan never auto-approve", () => {
    expect(workerMayApproveGate("manual", "ls")).toBe(false);
    expect(workerMayApproveGate("plan", "ls")).toBe(false);
    expect(workerMayApproveGate(null, "rm -rf /")).toBe(false);
  });

  test("a wrapper's options never hide a circuit breaker or a deletion", () => {
    expect(workerMayApproveGate("bypass", "sudo -n rm -rf /")).toBe(false);
    expect(workerMayApproveGate("bypass", "env -i timeout 5 rm -rf ~")).toBe(false);
    expect(workerMayApproveGate("auto", "sudo -u root rm notes.txt")).toBe(false);
    expect(workerMayApproveGate("bypass", "sudo --frobnicate ls")).toBe(false);
    expect(workerMayApproveGate("bypass", "sudo -n ls /tmp")).toBe(true);
  });

  test("bypass holds a redirection onto an absolute sensitive path", () => {
    expect(workerMayApproveGate("bypass", "echo x > /workspace/.env")).toBe(false);
    expect(workerMayApproveGate("bypass", "echo x>>/root/.ssh/authorized_keys")).toBe(false);
    expect(workerMayApproveGate("bypass", "echo x > /workspace/.git/hooks/pre-commit")).toBe(false);
    expect(workerMayApproveGate("bypass", "echo x >")).toBe(false);
    expect(workerMayApproveGate("bypass", "echo x > /workspace/notes.md 2>&1")).toBe(true);
  });

  test("bypass allows a deletion under the home directory that is not the home itself", () => {
    expect(workerMayApproveGate("bypass", "rm -rf ~/notes")).toBe(true);
  });
});
