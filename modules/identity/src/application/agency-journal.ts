import type {
  AgencyJournalEventDto,
  AgencyJournalEventKind,
  AgencyJournalPageDto,
} from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { assertWorkspaceId } from "../domain/workspace-access";
import { decodeCursor, encodeCursor, parseLimit, type AgencyAuditCursor } from "./agency-audit";

type AgencyJournalPageInput = {
  userId: string;
  agencyId: string;
  after?: string | null;
  limit?: number;
};

type AgencyJournalRow = {
  id: string;
  kind: AgencyJournalEventKind;
  role: string | null;
  actorUserId: string | null;
  actorLabel: string | null;
  subjectUserId: string | null;
  subjectLabel: string | null;
  subjectOrganizationId: string | null;
  subjectOrganizationName: string | null;
  occurredAt: string;
};

function journalForbidden(): HttpError {
  return new HttpError(403, "AGENCY_JOURNAL_FORBIDDEN", "Seuls les owners et admins de l’agence peuvent lire ce journal.");
}

function toEvent(row: AgencyJournalRow): AgencyJournalEventDto {
  return {
    id: row.id,
    kind: row.kind,
    role: row.role,
    actor: row.actorUserId && row.actorLabel ? { userId: row.actorUserId, label: row.actorLabel } : null,
    subjectUser: row.subjectUserId && row.subjectLabel
      ? { userId: row.subjectUserId, label: row.subjectLabel }
      : null,
    subjectOrganization: row.subjectOrganizationId && row.subjectOrganizationName
      ? { organizationId: row.subjectOrganizationId, name: row.subjectOrganizationName }
      : null,
    occurredAt: row.occurredAt,
  };
}

function journalRowsQuery(
  tx: Bun.TransactionSQL,
  input: { userId: string; agencyId: string; cursor: AgencyAuditCursor | null; limit: number },
): Promise<AgencyJournalRow[]> {
  const { userId, agencyId, cursor, limit } = input;
  return cursor
    ? tx<AgencyJournalRow[]>`
        with journal_events as (
          select me.id, me.kind, me.role, me.actor_user_id, me.subject_user_id,
            me.subject_organization_id, me.occurred_at
            from membership_events me
           where me.organization_id = ${agencyId}
             and me.kind not in ('agency_granted', 'agency_revoked')
          union all
          -- The schema does not require uuid-ossp. A deterministic UUID from md5
          -- keeps each virtual grant event stable and sortable by the cursor.
          select md5(ag.id::text || ':granted')::uuid, 'agency_granted', 'agency',
            ag.granted_by_user_id, null::uuid, ag.client_organization_id, ag.created_at
            from agency_grants ag
           where ag.agency_organization_id = ${agencyId}
          union all
          select md5(ag.id::text || ':revoked')::uuid, 'agency_revoked', 'agency',
            ag.revoked_by_user_id, null::uuid, ag.client_organization_id, ag.revoked_at
            from agency_grants ag
           where ag.agency_organization_id = ${agencyId} and ag.revoked_at is not null
        ),
        visible_users as (
          select m.user_id
            from memberships m
           where m.organization_id = ${agencyId} and m.revoked_at is null
          union
          select ag.granted_by_user_id
            from agency_grants ag
           where ag.agency_organization_id = ${agencyId} and ag.granted_by_user_id is not null
          union
          select ag.revoked_by_user_id
            from agency_grants ag
           where ag.agency_organization_id = ${agencyId} and ag.revoked_by_user_id is not null
        ),
        authorized_clients as (
          select (workspace->>'id')::uuid as id, workspace->>'name' as name
            from jsonb_array_elements(
              (agency_client_directory(${userId}::uuid, ${agencyId}::uuid, '', 0, 25)->'workspaces')
            ) as workspace
        ),
        labelled as (
          select je.id, je.kind, je.role,
            case when actor.id is not null and (nullif(btrim(actor.display_name), '') is not null or actor_visible.user_id is not null)
              then actor.id end as actor_user_id,
            case when actor.id is not null and (nullif(btrim(actor.display_name), '') is not null or actor_visible.user_id is not null)
              then coalesce(nullif(btrim(actor.display_name), ''), actor.email) end as actor_label,
            case when subject.id is not null and (nullif(btrim(subject.display_name), '') is not null or subject_visible.user_id is not null)
              then subject.id end as subject_user_id,
            case when subject.id is not null and (nullif(btrim(subject.display_name), '') is not null or subject_visible.user_id is not null)
              then coalesce(nullif(btrim(subject.display_name), ''), subject.email) end as subject_label,
            je.subject_organization_id,
            coalesce(authorized_clients.name, subject_organization.name) as subject_organization_name,
            je.occurred_at
            from journal_events je
            left join users actor on actor.id = je.actor_user_id
            left join visible_users actor_visible on actor_visible.user_id = actor.id
            left join users subject on subject.id = je.subject_user_id
            left join visible_users subject_visible on subject_visible.user_id = subject.id
            left join authorized_clients on authorized_clients.id = je.subject_organization_id
            left join organizations subject_organization on subject_organization.id = je.subject_organization_id
        )
        select id, kind, role, actor_user_id as "actorUserId", actor_label as "actorLabel",
          subject_user_id as "subjectUserId", subject_label as "subjectLabel",
          subject_organization_id as "subjectOrganizationId",
          subject_organization_name as "subjectOrganizationName",
          to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt"
          from labelled
         where (occurred_at, id) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)
         order by occurred_at desc, id desc
         limit ${limit + 1}
      `
    : tx<AgencyJournalRow[]>`
        with journal_events as (
          select me.id, me.kind, me.role, me.actor_user_id, me.subject_user_id,
            me.subject_organization_id, me.occurred_at
            from membership_events me
           where me.organization_id = ${agencyId}
             and me.kind not in ('agency_granted', 'agency_revoked')
          union all
          -- The schema does not require uuid-ossp. A deterministic UUID from md5
          -- keeps each virtual grant event stable and sortable by the cursor.
          select md5(ag.id::text || ':granted')::uuid, 'agency_granted', 'agency',
            ag.granted_by_user_id, null::uuid, ag.client_organization_id, ag.created_at
            from agency_grants ag
           where ag.agency_organization_id = ${agencyId}
          union all
          select md5(ag.id::text || ':revoked')::uuid, 'agency_revoked', 'agency',
            ag.revoked_by_user_id, null::uuid, ag.client_organization_id, ag.revoked_at
            from agency_grants ag
           where ag.agency_organization_id = ${agencyId} and ag.revoked_at is not null
        ),
        visible_users as (
          select m.user_id
            from memberships m
           where m.organization_id = ${agencyId} and m.revoked_at is null
          union
          select ag.granted_by_user_id
            from agency_grants ag
           where ag.agency_organization_id = ${agencyId} and ag.granted_by_user_id is not null
          union
          select ag.revoked_by_user_id
            from agency_grants ag
           where ag.agency_organization_id = ${agencyId} and ag.revoked_by_user_id is not null
        ),
        authorized_clients as (
          select (workspace->>'id')::uuid as id, workspace->>'name' as name
            from jsonb_array_elements(
              (agency_client_directory(${userId}::uuid, ${agencyId}::uuid, '', 0, 25)->'workspaces')
            ) as workspace
        ),
        labelled as (
          select je.id, je.kind, je.role,
            case when actor.id is not null and (nullif(btrim(actor.display_name), '') is not null or actor_visible.user_id is not null)
              then actor.id end as actor_user_id,
            case when actor.id is not null and (nullif(btrim(actor.display_name), '') is not null or actor_visible.user_id is not null)
              then coalesce(nullif(btrim(actor.display_name), ''), actor.email) end as actor_label,
            case when subject.id is not null and (nullif(btrim(subject.display_name), '') is not null or subject_visible.user_id is not null)
              then subject.id end as subject_user_id,
            case when subject.id is not null and (nullif(btrim(subject.display_name), '') is not null or subject_visible.user_id is not null)
              then coalesce(nullif(btrim(subject.display_name), ''), subject.email) end as subject_label,
            je.subject_organization_id,
            coalesce(authorized_clients.name, subject_organization.name) as subject_organization_name,
            je.occurred_at
            from journal_events je
            left join users actor on actor.id = je.actor_user_id
            left join visible_users actor_visible on actor_visible.user_id = actor.id
            left join users subject on subject.id = je.subject_user_id
            left join visible_users subject_visible on subject_visible.user_id = subject.id
            left join authorized_clients on authorized_clients.id = je.subject_organization_id
            left join organizations subject_organization on subject_organization.id = je.subject_organization_id
        )
        select id, kind, role, actor_user_id as "actorUserId", actor_label as "actorLabel",
          subject_user_id as "subjectUserId", subject_label as "subjectLabel",
          subject_organization_id as "subjectOrganizationId",
          subject_organization_name as "subjectOrganizationName",
          to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt"
          from labelled
         order by occurred_at desc, id desc
         limit ${limit + 1}
      `;
}

export async function readAgencyJournalPage(
  db: Db,
  input: AgencyJournalPageInput,
): Promise<AgencyJournalPageDto> {
  const agencyId = assertWorkspaceId(input.agencyId);
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.after);

  return withTenant(db, agencyId, async (tx) => {
    await tx`select set_config('app.authenticating_user_id', ${input.userId}, true)`;
    const access = await tx<Array<{ kind: string; role: string }>>`
      select o.kind, m.role
        from organizations o
        join memberships m on m.organization_id = o.id and m.user_id = ${input.userId}
       where o.id = ${agencyId} and o.kind = 'agency' and o.deleted_at is null
         and m.revoked_at is null and m.role in ('owner', 'admin')
    `;
    if (!access[0]) throw journalForbidden();

    const rows = await journalRowsQuery(tx, { userId: input.userId, agencyId, cursor, limit });
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const events = pageRows.map(toEvent);
    const last = pageRows.at(-1);
    return {
      events,
      nextCursor: hasMore && last ? encodeCursor({ occurredAt: last.occurredAt, id: last.id }) : null,
      hasMore,
      limit,
    };
  });
}
