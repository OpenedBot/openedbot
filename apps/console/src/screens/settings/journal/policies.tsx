import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { IconKey, IconLock, IconShieldCheck } from "@tabler/icons-react";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { useT } from "../../../lib/i18n";
import { ACTIONS, BUTTON, ListRow, ListSection, ToneBadge } from "../../../components/settings/primitives";
import { SettingsCardGrid } from "../../../components/settings/settings-card-grid";
import { InsetGroupedRow, InsetGroupedSection, InsetGroupedStatic } from "../../../components/mobile/inset-grouped";
import { FleetA2APolicySettings, OrganizationPermissionRulesSettings } from "../../../pro-console/slots";
import { OrganizationPermissionPolicySettings } from "../../../components/settings/organization-permission-policy";
import { YoloLeasesCard } from "../../../components/yolo/yolo-leases-card";
import { SettingsPane } from "../pane";

/**
 * Lecture des garanties du produit et de la politique A2A du client sélectionné.
 *
 * Les règles générales ci-dessous décrivent les invariants du client et de
 * l’API. Les réglages A2A apparaissent seulement dans le cadre d’un client
 * d’agence avec mandat actif et utilisent les opérations nommées de son runtime.
 *
 * Chaque phrase affichée doit rester vraie dans le code : plus de canal SSH
 * sortant depuis OHB-15 (`runtimeAdminChannels` vaut `{ local: false }`), les
 * secrets fournisseurs partent sur le canal HTTPS authentifié, l’API refuse
 * les origines HTTP non déclarées et les autorisations `session` / `always`.
 * Sur mobile, ces phrases se lisent en entier (`multiline`), jamais tronquées.
 */
export function PoliciesSettings() {
  const { t } = useT();
  // Dans la modale, son en-tête porte déjà le titre : celui-ci reste aux lecteurs d'écran.
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
        <YoloLeasesCard />
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
        <h1 className="text-base font-semibold tracking-tight">{t("settingsPolicies.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-sm text-muted-foreground">
          {t("settingsPolicies.description")}
        </p>
      </div>

      {/* Les garanties, en lecture seule : trois cartes côte à côte, une ligne
          par règle (`DESIGN.md` › Bureau › Regrouper et aligner). Les
          réglages modifiables suivent, pleine largeur. */}
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

      {/* À côté du plafond : les baux YOLO en cours et « Couper YOLO partout ». */}
      <YoloLeasesCard />

      <OrganizationPermissionRulesSettings />

      <FleetA2APolicySettings />

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
