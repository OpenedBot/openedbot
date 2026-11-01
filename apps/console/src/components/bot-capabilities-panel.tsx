import { useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import type { BotDto, BotMcpServerDto, ToolErrorDto, ToolErrorPageDto } from "@openedbot/contracts-api";
import { capabilityView, RUNTIME_SIDE_STORES, type CapabilityToolsetView } from "@openedbot/runtimes/domain/bot-capabilities";
import { runtimeToolsetNameIsContractForbidden } from "@openedbot/runtimes/domain/runtime-contract";
import { Skeleton, Switch, cn, toast, useIsMobile } from "@openedbot/browser-ui-kit";
import { ApiError, api, errorMessage, queryKeys } from "../lib/api";
import { conversationPath } from "../lib/conversation-href";
import { useT } from "../lib/i18n";
import { BUTTON } from "./settings/primitives";
import { BotMcpCatalogSection, useBotMcpConnect } from "./bot-mcp-catalog";

/**
 * Ce que ce bot peut appeler, et ce qu'il a appelé.
 *
 * Deux rubriques du dialogue : `skills` (outils natifs + skills) et `mcp`
 * (serveurs MCP du profil). Les mélanger sous « Skills » faisait lire
 * « notion » comme une skill.
 *
 * L'inventaire vient du RUNTIME et vaut pour tous les bots de l'espace
 * (mesuré le 25-08, `/v1/toolsets` rend la même configuration pour la racine
 * et pour chaque profil, et une restriction au niveau du run est ignorée) ;
 * les appels, eux, sont ceux de ce bot.
 */
type BotCapabilitiesPane = "skills" | "mcp";

type BotCapabilitiesPanelProps = {
  bot: BotDto;
  open: boolean;
  /** Skills (outils + skills) ou serveurs MCP : deux rubriques du dialogue. */
  pane?: BotCapabilitiesPane;
  createProfileAvailable?: boolean;
  onCreateProfile?: () => void;
  createProfilePending?: boolean;
  createProfileError?: string | null;
};

/**
 * Shared by the panel and by the bot dialog, which starts this read as soon as
 * it opens: on a cold host the inventory takes seconds (one interpreter start
 * per host read), and the time spent in the menu then hides it.
 */
export function botCapabilitiesQueryOptions(botId: string) {
  return {
    queryKey: queryKeys.botCapabilities(botId),
    queryFn: () => api.botCapabilities(botId),
  };
}

export function BotCapabilitiesPanel({
  bot,
  open,
  pane = "skills",
  createProfileAvailable = false,
  onCreateProfile,
  createProfilePending = false,
  createProfileError = null,
}: BotCapabilitiesPanelProps) {
  const { t, plural, formatDate } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const capabilities = useQuery({ ...botCapabilitiesQueryOptions(bot.id), enabled: open });
  const updateCapability = useMutation({
    mutationFn: (input: { kind: "toolset" | "mcp" | "skill"; name: string; enabled: boolean }) =>
      input.kind === "toolset"
        ? api.setBotToolset(bot.id, input.name, input.enabled)
        : input.kind === "mcp"
          ? api.setBotMcpServer(bot.id, input.name, input.enabled)
          : api.setBotSkill(bot.id, input.name, input.enabled),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.botCapabilities(bot.id) });
      if (!result.applied) toast.error(t("botCapabilities.mutationNotApplied"));
    },
  });

  // Avant tout retour anticipé : un hook ne se saute pas selon l'état de la lecture.
  const mcpConnect = useBotMcpConnect(bot, capabilities.data?.writable === true, open && pane === "mcp");
  // Retire un serveur du catalogue de CE profil et efface son jeton sur l'hôte.
  const disconnectMcp = useMutation({
    mutationFn: (name: string) => api.disconnectMcpConnector(name, bot.id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.botCapabilities(bot.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProfiles });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeGateway });
    },
  });

  if (capabilities.isPending) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label={t("botCapabilities.loading")}>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (capabilities.isError) {
    return (
      <Failure
        message={capabilities.error instanceof ApiError
          ? capabilities.error.message
          : t("botSettingsDialog.saveFailed")}
        onRetry={() => void capabilities.refetch()}
      />
    );
  }

  const dto = capabilities.data;
  const view = capabilityView(dto);
  const createProfileBanner = createProfileAvailable && !bot.hermesProfile && !isMobile && onCreateProfile ? (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3">
      <p className="text-sm text-foreground">{t("botCapabilities.profileCreateHint")}</p>
      <button
        type="button"
        onClick={onCreateProfile}
        disabled={createProfilePending}
        className={BUTTON.secondary}
      >
        {createProfilePending ? t("botCapabilities.profileCreating") : t("botCapabilities.profileCreate")}
      </button>
      {createProfileError ? <p className="text-sm text-destructive-text" role="alert">{createProfileError}</p> : null}
    </div>
  ) : null;

  if (pane === "mcp") {
    return (
      <div className="space-y-5">
        <div className="space-y-1.5">
          <p className="text-sm text-muted-foreground">{t("botCapabilities.mcpIntro")}</p>
          <p className="text-xs text-muted-foreground">
            {dto.scope === "profile"
              ? t("botCapabilities.profileScopeNote", { slug: bot.slug })
              : t("botCapabilities.mcpProfileRequired")}
          </p>
        </div>
        {createProfileBanner}
        {dto.scope === "profile" ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("botCapabilities.mcpTitle")}</h3>
            {dto.mcpServers === null ? (
              <p className="text-sm text-muted-foreground">{t("botCapabilities.mcpUnavailable")}</p>
            ) : dto.mcpServers.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("botCapabilities.mcpEmpty")}</p>
            ) : (
              <ul className="space-y-1.5">
                {dto.mcpServers.map((server) => (
                  <McpServerRow
                    key={server.name}
                    server={server}
                    writable={dto.writable}
                    pending={updateCapability.isPending && updateCapability.variables?.name === server.name && updateCapability.variables.kind === "mcp"}
                    onChange={(enabled) => updateCapability.mutate({ kind: "mcp", name: server.name, enabled })}
                    onReconnect={(() => {
                      // Un serveur du catalogue se réautorise d'ici (jeton expiré,
                      // compte changé) ; un serveur ajouté à la main, depuis les réglages.
                      const entry = mcpConnect.catalogEntry(server.name);
                      return entry && mcpConnect.blocker === null && !mcpConnect.busy ? () => mcpConnect.connect(entry) : undefined;
                    })()}
                    onDisconnect={mcpConnect.catalogEntry(server.name) && mcpConnect.canDisconnect
                      ? () => disconnectMcp.mutate(server.name)
                      : undefined}
                    disconnecting={disconnectMcp.isPending && disconnectMcp.variables === server.name}
                  />
                ))}
              </ul>
            )}
            {disconnectMcp.isError ? (
              <p className="text-sm text-destructive-text" role="alert">
                {errorMessage(disconnectMcp.error, t("connectorsPage.disconnectFailed"))}
              </p>
            ) : disconnectMcp.isSuccess ? (
              <p className="text-sm text-muted-foreground" role="status">{t(mcpConnect.liveReload ? "botCapabilities.mcpDisconnectedLive" : "botCapabilities.mcpDisconnected")}</p>
            ) : null}
            {updateCapability.isError ? (
              <p className="text-sm text-destructive-text" role="alert">
                {updateCapability.error instanceof ApiError ? updateCapability.error.message : t("botCapabilities.mutationFailed")}
              </p>
            ) : null}
          </section>
        ) : null}
        <BotMcpCatalogSection
          profileServers={dto.scope === "profile" ? dto.mcpServers : null}
          connect={mcpConnect}
          onRestarted={() => void queryClient.invalidateQueries({ queryKey: queryKeys.botCapabilities(bot.id) })}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">{t("botCapabilities.intro")}</p>
        <p className="text-xs text-muted-foreground">
          {dto.scope === "profile"
            ? t("botCapabilities.profileScopeNote", { slug: bot.slug })
            : t("botCapabilities.scopeNote", {
                runtime: dto.runtimeName ?? t("botSettingsDialog.hermesRuntimeFallback"),
                slug: bot.slug,
              })}
        </p>
      </div>

      {createProfileBanner}

      {dto.inventoryError ? (
        <Failure
          message={t("botCapabilities.inventoryFailed", { message: dto.inventoryError.message })}
          onRetry={() => void capabilities.refetch()}
        />
      ) : (
        <p className="text-sm">
          {t("botCapabilities.summary", { tools: view.totals.tools, skills: view.totals.skills })}
        </p>
      )}

      {view.totals.unconfigured > 0 ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive-text">
          <IconAlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          {plural(view.totals.unconfigured, {
            one: t("botCapabilities.unconfiguredWarning_one"),
            other: t("botCapabilities.unconfiguredWarning_other"),
          })}
        </p>
      ) : null}

      {view.totals.forbidden.length > 0 ? (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive-text">
          <IconAlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          {t("botCapabilities.forbiddenWarning", { toolsets: view.totals.forbidden.join(", ") })}
        </p>
      ) : null}

      {view.totals.outOfReach.length > 0 ? (
        <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <IconAlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          {t("botCapabilities.outOfReachWarning", { toolsets: view.totals.outOfReach.join(", ") })}
        </p>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("botCapabilities.toolsetsTitle")}</h3>
        {view.toolsets === null ? (
          <p className="text-sm text-muted-foreground">{t("botCapabilities.toolsetsUnavailable")}</p>
        ) : (
          <ul className="space-y-1.5">
            {view.toolsets.map((toolset) => (
              dto.scope === "profile"
                ? <ProfileToolsetRow
                    key={toolset.name}
                    toolset={toolset}
                    writable={dto.writable}
                    pending={updateCapability.isPending && updateCapability.variables?.name === toolset.name}
                    onChange={(enabled) => updateCapability.mutate({ kind: "toolset", name: toolset.name, enabled })}
                  />
                : <ToolsetRow key={toolset.name} toolset={toolset} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("botCapabilities.skillsTitle")}</h3>
        {view.skills === null ? (
          <p className="text-sm text-muted-foreground">{t("botCapabilities.skillsUnavailable")}</p>
        ) : (
          <ul className="space-y-2">
            {view.skills.map((group) => (
              <li key={group.category || "-"} className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {group.category || "-"} · {group.skills.length}
                </p>
                {dto.scope === "profile" ? (
                  <ul className="space-y-1.5">
                    {group.skills.map((skill) => (
                      <li key={skill.name} className={cn("flex items-center justify-between gap-3 rounded-md border px-3 py-2", !skill.enabled && "opacity-60")}>
                        <span className="truncate font-mono text-sm" title={skill.description ?? undefined}>{skill.name}</span>
                        <div className="flex shrink-0 items-center gap-2">
                          {updateCapability.isPending && updateCapability.variables?.kind === "skill" && updateCapability.variables.name === skill.name ? (
                            <span className="text-xs text-muted-foreground">{t("botCapabilities.updating")}</span>
                          ) : null}
                          <Switch
                            checked={skill.enabled}
                            aria-label={t("botCapabilities.skillToggleAria", { name: skill.name })}
                            disabled={!skill.writable || updateCapability.isPending}
                            onCheckedChange={(enabled) => updateCapability.mutate({ kind: "skill", name: skill.name, enabled })}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="flex flex-wrap gap-1">
                    {group.skills.map((skill) => (
                      <span
                        key={skill.name}
                        title={skill.description ?? undefined}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                      >
                        {skill.name}
                      </span>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("botCapabilities.usageTitle")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("botCapabilities.usageWindow", { days: dto.usageWindowDays })}
        </p>
        {dto.usage.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("botCapabilities.usageEmpty")}</p>
        ) : (
          <ul className="space-y-1">
            {dto.usage.map((row) => (
              <li key={row.tool} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-mono text-xs">{row.tool}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {plural(row.calls, {
                    one: t("botCapabilities.calls_one"),
                    other: t("botCapabilities.calls_other"),
                  })}
                  {row.failures > 0
                    ? ` · ${plural(row.failures, {
                        one: t("botCapabilities.failures_one"),
                        other: t("botCapabilities.failures_other"),
                      })}`
                    : ""}
                  {" · "}
                  {formatDate(row.lastUsedAt, { dateStyle: "short" })}
                </span>
              </li>
            ))}
          </ul>
        )}
        {view.retiredUsage.length > 0 && view.toolsets !== null ? (
          <p className="text-xs text-muted-foreground">
            {t("botCapabilities.retiredTitle")} : {view.retiredUsage.map((row) => row.tool).join(", ")}
          </p>
        ) : null}
      </section>

      <ToolErrorsSection bot={bot} open={open} />
    </div>
  );
}

/**
 * Les derniers échecs d'outils du bot (`tool_errors`, 0037). Une table à
 * part, pas une relecture de `run_events` : elle survit à la purge du fil.
 * Chaque ligne mène au run dans le fil (`?focus=run:…`) ; le message est
 * celui que le runtime a transmis, borné et rédigé, ou l'aveu qu'il n'a rien
 * dit, ce qui est le cas mesuré sur `/v1/runs`.
 */
export function ToolErrorsSection({ bot, open }: { bot: Pick<BotDto, "id" | "threadId">; open: boolean }) {
  const { t, formatDate } = useT();
  const errors = useInfiniteQuery({
    queryKey: queryKeys.botToolErrors(bot.id),
    queryFn: ({ pageParam }) => api.botToolErrors(bot.id, { cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page: ToolErrorPageDto) => page.nextCursor,
    enabled: open,
  });
  const rows: ToolErrorDto[] = errors.data?.pages.flatMap((page) => page.errors) ?? [];

  return (
    <section className="space-y-2" data-tool-errors="">
      <h3 className="text-sm font-medium">{t("botCapabilities.errorsTitle")}</h3>
      <p className="text-xs text-muted-foreground">{t("botCapabilities.errorsIntro")}</p>
      {errors.isPending ? (
        <Skeleton className="h-10 w-full" aria-busy="true" />
      ) : errors.isError ? (
        <Failure
          message={errors.error instanceof ApiError ? errors.error.message : t("botCapabilities.errorsLoadFailed")}
          onRetry={() => void errors.refetch()}
        />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("botCapabilities.errorsEmpty")}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <li key={row.id} className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate font-mono text-xs">{row.tool}</span>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={row.occurredAt}>
                  {formatDate(row.occurredAt, { dateStyle: "short", timeStyle: "short" })}
                </time>
              </div>
              <p className={cn("mt-1 whitespace-pre-wrap break-words text-xs", row.errorMessage ? "text-destructive-text" : "italic text-muted-foreground")}>
                {row.errorMessage ?? t("botCapabilities.errorsNoMessage")}
              </p>
              <a
                href={conversationPath(bot.id, row.threadId === bot.threadId ? undefined : row.threadId, `run:${row.runId}`)}
                className="mt-1 inline-flex min-h-11 items-center text-xs underline underline-offset-2 sm:min-h-0"
              >
                {t("botCapabilities.errorsOpenRun")}
              </a>
            </li>
          ))}
        </ul>
      )}
      {errors.hasNextPage ? (
        <button
          type="button"
          onClick={() => void errors.fetchNextPage()}
          disabled={errors.isFetchingNextPage}
          className={BUTTON.small}
        >
          {t("botCapabilities.errorsMore")}
        </button>
      ) : null}
    </section>
  );
}

function ToolsetRow({ toolset }: { toolset: CapabilityToolsetView }) {
  const { t, plural } = useT();
  return (
    <li
      className={cn(
        "rounded-md border px-3 py-2",
        toolset.willFail ? "border-destructive/40 bg-destructive/5" : "border-border",
        !toolset.enabled && "opacity-60",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm">{toolset.label}</span>
        <span
          className={cn(
            "shrink-0 text-xs",
            toolset.willFail ? "text-destructive-text" : "text-muted-foreground",
          )}
        >
          {[
            toolset.willFail ? t("botCapabilities.badgeUnconfigured") : null,
            toolset.enabled ? null : t("botCapabilities.badgeDisabled"),
            toolset.calls > 0
              ? plural(toolset.calls, {
                  one: t("botCapabilities.calls_one"),
                  other: t("botCapabilities.calls_other"),
                })
              : null,
          ].filter(Boolean).join(" · ")}
        </span>
      </div>
      {toolset.tools.length > 0 ? (
        <p className="mt-1 flex flex-wrap gap-1">
          {toolset.tools.map((tool) => (
            <span key={tool} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {tool}
            </span>
          ))}
        </p>
      ) : null}
      <HostToolsetNote toolset={toolset} />
    </li>
  );
}

/** Un toolset actif peut n'avoir aucun outil appelable : l'écran le dit et nomme le geste. */
function HostToolsetNote({ toolset }: { toolset: CapabilityToolsetView }) {
  const { t } = useT();
  if (toolset.noTools) return <p className="mt-1 text-xs text-destructive-text">{t("botCapabilities.noCallableTools")}</p>;
  if (toolset.unavailable) {
    const reason = toolset.unavailableReason === "credentials_missing"
      ? t("botCapabilities.unavailableCredentials")
      : toolset.unavailableReason === "check_failed"
        ? t("botCapabilities.unavailableCheck")
        : null;
    return (
      <div className="mt-1 space-y-0.5 text-xs">
        <p className="text-destructive-text">{t("botCapabilities.unavailableOnHost")}</p>
        {reason ? <p className="text-muted-foreground">{reason}</p> : null}
      </div>
    );
  }
  if (toolset.needsHostSoftware) return <p className="mt-1 text-xs text-muted-foreground">{t("botCapabilities.hostSoftwareNote")}</p>;
  return null;
}

function ProfileToolsetRow({
  toolset,
  writable,
  pending,
  onChange,
}: {
  toolset: CapabilityToolsetView;
  writable: boolean;
  pending: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { t } = useT();
  const forbidden = runtimeToolsetNameIsContractForbidden(toolset.name, { scope: "profile" });
  const profileStore = RUNTIME_SIDE_STORES.has(toolset.name);
  return (
    <li className={cn("rounded-md border px-3 py-2", !toolset.enabled && "opacity-60")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm">{toolset.label}</p>
          {forbidden ? <p className="mt-1 text-xs text-destructive-text">{t("botCapabilities.forbiddenToggleDisabled")}</p> : null}
          {!forbidden && profileStore ? (
            <p className="mt-1 text-xs text-muted-foreground">{t("botCapabilities.profileMemoryNote")}</p>
          ) : null}
          {!forbidden ? <HostToolsetNote toolset={toolset} /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pending ? <span className="text-xs text-muted-foreground">{t("botCapabilities.updating")}</span> : null}
          <Switch
            checked={toolset.enabled}
            aria-label={toolset.label}
            disabled={!writable || forbidden || pending}
            onCheckedChange={onChange}
          />
        </div>
      </div>
    </li>
  );
}

function McpServerRow({
  server,
  writable,
  pending,
  onChange,
  onReconnect,
  onDisconnect,
  disconnecting = false,
}: {
  server: BotMcpServerDto;
  writable: boolean;
  pending: boolean;
  onChange: (enabled: boolean) => void;
  /** Présent pour un serveur du catalogue que ce bot peut réautoriser. */
  onReconnect?: () => void;
  /** Présent pour un serveur du catalogue que l'hôte sait retirer de ce profil. */
  onDisconnect?: () => void;
  disconnecting?: boolean;
}) {
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className={cn("rounded-md border px-3 py-2", !server.enabled && "opacity-60")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm">{server.name}</p>
          {server.unreachable ? <p className="mt-1 text-xs text-destructive-text">{t("botCapabilities.mcpUnreachable")}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pending ? <span className="text-xs text-muted-foreground">{t("botCapabilities.updating")}</span> : null}
          {disconnecting ? (
            <span className="text-xs text-muted-foreground">{t("connectorsPage.disconnecting")}</span>
          ) : confirming && onDisconnect ? (
            <>
              <button type="button" className={BUTTON.small} onClick={() => setConfirming(false)}>{t("common.cancel")}</button>
              <button
                type="button"
                className={BUTTON.danger}
                onClick={() => {
                  setConfirming(false);
                  onDisconnect();
                }}
              >
                {t("connectorsPage.disconnectConfirm")}
              </button>
            </>
          ) : (
            <>
              {onReconnect ? (
                <button type="button" className={BUTTON.soft} onClick={onReconnect}>
                  {t("mcpCatalog.reconnect")}
                </button>
              ) : null}
              {onDisconnect ? (
                <button
                  type="button"
                  className={BUTTON.small}
                  aria-label={t("botCapabilities.mcpDisconnectAria", { name: server.name })}
                  onClick={() => setConfirming(true)}
                >
                  {t("connectorsPage.disconnect")}
                </button>
              ) : null}
            </>
          )}
          <Switch
            checked={server.enabled}
            aria-label={server.name}
            disabled={!writable || pending}
            onCheckedChange={onChange}
          />
        </div>
      </div>
    </li>
  );
}

function Failure({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useT();
  return (
    <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
      <p className="text-sm text-destructive-text">{message}</p>
      <button type="button" onClick={onRetry} className={BUTTON.secondary}>
        <IconRefresh size={14} aria-hidden />
        {t("botCapabilities.retry")}
      </button>
    </div>
  );
}
