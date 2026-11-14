import type { RuntimeLinkDto } from "@openedbot/contracts-api";
import { StatusRow, ToneBadge } from "../../../../components/settings/primitives";
import { connectorUpgradeLevel, hermesVersionState } from "../../../../lib/runtime/connector-upgrade";
import { useT } from "../../../../lib/i18n";

/**
 * What runs on the host, always shown in « Lien connecteur »: edge-setup and
 * Hermes, each up to date, behind, or unknown. The notices below give the
 * command; these rows only say the versions.
 */
export function RuntimeVersionRows({ link }: { link: RuntimeLinkDto | null | undefined }) {
  const { t } = useT();
  const connector = link?.connector;
  const level = connectorUpgradeLevel(connector);
  const edgeSetup = !connector?.version ? (
    <ToneBadge tone="neutral">{t("connectorUpgrade.versionUnknown")}</ToneBadge>
  ) : level === "outdated" && connector.minimumVersion ? (
    <ToneBadge tone="danger">{t("connectorUpgrade.versionRequired", { version: connector.version, latest: connector.minimumVersion })}</ToneBadge>
  ) : level === "available" && connector.latestVersion ? (
    <ToneBadge tone="warning">{t("connectorUpgrade.versionBehind", { version: connector.version, latest: connector.latestVersion })}</ToneBadge>
  ) : (
    <ToneBadge tone="success">{t("connectorUpgrade.versionCurrent", { version: connector.version })}</ToneBadge>
  );
  const hermes = hermesVersionState(link);
  const hermesValue = hermes.kind === "unknown" ? (
    <ToneBadge tone="neutral">{t("connectorUpgrade.versionUnknown")}</ToneBadge>
  ) : hermes.kind === "behind" ? (
    <ToneBadge tone="warning">{t("connectorUpgrade.versionBehind", { version: hermes.version, latest: hermes.latest })}</ToneBadge>
  ) : (
    <ToneBadge tone="success">{t("connectorUpgrade.versionCurrent", { version: hermes.version })}</ToneBadge>
  );
  return (
    <>
      <StatusRow label={t("connectorUpgrade.edgeSetupRow")} value={edgeSetup} />
      <StatusRow
        label={t("connectorUpgrade.hermesRow")}
        value={hermes.upstream ? (
          <span className="flex flex-wrap items-center justify-end gap-1.5">
            {hermesValue}
            <ToneBadge tone="info">{t("connectorUpgrade.hermesUpstream", { version: hermes.upstream })}</ToneBadge>
          </span>
        ) : hermesValue}
      />
    </>
  );
}
