import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import type { BotDto, BotRoutineToolDto } from "@openedbot/contracts-api";
import { Card, CardContent, Skeleton, Switch, toast } from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys } from "../lib/api";
import { useT, type MessageKey } from "../lib/i18n";
import { GatewayRestartCard } from "../screens/settings/installation/connectors/connectors-mcp";

export const ROUTINE_TOOL_REFETCH_MS = 15_000;
const WAITING: ReadonlySet<BotRoutineToolDto["status"]> = new Set(["pending", "restart_pending"]);

/** How often the card reads the state again: only while the API is moving it, or the host is away. */
export function routineToolRefetchMs(tool: BotRoutineToolDto | undefined): number | false {
  return tool && (WAITING.has(tool.status) || tool.reason === "host_offline") ? ROUTINE_TOOL_REFETCH_MS : false;
}

/** The sentence under the title: what the bot's next run gets, and why when it does not. */
export function routineToolStatusKey(tool: BotRoutineToolDto): MessageKey {
  switch (tool.status) {
    // Installed: an offline host delays its use, it installs nothing more.
    case "active": return tool.reason === "host_offline" ? "botRoutinesDialog.toolActiveOffline" : "botRoutinesDialog.toolActive";
    case "switched_off": return "botRoutinesDialog.toolSwitchedOff";
    case "restart_pending": return "botRoutinesDialog.toolRestart";
    case "unavailable":
      return tool.reason === "https_required" ? "botRoutinesDialog.toolUnavailableHttps"
        : tool.reason === "runtime_required" ? "botRoutinesDialog.toolUnavailableRuntime"
          : tool.reason === "profile_unsupported" ? "botRoutinesDialog.toolUnavailableProfile"
            : tool.reason === "profile_failed" ? "botRoutinesDialog.toolUnavailableProfileFailed"
              : "botRoutinesDialog.toolUnavailableHost";
    case "pending":
      return tool.reason === "host_offline" ? "botRoutinesDialog.toolPendingOffline"
        : tool.reason === "host_unreachable" ? "botRoutinesDialog.toolPendingUnreachable"
          : tool.reason === "unverified" ? "botRoutinesDialog.toolPendingUnverified"
            : tool.reason === "profile_preparing" ? "botRoutinesDialog.toolPendingProfile"
              : "botRoutinesDialog.toolPending";
  }
}

/**
 * « Programmer depuis le chat » (DEV-209, 0187): on by default, openedbot
 * installs it on the bot's host by itself; the switch is the operator's
 * opt-out, remembered. Bot only: a salon has no run of its own. A host that
 * does not reload MCP on its own needs a gateway restart only the operator
 * triggers, hence the restart card in that state.
 */
export function RoutineToolCard({ bot, open, onChanged }: { bot: BotDto; open: boolean; onChanged: () => void }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const key = queryKeys.botRoutineTool(bot.id);
  const tool = useQuery({
    queryKey: key,
    queryFn: () => api.botRoutineTool(bot.id),
    enabled: open,
    // A state the API moves on its own is read again while the dialog is open.
    refetchInterval: (query) => routineToolRefetchMs(query.state.data),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setBotRoutineTool(bot.id, enabled),
    onSuccess: (saved) => {
      queryClient.setQueryData(key, saved);
      toast.success(t(saved.enabled ? "botRoutinesDialog.toolEnabled" : "botRoutinesDialog.toolDisabled", { name: bot.name }));
      onChanged();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t("botRoutinesDialog.toolFailed")),
    // A failed write may still have recorded the choice: read the state again either way.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const data = tool.data;
  return (
    <section aria-labelledby="routine-tool-title" className="space-y-3">
      <Card size="sm" className="gap-3 py-3 shadow-none">
        <CardContent className="flex items-start gap-3 px-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot aria-hidden className="size-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <p id="routine-tool-title" className="text-sm font-semibold text-foreground">{t("botRoutinesDialog.toolTitle")}</p>
            <p className="text-xs leading-5 text-muted-foreground">{t("botRoutinesDialog.toolDescription", { name: bot.name })}</p>
            {data ? (
              <p data-routine-tool-status={data.status} className="text-xs text-muted-foreground">
                {t(routineToolStatusKey(data), { name: bot.name })}
              </p>
            ) : null}
            {tool.isError ? (
              <p role="alert" className="text-xs text-destructive-text">
                {tool.error instanceof ApiError ? tool.error.message : t("botRoutinesDialog.toolFailed")}
              </p>
            ) : null}
          </div>
          {tool.isPending ? (
            <Skeleton className="mt-0.5 h-5 w-8 shrink-0 rounded-full motion-reduce:animate-none" />
          ) : (
            <Switch
              checked={data?.enabled === true}
              onCheckedChange={(enabled) => toggle.mutate(enabled)}
              aria-label={t("botRoutinesDialog.toolAria", { name: bot.name })}
              // The choice is remembered whatever the host: only a failed read or a write in flight locks it.
              disabled={!data || toggle.isPending}
              className="mt-0.5 shrink-0"
            />
          )}
        </CardContent>
      </Card>
      {data?.status === "restart_pending" ? (
        <GatewayRestartCard onRestarted={() => void queryClient.invalidateQueries({ queryKey: key })} />
      ) : null}
    </section>
  );
}
