import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { canOperateWorkspace } from "@openedbot/contracts-api";
import { Switch, toast } from "@openedbot/browser-ui-kit";
import { api, errorMessage, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { ListRow, ListSection, Note } from "../../../../components/settings/primitives";

/**
 * PERM2-4, D-3: the runtime switch "dangerous commands: always allow". It
 * holds for every bot of this runtime, which the card says before the
 * switch. Also turned on from a gate card; turned off only here or there.
 * The switch shows the row the API read back, never the click.
 */
export function RuntimeTerminalSwitch({ runtimeId }: { runtimeId: string }) {
  const { t, formatDate } = useT();
  const queryClient = useQueryClient();
  // The routes require an operator (owner, admin); a member sees nothing here.
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
    // A one-line list (`DESIGN.md` › Bureau): the title and its sentence in
    // the header, then the setting on ONE line, the switch on the right and
    // the warning underneath; who changed it, in the footer.
    <div data-runtime-terminal-switch="">
      <ListSection
        title={t("cloudRuntimeSettings.terminalSwitchTitle")}
        description={t("cloudRuntimeSettings.terminalSwitchDescription")}
        footer={data?.updatedAt && data.updatedByName ? (
          <p className="text-xs text-text-tertiary">
            {t("cloudRuntimeSettings.terminalSwitchUpdated", { name: data.updatedByName, date: formatDate(data.updatedAt) })}
          </p>
        ) : undefined}
      >
        {settings.isError ? (
          <li className="p-4"><Note tone="danger" role="alert">{t("cloudRuntimeSettings.terminalSwitchLoadFailed")}</Note></li>
        ) : (
          <ListRow
            label={t("cloudRuntimeSettings.terminalSwitchLabel")}
            description={<span className="text-warn-700">{t("cloudRuntimeSettings.terminalSwitchWarning")}</span>}
            descriptionId={warningId}
          >
            <Switch
              checked={data?.terminalDangerAlways === true}
              onCheckedChange={(value) => toggle.mutate(value)}
              disabled={!data || toggle.isPending}
              aria-label={t("cloudRuntimeSettings.terminalSwitchLabel")}
              aria-describedby={warningId}
              className="shrink-0"
            />
          </ListRow>
        )}
      </ListSection>
    </div>
  );
}
