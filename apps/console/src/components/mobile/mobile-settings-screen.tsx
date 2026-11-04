import type { ComponentType, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { IconLogout, IconRestore } from "@tabler/icons-react";
import { cn } from "@openedbot/browser-ui-kit";
import { api, queryKeys, runtimeQueryOptions } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { runtimeHealthLabel } from "../../lib/runtime/runtime-health";
import { useSignOut } from "../../lib/session/sign-out";
import { SHOW_DEV_SETTINGS } from "../../lib/shell/dev-settings-ui";
import { SETTINGS_GROUPS, useVisibleSettingsGroups } from "../dashboard/settings-sidebar";
import {
  DevOnboardingRestartDialog,
  useDevOnboardingAvailable,
  useDevOnboardingRestart,
} from "../settings/dev-onboarding-restart";
import {
  InsetGroupedRow,
  InsetGroupedRowInner,
  InsetGroupedSection,
  insetGroupedRowClassName,
} from "./inset-grouped";

/**
 * L'écran racine des réglages sur mobile : Inset Grouped (`DESIGN.md`),
 * les mêmes groupes que `SETTINGS_GROUPS`.
 */

type SettingsIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

function GroupList({ label, children }: { label: string; children: ReactNode }) {
  return <InsetGroupedSection caption={label}>{children}</InsetGroupedSection>;
}

function SettingsDestination({
  url,
  icon,
  label,
  onSelect,
  disabled,
}: {
  url: string;
  icon?: SettingsIcon;
  label: string;
  onSelect?: (url: string) => void;
  disabled?: boolean;
}) {
  if (disabled) {
    return <InsetGroupedRow icon={icon} label={label} disabled />;
  }
  if (onSelect) {
    return <InsetGroupedRow icon={icon} label={label} onClick={() => onSelect(url)} />;
  }
  return (
    <li>
      <Link to={url} data-inset-grouped-row="" className={insetGroupedRowClassName}>
        <InsetGroupedRowInner icon={icon} label={label} />
      </Link>
    </li>
  );
}

/**
 * Les groupes de `/settings` (mobile) : liens sur l'écran, boutons dans
 * la feuille opérateur (`onSelect` pousse une rubrique sans quitter la scène).
 */
export function MobileSettingsGroups({
  onSelect,
}: {
  onSelect?: (url: string) => void;
}) {
  const { t } = useT();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const impersonating = me.data?.kind === "session" && me.data.session.impersonation !== null;
  const leaving = useSignOut();
  const restart = useDevOnboardingRestart();
  const restartAvailable = useDevOnboardingAvailable();
  const groups = useVisibleSettingsGroups(SETTINGS_GROUPS);

  return (
    <>
      {groups.map((group) => (
        <GroupList key={group.labelKey} label={t(group.labelKey)}>
          {group.items
            .filter((item) => !item.exact)
            .map((item) => (
              <SettingsDestination
                key={item.url}
                url={item.url}
                icon={item.icon}
                label={t(item.titleKey)}
                onSelect={onSelect}
                disabled={item.disabled}
              />
            ))}
        </GroupList>
      ))}

      <GroupList label={t("mobileShell.settingsAccount")}>
        {/* « Mon compte » est dans « Moi » : ce bloc ne garde que la session
            (et, en développement seulement, le retour à zéro de l'accueil). */}
        {SHOW_DEV_SETTINGS && restartAvailable ? (
          <InsetGroupedRow
            icon={IconRestore}
            label={
              restart.isPending
                ? t("settingsProfile.devWipeWorkspacePending")
                : t("settingsSidebar.devRestartOnboarding")
            }
            disabled={restart.isPending}
            onClick={restart.ask}
          />
        ) : null}
        <li>
          {me.data?.kind === "session" ? (
            <button
              type="button"
              data-inset-grouped-row=""
              disabled={leaving.isPending}
              onClick={() => leaving.mutate()}
              className={cn(insetGroupedRowClassName, "justify-center text-destructive-text disabled:opacity-60")}
            >
              <IconLogout className="size-[22px]" aria-hidden="true" />
              <span className="text-[17px] leading-[22px]">
                {leaving.isPending
                  ? t("mobileShell.signingOut")
                  : t(impersonating ? "mobileShell.leaveImpersonation" : "mobileShell.signOut")}
              </span>
            </button>
          ) : (
            <p className="px-4 py-3 text-center text-[13px] text-[var(--ohb-grouped-caption)]">
              {t("mobileShell.localSession")}
            </p>
          )}
        </li>
      </GroupList>
      <DevOnboardingRestartDialog restart={restart} />
    </>
  );
}

export function MobileSettingsScreen() {
  const { t, locale } = useT();
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const runtime = useQuery(runtimeQueryOptions());
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });

  const operator = roster.data?.operator ?? null;
  const identity = operator
    ? t("navUser.handle", { username: operator.username })
    : me.data?.kind === "session"
      ? me.data.user.email
      : t("navUser.operator");
  const health = runtimeHealthLabel(runtime.data, runtime.error, locale);
  const impersonating = me.data?.kind === "session" && me.data.session.impersonation !== null;

  return (
    <div
      data-mobile-settings=""
      className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto bg-[var(--ohb-grouped-canvas)] pb-[max(1.5rem,var(--ohb-safe-bottom))]"
    >
      <section data-inset-grouped="" className="px-4 pt-6">
        <Link
          to="/settings/account"
          data-inset-grouped-row=""
          className={cn(insetGroupedRowClassName, "rounded-[20px] bg-[var(--ohb-grouped-card)]")}
        >
          <InsetGroupedRowInner
            label={identity}
            subtitle={impersonating
              ? t("navUser.impersonationReadOnly")
              : runtime.data?.name?.trim() ? `${runtime.data.name} · ${health}` : health}
          />
        </Link>
      </section>

      <MobileSettingsGroups />
    </div>
  );
}
