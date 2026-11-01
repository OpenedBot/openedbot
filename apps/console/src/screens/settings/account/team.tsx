import { canManageWorkspaceMembers } from "@openedbot/contracts-api";
import { IconChevronRight } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { useAccountWorkspaces } from "../../../components/workspace/workspace-navigation";
import {
  CardSkeleton,
  ListRow,
  ListSection,
  Note,
  SectionHeading,
} from "../../../components/settings/primitives";
import { api, queryKeys } from "../../../lib/api";
import { activeOrganizationId } from "../../../lib/cloud-session";
import { isOwnFleet } from "../../../lib/organization-gate";
import { useT } from "../../../lib/i18n";
import { isOverlaySettingsPath, useSettingsOverlay } from "../../../lib/settings-overlay";
import { SettingsPane } from "../pane";
import { MembersCard } from "./account";
import { hasFleetConsole } from "../../../pro-console/slots";

/** Members of the signed-in user's active agency only. */
export function OrganizationTeamSettings() {
  const { t } = useT();
  const account = useAccountWorkspaces();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const organizationId = activeOrganizationId();
  const activeWorkspace = organizationId
    ? account.data?.workspaces.find((workspace) => workspace.id === organizationId) ?? null
    : null;
  const session = me.data;
  const isMobile = useIsMobile();
  const [mobileMemberInvitationAction, setMobileMemberInvitationAction] = useState<ReactNode>(null);

  if (account.isPending || me.isPending) {
    return (
      <SettingsPane>
        <SectionHeading
          title={t("settingsAccount.membersTitle")}
          description={t("settingsAccount.membersDescription")}
        />
        <CardSkeleton label={t("settingsAccount.loading")} rows={2} />
      </SettingsPane>
    );
  }

  if (account.error || me.error || !account.data || !session) {
    return (
      <SettingsPane>
        <SectionHeading
          title={t("settingsAccount.membersTitle")}
          description={t("settingsAccount.membersDescription")}
        />
        <Note tone="danger" role="alert">
          {account.error instanceof Error
            ? account.error.message
            : me.error instanceof Error
              ? me.error.message
              : t("settingsAccount.readError")}
        </Note>
      </SettingsPane>
    );
  }

  // Fail closed for client workspaces and stale/mismatched workspace context.
  // MembersCard only mounts after this proof, so client members are never
  // requested from an agency-client frame.
  if (!activeWorkspace || session.organization.id !== organizationId || session.session.role !== activeWorkspace.role) {
    return null;
  }

  if (!isOwnFleet(activeWorkspace)) {
    return (
      <SettingsPane>
        <SectionHeading
          title={t("settingsAccount.membersTitle")}
          description={t("fleet.selectedClient", { name: activeWorkspace.name })}
        />
        <Note tone="warning" role="alert">
          {t("settingsAccount.readOnly")}
        </Note>
      </SettingsPane>
    );
  }

  const canManage =
    session.session.canWrite && canManageWorkspaceMembers(session.session.role);

  return (
    <SettingsPane footer={isMobile ? mobileMemberInvitationAction : undefined}>
      <SectionHeading
        title={activeWorkspace.name}
        description={t("settingsAccount.membersDescription")}
      />
      <MembersCard
        canManage={canManage}
        impersonating={session.session.impersonation !== null}
        invitations
        viewerEmail={session.user.email}
        onMobileActionChange={setMobileMemberInvitationAction}
      />
      {hasFleetConsole() ? (
        <ListSection title={t("fleet.activeMandates")} description={t("fleet.activeMandatesDescription")}>
          <ListRow
            label={(
              <SettingsNavigationLink to="/settings/clients">
                {t("fleetClients.title")}
              </SettingsNavigationLink>
            )}
            description={t("fleetClients.teamLinkDescription")}
            value={<IconChevronRight className="size-4 text-muted-foreground" aria-hidden />}
          />
        </ListSection>
      ) : null}
    </SettingsPane>
  );
}

function SettingsNavigationLink({ to, children }: { to: string; children: ReactNode }) {
  const overlay = useSettingsOverlay();
  const router = useRouter();
  const className = "font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  if (overlay && isOverlaySettingsPath(to)) {
    return (
      <a
        href={router.buildLocation({ to }).publicHref}
        className={className}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          overlay.open(to);
        }}
      >
        {children}
      </a>
    );
  }
  return <Link to={to} className={className}>{children}</Link>;
}
