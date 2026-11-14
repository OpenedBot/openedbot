import type { Db } from "@openedbot/platform-db";
import { withCredential } from "@openedbot/platform-db";
import { readWorkspaceAccess } from "./workspace-access";

/** Long-lived streams must not outlive their session or membership. */
export async function hasLiveWorkspaceSession(db: Db, input: {
  sessionId: string; credentialHash: string; organizationId: string; userId: string;
}): Promise<boolean> {
  return withCredential(db, input.credentialHash, async (tx) => {
    await tx`select set_config('app.organization_id', ${input.organizationId}, true)`;
    const rows = await tx<Array<{ id: string }>>`select s.id from sessions s
      where s.id = ${input.sessionId} and s.user_id = ${input.userId} and s.revoked_at is null and s.access_expires_at > now()
        and ((s.kind = 'web' and s.impersonated_by_staff_user_id is null) or s.organization_id = ${input.organizationId})`;
    if (!rows[0]) return false;
    const access = await readWorkspaceAccess(tx, input.userId, input.organizationId);
    return Boolean(access?.role);
  });
}
