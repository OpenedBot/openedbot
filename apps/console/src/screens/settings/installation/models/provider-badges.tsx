import type { RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { isKeylessProvider } from "@openedbot/runtimes/domain/runtime/keyless-providers";
import { ToneBadge } from "../../../../components/settings/primitives";
import { useT } from "../../../../lib/i18n";
import { useProviderIncident } from "../../../../components/provider-incident-banner";

export function ProviderAccessBadge({ provider }: { provider: RuntimeModelProviderDto }) {
  const { t } = useT();
  // Hermes keeps `authenticated` on a revoked credential: the incident wins.
  const incident = useProviderIncident(provider.slug);
  if (incident) {
    return (
      <ToneBadge tone="danger">
        {t(incident.kind === "quota" ? "providerIncidents.statusQuota" : "providerIncidents.statusAuth")}
      </ToneBadge>
    );
  }
  // A detected access is worth nothing without the connector: every run would fail.
  if (provider.sdkInstalled === false) {
    return <ToneBadge tone="warning">{t("modelsSettings.sdkMissing")}</ToneBadge>;
  }
  return (
    <ToneBadge tone={provider.authenticated ? "info" : "warning"}>
      {provider.alwaysAuthenticated
        ? t("modelsSettings.integrated")
        : provider.authenticated
          ? isKeylessProvider(provider.slug)
            ? t("modelsSettings.accessAnonymous")
            : t("modelsSettings.accessDetected")
          : t("modelsSettings.unavailable")}
    </ToneBadge>
  );
}
