import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@openedbot/browser-ui-kit";
import { isLocalEngine, LOCAL_ENGINES, type RuntimePublicDto } from "@openedbot/contracts-api";
import { ProviderIcon } from "../provider-icon";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { displayedRuntimeHealth, runtimeHealthStatusLabel } from "../../lib/runtime/runtime-health";

const WORKSPACE_DEFAULT = "workspace-default";
type ExecutionHost = RuntimePublicDto & { id: string };

export function useBotCreationHosts(value: string, enabled = true) {
  const registry = useQuery({ queryKey: queryKeys.runtimeList, queryFn: api.runtimeList, enabled });
  const hosts = registry.data?.filter((runtime): runtime is ExecutionHost => runtime.dedicated === true && runtime.id !== null) ?? [];
  const defaultHost = registry.data?.find((runtime) => runtime.isActive) ?? null;
  const selectedHost = hosts.find((host) => host.id === value) ?? null;
  const requiresHost = hosts.length > 0 && defaultHost === null;
  return {
    hosts,
    defaultHost,
    selectedHost,
    requiresHost,
    registryReady: registry.data !== undefined,
    registryFailed: registry.isError && registry.data === undefined,
    refreshHosts: registry.refetch,
  };
}

export function ExecutionHostField({ id, hosts, defaultHost, registryReady, registryFailed, refreshHosts, value, onChange, onOpenMachines }: {
  id: string;
  hosts: ExecutionHost[];
  defaultHost: RuntimePublicDto | null;
  registryReady: boolean;
  registryFailed: boolean;
  refreshHosts: () => unknown;
  value: string;
  onChange: (value: string) => void;
  onOpenMachines?: () => void;
}) {
  const { t, locale } = useT();
  if (!registryReady) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-caption-1-regular text-text-secondary" role={registryFailed ? "alert" : "status"}>
        {t(registryFailed ? "newBotDialog.executionHostsFailed" : "newBotDialog.executionHostsLoading")}
        {registryFailed ? <Button type="button" variant="ghost" onClick={() => void refreshHosts()}>{t("common.retry")}</Button> : null}
      </div>
    );
  }
  if (hosts.length === 0 && !defaultHost && !value) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-caption-1-medium text-text-secondary">{t("newBotDialog.executionHost")}</Label>
      <Select value={value || (defaultHost ? WORKSPACE_DEFAULT : "")} onValueChange={(next) => onChange(next === WORKSPACE_DEFAULT ? "" : next)}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={t("newBotDialog.chooseExecutionHost")} />
        </SelectTrigger>
        <SelectContent>
          {defaultHost ? (
            <SelectItem value={WORKSPACE_DEFAULT}>
              {t("newBotDialog.defaultExecutionHost", { host: defaultHost.name ?? t("newBotDialog.rulesServerFallback") })}
            </SelectItem>
          ) : null}
          {value && !hosts.some((host) => host.id === value) ? (
            <SelectItem value={value} disabled>{t("newBotDialog.executionHostUnavailable")}</SelectItem>
          ) : null}
          {hosts.map((host) => {
            const health = displayedRuntimeHealth(host);
            const name = host.name ?? t("newBotDialog.rulesServerFallback");
            const label = health === "healthy"
              ? t("newBotDialog.localHost", { host: name })
              : t("newBotDialog.localHostWithStatus", {
                  host: name,
                  status: health === "not_configured"
                    ? t("newBotDialog.executionHostUnavailable")
                    : runtimeHealthStatusLabel(health, locale),
                });
            return (
              <SelectItem key={host.id} value={host.id}>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  {isLocalEngine(host.engine) ? (
                    <ProviderIcon provider={LOCAL_ENGINES[host.engine].provider} className="size-4 shrink-0" decorative withTitle={false} />
                  ) : null}
                  <span className="truncate">{label}</span>
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {hosts.length === 0 ? (
        <Link to="/settings/runtime" search={{ section: "runtimes" }} onClick={onOpenMachines} className="self-start rounded-sm text-caption-1-medium text-text-secondary underline underline-offset-2 focus-visible:outline focus-visible:outline-border-focus-ring">
          {t("newBotDialog.connectLocalAgents")}
        </Link>
      ) : null}
    </div>
  );
}
