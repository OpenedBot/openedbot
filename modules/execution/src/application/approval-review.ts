/**
 * PERM2-7: the automatic reviewer. A gate the pipeline sends to
 * review is born `reviewing` (persist.ts); this loop, outside any run
 * transaction, claims it with a token and a lease, asks the bot's model on
 * the tool-less `openedbot-reviewer` profile, and writes the verdict under that
 * token. Whatever goes wrong, the gate ends with a human:
 *
 * The reviewer reads the bot's natural-language rules and its organization's
 * (PERM2-6), tenant-scoped, as fenced data next to the goal.
 *
 *   approve  -> `once`, decided by the policy at stage `review`
 *   deny     -> `deny`, same trace
 *   escalate, no verdict, a refused or slow reviewer, the 15 s budget spent,
 *   three review refusals in a row in the run, the review profile no longer
 *   proven, the organization back on `legacy` -> `awaiting_human`, and the
 *   workflow moves to `awaiting_approval` (which notifies). On a workflow
 *   with "Never wait" (PERM2-9) nobody would answer: the gate is refused at
 *   stage `unattended` instead, and nobody is notified.
 *
 * A verdict is never written twice: the write requires the claim token, the
 * gate still `pending` and still `reviewing`.
 */

import type { SQL } from "bun";
import { HermesClientError, type HermesClient } from "@openedbot/hermes";
import { REVIEW_PROFILE } from "@openedbot/runtimes/domain/runtime-contract";
import { readReviewProven } from "@openedbot/runtimes/application/review-profile";
import type { GateDescriptor, GateKind } from "../domain/gate-identity";
import type { ResolvedPermissionRuleSource } from "../domain/permission-rules";
import {
  REVIEW_BUDGET_MS, REVIEW_CIRCUIT_DENIALS, REVIEW_INSTRUCTIONS, buildReviewInput, effectiveReviewRules, parseReviewVerdict,
  type ReviewRule, type ReviewVerdict,
} from "../domain/review-verdict";
import { lockWorkflowTx, permissionRuleSourceFor } from "./runner/permission-rule-sources";
import { applyRuntimeModelSelection } from "./runner/provider-recovery";
import type { RuntimeClientContext } from "./runtime-client";
import { log } from "./runner/util";

/** A claim outlives the budget by a margin: a stuck reviewer is taken over, never doubled. */
const REVIEW_LEASE_SECONDS = 25;
const REVIEW_POLL_MS = 250;
/** The reviewer answers in one short sentence: keep its reasoning cheap. */
const REVIEW_REASONING_EFFORT = "low";

export type ReviewJob = {
  id: string;
  organizationId: string;
  runId: string;
  /** The run's bot, whose rules (and its organization's) the reviewer reads. */
  botId: string | null;
  claimToken: string;
  createdAt: Date;
  gateKind: GateKind;
  toolKey: string | null;
  gateArgs: Record<string, unknown> | null;
  command: string | null;
  description: string | null;
  goal: string | null;
  workflowId: string | null;
  pipeline: string;
  botModel: string | null;
  botReasoningEffort: string | null;
  assignmentMode: string | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  runtime: Omit<RuntimeClientContext, "hermesProfile"> | null;
};

type ReviewOutcome =
  | { kind: "verdict"; verdict: Exclude<ReviewVerdict["verdict"], "escalate">; reason: string }
  | { kind: "escalate"; code: string; reason: string | null };

export type ReviewDeps = {
  /** A client on the review profile of the gate's runtime. */
  client(runtime: Omit<RuntimeClientContext, "hermesProfile">): Pick<HermesClient, "createRun" | "getRunStatus" | "stopRun" | "deleteSession" | "mcpInventory" | "hostProfileInventory">;
  now(): number;
  sleep(ms: number): Promise<unknown>;
  /** The worker's shutdown: an interrupted review hands the gate to a person. */
  signal?: AbortSignal;
};

/** Claims up to `limit` gates under review, oldest first. */
export async function claimReviewGates(db: SQL, limit: number): Promise<ReviewJob[]> {
  return db<ReviewJob[]>`
    with candidate as (
      select a.organization_id, a.id from approval_requests a
       where a.decision_state = 'reviewing' and a.status = 'pending'
         and (a.decision_lease_expires_at is null or a.decision_lease_expires_at < now())
       order by a.created_at
       for update skip locked
       limit ${limit}
    ), claimed as (
      update approval_requests a
         set decision_claim_token = gen_random_uuid(),
             decision_lease_expires_at = now() + (${REVIEW_LEASE_SECONDS} * interval '1 second')
        from candidate c
       where a.organization_id = c.organization_id and a.id = c.id
      returning a.*
    )
    select a.id, a.organization_id as "organizationId", a.run_id as "runId", r.bot_id as "botId",
           a.decision_claim_token as "claimToken", a.created_at as "createdAt",
           a.gate_kind as "gateKind", a.tool_key as "toolKey", a.gate_args as "gateArgs",
           a.command, a.description, r.input as goal, r.workflow_id as "workflowId",
           o.permission_pipeline as pipeline, coalesce(r.model, b.model) as "botModel",
           b.reasoning_effort as "botReasoningEffort", o.model_assignment_mode as "assignmentMode",
           rt.selected_provider as "selectedProvider", rt.selected_model as "selectedModel",
           rt.reasoning_effort as "selectedReasoningEffort",
           case when rt.id is null then null else jsonb_build_object(
             'runtimeId', rt.id, 'reachability', rt.reachability, 'runtimeEndpoint', rt.endpoint,
             'tokenCiphertext', rt.token_ciphertext, 'tokenNonce', rt.token_nonce, 'tokenTag', rt.token_tag,
             'tokenKeyId', rt.token_key_id, 'edgeAuthCiphertext', rt.edge_auth_ciphertext,
             'edgeAuthNonce', rt.edge_auth_nonce, 'edgeAuthTag', rt.edge_auth_tag, 'edgeAuthKeyId', rt.edge_auth_key_id
           ) end as runtime
      from claimed a
      join runs r on r.organization_id = a.organization_id and r.id = a.run_id
      join organizations o on o.id = a.organization_id
      left join bots b on b.organization_id = r.organization_id and b.id = r.bot_id
      left join runtimes rt on rt.organization_id = a.organization_id and rt.is_active and rt.revoked_at is null
  `;
}

/** Three review refusals in a row in this run, with nothing approved since. */
async function circuitOpen(db: SQL, job: ReviewJob): Promise<boolean> {
  const rows = await db<Array<{ choice: string | null }>>`
    select selected_choice as choice from approval_requests
     where organization_id = ${job.organizationId} and run_id = ${job.runId}
       and decision_stage = 'review' and decided_by_kind = 'policy' and id <> ${job.id}
     order by gate_ordinal desc
     limit ${REVIEW_CIRCUIT_DENIALS}
  `;
  return rows.length === REVIEW_CIRCUIT_DENIALS && rows.every((row) => row.choice === "deny");
}

/**
 * PERM2-7a criterion: a root MCP server added after the last proof is caught
 * before this review, not two minutes later.
 */
async function reviewProfileStillToolLess(client: ReturnType<ReviewDeps["client"]>): Promise<boolean> {
  const [root, inventory] = await Promise.all([client.mcpInventory(), client.hostProfileInventory()]);
  const profile = inventory.profiles.find((entry) => entry.name === REVIEW_PROFILE);
  if (!profile || profile.mcpServers.some((flag) => flag.enabled)) return false;
  const off = new Set(profile.mcpServers.map((flag) => flag.name));
  return root.servers.every((server) => off.has(server.name));
}

/**
 * The gateway caps concurrent runs (`max_concurrent_runs`) and the bot's own
 * run, waiting on this gate, holds a slot: on a one-slot host the review
 * waits for another run to end, within the budget, then lets a person decide.
 */
async function createWithinBudget(deps: ReviewDeps, deadline: number, create: () => Promise<string>): Promise<string | null> {
  for (;;) {
    try { return await create(); }
    catch (error) {
      if (!(error instanceof HermesClientError && error.status === 429)) throw error;
      if (deps.now() + 1_000 >= deadline) return null;
      await deps.sleep(1_000);
    }
  }
}

/**
 * PERM2-6: the rules for this gate, read through the `PermissionRuleSource`
 * port in one transaction, so the rules and the mode agree. A rule changed
 * after this read raises the bot's revision and the forwarding claim redoes
 * the decision: a verdict never leaves on stale rules.
 */
export async function readReviewRules(
  db: SQL,
  organizationId: string,
  botId: string | null,
  source?: ResolvedPermissionRuleSource,
): Promise<ReviewRule[]> {
  if (!botId) return [];
  const from = source ?? await permissionRuleSourceFor(organizationId);
  return db.begin(async (tx) => {
    const { rulesMode, rules } = await from.reviewRules(tx, { organizationId, botId });
    return effectiveReviewRules(rules, rulesMode);
  }) as Promise<ReviewRule[]>;
}

/**
 * The model the review runs on: the gated run's, with a NAMED provider.
 *
 * A bot model comes back from `applyRuntimeModelSelection` without a
 * provider, and the gateway then guesses one. Measured 2026-10-31 on the lab
 * host: it picked `xai-oauth` (the host's active login) for
 * `claude-sonnet-5-5`, which xAI answers 404, so every review failed
 * (`review_run_failed`) and fell back to a human. The bot's own runs resolve
 * the provider from the catalogue (`resolveSelectionForNewRun`); here, the
 * runtime's selection names it whenever it is the same model.
 */
export function reviewModelSelection(job: Pick<ReviewJob,
  "botModel" | "botReasoningEffort" | "assignmentMode" | "selectedProvider" | "selectedModel" | "selectedReasoningEffort">) {
  const selection = applyRuntimeModelSelection(
    { model: job.botModel, reasoningEffort: job.botReasoningEffort },
    { provider: job.selectedProvider, model: job.selectedModel, reasoningEffort: job.selectedReasoningEffort },
    job.assignmentMode === "global" ? "global" : "per_bot",
  );
  const selectedModel = job.selectedModel?.trim() || null;
  const selectedProvider = job.selectedProvider?.trim() || null;
  if (selection.provider === null && selectedProvider && selection.model !== null && selection.model === selectedModel) {
    return { ...selection, provider: selectedProvider };
  }
  return selection;
}

const REVIEW_TIMEOUT: ReviewOutcome = { kind: "escalate", code: "review_timeout", reason: null };

async function askReviewer(
  job: ReviewJob,
  rules: readonly ReviewRule[],
  deps: ReviewDeps,
  deadline: number,
  signal: AbortSignal,
): Promise<ReviewOutcome> {
  if (!job.runtime) return { kind: "escalate", code: "review_runtime_missing", reason: null };
  const client = deps.client(job.runtime);
  if (!(await reviewProfileStillToolLess(client))) return { kind: "escalate", code: "review_profile_stale", reason: null };
  if (deps.now() >= deadline) return REVIEW_TIMEOUT;
  const selection = reviewModelSelection(job);
  const sessionId = `openedbot-review-${job.id}`;
  let hermesRunId: string | null = null;
  try {
    hermesRunId = await createWithinBudget(deps, deadline, () => client.createRun({
      input: buildReviewInput({
        toolKey: job.toolKey, gateKind: job.gateKind,
        descriptor: job.gateKind === "plugin_tool" ? job.gateArgs as GateDescriptor | null : null,
        command: job.command, description: job.description, goal: job.goal, rules,
      }),
      instructions: REVIEW_INSTRUCTIONS,
      sessionId,
      model: selection.model,
      provider: selection.provider,
      reasoningEffort: REVIEW_REASONING_EFFORT,
      // One review per gate, in its own session: a 1h write would be wasted.
      promptCacheTtl: "5m",
      idempotencyKey: `review:${job.id}:${job.claimToken}`,
      signal,
    }));
    if (hermesRunId === null) return { kind: "escalate", code: "review_runtime_busy", reason: null };
    while (deps.now() < deadline) {
      const status = await client.getRunStatus(hermesRunId, signal);
      // A reply that lands after the budget is no verdict: a person decides.
      if (deps.now() >= deadline) break;
      if (status.status === "completed") {
        const verdict = parseReviewVerdict(status.output);
        if (!verdict) return { kind: "escalate", code: "review_unreadable", reason: null };
        if (verdict.verdict === "escalate") return { kind: "escalate", code: "review_escalated", reason: verdict.reason };
        return { kind: "verdict", verdict: verdict.verdict, reason: verdict.reason };
      }
      if (status.status === "failed" || status.status === "cancelled") return { kind: "escalate", code: "review_run_failed", reason: null };
      await deps.sleep(REVIEW_POLL_MS);
    }
    await client.stopRun(hermesRunId).catch(() => undefined);
    return REVIEW_TIMEOUT;
  } catch (error) {
    if (!signal.aborted) throw error;
    // The budget or the worker's shutdown cut a call short: the remote review
    // is stopped (outside the spent signal) and the gate goes to a person.
    if (hermesRunId !== null) await client.stopRun(hermesRunId).catch(() => undefined);
    return deps.signal?.aborted ? { kind: "escalate", code: "review_failed", reason: null } : REVIEW_TIMEOUT;
  } finally {
    await client.deleteSession(sessionId).catch(() => undefined);
  }
}

/** Every check that sends the gate to a human without asking the model. */
async function preflight(db: SQL, job: ReviewJob, deps: ReviewDeps): Promise<ReviewOutcome | null> {
  if (job.pipeline !== "v2") return { kind: "escalate", code: "review_pipeline_legacy", reason: null };
  if (deps.now() - new Date(job.createdAt).getTime() >= REVIEW_BUDGET_MS) return { kind: "escalate", code: "review_timeout", reason: null };
  const proven = await readReviewProven(db, job.organizationId);
  if (!proven) return { kind: "escalate", code: "review_unavailable", reason: null };
  if (await circuitOpen(db, job)) return { kind: "escalate", code: "review_circuit_open", reason: null };
  return null;
}

/**
 * Writes the outcome under the claim token. The run, then its workflow, then
 * the gate: the forwarder's order (runner/approval-forwarding.ts), so the two cannot deadlock.
 * "Never wait" (PERM2-9) is read through the port under the workflow lock;
 * the snapshot never changes once the workflow exists (0144).
 */
async function writeOutcome(
  db: SQL,
  job: ReviewJob,
  verdictOrEscalation: ReviewOutcome,
  durationMs: number,
  source: ResolvedPermissionRuleSource,
  lateAfter: () => boolean,
): Promise<{ written: boolean; neverWait: boolean; outcome: ReviewOutcome }> {
  return db.begin(async (tx) => {
    await tx`select id from runs where organization_id = ${job.organizationId} and id = ${job.runId} for update`;
    const neverWait = await lockWorkflowTx(tx as unknown as SQL, job.organizationId, job.workflowId, source);
    // Re-checked under the locks: a verdict that reaches the write after the
    // budget is refused, and the gate goes to a person like any timeout.
    const outcome = verdictOrEscalation.kind === "verdict" && lateAfter() ? REVIEW_TIMEOUT : verdictOrEscalation;
    const reasonCode = outcome.kind === "verdict" ? `review_${outcome.verdict}` : outcome.code;
    const detail = { reason: reasonCode, ...(outcome.reason ? { reviewerReason: outcome.reason } : {}), durationMs };
    // The detail MERGES into what the pipeline wrote: `effectiveMode` is what
    // tells the card it may offer "Always" (`permission-always.ts`), and a
    // replaced detail lost it (lab, 2026-10-25).
    // PERM2-9: nobody waits for this gate, so an escalation is a refusal,
    // under the same trace as a verdict, and nobody is notified.
    const rows = outcome.kind === "escalate" && neverWait
      ? await tx<Array<{ id: string }>>`
          update approval_requests
             set status = 'denied', selected_choice = 'deny',
                 resolved_at = now(), resolved_by_policy = 'auto',
                 decision_state = 'decided', decided_by_kind = 'policy', decision_stage = 'unattended',
                 decision_detail = coalesce(decision_detail, '{}'::jsonb) || ${{ reason: "never_wait", heldStage: "review", heldReason: reasonCode, durationMs }}::jsonb,
                 decision_claim_token = null, decision_lease_expires_at = null
           where organization_id = ${job.organizationId} and id = ${job.id}
             and decision_claim_token = ${job.claimToken} and status = 'pending' and decision_state = 'reviewing'
          returning id
        `
      : outcome.kind === "verdict"
      ? await tx<Array<{ id: string }>>`
          update approval_requests
             set status = ${outcome.verdict === "approve" ? "approved" : "denied"},
                 selected_choice = ${outcome.verdict === "approve" ? "once" : "deny"},
                 resolved_at = now(), resolved_by_policy = 'auto',
                 decision_state = 'decided', decided_by_kind = 'policy', decision_stage = 'review',
                 decision_detail = coalesce(decision_detail, '{}'::jsonb) || ${detail}::jsonb, decision_claim_token = null, decision_lease_expires_at = null
           where organization_id = ${job.organizationId} and id = ${job.id}
             and decision_claim_token = ${job.claimToken} and status = 'pending' and decision_state = 'reviewing'
          returning id
        `
      : await tx<Array<{ id: string }>>`
          update approval_requests
             set decision_state = 'awaiting_human', decision_stage = 'review', decision_detail = coalesce(decision_detail, '{}'::jsonb) || ${detail}::jsonb,
                 decision_claim_token = null, decision_lease_expires_at = null
           where organization_id = ${job.organizationId} and id = ${job.id}
             and decision_claim_token = ${job.claimToken} and status = 'pending' and decision_state = 'reviewing'
          returning id
        `;
    if (!rows[0]) return { written: false, neverWait, outcome };
    if (outcome.kind === "escalate" && !neverWait && job.workflowId) await tx`
      update workflows set status = 'awaiting_approval', updated_at = now()
       where organization_id = ${job.organizationId} and id = ${job.workflowId} and status = 'running'
    `;
    return { written: true, neverWait, outcome };
  }) as Promise<{ written: boolean; neverWait: boolean; outcome: ReviewOutcome }>;
}

export async function reviewGate(db: SQL, job: ReviewJob, deps: ReviewDeps): Promise<void> {
  const started = deps.now();
  const deadline = new Date(job.createdAt).getTime() + REVIEW_BUDGET_MS;
  let outcome: ReviewOutcome;
  let failure: { code: string | null; status: number | null } | null = null;
  let rulesCount: number | null = null;
  // The port is resolved once, outside every transaction; a failing selector
  // falls back to the core's on its own (permission-rule-sources.ts).
  const source = await permissionRuleSourceFor(job.organizationId);
  // One signal for every reviewer call: the budget's end or the worker's shutdown.
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort("review_budget"), Math.max(0, deadline - deps.now()));
  const signal = deps.signal ? AbortSignal.any([budget.signal, deps.signal]) : budget.signal;
  try {
    const held = await preflight(db, job, deps);
    if (held) {
      outcome = held;
    } else {
      // A failed read is a failed review: a human decides, never a review without the rules.
      const rules = await readReviewRules(db, job.organizationId, job.botId, source);
      rulesCount = rules.length;
      outcome = await askReviewer(job, rules, deps, deadline, signal);
    }
  } catch (error) {
    // The code and status only: a provider message may quote the gate.
    failure = error instanceof HermesClientError ? { code: String(error.code), status: error.status } : { code: null, status: null };
    outcome = { kind: "escalate", code: "review_failed", reason: null };
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Math.round(deps.now() - started);
  const result = await writeOutcome(db, job, outcome, durationMs, source, () => deps.now() >= deadline);
  const { written, neverWait } = result;
  outcome = result.outcome;
  const unattended = outcome.kind === "escalate" && neverWait;
  log("approval.decision", {
    runId: job.runId, stage: unattended ? "unattended" : "review", reviewer: true,
    outcome: outcome.kind === "verdict" ? (outcome.verdict === "approve" ? "once" : "deny") : unattended ? "deny" : "human",
    reason: outcome.kind === "verdict" ? `review_${outcome.verdict}` : unattended ? "never_wait" : outcome.code,
    ...(outcome.kind === "escalate" && unattended ? { heldReason: outcome.code } : {}),
    durationMs, written, ...(rulesCount === null ? {} : { rules: rulesCount }), ...(failure ? { errorCode: failure.code, errorStatus: failure.status } : {}),
  });
}
