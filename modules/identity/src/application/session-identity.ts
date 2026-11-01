import type { OrganizationKind, WorkspaceRole } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { withCredential, withTenant } from "@openedbot/platform-db";
import { EMPTY_WORKSPACE_ID } from "../domain/workspace-access";
import { readAccountIdentity, readLivingOrganizationSummary, readUserEmail } from "../sql/accounts";
import { findLiveSession } from "../sql/sessions";
import { readWorkspaceAccess } from "../sql/workspace-access";

/** Ce qu'une route PUBLIQUE peut apprendre d'une session vivante, CSRF compris. */
export type LiveSessionIdentity = {
  userId: string;
  organizationId: string;
  email: string;
  csrfHash: string | null;
};

/**
 * Résout la session d'un justificatif SANS rien exiger : `null` quand il
 * n'ouvre plus rien, quand l'adhésion manque ou quand le compte n'a pas
 * d'adresse. L'identité vient de la BASE, jamais du corps de la requête.
 */
export async function resolveSessionIdentity(db: Db, credentialHash: string): Promise<LiveSessionIdentity | null> {
  return withCredential(db, credentialHash, async (tx) => {
    const found = await findLiveSession(tx, credentialHash);
    if (!found) return null;
    const sessionOrganization = found.organizationId ?? EMPTY_WORKSPACE_ID;
    await tx`select set_config('app.organization_id', ${sessionOrganization}, true)`;
    const access = await readWorkspaceAccess(tx, found.userId, sessionOrganization);
    if (!access?.role && (found.kind !== "web" || found.impersonatedByStaffUserId)) return null;
    const email = await readUserEmail(tx, found.userId);
    if (!email) return null;
    return { userId: found.userId, organizationId: sessionOrganization, email, csrfHash: found.csrfHash };
  });
}

export type AccountIdentityView = {
  user: { id: string; email: string; displayName: string | null } | undefined;
  organization: { id: string; slug: string; name: string; kind: OrganizationKind } | undefined;
  role: WorkspaceRole;
  mustChangePassword: boolean;
};

/**
 * `mustChangePassword` voyage avec l'identité, et pas dans une lecture à
 * part : le garde de route de la PWA le consulte à chaque navigation, et
 * deux lectures pourraient se contredire le temps d'un changement de mot
 * de passe.
 */
export async function readAccountIdentityView(
  db: Db,
  input: { userId: string; organizationId: string },
): Promise<AccountIdentityView> {
  return withTenant(db, input.organizationId, async (tx) => {
    const user = await readAccountIdentity(tx, input.userId);
    const organization = await readLivingOrganizationSummary(tx, input.organizationId);
    const access = organization ? await readWorkspaceAccess(tx, input.userId, input.organizationId) : null;
    return {
      user: user ? { id: user.id, email: user.email, displayName: user.displayName } : undefined,
      organization: organization ?? undefined,
      role: access?.role ?? "member",
      mustChangePassword: user?.mustChangePassword === true,
    };
  });
}
