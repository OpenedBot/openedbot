import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { IconKey, IconLock, IconShieldCheck } from "@tabler/icons-react";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { useT } from "../../../lib/i18n";
import {
  ACTIONS,
  BUTTON,
  CardHeading,
  SettingsCard,
  StatusList,
  StatusRow,
  ToneBadge,
} from "../../../components/settings/primitives";
import { InsetGroupedRow, InsetGroupedSection, InsetGroupedStatic } from "../../../components/mobile/inset-grouped";
import { FleetA2APolicySettings, OrganizationPermissionRulesSettings } from "../../../pro-console/slots";
import { OrganizationPermissionPolicySettings } from "../../../components/settings/organization-permission-policy";
import { useSettingsModal } from "../../../lib/shell/settings-modal-context";
import { SettingsPane } from "../pane";

/**
 * Lecture des garanties du produit et de la politique A2A du client sélectionné.
 *
 * Les règles générales ci-dessous décrivent les invariants du client et de
 * l’API. Les réglages A2A apparaissent seulement dans le cadre d’un client
 * d’agence avec mandat actif et utilisent les opérations nommées de son runtime.
 *
 * Chaque phrase affichée doit rester vraie dans le code : plus de canal SSH
 * sortant depuis OHB-15 (`RuntimeAdminRequest = "disabled" | "local"`), les
 * secrets fournisseurs partent sur le canal HTTPS authentifié, l’API refuse
 * les origines HTTP non déclarées et les autorisations `session` / `always`.
 * Sur mobile, ces phrases se lisent en entier (`multiline`), jamais tronquées.
 */
export function PoliciesSettings() {
  const { t } = useT();
  // Dans la modale, son en-tête porte déjà le titre : celui-ci reste aux lecteurs d'écran.
  const inModal = useSettingsModal() !== null;
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [policyFooter, setPolicyFooter] = useState<ReactNode>(null);
  const [permissionFooter, setPermissionFooter] = useState<ReactNode>(null);

  if (isMobile) {
    return (
      <SettingsPane footer={permissionFooter ?? policyFooter ?? undefined}>
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
        <FleetA2APolicySettings mobile onMobileFooterChange={setPolicyFooter} />
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
          Les textes légaux étaient trois liens de 23 px posés côte à côte : au
          doigt, on vise la mauvaise mention une fois sur trois. Ces destinations
          deviennent des lignes de groupe, comme le reste de l'écran.
        */}
        <InsetGroupedSection caption={t("legal.navigationLabel")}>
          <InsetGroupedRow
            label={t("legal.mentions")}
            onClick={() => void navigate({ to: "/legal/$slug", params: { slug: "mentions" } })}
          />
          <InsetGroupedRow
            label={t("legal.privacy")}
            onClick={() => void navigate({ to: "/legal/$slug", params: { slug: "privacy" } })}
          />
          <InsetGroupedRow
            label={t("legal.terms")}
            onClick={() => void navigate({ to: "/legal/$slug", params: { slug: "terms" } })}
          />
        </InsetGroupedSection>
      </SettingsPane>
    );
  }

  return (
    <SettingsPane>
      <div>
        <h1 className={inModal ? "sr-only" : "text-base font-semibold tracking-tight"}>{t("settingsPolicies.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-sm text-muted-foreground">
          {t("settingsPolicies.description")}
        </p>
      </div>

      <SettingsCard className="space-y-4">
        <CardHeading
          title={t("settingsPolicies.approvalsTitle")}
          description={t("settingsPolicies.approvalsDescription")}
          action={<ToneBadge tone="success">{t("settingsPolicies.enforcedBadge")}</ToneBadge>}
        />
        <StatusList className="rounded-xl border border-border">
          <StatusRow label={t("settingsPolicies.decisionLabel")} value={t("settingsPolicies.decisionValue")} />
          <StatusRow label={t("settingsPolicies.permanentLabel")} value={t("settingsPolicies.permanentValue")} />
          <StatusRow label={t("settingsPolicies.expiryLabel")} value={t("settingsPolicies.expiryValue")} />
        </StatusList>
        <div className={ACTIONS}>
          <Link to="/settings/decisions" className={BUTTON.secondary}>
            <IconShieldCheck className="size-4" />
            {t("settingsPolicies.decisionsLink")}
          </Link>
        </div>
      </SettingsCard>

      <OrganizationPermissionPolicySettings />

      <OrganizationPermissionRulesSettings />

      <FleetA2APolicySettings />

      <SettingsCard className="space-y-4">
        <CardHeading
          title={t("settingsPolicies.runtimeTitle")}
          description={t("settingsPolicies.runtimeDescription")}
          action={<IconKey className="size-5 text-muted-foreground" aria-hidden="true" />}
        />
        <StatusList className="rounded-xl border border-border">
          <StatusRow label={t("settingsPolicies.rolesLabel")} value={t("settingsPolicies.rolesValue")} />
          <StatusRow label={t("settingsPolicies.adminChannelLabel")} value={t("settingsPolicies.adminChannelValue")} />
          <StatusRow label={t("settingsPolicies.draftLabel")} value={t("settingsPolicies.draftValue")} />
          <StatusRow label={t("settingsPolicies.secretsLabel")} value={t("settingsPolicies.secretsValue")} />
        </StatusList>
        <div className={ACTIONS}>
          <Link to="/settings/runtime" className={BUTTON.secondary}>
            {t("settingsPolicies.runtimeLink")}
          </Link>
        </div>
      </SettingsCard>

      <SettingsCard className="space-y-4">
        <CardHeading
          title={t("settingsPolicies.dataTitle")}
          description={t("settingsPolicies.dataDescription")}
          action={<IconLock className="size-5 text-muted-foreground" aria-hidden="true" />}
        />
        <StatusList className="rounded-xl border border-border">
          <StatusRow label={t("settingsPolicies.isolationLabel")} value={t("settingsPolicies.isolationValue")} />
          <StatusRow label={t("settingsPolicies.transportLabel")} value={t("settingsPolicies.transportValue")} />
          <StatusRow label={t("settingsPolicies.journalLabel")} value={t("settingsPolicies.journalValue")} />
        </StatusList>
        <div className={ACTIONS}>
          <Link to="/settings/security" className={BUTTON.secondary}>
            {t("settingsPolicies.securityLink")}
          </Link>
        </div>
      </SettingsCard>

      <nav aria-label={t("legal.navigationLabel")} className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <Link to="/legal/$slug" params={{ slug: "mentions" }} className="underline underline-offset-4 hover:text-foreground">
          {t("legal.mentions")}
        </Link>
        <Link to="/legal/$slug" params={{ slug: "privacy" }} className="underline underline-offset-4 hover:text-foreground">
          {t("legal.privacy")}
        </Link>
        <Link to="/legal/$slug" params={{ slug: "terms" }} className="underline underline-offset-4 hover:text-foreground">
          {t("legal.terms")}
        </Link>
      </nav>
    </SettingsPane>
  );
}
