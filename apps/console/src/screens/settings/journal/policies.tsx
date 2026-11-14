import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { IconKey, IconLock, IconShieldCheck } from "@tabler/icons-react";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { useT } from "../../../lib/i18n";
import { ACTIONS, BUTTON, ListRow, ListSection, ToneBadge } from "../../../components/settings/primitives";
import { SettingsCardGrid } from "../../../components/settings/settings-card-grid";
import { InsetGroupedRow, InsetGroupedSection, InsetGroupedStatic } from "../../../components/mobile/inset-grouped";
import { OrganizationPermissionRulesSettings } from "../../../pro-console/slots";
import { OrganizationPermissionPolicySettings } from "../../../components/settings/organization-permission-policy";
import { SettingsPane } from "../pane";

/**
 * Reading of the product guarantees.
 *
 * The general rules below describe the invariants of the client and of
 * the API.
 *
 * Each displayed sentence must stay true in the code: no more outgoing SSH
 * channel (`runtimeAdminChannels` is `{ local: false }`), the
 * provider secrets leave on the authenticated HTTPS channel, the API refuses
 * undeclared HTTP origins and the `session` / `always` authorizations.
 * On mobile, these sentences are read in full (`multiline`), never truncated.
 */
export function PoliciesSettings() {
  const { t } = useT();
  // In the modal, its header already carries the title: this one stays for screen readers.
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [permissionFooter, setPermissionFooter] = useState<ReactNode>(null);

  if (isMobile) {
    return (
      <SettingsPane footer={permissionFooter ?? undefined}>
        <InsetGroupedSection caption={t("settingsPolicies.approvalsTitle")}>
          <InsetGroupedStatic multiline label={t("settingsPolicies.decisionLabel")} value={t("settingsPolicies.decisionValue")} />
          <InsetGroupedStatic multiline label={t("settingsPolicies.permanentLabel")} value={t("settingsPolicies.permanentValue")} />
          <InsetGroupedStatic multiline label={t("settingsPolicies.expiryLabel")} value={t("settingsPolicies.expiryValue")} />
          <InsetGroupedRow
            icon={IconShieldCheck}
            label={t("settingsPolicies.decisionsLink")}
            onClick={() => void navigate({ to: "/settings/decisions" })}
          />
        </InsetGroupedSection>
        <InsetGroupedSection caption={t("settingsPolicies.runtimeTitle")}>
          <InsetGroupedStatic multiline label={t("settingsPolicies.rolesLabel")} value={t("settingsPolicies.rolesValue")} />
          <InsetGroupedStatic
            multiline
            label={t("settingsPolicies.adminChannelLabel")}
            value={t("settingsPolicies.adminChannelValue")}
          />
          <InsetGroupedStatic multiline label={t("settingsPolicies.draftLabel")} value={t("settingsPolicies.draftValue")} />
          <InsetGroupedStatic multiline label={t("settingsPolicies.secretsLabel")} value={t("settingsPolicies.secretsValue")} />
          <InsetGroupedRow
            icon={IconKey}
            label={t("settingsPolicies.runtimeLink")}
            onClick={() => void navigate({ to: "/settings/runtime" })}
          />
        </InsetGroupedSection>
        <OrganizationPermissionPolicySettings mobile onMobileFooterChange={setPermissionFooter} />
        <OrganizationPermissionRulesSettings />
        <InsetGroupedSection caption={t("settingsPolicies.dataTitle")}>
          <InsetGroupedStatic multiline label={t("settingsPolicies.isolationLabel")} value={t("settingsPolicies.isolationValue")} />
          <InsetGroupedStatic multiline label={t("settingsPolicies.transportLabel")} value={t("settingsPolicies.transportValue")} />
          <InsetGroupedStatic multiline label={t("settingsPolicies.journalLabel")} value={t("settingsPolicies.journalValue")} />
          <InsetGroupedRow
            icon={IconLock}
            label={t("settingsPolicies.securityLink")}
            onClick={() => void navigate({ to: "/settings/security" })}
          />
        </InsetGroupedSection>
        {/*
          The legal texts were three 23 px links set side by side: with a
          finger, one hits the wrong notice one time in three. These destinations
          become group rows, like the rest of the screen.
        */}
        <InsetGroupedSection caption={t("legal.navigationLabel")}>
          <InsetGroupedRow
            label={t("legal.mentions")}
            onClick={() => openLegalPage("mentions")}
          />
          <InsetGroupedRow
            label={t("legal.privacy")}
            onClick={() => openLegalPage("privacy")}
          />
          <InsetGroupedRow
            label={t("legal.terms")}
            onClick={() => openLegalPage("terms")}
          />
        </InsetGroupedSection>
      </SettingsPane>
    );
  }

  return (
    <SettingsPane>
      <div>
        <h1 className="text-base font-semibold tracking-tight">{t("settingsPolicies.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-sm text-muted-foreground">
          {t("settingsPolicies.description")}
        </p>
      </div>

      {/* The guarantees, read only: three cards side by side, one row
          per rule (`DESIGN.md` › Bureau › Regrouper et aligner). The
          editable settings follow, full width. */}
      <SettingsCardGrid trio>
        <ListSection
          title={t("settingsPolicies.approvalsTitle")}
          description={t("settingsPolicies.approvalsDescription")}
          action={<ToneBadge tone="success">{t("settingsPolicies.enforcedBadge")}</ToneBadge>}
          footer={<div className={ACTIONS}><Link to="/settings/decisions" className={BUTTON.secondary}><IconShieldCheck className="size-4" />{t("settingsPolicies.decisionsLink")}</Link></div>}
        >
          <ListRow label={t("settingsPolicies.decisionLabel")} description={t("settingsPolicies.decisionValue")} />
          <ListRow label={t("settingsPolicies.permanentLabel")} description={t("settingsPolicies.permanentValue")} />
          <ListRow label={t("settingsPolicies.expiryLabel")} description={t("settingsPolicies.expiryValue")} />
        </ListSection>
        <ListSection
          title={t("settingsPolicies.runtimeTitle")}
          description={t("settingsPolicies.runtimeDescription")}
          action={<IconKey className="size-5 text-muted-foreground" aria-hidden="true" />}
          footer={<div className={ACTIONS}><Link to="/settings/runtime" className={BUTTON.secondary}>{t("settingsPolicies.runtimeLink")}</Link></div>}
        >
          <ListRow label={t("settingsPolicies.rolesLabel")} description={t("settingsPolicies.rolesValue")} />
          <ListRow label={t("settingsPolicies.adminChannelLabel")} description={t("settingsPolicies.adminChannelValue")} />
          <ListRow label={t("settingsPolicies.draftLabel")} description={t("settingsPolicies.draftValue")} />
          <ListRow label={t("settingsPolicies.secretsLabel")} description={t("settingsPolicies.secretsValue")} />
        </ListSection>
        <ListSection
          title={t("settingsPolicies.dataTitle")}
          description={t("settingsPolicies.dataDescription")}
          action={<IconLock className="size-5 text-muted-foreground" aria-hidden="true" />}
          footer={<div className={ACTIONS}><Link to="/settings/security" className={BUTTON.secondary}>{t("settingsPolicies.securityLink")}</Link></div>}
        >
          <ListRow label={t("settingsPolicies.isolationLabel")} description={t("settingsPolicies.isolationValue")} />
          <ListRow label={t("settingsPolicies.transportLabel")} description={t("settingsPolicies.transportValue")} />
          <ListRow label={t("settingsPolicies.journalLabel")} description={t("settingsPolicies.journalValue")} />
        </ListSection>
      </SettingsCardGrid>

      <OrganizationPermissionPolicySettings />

      <OrganizationPermissionRulesSettings />

      <nav aria-label={t("legal.navigationLabel")} className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {LEGAL_SLUGS.map((slug) => (
          <a
            key={slug}
            href={legalPageUrl(slug)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            {t(`legal.${slug}`)}
          </a>
        ))}
      </nav>
    </SettingsPane>
  );
}

const LEGAL_SLUGS = ["mentions", "privacy", "terms"] as const;
type LegalSlug = (typeof LEGAL_SLUGS)[number];

/**
 * The legal texts open on the web, in the browser, and not in
 * the application: a public page (`/legal/<slug>`, the one the site's
 * footer also points at) that one reads, keeps or shares outside the
 * session. In the desktop app, a new tab goes to the system
 * browser.
 */
function legalPageUrl(slug: LegalSlug): string {
  // Relative to the console's origin: the browser resolves it, and the desktop
  // app receives the absolute address in `setWindowOpenHandler`.
  return `/legal/${slug}`;
}

function openLegalPage(slug: LegalSlug): void {
  window.open(legalPageUrl(slug), "_blank", "noopener,noreferrer");
}
