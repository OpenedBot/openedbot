import { isoInstant } from "@openedbot/contracts-primitives";
import { Hono } from "hono";
import type { AppVariables } from "../identity/auth";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type {
  InboxApprovalItemDto,
  InboxCountsDto,
  InboxDto,
  InboxItemDto,
  InboxNeedsReviewItemDto,
  InboxNeedsYouItemDto,
} from "@openedbot/contracts-api";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { approvalGateView, routineGateContext, type AlwaysGateRow, type RoutineGateContext } from "../conversation/approval-always";

const INBOX_LIMIT_DEFAULT = 50;
const INBOX_LIMIT_MAX = 200;

/** Same logic as `readHistoryLimit` (`workflow-routes.ts`): a parameter
 * out of bounds falls back to the default rather than producing an error. */
export function readInboxLimit(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return INBOX_LIMIT_DEFAULT;
  return Math.min(INBOX_LIMIT_MAX, parsed);
}

type ApprovalRow = Pick<AlwaysGateRow, "gateKind" | "toolKey" | "gateArgs"> & {
  approvalId: string;
  runId: string;
  threadId: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  summary: string | null;
  isDefaultThread: boolean;
  botId: string | null;
  botSlug: string | null;
  botName: string | null;
  botFace: unknown;
  groupId: string | null;
  groupName: string | null;
};

type NeedsReviewRow = {
  workflowId: string;
  threadId: string;
  status: "unknown" | "failed" | "expired";
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date | string;
  endedAt: Date | string | null;
  updatedAt: Date | string;
  isDefaultThread: boolean;
  botId: string | null;
  botSlug: string | null;
  botName: string | null;
  botFace: unknown;
  groupId: string | null;
  groupName: string | null;
  initiatorName: string | null;
  initiatorEmail: string | null;
};

type NeedsYouRow = {
  groupId: string;
  groupName: string;
  updatedAt: Date | string;
  threadId: string;
  isDefaultThread: boolean;
};

type CountsRow = { approval: number; needsReview: number; needsYou: number };

export function inboxRoutes(db: Db): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * The « à traiter » box: what is waiting for a human decision, all bots
   * together: pending approvals, workflows to review
   * (`unknown`/`failed`/`expired` without an `abandoned`/`retried` resolution),
   * rooms flagged « needs you ». Replaces
   * `/history`, which listed every sent message with its cost; that noise
   * stays in `WorkflowOverview` (workflows in flight), not here. Member
   * read: no `requireRole`.
   */
  routes.get("/inbox", async (context) => {
    const auth = context.get("auth");
    const url = new URL(context.req.url);
    const limit = readInboxLimit(url.searchParams.get("limit"));

    const [approvals, needsReview, needsYou, countsRows, routineGates] = await withTenant(
      db,
      auth.organizationId,
      async (tx) => {
        const read = await Promise.all([
          readApprovals(tx, auth.organizationId, limit),
          readNeedsReview(tx, auth.organizationId, limit),
          readNeedsYou(tx, auth.organizationId, limit),
          readCounts(tx, auth.organizationId),
        ] as const);
        return [...read, await routineGateContext(tx, auth.organizationId, read[0], context.req.header("accept-language"))] as const;
      },
    );

    return context.json(inboxDto(approvals, needsReview, needsYou, countsRows[0] ?? {
      approval: 0, needsReview: 0, needsYou: 0,
    }, routineGates));
  });

  return routes;
}

function readApprovals(tx: TransactionDb, organizationId: string, limit: number) {
  return tx<ApprovalRow[]>`
    select a.id as "approvalId", a.run_id as "runId", a.thread_id as "threadId",
           a.created_at as "createdAt", a.expires_at as "expiresAt",
           left(a.description, 160) as "summary",
           a.gate_kind as "gateKind", a.tool_key as "toolKey", a.gate_args as "gateArgs",
           t.is_default as "isDefaultThread",
           coalesce(r.bot_id, t.bot_id) as "botId",
           b.slug as "botSlug", b.name as "botName", b.face as "botFace",
           t.group_id as "groupId", g.name as "groupName"
      from approval_requests a
      join runs r on r.organization_id = a.organization_id and r.id = a.run_id
      join threads t on t.organization_id = a.organization_id and t.id = a.thread_id
      left join bots b on b.organization_id = a.organization_id and b.id = coalesce(r.bot_id, t.bot_id)
      left join bot_groups g on g.organization_id = a.organization_id and g.id = t.group_id
     where a.organization_id = ${organizationId}
       and a.status = 'pending' and a.forward_state = 'pending'
       -- A gate under automatic review (PERM2-7) is nobody's to answer yet.
       and a.decision_state is distinct from 'reviewing'
     -- Même prédicat que le fil (conversation-routes.ts) : pas de filtre sur
     -- expires_at, l'expiration est un fait du worker, pas de cette vue.
     order by a.created_at desc
     limit ${limit}
  `;
}

function readNeedsReview(tx: TransactionDb, organizationId: string, limit: number) {
  return tx<NeedsReviewRow[]>`
    select w.id as "workflowId", w.thread_id as "threadId", w.status,
           w.error_code as "errorCode", w.error_message as "errorMessage",
           w.created_at as "createdAt", w.ended_at as "endedAt", w.updated_at as "updatedAt",
           t.is_default as "isDefaultThread",
           b.id as "botId", b.slug as "botSlug", b.name as "botName", b.face as "botFace",
           t.group_id as "groupId", g.name as "groupName",
           u.display_name as "initiatorName", u.email as "initiatorEmail"
      from workflows w
      join threads t on t.organization_id = w.organization_id and t.id = w.thread_id
      left join bots b on b.organization_id = w.organization_id and b.id = w.root_bot_id
      left join bot_groups g on g.organization_id = w.organization_id and g.id = t.group_id
      left join users u on u.id = w.initiator_user_id
     where w.organization_id = ${organizationId}
       and w.status in ('unknown', 'failed', 'expired')
       and coalesce(w.recovery_state->>'resolution', '') not in ('abandoned', 'retried')
     order by coalesce(w.ended_at, w.updated_at) desc
     limit ${limit}
  `;
}

function readNeedsYou(tx: TransactionDb, organizationId: string, limit: number) {
  return tx<NeedsYouRow[]>`
    select g.id as "groupId", g.name as "groupName", g.updated_at as "updatedAt",
           t.id as "threadId", t.is_default as "isDefaultThread"
      from bot_groups g
      join threads t on t.organization_id = g.organization_id and t.group_id = g.id
     where g.organization_id = ${organizationId} and g.needs_you = true
     order by g.updated_at desc
     limit ${limit}
  `;
}

/** Counts independent of `limit`: three scalar subqueries, never a
 * `limit` passed here. */
function readCounts(tx: TransactionDb, organizationId: string) {
  return tx<CountsRow[]>`
    select
      (select count(*)::int from approval_requests a
         join runs r on r.organization_id = a.organization_id and r.id = a.run_id
         join threads t on t.organization_id = a.organization_id and t.id = a.thread_id
        where a.organization_id = ${organizationId}
          and a.status = 'pending' and a.forward_state = 'pending'
          and a.decision_state is distinct from 'reviewing') as "approval",
      (select count(*)::int from workflows w
         join threads t on t.organization_id = w.organization_id and t.id = w.thread_id
        where w.organization_id = ${organizationId}
          and w.status in ('unknown', 'failed', 'expired')
          and coalesce(w.recovery_state->>'resolution', '') not in ('abandoned', 'retried')) as "needsReview",
      (select count(*)::int from bot_groups g
         join threads t on t.organization_id = g.organization_id and t.group_id = g.id
        where g.organization_id = ${organizationId} and g.needs_you = true) as "needsYou"
  `;
}

export function inboxDto(
  approvals: ApprovalRow[],
  needsReview: NeedsReviewRow[],
  needsYou: NeedsYouRow[],
  counts: CountsRow,
  routineGates?: RoutineGateContext,
): InboxDto {
  const items: InboxItemDto[] = [
    ...approvals.map((row) => approvalItemDto(row, routineGates)),
    ...needsReview.map(needsReviewItemDto),
    ...needsYou.map(needsYouItemDto),
  ];
  const countsDto: InboxCountsDto = {
    approval: counts.approval,
    needsReview: counts.needsReview,
    needsYou: counts.needsYou,
    total: counts.approval + counts.needsReview + counts.needsYou,
  };
  return { items: sortInboxItems(items), counts: countsDto };
}

/** Stable sort by `occurredAt` descending: on a tie, the entry order
 * (approvals, then review, then needs-you) is preserved. */
export function sortInboxItems(items: InboxItemDto[]): InboxItemDto[] {
  return [...items].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}

function approvalItemDto(row: ApprovalRow, routineGates?: RoutineGateContext): InboxApprovalItemDto {
  // A `routine_manage` gate reads as what it is about to do, as in the thread.
  const described = approvalGateView(row, routineGates).detail;
  return {
    kind: "approval",
    id: row.approvalId,
    occurredAt: isoInstant(row.createdAt),
    approvalId: row.approvalId,
    runId: row.runId,
    summary: described ?? row.summary,
    expiresAt: isoInstant(row.expiresAt),
    threadId: row.threadId,
    isDefaultThread: row.isDefaultThread,
    botId: row.botId,
    botSlug: row.botSlug,
    botName: row.botName,
    botFace: (row.botFace ?? null) as BotFaceSpec | null,
    groupId: row.groupId,
    groupName: row.groupName,
  };
}

function needsReviewItemDto(row: NeedsReviewRow): InboxNeedsReviewItemDto {
  return {
    kind: "needs_review",
    id: row.workflowId,
    occurredAt: isoInstant(row.endedAt ?? row.updatedAt),
    workflowId: row.workflowId,
    status: row.status,
    recoveryState: row.status === "unknown" ? "needs_review" : null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: isoInstant(row.createdAt),
    endedAt: row.endedAt ? isoInstant(row.endedAt) : null,
    // The email never leaves the inbox: display name, otherwise the local
    // part, same rule as `workflow-routes.ts` (historyDto).
    initiatorName: row.initiatorName ?? (row.initiatorEmail ? row.initiatorEmail.split("@")[0]! : null),
    threadId: row.threadId,
    isDefaultThread: row.isDefaultThread,
    botId: row.botId,
    botSlug: row.botSlug,
    botName: row.botName,
    botFace: (row.botFace ?? null) as BotFaceSpec | null,
    groupId: row.groupId,
    groupName: row.groupName,
  };
}

function needsYouItemDto(row: NeedsYouRow): InboxNeedsYouItemDto {
  return {
    kind: "needs_you",
    id: row.groupId,
    occurredAt: isoInstant(row.updatedAt),
    threadId: row.threadId,
    isDefaultThread: row.isDefaultThread,
    botId: null,
    botSlug: null,
    botName: null,
    botFace: null,
    groupId: row.groupId,
    groupName: row.groupName,
  };
}
