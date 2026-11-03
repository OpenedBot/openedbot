import { isUuid } from "@openedbot/contracts-primitives";
import type { AgencyAuditEventDto, AgencyAuditPageDto } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { assertWorkspaceId } from "../domain/workspace-access";
import { readWorkspaceAccess } from "../sql/workspace-access";

const AGENCY_AUDIT_LIMIT = 50;
const AGENCY_AUDIT_CURSOR_MAX_LENGTH = 128;
const AGENCY_AUDIT_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

export type AgencyAuditCursor = { occurredAt: string; id: string };

export type AgencyAuditPageInput = {
  userId: string;
  agencyId: string;
  clientId: string;
  after?: string | null;
  limit?: number;
};

function cursorInvalid(): HttpError {
  return new HttpError(400, "AGENCY_AUDIT_CURSOR_INVALID", "Curseur d’historique invalide.");
}

function isCursorTimestamp(value: string): boolean {
  const parts = AGENCY_AUDIT_TIMESTAMP.exec(value);
  if (!parts) return false;

  const datePart = `${parts[1]}-${parts[2]}-${parts[3]}`;
  const midnight = new Date(`${datePart}T00:00:00.000Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== datePart) return false;

  return Number(parts[4]) <= 23 && Number(parts[5]) <= 59 && Number(parts[6]) <= 59;
}

export function encodeCursor(cursor: AgencyAuditCursor): string {
  return btoa(`${cursor.occurredAt}\n${cursor.id}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeCursor(value: string | null | undefined): AgencyAuditCursor | null {
  if (value === undefined || value === null) return null;
  if (value.length === 0 || value.length > AGENCY_AUDIT_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw cursorInvalid();
  }

  const encoded = value.replace(/-/g, "+").replace(/_/g, "/");
  let decoded: string;
  try {
    decoded = atob(encoded + "=".repeat((4 - (encoded.length % 4)) % 4));
  } catch {
    throw cursorInvalid();
  }

  const split = decoded.indexOf("\n");
  if (split < 0 || split !== decoded.lastIndexOf("\n")) throw cursorInvalid();
  const cursor = { occurredAt: decoded.slice(0, split), id: decoded.slice(split + 1) };
  if (!isCursorTimestamp(cursor.occurredAt) || !isUuid(cursor.id) || encodeCursor(cursor) !== value) {
    throw cursorInvalid();
  }
  return cursor;
}

export function parseLimit(limit: number | undefined): number {
  if (limit === undefined) return AGENCY_AUDIT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENCY_AUDIT_LIMIT) {
    throw new HttpError(400, "AGENCY_AUDIT_LIMIT_INVALID", "Limite d’historique invalide.");
  }
  return limit;
}

/** Read only the current selected agency grant's membership history inside the client tenant. */
export async function readAgencyAuditPage(db: Db, input: AgencyAuditPageInput): Promise<AgencyAuditPageDto> {
  const agencyId = assertWorkspaceId(input.agencyId);
  const clientId = assertWorkspaceId(input.clientId);
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.after);

  return withTenant(db, clientId, async (tx) => {
    const access = await readWorkspaceAccess(tx, input.userId, clientId);
    if (!access?.viaAgencyIds.includes(agencyId)) {
      throw new HttpError(403, "WORKSPACE_ACCESS_REVOKED", "Vous n’avez plus accès à ce client.");
    }

    const rows = cursor
      ? await tx<AgencyAuditEventDto[]>`
          select id, kind, role, actor_user_id as "actorUserId",
            to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt"
            from membership_events
           where organization_id = ${clientId}
             and subject_organization_id = ${agencyId}
             and kind in ('agency_granted', 'agency_revoked')
             and (occurred_at, id) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)
           order by occurred_at desc, id desc
           limit ${limit + 1}
        `
      : await tx<AgencyAuditEventDto[]>`
          select id, kind, role, actor_user_id as "actorUserId",
            to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "occurredAt"
            from membership_events
           where organization_id = ${clientId}
             and subject_organization_id = ${agencyId}
             and kind in ('agency_granted', 'agency_revoked')
           order by occurred_at desc, id desc
           limit ${limit + 1}
        `;

    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;
    const last = events[events.length - 1];
    return {
      events,
      nextCursor: hasMore && last ? encodeCursor({ occurredAt: last.occurredAt, id: last.id }) : null,
      hasMore,
      limit,
    };
  });
}
