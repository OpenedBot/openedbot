import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { canOperateWorkspace } from "@openedbot/contracts-api";
import { Switch, toast } from "@openedbot/browser-ui-kit";
import { api, errorMessage, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { CardHeading, Note, SettingsCard } from "../../../../components/settings/primitives";

/**
 * PERM2-4, D-3: the runtime switch "dangerous commands: always allow". It
 * holds for every bot of this runtime, which the card says before the
 * switch. Also turned on from a gate card; turned off only here or there.
 * The switch shows the row the API read back, never the click.
 */
export function RuntimeTerminalSwitch({ runtimeId }: { runtimeId: string }) {
  const { t, formatDate } = useT();
  const queryClient = useQueryClient();
  // The routes require an operator (owner, admin, agency); a member sees nothing here.
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const operator = canOperateWorkspace(me.data?.session.role ?? "");
  const key = queryKeys.runtimePermissionSettings(runtimeId);
  const settings = useQuery({ queryKey: key, queryFn: () => api.runtimePermissionSettings(runtimeId), enabled: operator });
  const toggle = useMutation({
    mutationFn: (value: boolean) => api.setRuntimeTerminalDangerAlways(runtimeId, value),
    onSuccess: (saved) => {
      queryClient.setQueryData(key, saved);
      toast.success(saved.terminalDangerAlways ? t("cloudRuntimeSettings.terminalSwitchOn") : t("cloudRuntimeSettings.terminalSwitchOff"));
    },
    onError: (error) => {
      toast.error(errorMessage(error, t("cloudRuntimeSettings.terminalSwitchFailed")));
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const data = settings.data;
  const warningId = `runtime-terminal-switch-warning-${runtimeId}`;

  if (!operator) return null;
  return (
    <SettingsCard className="space-y-3" data-runtime-terminal-switch="">
      <CardHeading
        title={t("cloudRuntimeSettings.terminalSwitchTitle")}
        description={t("cloudRuntimeSettings.terminalSwitchDescription")}
      />
      {settings.isError ? (
        <Note tone="danger" role="alert">{t("cloudRuntimeSettings.terminalSwitchLoadFailed")}</Note>
      ) : (
        <>
          <label className="flex min-h-11 items-center justify-between gap-3">
            <span className="text-sm text-text-primary">{t("cloudRuntimeSettings.terminalSwitchLabel")}</span>
            <Switch
              checked={data?.terminalDangerAlways === true}
              onCheckedChange={(value) => toggle.mutate(value)}
              disabled={!data || toggle.isPending}
              aria-describedby={warningId}
              className="shrink-0"
            />
          </label>
          <p id={warningId} className="text-xs leading-5 text-warn-700">{t("cloudRuntimeSettings.terminalSwitchWarning")}</p>
          {data?.updatedAt && data.updatedByName ? (
            <p className="text-xs text-text-tertiary">
              {t("cloudRuntimeSettings.terminalSwitchUpdated", { name: data.updatedByName, date: formatDate(data.updatedAt) })}
            </p>
          ) : null}
        </>
      )}
    </SettingsCard>
  );
}
