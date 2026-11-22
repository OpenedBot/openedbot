import { isLocalEngine, LOCAL_ENGINES, type RuntimePublicDto } from "@openedbot/contracts-api";
import { useT } from "../lib/i18n";
import { ProviderIcon } from "./provider-icon";

/** The model line of a bot created on a local agent: its CLI's own default. */
export function LocalAgentModelLabel({ host }: { host: Pick<RuntimePublicDto, "name" | "engine"> }) {
  const { t } = useT();
  const name = host.name ?? t("newBotDialog.rulesServerFallback");
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-body-medium text-text-secondary" title={t("composer.modelLocalAgentHost", { host: name })}>
      {isLocalEngine(host.engine) ? (
        <ProviderIcon provider={LOCAL_ENGINES[host.engine].provider} className="size-4 shrink-0" decorative withTitle={false} />
      ) : null}
      <span className="min-w-0 truncate">{t("composer.modelLocalAgentDefault")}</span>
    </span>
  );
}
