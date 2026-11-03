import type { AccountWorkspace, AgencyBusinessSummary, MetricsPeriod } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { HttpError } from "@openedbot/contracts-errors/http-error";

export type AgencyDirectoryPage = { authorizedTotal: number; filteredTotal: number; workspaces: AccountWorkspace[] };

async function withAgency<T>(db: Db, userId: string, agencyId: string, read: (tx: Bun.TransactionSQL) => Promise<T>): Promise<T> {
  try {
    return await withTenant(db, agencyId, async (tx) => {
      await tx`select set_config('app.authenticating_user_id', ${userId}, true)`;
      return read(tx);
    });
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { errno?: string; code?: string }).errno ?? (error as { code?: string }).code : null;
    if (code === "42501") throw new HttpError(403, "WORKSPACE_ACCESS_REVOKED", "Vous n’avez plus accès à cette agence.");
    throw error;
  }
}

export async function readAgencyDirectory(db: Db, userId: string, agencyId: string, page: number, search = ""): Promise<AgencyDirectoryPage> {
  const rows = await withAgency(db, userId, agencyId, (tx) => tx<Array<{ data: AgencyDirectoryPage }>>`
    select agency_client_directory(${userId}::uuid, ${agencyId}::uuid, ${search}, ${page * 25}, 25) as data`);
  if (!rows[0]?.data) throw new Error("Agency directory unavailable");
  return rows[0].data;
}

export async function readAgencyBusinessSummary(db: Db, userId: string, agencyId: string, period: MetricsPeriod, now: Date): Promise<AgencyBusinessSummary> {
  const rows = await withAgency(db, userId, agencyId, (tx) => tx<Array<{ data: AgencyBusinessSummary }>>`
    select agency_business_summary(${userId}::uuid, ${agencyId}::uuid, ${period.from}::timestamptz,
      ${period.until}::timestamptz, ${now.toISOString()}::timestamptz) as data`);
  if (!rows[0]?.data) throw new Error("Agency summary unavailable");
  return rows[0].data;
}

export async function readAgencyClientWorkspace(db: Db, userId: string, agencyId: string, clientId: string): Promise<AccountWorkspace> {
  return withTenant(db, clientId, async (tx) => {
    const access = await tx<Array<{ ids: string[] }>>`select via_agency_ids as ids from workspace_access(${userId}::uuid, ${clientId}::uuid)`;
    if (!access[0]?.ids.includes(agencyId)) throw new HttpError(403, "WORKSPACE_ACCESS_REVOKED", "Vous n’avez plus accès à ce client.");
    const rows = await tx<Array<{ id: string; name: string; slug: string }>>`select id, name, slug from organizations where id = ${clientId} and deleted_at is null`;
    if (!rows[0]) throw new HttpError(403, "WORKSPACE_ACCESS_REVOKED", "Vous n’avez plus accès à ce client.");
    return { ...rows[0], kind: "personal", role: "agency", viaAgencyIds: [agencyId] };
  });
}
