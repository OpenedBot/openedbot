import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPencil } from "@tabler/icons-react";
import type { BotDto } from "@openedbot/contracts-api";
import { Card, CardContent, Skeleton, Switch, toast } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { GatewayRestartCard } from "../../screens/settings/installation/connectors-mcp";

/**
 * L'interrupteur `bot_settings_propose` : le bot PROPOSE de changer sa persona
 * et ses réglages légers, l'opérateur décide dans la carte du fil. Même forme
 * que `RoutineToolCard` : le gateway ne lit ses serveurs MCP qu'au démarrage,
 * d'où la carte de redémarrage après une bascule qui l'exige.
 */
export function SettingsToolCard({ bot, open }: { bot: BotDto; open: boolean }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const key = queryKeys.botSettingsTool(bot.id);
  const tool = useQuery({ queryKey: key, queryFn: () => api.botSettingsTool(bot.id), enabled: open });
  const [restartPending, setRestartPending] = useState(false);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setBotSettingsTool(bot.id, enabled),
    onSuccess: (saved) => {
      queryClient.setQueryData(key, saved);
      setRestartPending(saved.restartPending);
      toast.success(t(saved.enabled ? "botSettingsDialog.settingsToolEnabled" : "botSettingsDialog.settingsToolDisabled", { name: bot.name }));
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t("botSettingsDialog.settingsToolFailed")),
  });
  const data = tool.data;
  const unavailable = data && !data.available
    ? t(data.reason === "https_required"
      ? "botRoutinesDialog.toolUnavailableHttps"
      : data.reason === "runtime_required"
      ? "botRoutinesDialog.toolUnavailableRuntime"
      : data.reason === "profile_unsupported"
        ? "botRoutinesDialog.toolUnavailableProfile"
        : "botRoutinesDialog.toolUnavailableHost")
    : null;
  return (
    <section aria-labelledby="settings-tool-title" className="space-y-3">
      <Card size="sm" className="gap-3 py-3 shadow-none">
        <CardContent className="flex items-start gap-3 px-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <IconPencil aria-hidden className="size-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <p id="settings-tool-title" className="text-sm font-semibold text-foreground">{t("botSettingsDialog.settingsToolTitle")}</p>
            <p className="text-xs leading-5 text-muted-foreground">{t("botSettingsDialog.settingsToolDescription")}</p>
            {unavailable ? <p className="text-xs text-muted-foreground">{unavailable}</p> : null}
            {tool.isError ? (
              <p role="alert" className="text-xs text-destructive-text">
                {tool.error instanceof ApiError ? tool.error.message : t("botSettingsDialog.settingsToolFailed")}
              </p>
            ) : null}
          </div>
          {tool.isPending ? (
            <Skeleton className="mt-0.5 h-5 w-8 shrink-0 rounded-full motion-reduce:animate-none" />
          ) : (
            <Switch
              checked={data?.enabled === true}
              onCheckedChange={(enabled) => toggle.mutate(enabled)}
              aria-label={t("botSettingsDialog.settingsToolAria", { name: bot.name })}
              disabled={!data?.available || toggle.isPending}
              className="mt-0.5 shrink-0"
            />
          )}
        </CardContent>
      </Card>
      {restartPending ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("botSettingsDialog.settingsToolRestart")}</p>
          <GatewayRestartCard onRestarted={() => setRestartPending(false)} />
        </div>
      ) : null}
    </section>
  );
}
