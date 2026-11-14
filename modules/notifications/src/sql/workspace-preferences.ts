import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import type { WorkflowEmailPreferences } from "@openedbot/contracts-api";

export async function workspacePreferences(
  db: Db,
  organizationId: string,
  userId: string,
  patch?: Partial<WorkflowEmailPreferences>,
): Promise<WorkflowEmailPreferences> {
  return withTenant(db, organizationId, async (tx) => {
    await tx`select set_config('app.authenticating_user_id',${userId},true)`;
    if (patch) {
      await tx`insert into user_workspace_preferences(organization_id,user_id) values(${organizationId},${userId}) on conflict do nothing`;
      await tx`update user_workspace_preferences set
        approval_enabled_at=case when ${patch.approval ?? null}::boolean is null then approval_enabled_at when ${patch.approval ?? false} then coalesce(approval_enabled_at,now()) else null end,
        completed_enabled_at=case when ${patch.completed ?? null}::boolean is null then completed_enabled_at when ${patch.completed ?? false} then coalesce(completed_enabled_at,now()) else null end,
        failed_enabled_at=case when ${patch.failed ?? null}::boolean is null then failed_enabled_at when ${patch.failed ?? false} then coalesce(failed_enabled_at,now()) else null end,
        locale=coalesce(${patch.locale ?? null}::text,locale), checklist_hidden=coalesce(${patch.checklistHidden ?? null}::boolean,checklist_hidden)
        where organization_id=${organizationId} and user_id=${userId}`;
    }
    const rows = await tx<
      WorkflowEmailPreferences[]
    >`select approval_enabled_at is not null as approval,
      completed_enabled_at is not null as completed, failed_enabled_at is not null as failed,
      locale,checklist_hidden as "checklistHidden" from user_workspace_preferences
      where organization_id=${organizationId} and user_id=${userId}`;
    return (
      rows[0] ?? {
        approval: false,
        completed: false,
        failed: false,
        locale: "fr",
        checklistHidden: false,
      }
    );
  });
}
