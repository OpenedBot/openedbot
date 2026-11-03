import type { TransactionDb } from "@openedbot/platform-db";
import type { ThreadHistoryAnchor } from "../domain/thread-history-cursor";

export type ThreadHistorySelection = {
  anchors: ThreadHistoryAnchor[];
  runIds: string[];
  standaloneMessageIds: string[];
  hasMore: boolean;
};

/** A workflow root is one turn, including folded inputs and every child run. */
export async function selectThreadHistoryTx(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
  before: ThreadHistoryAnchor | null,
  limit: number,
): Promise<ThreadHistorySelection> {
  const rows = await tx<ThreadHistoryAnchor[]>`
    select kind, id, to_char(anchor_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
      from (
        (select 'run'::text as kind, run.id, run.created_at as anchor_time
          from runs run left join workflows workflow
            on workflow.organization_id = run.organization_id and workflow.id = run.workflow_id
         where run.organization_id = ${organizationId} and run.thread_id = ${threadId}
           and (run.workflow_id is null or workflow.root_run_id = run.id)
           and (${before === null} or (run.created_at, run.id, 'run'::text) <
             (${before?.createdAt ?? null}::timestamptz, ${before?.id ?? null}::uuid, ${before?.kind ?? null}::text))
         order by run.created_at desc, run.id desc limit ${limit + 1})
        union all
        (select 'message'::text as kind, message.id, message.created_at as anchor_time
          from messages message
         where message.organization_id = ${organizationId} and message.thread_id = ${threadId} and message.run_id is null
           and (${before === null} or (message.created_at, message.id, 'message'::text) <
             (${before?.createdAt ?? null}::timestamptz, ${before?.id ?? null}::uuid, ${before?.kind ?? null}::text))
         order by message.created_at desc, message.id desc limit ${limit + 1})
      ) anchors
     order by anchor_time desc, id desc, kind desc limit ${limit + 1}
  `;
  const anchors = rows.slice(0, limit);
  const rootIds = anchors.filter((anchor) => anchor.kind === "run").map((anchor) => anchor.id);
  const selectedRoots = await tx<Array<{ id: string; workflowId: string | null }>>`
    select run.id, run.workflow_id as "workflowId" from runs run
     where run.organization_id = ${organizationId} and run.thread_id = ${threadId}
       and run.id = any(${tx.array(rootIds, "UUID")}::uuid[])
  `;
  // A separate partial index keeps active turn lookup independent of old history.
  const active = before === null ? await tx<Array<{ id: string; workflowId: string | null }>>`
    select id, workflow_id as "workflowId" from runs
     where organization_id = ${organizationId} and thread_id = ${threadId}
       and (ended_at is null or status = 'unknown' or external_state = 'ambiguous')
  ` : [];
  const ids = [...new Set([...selectedRoots, ...active].map((run) => run.id))];
  const workflowIds = [...new Set([...selectedRoots, ...active].flatMap((run) => run.workflowId ? [run.workflowId] : []))];
  // An active child must bring its complete workflow, including its root.
  const expanded = await tx<Array<{ id: string }>>`
    select member.id from runs member
     where member.organization_id = ${organizationId} and member.thread_id = ${threadId}
       and (member.id = any(${tx.array(ids, "UUID")}::uuid[]) or member.workflow_id = any(${tx.array(workflowIds, "UUID")}::uuid[]))
  `;
  return { anchors, runIds: expanded.map((run) => run.id),
    standaloneMessageIds: anchors.filter((anchor) => anchor.kind === "message").map((anchor) => anchor.id),
    hasMore: rows.length > limit };
}
