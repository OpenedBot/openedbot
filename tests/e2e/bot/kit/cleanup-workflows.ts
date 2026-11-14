import type { SQL } from "bun";
import type { Session } from "./session";

const ACTIVE_RUNS = ["queued", "starting", "running", "awaiting_approval", "relaying"];
const ACTIVE_WORKFLOWS = ["queued", "running", "awaiting_approval", "reconciling"];
const TERMINAL_RUNS = ["completed", "failed", "cancelled"];
const TERMINAL_WORKFLOWS = ["completed", "failed", "cancelled", "expired"];
export type CleanupOwner = { botId: string | null; organizationId: string | null };
export type CleanupRun = CleanupOwner & { id: string; status: string; workflowId: string | null };
export type CleanupWorkflow = {
  id: string; organizationId: string; status: string; rootRunId: string;
  owners: CleanupOwner[]; runs: CleanupRun[];
};
export type CleanupStore = {
  targets(botId: string): Promise<CleanupRun[]>;
  workflow(id: string): Promise<CleanupWorkflow | null>;
  standalone(id: string): Promise<{ run: CleanupRun; affectedRuns: CleanupRun[]; owners: CleanupOwner[] } | null>;
};

function assertOwners(owners: CleanupOwner[], organizationId: string, live: ReadonlySet<string>): void {
  if (!owners.length || owners.some((owner) => !owner.botId || owner.organizationId !== organizationId || !live.has(owner.botId))) {
    throw new Error("Cleanup refused: foreign, missing or null bot ownership; no cancellation or abandonment is authorized.");
  }
}
function validateWorkflow(value: CleanupWorkflow | null, id: string, organizationId: string, live: ReadonlySet<string>): CleanupWorkflow {
  if (!value || value.id !== id || value.organizationId !== organizationId || !value.runs.length
    || !value.runs.some((run) => run.id === value.rootRunId)
    || value.runs.some((run) => run.workflowId !== id)) {
    throw new Error(`Cleanup refused: missing or inconsistent workflow ${id}.`);
  }
  assertOwners([...value.owners, ...value.runs], organizationId, live);
  return value;
}

/** Cleanup only: callers retain the failed scenario verdict before explicit abandonment. */
export async function settleCleanupWork(
  store: CleanupStore, mutate: (path: string) => Promise<void>, botId: string,
  organizationId: string, live: ReadonlySet<string>, timeoutMs: number,
  clock = { now: () => Date.now(), sleep: (ms: number) => Bun.sleep(ms) },
): Promise<void> {
  const deadline = clock.now() + timeoutMs;
  const budget = () => { if (clock.now() >= deadline) throw new Error(`Cleanup settlement timed out for owned bot ${botId}; deletion refused.`); };
  const relatedWorkflows = async (runs: CleanupRun[]): Promise<CleanupWorkflow[]> => {
    const related: CleanupWorkflow[] = [];
    for (const id of new Set(runs.flatMap((run) => run.workflowId ? [run.workflowId] : []))) {
      const workflow = validateWorkflow(await store.workflow(id), id, organizationId, live);
      if (runs.some((run) => run.workflowId === id && !workflow.runs.some((member) => member.id === run.id))) {
        throw new Error(`Cleanup refused: standalone child is missing from workflow ${id}.`);
      }
      related.push(workflow);
    }
    return related;
  };
  const targets = await store.targets(botId);
  assertOwners([{ botId, organizationId }, ...targets], organizationId, live);
  const workflows = [...new Set(targets.flatMap((run) => run.workflowId ? [run.workflowId] : []))];
  // Preflight the complete target set before the first mutation.
  for (const id of workflows) validateWorkflow(await store.workflow(id), id, organizationId, live);
  for (const run of targets.filter((target) => !target.workflowId)) {
    const snapshot = await store.standalone(run.id);
    if (!snapshot || snapshot.run.id !== run.id || snapshot.run.workflowId !== null) throw new Error(`Cleanup refused: standalone run ${run.id} changed ownership.`);
    assertOwners([snapshot.run, ...snapshot.affectedRuns, ...snapshot.owners], organizationId, live);
    await relatedWorkflows(snapshot.affectedRuns);
    if ([snapshot.run, ...snapshot.affectedRuns].some((member) => member.status === "unknown")) {
      throw new Error(`Cleanup refused: unknown standalone run ${run.id} or child has no safe workflow to abandon; explicit operator reconciliation required.`);
    }
  }
  for (const id of workflows) {
    let cancelled = false;
    let abandoned = false;
    while (true) {
      budget();
      const value = validateWorkflow(await store.workflow(id), id, organizationId, live);
      budget();
      const active = value.runs.some((run) => ACTIVE_RUNS.includes(run.status));
      const unknown = value.runs.some((run) => run.status === "unknown");
      if (TERMINAL_WORKFLOWS.includes(value.status) && value.runs.every((run) => TERMINAL_RUNS.includes(run.status))) break;
      if (!cancelled && (ACTIVE_WORKFLOWS.includes(value.status) || active)) {
        await mutate(`/api/workflows/${id}/cancel`);
        cancelled = true;
      } else if (!active && (value.status === "unknown" || unknown) && !abandoned) {
        if (!["unknown", "failed", "expired"].includes(value.status)) throw new Error(`Cleanup refused: inconsistent unknown workflow ${id}.`);
        await mutate(`/api/workflows/${id}/abandon`);
        abandoned = true;
      }
      await clock.sleep(Math.min(250, Math.max(0, deadline - clock.now())));
    }
  }
  for (const target of targets.filter((run) => !run.workflowId)) {
    let cancelled = false;
    while (true) {
      budget();
      const snapshot = await store.standalone(target.id);
      const run = snapshot?.run;
      if (!snapshot || !run || run.id !== target.id || run.workflowId !== null) throw new Error(`Cleanup refused: standalone run ${target.id} changed ownership.`);
      assertOwners([run, ...snapshot.affectedRuns, ...snapshot.owners], organizationId, live);
      // Cancelling a courier also updates each child's workflow envelope.
      // Audit its whole ownership boundary, but never broaden cancellation.
      const related = await relatedWorkflows(snapshot.affectedRuns);
      budget();
      const relatedSettled = related.every((workflow) => TERMINAL_WORKFLOWS.includes(workflow.status)
        && workflow.runs.every((member) => TERMINAL_RUNS.includes(member.status)));
      if ([run, ...snapshot.affectedRuns].every((member) => TERMINAL_RUNS.includes(member.status)) && relatedSettled) break;
      if (related.some((workflow) => workflow.status === "unknown" || workflow.runs.some((member) => member.status === "unknown"))) {
        throw new Error(`Cleanup refused: standalone child workflow is unknown; explicit operator reconciliation required.`);
      }
      if ([run, ...snapshot.affectedRuns].some((member) => member.status === "unknown")) throw new Error(`Cleanup refused: unknown standalone run ${run.id}; explicit operator reconciliation required.`);
      if (![...ACTIVE_RUNS, ...TERMINAL_RUNS].includes(run.status)) throw new Error(`Cleanup refused: unsupported run status ${run.status}.`);
      if (!cancelled) { await mutate(`/api/runs/${run.id}/cancel`); cancelled = true; }
      await clock.sleep(Math.min(250, Math.max(0, deadline - clock.now())));
    }
  }
  // Include newly queued work rather than deleting underneath a late handoff.
  if ((await store.targets(botId)).length) throw new Error(`Cleanup refused: unsettled work remains for owned bot ${botId}.`);
}

export function cleanupStore(db: SQL): CleanupStore {
  return {
    async targets(botId) {
      return db<CleanupRun[]>`
        select r.id, r.status, r.workflow_id as "workflowId", r.bot_id as "botId", b.organization_id as "organizationId"
          from runs r left join bots b on b.id = r.bot_id and b.organization_id = r.organization_id
          left join threads t on t.id = r.thread_id and t.organization_id = r.organization_id
         where ((r.bot_id = ${botId} or r.caller_bot_id = ${botId} or r.handoff_target_bot_id = ${botId}
              or t.bot_id = ${botId} or (t.group_id is not null and exists (
                select 1 from group_members member where member.organization_id = r.organization_id
                  and member.group_id = t.group_id and member.bot_id = ${botId})))
            and r.status in ('queued','starting','running','awaiting_approval','relaying','unknown'))
            or r.id in (select w.root_run_id from workflows w where w.root_bot_id = ${botId}
              and w.status in ('queued','running','awaiting_approval','reconciling','unknown'))`;
    },
    async standalone(id) {
      const rows = await db<CleanupRun[]>`
        select r.id, r.status, r.workflow_id as "workflowId", r.bot_id as "botId", b.organization_id as "organizationId"
          from runs r left join bots b on b.id = r.bot_id and b.organization_id = r.organization_id where r.id = ${id}`;
      if (!rows[0]) return null;
      // The public run-cancel API also cancels a relaying courier's active
      // children. Verify every possible child, including a completed one,
      // and retain them in subsequent polls after the courier settles.
      const affectedRuns = await db<CleanupRun[]>`
        select r.id, r.status, r.workflow_id as "workflowId", r.bot_id as "botId", b.organization_id as "organizationId"
          from runs r left join bots b on b.id = r.bot_id and b.organization_id = r.organization_id
         where r.origin_run_id = ${id}`;
      const owners = await db<CleanupOwner[]>`
        with affected as (
          select r.organization_id, r.caller_bot_id, r.handoff_target_bot_id,
                 t.bot_id as thread_bot_id, t.group_id, t.organization_id as thread_organization_id
            from runs r left join threads t on t.id = r.thread_id and t.organization_id = r.organization_id
           where r.id = ${id} or r.origin_run_id = ${id}
        ), boundary as (
          select thread_bot_id as bot_id, thread_organization_id as organization_id from affected where group_id is null
          union all select gm.bot_id, gm.organization_id from affected a join group_members gm on gm.group_id = a.group_id
          union all select null::uuid, null::uuid from affected a where a.group_id is not null and (
            not exists (select 1 from bot_groups g where g.id = a.group_id and g.organization_id = a.organization_id)
            or not exists (select 1 from group_members gm where gm.group_id = a.group_id))
          union all select caller_bot_id, organization_id from affected where caller_bot_id is not null
          union all select handoff_target_bot_id, organization_id from affected where handoff_target_bot_id is not null
        ) select boundary.bot_id as "botId", b.organization_id as "organizationId"
          from boundary left join bots b on b.id = boundary.bot_id and b.organization_id = boundary.organization_id`;
      return { run: rows[0], affectedRuns, owners };
    },
    async workflow(id) {
      const rows = await db<CleanupWorkflow[]>`
        select w.id, w.organization_id as "organizationId", w.status, w.root_run_id as "rootRunId",
          (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'workflowId', r.workflow_id,
            'botId', r.bot_id, 'organizationId', b.organization_id)), '[]'::jsonb)
            from runs r left join bots b on b.id = r.bot_id and b.organization_id = r.organization_id where r.workflow_id = w.id) as runs,
          (select coalesce(jsonb_agg(jsonb_build_object('botId', o.bot_id, 'organizationId', b.organization_id)), '[]'::jsonb)
             from (
               select w.root_bot_id as bot_id, w.organization_id
               union all select t.bot_id, t.organization_id where t.group_id is null
               union all select gm.bot_id, gm.organization_id from group_members gm where gm.group_id = t.group_id
               union all select null::uuid, null::uuid where t.group_id is not null and (
                 not exists (select 1 from bot_groups g where g.id = t.group_id and g.organization_id = w.organization_id)
                 or not exists (select 1 from group_members gm where gm.group_id = t.group_id))
               union all select r.caller_bot_id, r.organization_id from runs r where r.workflow_id = w.id and r.caller_bot_id is not null
               union all select r.handoff_target_bot_id, r.organization_id from runs r where r.workflow_id = w.id and r.handoff_target_bot_id is not null
             ) o left join bots b on b.id = o.bot_id and b.organization_id = o.organization_id) as owners
          from workflows w left join threads t on t.id = w.thread_id and t.organization_id = w.organization_id
         where w.id = ${id}`;
      return rows[0] ?? null;
    },
  };
}

export async function settleBotCleanup(db: SQL, session: Session, botId: string, live: ReadonlySet<string>, timeoutMs: number): Promise<void> {
  await settleCleanupWork(cleanupStore(db), async (path) => { await session.api("POST", path, undefined, 204); },
    botId, session.organizationId, live, timeoutMs);
}
