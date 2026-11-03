import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { checkBeforeForwardTx, resolveGateTx } from "../src/application/runner/permission-gate";
import type { GateIdentity } from "../src/domain/gate-identity";
import { YOLO_DEFAULT_PROTECT } from "../src/domain/yolo-hardline";

const CONTEXT = { organizationId: "org-1", botId: "bot-1", neverWait: false };
const UNATTENDED = { ...CONTEXT, neverWait: true };
const GRANT_ID = "71000000-0000-4000-8000-0000000000aa";

/** A transaction that answers the two policy reads and records the locks it was asked for. */
type OrgPolicyState = { ceiling: string | null; enforceReview: boolean; commandBlocklist: unknown };

function fakeTx(state: {
  pipeline: string | null; mode?: string; revision?: number; reviewProven?: boolean;
  orgPolicy?: OrgPolicyState; toolPolicies?: Record<string, string>; grant?: boolean; terminalAlways?: boolean;
  yolo?: { id: string; payload: unknown };
}) {
  const queries: string[] = [];
  const values: unknown[][] = [];
  const tenant: string[] = [];
  const tx = ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push(text);
    values.push(parameters);
    if (text.includes("current_setting('app.organization_id'")) return Promise.resolve([{ previous: "" }]);
    if (text.includes("set_config('app.organization_id'")) { tenant.push(String(parameters[0])); return Promise.resolve([{ set_config: parameters[0] }]); }
    if (text.includes("from bot_permission_tool_policies")) {
      const policy = state.toolPolicies?.[String(parameters[2])];
      // The row is only visible under the tenant setting of its organization.
      return Promise.resolve(policy && tenant.at(-1) === parameters[0] ? [{ policy }] : []);
    }
    if (text.includes("from runtime_review_profiles")) return Promise.resolve([{ proven: state.reviewProven === true }]);
    if (text.includes("from permission_yolo_leases")) return Promise.resolve(state.yolo && tenant.at(-1) === parameters[0] ? [state.yolo] : []);
    if (text.includes("from organization_permission_policies")) return Promise.resolve(state.orgPolicy ? [state.orgPolicy] : []);
    if (text.includes("from bot_permission_grants")) return Promise.resolve(state.grant === true && tenant.at(-1) === parameters[0] ? [{ id: GRANT_ID }] : []);
    if (text.includes("from runtime_permission_settings")) return Promise.resolve([{ switched: state.terminalAlways === true && tenant.at(-1) === parameters[0] }]);
    if (text.includes("from organizations")) return Promise.resolve(state.pipeline === null ? [] : [{ pipeline: state.pipeline }]);
    if (text.includes("from bots")) return Promise.resolve([{ mode: state.mode ?? "manual", revision: state.revision ?? 0 }]);
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as SQL;
  return { tx, queries, values, tenant };
}

const WRITE: GateIdentity = {
  hermesRequestId: "req-1",
  gateKind: "plugin_tool",
  toolKey: "write_file",
  gateArgs: { tool: "write_file", deletes: "no", opaque: false, digest: "a".repeat(64), args: { path: "notes.md", size: 4 } },
  descriptorVersion: 1,
};
const CRON: GateIdentity = { ...WRITE, toolKey: "cronjob", gateArgs: { ...WRITE.gateArgs, tool: "cronjob" } };
const CHOICES = ["once", "deny"];
const TERMINAL: GateIdentity = {
  hermesRequestId: "req-2", gateKind: "terminal_danger", toolKey: null, gateArgs: { command: "git push --force" }, descriptorVersion: null,
};

describe("resolveGateTx", () => {
  test("a legacy organization keeps the old heuristic and takes no lock", async () => {
    const { tx, queries } = fakeTx({ pipeline: "legacy" });
    expect(await resolveGateTx(tx, CONTEXT, WRITE, CHOICES)).toEqual({ pipeline: "legacy" });
    expect(queries.some((query) => query.includes("for share"))).toBe(false);
  });

  test("a missing organization is legacy", async () => {
    expect(await resolveGateTx(fakeTx({ pipeline: null }).tx, CONTEXT, WRITE, CHOICES)).toEqual({ pipeline: "legacy" });
  });

  test("v2 locks the organization before the bot and decides at the bot revision", async () => {
    const { tx, queries } = fakeTx({ pipeline: "v2", mode: "bypass", revision: 7 });
    const resolution = await resolveGateTx(tx, CONTEXT, WRITE, CHOICES);
    expect(resolution).toMatchObject({ pipeline: "v2", choice: "once", revision: 7, decision: { stage: "full" } });
    const locks = queries.filter((query) => query.includes("for share"));
    expect(locks.map((query) => (query.includes("from organizations") ? "organization" : "bot"))).toEqual(["organization", "bot"]);
  });

  test("auto without a proven reviewer goes to a human, never to an unanswered review", async () => {
    const resolution = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "auto", revision: 1 }).tx, CONTEXT, WRITE, CHOICES);
    expect(resolution).toMatchObject({ pipeline: "v2", choice: null, decision: { outcome: "human", effectiveMode: "manual" } });
  });

  test("auto with a proven review profile sends the gate to the reviewer, with no answer yet", async () => {
    const resolution = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "auto", revision: 1, reviewProven: true }).tx, CONTEXT, WRITE, CHOICES);
    expect(resolution).toMatchObject({ pipeline: "v2", choice: null, decision: { outcome: "review", stage: "review", effectiveMode: "auto" } });
  });

  test("a policy decision redone at forward time as a review is refused, never reviewed late", async () => {
    const check = await checkBeforeForwardTx(fakeTx({ pipeline: "v2", mode: "auto", revision: 9, reviewProven: true }).tx, CONTEXT, {
      choice: "once", decidedByKind: "policy", revisionSeen: 3, gate: WRITE, choices: CHOICES,
    });
    expect(check).toMatchObject({ action: "redecide", resolution: { choice: null, decision: { outcome: "review" } } });
  });

  test("a forbidden tool is denied in every mode", async () => {
    const resolution = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass" }).tx, CONTEXT, CRON, CHOICES);
    expect(resolution).toMatchObject({ choice: "deny", decision: { stage: "forbidden", reason: "tool_forbidden" } });
  });
});

describe("resolveGateTx with the organization policy (PERM2-8)", () => {
  const TERMINAL: GateIdentity = {
    hermesRequestId: "req-2",
    gateKind: "terminal_danger",
    toolKey: null,
    gateArgs: { command: "git push --force origin main" },
    descriptorVersion: 1,
  };
  const policy = (overrides: Partial<OrgPolicyState> = {}): OrgPolicyState => ({ ceiling: null, enforceReview: false, commandBlocklist: [], ...overrides });

  test("the policy is read after the organization lock, in the same decision", async () => {
    const { tx, queries } = fakeTx({ pipeline: "v2", mode: "bypass", orgPolicy: policy() });
    await resolveGateTx(tx, CONTEXT, WRITE, CHOICES);
    const lock = queries.findIndex((query) => query.includes("from organizations") && query.includes("for share"));
    const read = queries.findIndex((query) => query.includes("from organization_permission_policies"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(lock);
  });

  test("a legacy organization never reads the policy", async () => {
    const { tx, queries } = fakeTx({ pipeline: "legacy", orgPolicy: policy({ ceiling: "manual" }) });
    await resolveGateTx(tx, CONTEXT, WRITE, CHOICES);
    expect(queries.some((query) => query.includes("from organization_permission_policies"))).toBe(false);
  });

  test("a bypass bot under a manual ceiling goes to a human", async () => {
    const resolution = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass", orgPolicy: policy({ ceiling: "manual" }) }).tx, CONTEXT, WRITE, CHOICES);
    expect(resolution).toMatchObject({ choice: null, decision: { outcome: "human", effectiveMode: "manual" } });
  });

  test("an unknown stored ceiling caps at manual", async () => {
    const resolution = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass", orgPolicy: policy({ ceiling: "everything" }) }).tx, CONTEXT, WRITE, CHOICES);
    expect(resolution).toMatchObject({ decision: { effectiveMode: "manual" } });
  });

  test("enforce_review turns bypass into auto", async () => {
    const resolution = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass", reviewProven: true, orgPolicy: policy({ enforceReview: true }) }).tx, CONTEXT, WRITE, CHOICES);
    expect(resolution).toMatchObject({ choice: null, decision: { effectiveMode: "auto" } });
  });

  test("a blocklisted terminal command is denied even in bypass", async () => {
    const resolution = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass", orgPolicy: policy({ commandBlocklist: ["git push --force"] }) }).tx, CONTEXT, TERMINAL, CHOICES);
    expect(resolution).toMatchObject({ choice: "deny", decision: { stage: "forbidden", reason: "command_blocklisted" } });
  });

  test("an unreadable command is denied while a list exists, and only then", async () => {
    const unreadable: GateIdentity = { ...TERMINAL, gateArgs: { command: "echo 'unterminated" } };
    const denied = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass", orgPolicy: policy({ commandBlocklist: ["rm"] }) }).tx, CONTEXT, unreadable, CHOICES);
    expect(denied).toMatchObject({ choice: "deny", decision: { stage: "forbidden", reason: "command_unreadable" } });
    const open = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass", orgPolicy: policy() }).tx, CONTEXT, unreadable, CHOICES);
    expect(open).not.toMatchObject({ decision: { stage: "forbidden" } });
  });

  test("no policy row is no ceiling and no blocklist", async () => {
    const resolution = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass" }).tx, CONTEXT, WRITE, CHOICES);
    expect(resolution).toMatchObject({ choice: "once", decision: { stage: "full", effectiveMode: "bypass" } });
  });

  test("a human once on a command blocklisted since leaves as deny", async () => {
    const tx = fakeTx({ pipeline: "v2", mode: "manual", revision: 2, orgPolicy: policy({ commandBlocklist: ["git push"] }) }).tx;
    expect(await checkBeforeForwardTx(tx, CONTEXT, { choice: "once", decidedByKind: "member", revisionSeen: 1, gate: TERMINAL, choices: CHOICES }))
      .toEqual({ action: "deny", reason: "command_blocklisted" });
  });
});

describe("PERM2-5: the gate's tool policy", () => {
  const TERMINAL: GateIdentity = { hermesRequestId: "req-2", gateKind: "terminal_danger", toolKey: null, gateArgs: { command: "ls" }, descriptorVersion: null };

  test("a blocked tool is denied even in bypass, read under its organization and given back", async () => {
    const { tx, queries, tenant } = fakeTx({ pipeline: "v2", mode: "bypass", toolPolicies: { write_file: "block" } });
    const resolution = await resolveGateTx(tx, CONTEXT, WRITE, CHOICES);
    expect(resolution).toMatchObject({ choice: "deny", decision: { stage: "forbidden", reason: "tool_blocked" } });
    expect(queries.some((query) => query.includes("from bot_permission_tool_policies") && query.includes("organization_id = ?"))).toBe(true);
    // Set for each read (tool policy, then grant), then restored for the rest of the transaction.
    expect(tenant).toEqual([CONTEXT.organizationId, "", CONTEXT.organizationId, ""]);
  });

  test("always pre-approves in auto; ask sends to a human in bypass; another tool's policy is not used", async () => {
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "auto", reviewProven: true, toolPolicies: { write_file: "always" } }).tx, CONTEXT, WRITE, CHOICES))
      .toMatchObject({ choice: "once", decision: { stage: "tool_policy", reason: "tool_always" } });
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass", toolPolicies: { write_file: "ask" } }).tx, CONTEXT, WRITE, CHOICES))
      .toMatchObject({ choice: null, decision: { stage: "tool_policy", reason: "tool_ask" } });
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass", toolPolicies: { patch: "block" } }).tx, CONTEXT, WRITE, CHOICES))
      .toMatchObject({ choice: "once", decision: { stage: "full" } });
  });

  test("an unknown stored value asks; a terminal gate reads no tool policy", async () => {
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass", toolPolicies: { write_file: "sometimes" } }).tx, CONTEXT, WRITE, CHOICES))
      .toMatchObject({ choice: null, decision: { reason: "tool_ask" } });
    const { tx, queries } = fakeTx({ pipeline: "v2", mode: "bypass" });
    await resolveGateTx(tx, CONTEXT, TERMINAL, CHOICES);
    expect(queries.some((query) => query.includes("bot_permission_tool_policies"))).toBe(false);
  });

  test("a human once on a tool blocked since leaves as deny", async () => {
    const tx = fakeTx({ pipeline: "v2", mode: "manual", revision: 5, toolPolicies: { write_file: "block" } }).tx;
    expect(await checkBeforeForwardTx(tx, CONTEXT, { choice: "once", decidedByKind: "member", revisionSeen: 4, gate: WRITE, choices: CHOICES }))
      .toEqual({ action: "deny", reason: "tool_blocked" });
  });
});

describe("PERM2-4 pre-approvals", () => {
  test("an active grant answers the tool's gate once in auto, read under the run's organization", async () => {
    const { tx, queries, values } = fakeTx({ pipeline: "v2", mode: "auto", revision: 2, reviewProven: true, grant: true });
    const resolution = await resolveGateTx(tx, CONTEXT, WRITE, CHOICES);
    expect(resolution).toMatchObject({ pipeline: "v2", choice: "once", decision: { stage: "grant", reason: "grant" } });
    // PERM2-11: the decision names the grant that answered it.
    expect(resolution).toMatchObject({ detail: { reason: "grant", grantId: GRANT_ID } });
    const bind = queries.findIndex((query) => query.includes("set_config('app.organization_id'"));
    const grant = queries.findIndex((query) => query.includes("from bot_permission_grants"));
    expect(bind).toBeGreaterThan(queries.findIndex((query) => query.includes("from bots")));
    expect(bind).toBeLessThan(grant);
    expect(values[bind]).toEqual([CONTEXT.organizationId]);
    // The worker's read filters the organization itself, never the GUC alone.
    expect(queries[grant]).toContain("organization_id = ?");
    expect(values[grant]).toEqual([CONTEXT.organizationId, CONTEXT.botId, "write_file"]);
    expect(queries.some((query) => query.includes("from runtime_permission_settings"))).toBe(false);
  });

  test("without a grant the same gate goes to the reviewer", async () => {
    const resolution = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "auto", reviewProven: true }).tx, CONTEXT, WRITE, CHOICES);
    expect(resolution).toMatchObject({ choice: null, decision: { outcome: "review", stage: "review" } });
  });

  test("a grant never lifts a deletion, a sensitive path or a forbidden tool", async () => {
    const state = { pipeline: "v2", mode: "auto", reviewProven: true, grant: true } as const;
    const emptied: GateIdentity = { ...WRITE, gateArgs: { ...WRITE.gateArgs, deletes: "yes" } };
    const ssh: GateIdentity = { ...WRITE, gateArgs: { ...WRITE.gateArgs, args: { path: "/root/.ssh/authorized_keys", size: 4 } } };
    expect(await resolveGateTx(fakeTx(state).tx, CONTEXT, emptied, CHOICES)).toMatchObject({ choice: null, decision: { stage: "deletion" } });
    expect(await resolveGateTx(fakeTx(state).tx, CONTEXT, ssh, CHOICES)).toMatchObject({ choice: null, decision: { stage: "floor" } });
    expect(await resolveGateTx(fakeTx(state).tx, CONTEXT, CRON, CHOICES)).toMatchObject({ choice: "deny", decision: { stage: "forbidden" } });
  });

  test("the runtime switch answers a terminal gate once, and only a terminal gate", async () => {
    const on = fakeTx({ pipeline: "v2", mode: "auto", reviewProven: true, terminalAlways: true });
    expect(await resolveGateTx(on.tx, CONTEXT, TERMINAL, CHOICES))
      .toMatchObject({ choice: "once", decision: { stage: "grant", reason: "terminal_switch" } });
    expect((await resolveGateTx(fakeTx({ pipeline: "v2", mode: "auto", reviewProven: true, terminalAlways: true }).tx, CONTEXT, TERMINAL, CHOICES) as { detail: object }).detail)
      .not.toHaveProperty("grantId");
    expect(on.queries.some((query) => query.includes("from bot_permission_grants"))).toBe(false);
    const write = fakeTx({ pipeline: "v2", mode: "auto", reviewProven: true, terminalAlways: true });
    expect(await resolveGateTx(write.tx, CONTEXT, WRITE, CHOICES)).toMatchObject({ choice: null });
    const removal: GateIdentity = { ...TERMINAL, gateArgs: { command: "rm -rf build" } };
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "auto", reviewProven: true, terminalAlways: true }).tx, CONTEXT, removal, CHOICES))
      .toMatchObject({ choice: null, decision: { stage: "deletion" } });
  });

  test("an unidentified gate reads no pre-approval at all", async () => {
    const { tx, queries } = fakeTx({ pipeline: "v2", mode: "bypass", grant: true, terminalAlways: true });
    const unknown: GateIdentity = { hermesRequestId: null, gateKind: "unknown", toolKey: null, gateArgs: null, descriptorVersion: null };
    expect(await resolveGateTx(tx, CONTEXT, unknown, CHOICES)).toMatchObject({ choice: null, decision: { stage: "floor" } });
    expect(queries.some((query) => query.includes("set_config"))).toBe(false);
  });

  test("a grant revoked after a policy once makes the forwarding claim decide again", async () => {
    const check = await checkBeforeForwardTx(fakeTx({ pipeline: "v2", mode: "auto", revision: 6, reviewProven: true }).tx, CONTEXT, {
      choice: "once", decidedByKind: "policy", revisionSeen: 5, gate: WRITE, choices: CHOICES,
    });
    expect(check).toMatchObject({ action: "redecide", resolution: { revision: 6, choice: null } });
  });
});

describe("checkBeforeForwardTx", () => {
  const approval = (overrides: Partial<Parameters<typeof checkBeforeForwardTx>[2]> = {}) => ({
    choice: "once" as const, decidedByKind: "policy", revisionSeen: 3, gate: WRITE, choices: CHOICES, ...overrides,
  });

  test("a legacy gate is forwarded without reading the policy", async () => {
    const { tx, queries } = fakeTx({ pipeline: "v2" });
    expect(await checkBeforeForwardTx(tx, CONTEXT, approval({ decidedByKind: null }))).toEqual({ action: "forward" });
    expect(queries).toEqual([]);
  });

  test("a policy decision at the current revision is forwarded", async () => {
    expect(await checkBeforeForwardTx(fakeTx({ pipeline: "v2", mode: "bypass", revision: 3 }).tx, CONTEXT, approval()))
      .toEqual({ action: "forward" });
  });

  test("a policy decision at an older revision is decided again", async () => {
    const check = await checkBeforeForwardTx(fakeTx({ pipeline: "v2", mode: "manual", revision: 4 }).tx, CONTEXT, approval());
    expect(check).toMatchObject({ action: "redecide", resolution: { revision: 4, choice: null } });
  });

  test("a human once that became forbidden leaves as deny; a human deny never changes", async () => {
    const tx = fakeTx({ pipeline: "v2", mode: "manual", revision: 9 }).tx;
    expect(await checkBeforeForwardTx(tx, CONTEXT, approval({ decidedByKind: "member", gate: CRON })))
      .toEqual({ action: "deny", reason: "tool_forbidden" });
    expect(await checkBeforeForwardTx(tx, CONTEXT, approval({ decidedByKind: "member" }))).toEqual({ action: "forward" });
    expect(await checkBeforeForwardTx(tx, CONTEXT, approval({ decidedByKind: "agency", choice: "deny", gate: CRON })))
      .toEqual({ action: "forward" });
  });

  test("an organization back to legacy forwards what was already decided", async () => {
    expect(await checkBeforeForwardTx(fakeTx({ pipeline: "legacy" }).tx, CONTEXT, approval({ revisionSeen: 0 })))
      .toEqual({ action: "forward" });
  });
});

describe("a run nobody attends (PERM2-9)", () => {
  test("a gate that would wait for a person is refused at once, and says what held it", async () => {
    const resolution = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "manual", revision: 2 }).tx, UNATTENDED, WRITE, CHOICES);
    expect(resolution).toMatchObject({
      pipeline: "v2", choice: "deny", revision: 2,
      decision: { outcome: "deny", stage: "unattended", reason: "never_wait", heldBy: { stage: "human", reason: "manual_mode" } },
      detail: { reason: "never_wait", heldStage: "human", heldReason: "manual_mode" },
    });
  });

  test("the floor is refused, never answered once, even in bypass", async () => {
    const ssh: GateIdentity = { ...WRITE, gateArgs: { ...WRITE.gateArgs, args: { path: "/root/.ssh/authorized_keys", size: 4 } } };
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass" }).tx, UNATTENDED, ssh, CHOICES))
      .toMatchObject({ choice: "deny", decision: { stage: "unattended", heldBy: { stage: "floor", reason: "sensitive_path" } } });
  });

  test("an interdiction stays an interdiction, a policy once stays once, a review stays a review", async () => {
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass" }).tx, UNATTENDED, CRON, CHOICES))
      .toMatchObject({ choice: "deny", decision: { stage: "forbidden", reason: "tool_forbidden" } });
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass" }).tx, UNATTENDED, WRITE, CHOICES))
      .toMatchObject({ choice: "once", decision: { stage: "full" } });
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "auto", reviewProven: true }).tx, UNATTENDED, WRITE, CHOICES))
      .toMatchObject({ choice: null, decision: { outcome: "review" } });
  });

  test("a legacy organization is left to persist, which refuses there too", async () => {
    expect(await resolveGateTx(fakeTx({ pipeline: "legacy" }).tx, UNATTENDED, WRITE, CHOICES)).toEqual({ pipeline: "legacy" });
  });

  test("a decision redone at forward time stays unattended", async () => {
    const check = await checkBeforeForwardTx(fakeTx({ pipeline: "v2", mode: "manual", revision: 8 }).tx, UNATTENDED, {
      choice: "once", decidedByKind: "policy", revisionSeen: 3, gate: WRITE, choices: CHOICES,
    });
    expect(check).toMatchObject({ action: "redecide", resolution: { choice: "deny", decision: { stage: "unattended" } } });
  });
});

describe("a plan-only turn (0155)", () => {
  const PLAN_TURN = { ...CONTEXT, planOnly: true };

  test("a write of a bypass bot is refused: the turn is decided as plan", async () => {
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass", revision: 2 }).tx, PLAN_TURN, WRITE, CHOICES))
      .toMatchObject({ choice: "deny", revision: 2, decision: { stage: "forbidden", reason: "plan_write", effectiveMode: "plan" } });
  });

  test("a terminal gate of an auto bot waits for a person instead of the reviewer", async () => {
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "auto", reviewProven: true }).tx, PLAN_TURN, TERMINAL, CHOICES))
      .toMatchObject({ choice: null, decision: { outcome: "human", reason: "plan_mode" } });
  });

  test("the same bot outside the turn keeps its own mode", async () => {
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass" }).tx, CONTEXT, WRITE, CHOICES))
      .toMatchObject({ choice: "once", decision: { stage: "full" } });
  });

  test("a human once on a write is sent as deny, and a redecision stays plan", async () => {
    const human = await checkBeforeForwardTx(fakeTx({ pipeline: "v2", mode: "bypass", revision: 3 }).tx, PLAN_TURN, {
      choice: "once", decidedByKind: "human", revisionSeen: 3, gate: WRITE, choices: CHOICES,
    });
    expect(human).toEqual({ action: "deny", reason: "plan_write" });
    const redo = await checkBeforeForwardTx(fakeTx({ pipeline: "v2", mode: "bypass", revision: 9 }).tx, PLAN_TURN, {
      choice: "once", decidedByKind: "policy", revisionSeen: 3, gate: WRITE, choices: CHOICES,
    });
    expect(redo).toMatchObject({ action: "redecide", resolution: { choice: "deny", decision: { reason: "plan_write" } } });
  });

  test("a legacy organization is left to persist, which never auto-approves a plan turn", async () => {
    expect(await resolveGateTx(fakeTx({ pipeline: "legacy" }).tx, PLAN_TURN, WRITE, CHOICES)).toEqual({ pipeline: "legacy" });
  });
});

describe("resolveGateTx under a YOLO lease (0165)", () => {
  const LEASE_ID = "7a000000-0000-4000-8000-000000000001";
  const RUN = { ...CONTEXT, runtimeId: "7a000000-0000-4000-8000-0000000000aa", threadId: "7a000000-0000-4000-8000-0000000000bb" };
  const payload = (deny: string[] = []) => ({
    v: 1, leaseId: LEASE_ID, organizationId: "7a000000-0000-4000-8000-0000000000cc", runtimeId: RUN.runtimeId,
    scope: "runtime", profile: null, sessionKey: null, issuedAt: 1_800_000_000, notBefore: 1_800_000_000, expiresAt: 1_800_014_400,
    grantedBy: "7a000000-0000-4000-8000-0000000000dd", deny: { commands: deny, tools: [], paths: [] }, protect: [...YOLO_DEFAULT_PROTECT],
  });
  const leased = (mode: string, deny: string[] = []) => fakeTx({ pipeline: "v2", mode, yolo: { id: LEASE_ID, payload: payload(deny) } });

  test("a covered manual bot is answered once by the lease, named in the detail", async () => {
    const { tx, values, tenant } = leased("manual");
    const resolution = await resolveGateTx(tx, RUN, TERMINAL, CHOICES);
    expect(resolution).toMatchObject({ choice: "once", decision: { stage: "yolo", reason: "yolo_lease" }, detail: { yoloLeaseId: LEASE_ID } });
    // Read under the run's tenant, then the previous setting is put back.
    expect(tenant.slice(-2)).toEqual(["org-1", ""]);
    expect(values.find((parameters) => parameters.includes(RUN.runtimeId))).toContain(RUN.threadId);
  });

  test("the lease's deny-list and protections still refuse", async () => {
    expect(await resolveGateTx(leased("manual", ["git push"]).tx, RUN, TERMINAL, CHOICES))
      .toMatchObject({ choice: "deny", decision: { stage: "yolo", reason: "yolo_denied" } });
    const ssh: GateIdentity = { ...WRITE, gateArgs: { ...WRITE.gateArgs, args: { path: "/home/u/.ssh/id_rsa", size: 4 } } };
    expect(await resolveGateTx(leased("manual").tx, RUN, ssh, CHOICES)).toMatchObject({ choice: "deny", decision: { stage: "yolo" } });
  });

  test("a ceiling below bypass ignores the lease and names the downgrade", async () => {
    const resolution = await resolveGateTx(fakeTx({
      pipeline: "v2", mode: "bypass", orgPolicy: { ceiling: "manual", enforceReview: false, commandBlocklist: [] }, yolo: { id: LEASE_ID, payload: payload() },
    }).tx, RUN, WRITE, CHOICES);
    expect(resolution).toMatchObject({ choice: null, decision: { outcome: "human" }, detail: { effectiveMode: "manual", effectiveReason: "ceiling" } });
    expect((resolution as { detail: object }).detail).not.toHaveProperty("yoloLeaseId");
  });

  test("an unreadable stored payload is no lease, and a run without a runtime reads none", async () => {
    expect(await resolveGateTx(fakeTx({ pipeline: "v2", mode: "manual", yolo: { id: LEASE_ID, payload: { v: 2 } } }).tx, RUN, TERMINAL, CHOICES))
      .toMatchObject({ choice: null, decision: { outcome: "human" } });
    const { tx, queries } = leased("manual");
    expect(await resolveGateTx(tx, CONTEXT, TERMINAL, CHOICES)).toMatchObject({ choice: null });
    expect(queries.some((query) => query.includes("permission_yolo_leases"))).toBe(false);
  });

  test("a mode left as stored carries no downgrade reason", async () => {
    const resolution = await resolveGateTx(fakeTx({ pipeline: "v2", mode: "bypass" }).tx, RUN, WRITE, CHOICES);
    expect((resolution as { detail: object }).detail).not.toHaveProperty("effectiveReason");
  });
});
