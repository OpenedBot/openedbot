import { Fragment, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { resolveBotProvider } from "@openedbot/runtimes/domain/runtime/bot-provider";
import { cn } from "@openedbot/browser-ui-kit";
import { api, queryKeys, runtimesQueryOptions } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BUTTON } from "../settings/primitives";
import { ProviderIcon } from "../provider-icon";
import { UsageBar } from "../usage-bar";
import { useSecondaryReadsReady } from "../../lib/shell/after-first-paint";
import { countPendingPolls, providerUsagePollMs, providerUsageStaleMs } from "../../lib/runtime/provider-usage-poll";
import {
  ALERT_PERCENT, BotUsageList, BotsDisclosure, LIMIT_GRID, PanelSkeleton, StatusBanner, elapsedMinutes, peakUsedPercent,
  primaryWindow, statusMessage, unavailableSnapshot, unmeasuredNotice, percentTone, resetLabel, type ProviderBot, type ProviderRowKind,
} from "./provider-limits-parts";
export { percentTone, resetLabel } from "./provider-limits-parts";

/**
 * The reading of the provider subscriptions, and that alone.
 *
 * One read, two entry points: the composer's tab carries it
 * permanently (that is where one decides to spend), and the foot of the
 * sidebar shows only as an alert (`providerLimitsAlerting`). Before, the
 * two surfaces rendered the same windows from the same cache key: the
 * duplicate cost a fixed slot for a number that moves only at the
 * extremes.
 */

/** What openedbot has counted on a provider's finished runs, over a window. */
export type ProviderConsumption = { runs: number; inputTokens: number; outputTokens: number; tokens: number };

/** The two windows read for an API-key account: the day and the month. */
const CONSUMPTION_DAYS = { day: 1, month: 30 } as const;

/**
 * Tokens per provider, from the breakdown by model: a run
 * keeps only its model, and it is the runtime's catalogue that says which
 * provider serves it (the same resolver as for bots). A model
 * no connected provider claims is attributed to no one.
 */
export function consumptionByProvider(
  models: ReadonlyArray<{ model: string | null; runs: number; inputTokens: number; outputTokens: number; tokens: number }>,
  resolve: (model: string | null) => string | null,
): Map<string, ProviderConsumption> {
  const totals = new Map<string, ProviderConsumption>();
  for (const row of models) {
    const provider = resolve(row.model);
    if (!provider) continue;
    const current = totals.get(provider) ?? { runs: 0, inputTokens: 0, outputTokens: 0, tokens: 0 };
    totals.set(provider, {
      runs: current.runs + row.runs,
      inputTokens: current.inputTokens + row.inputTokens,
      outputTokens: current.outputTokens + row.outputTokens,
      tokens: current.tokens + row.tokens,
    });
  }
  return totals;
}


/** The only action of a panel banner: `BUTTON.secondary` full width (44 pt on mobile). */
const BANNER_LINK = `${BUTTON.secondary} w-full`;


/**
 * Is there something to do? Two cases, and two only: one is approaching the
 * wall, or one cannot say how far it is. A calm reading, or an
 * entirely unmeasurable set of accounts, do not justify occupying the bar.
 *
 * The wall is nobody's if it belongs to a provider IN SERVICE
 * nowhere. A ChatGPT account left connected but that no bot uses
 * can show 100% with nothing to do: that is not the wall
 * one will hit on the next turn. The alert peak is therefore that of only the
 * providers that carry a bot, or that the runtime would serve now.
 */
export function providerLimitsAlerting(limits: ProviderLimits): boolean {
  if (limits.servicePeak !== null && limits.servicePeak > ALERT_PERCENT) return true;
  return limits.status === "error" || limits.status === "disconnected";
}

/**
 * Does the reading have something to show? At least one measured account, or a
 * broken read one can repair (link closed, error). An entirely
 * unmeasurable set of accounts (OAuth with no account API, anonymous tier) would give only a
 * list of « sans relevé » and a Refresh button that will never bring anything back:
 * the composer's Quotas tab then withdraws, and comes back on its own at the first
 * measured account.
 */
export function providerLimitsWorthShowing(limits: ProviderLimits): boolean {
  if (!limits.canView || limits.runtimeId === null || limits.pending) return false;
  if (limits.readFailed || limits.status === "error" || limits.status === "disconnected") return true;
  return limits.peak !== null || limits.hasApiKey;
}

export type ProviderLimits = ReturnType<typeof useProviderLimits>;

/**
 * The panel's reads. `active` applies to the detail alone: the bot tokens
 * leave only once the panel is visible. Quota, catalogue and roster leave
 * as soon as it mounts: the sidebar alert must exist without a click, and
 * it needs to know which providers are actually in service.
 */
export function useProviderLimits(_active: boolean) {
  const queryClient = useQueryClient();
  const auth = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const canView = auth.data?.session.role === "owner" || auth.data?.session.role === "admin";
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled: canView });
  const secondaryReady = useSecondaryReadsReady();
  const runtime = runtimes.data?.runtimes[0] ?? null;
  const runtimeId = runtime?.id ?? null;
  // Polled at the API's `freshUntil`, quick only while a probe runs
  // (`provider-usage-poll.ts`, rework-flux-api step 1).
  const pendingPolls = useRef({ dataUpdatedAt: 0, count: 0 });
  const limits = useQuery({
    queryKey: queryKeys.runtimeProviderUsage(runtimeId ?? "none"),
    queryFn: () => api.runtimeProviderUsage(runtimeId!),
    enabled: canView && runtimeId !== null && secondaryReady,
    staleTime: (query) => providerUsageStaleMs(query.state.data, query.state.dataUpdatedAt),
    refetchInterval: (query) => {
      pendingPolls.current = countPendingPolls(pendingPolls.current, query.state.data, query.state.dataUpdatedAt);
      return providerUsagePollMs(query.state.data, pendingPolls.current.count, Date.now());
    },
    refetchOnWindowFocus: true,
    retry: false,
  });
  const catalog = useQuery({
    queryKey: queryKeys.runtimeModels(runtimeId ?? "none"),
    queryFn: () => api.runtimeModels(runtimeId!),
    enabled: canView && runtimeId !== null,
    staleTime: 60_000,
    retry: false,
  });
  // The roster says WHO uses which provider: the sidebar alert
  // depends on it, so it is read even with the panel closed (the bar already has it cached).
  // The bot tokens, for their part, serve only the expanded recap.
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, enabled: canView, retry: false });
  /*
    Consumption only makes sense for an API-key account: it is billed
    on these tokens, it has no other reading. Under a subscription it would
    read as its bill, which it is not (see below). It therefore
    leaves only if the reading has found an API key.
  */
  const hasApiKey = (limits.data?.providers ?? []).some((snapshot) => snapshot.source === "api_key");
  const consumptionDay = useQuery({
    queryKey: queryKeys.usageModelsWindow(CONSUMPTION_DAYS.day),
    queryFn: () => api.usageModels(CONSUMPTION_DAYS.day),
    enabled: canView && hasApiKey,
    staleTime: 60_000,
    retry: false,
  });
  const consumptionMonth = useQuery({
    queryKey: queryKeys.usageModelsWindow(CONSUMPTION_DAYS.month),
    queryFn: () => api.usageModels(CONSUMPTION_DAYS.month),
    enabled: canView && hasApiKey,
    staleTime: 60_000,
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: () => api.runtimeProviderUsage(runtimeId!, true),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.runtimeProviderUsage(runtimeId!), data),
  });

  /*
    Who runs on which provider, and nothing more. Tokens per bot have
    left this panel: a sum over seven days is not a quota, it does not
    compare to any of the neighbouring gauges, and placed under a subscription it
    read as its real consumption.
  */
  const providerBots = useMemo<ProviderBot[]>(() => {
    const providers = catalog.data?.providers ?? [];
    return (roster.data?.bots ?? [])
      .filter((bot) => bot.archivedAt === null)
      .map((bot) => ({
        id: bot.id,
        name: bot.name,
        face: bot.face,
        provider: resolveBotProvider(bot.model, {
          selectedProvider: runtime?.selectedProvider ?? null,
          selectedModel: runtime?.selectedModel ?? null,
        }, providers),
      }));
  }, [catalog.data?.providers, roster.data?.bots, runtime?.selectedModel, runtime?.selectedProvider]);

  /*
    « Réellement branché » is not `authenticated`: that boolean is also true
    for the integrated providers (`moa`, badge « Intégré » in /settings/models),
    which carry no access and therefore have neither a subscription nor a reading. The catalogue
    already computes the predicate on the API side (`provesInference` = access set AND not
    integrated, runtime-model-routes.ts), and onboarding adds the same guard
    « au moins un modèle » there. The rule is not redeclared here, it is consumed.
  */
  const providers = (catalog.data?.providers ?? [])
    .filter((provider) => provider.provesInference && provider.models.length > 0);
  const snapshots = new Map((limits.data?.providers ?? []).map((snapshot) => [snapshot.provider, snapshot]));

  /*
    « En service »: the provider the runtime would serve on the next turn,
    and those that living bots already resolve. An account left connected but
    that no bot uses is not the wall one will hit: it keeps its
    row in the panel, but it does not light the sidebar.
  */
  const inService = new Set<string>();
  if (runtime?.selectedProvider) inService.add(runtime.selectedProvider);
  for (const bot of providerBots) if (bot.provider) inService.add(bot.provider);
  const servicedProviders = providers.filter((provider) => inService.has(provider.slug));
  const catalogProviders = catalog.data?.providers ?? [];
  const resolveModel = (model: string | null) => resolveBotProvider(model, {
    selectedProvider: runtime?.selectedProvider ?? null,
    selectedModel: runtime?.selectedModel ?? null,
  }, catalogProviders);
  const consumption = {
    day: consumptionDay.data ? consumptionByProvider(consumptionDay.data.models, resolveModel) : null,
    month: consumptionMonth.data ? consumptionByProvider(consumptionMonth.data.models, resolveModel) : null,
    pending: consumptionDay.isPending || consumptionMonth.isPending,
    failed: consumptionDay.isError || consumptionMonth.isError,
  };
  const readFailed = limits.isError || catalog.isError || roster.isError;

  return {
    canView,
    runtimeId,
    /** The runtime is not known yet: a null `runtimeId` does not yet mean « aucun runtime ». */
    runtimePending: canView && runtimes.isPending,
    providers,
    snapshots,
    providerBots,
    inService,
    consumption,
    /** A connected API-key account: it has its consumption to show, even with no quota. */
    hasApiKey: providers.some((provider) => snapshots.get(provider.slug)?.source === "api_key"),
    peak: peakUsedPercent(providers, snapshots),
    /** The peak of only the providers in service: that is what alerts. */
    servicePeak: peakUsedPercent(servicedProviders, snapshots),
    status: readFailed ? "error" : limits.data?.status ?? "loading",
    reason: limits.data?.reason ?? null,
    error: limits.data?.error ?? null,
    fetchedAt: limits.data?.fetchedAt ?? null,
    pending: limits.isPending || catalog.isPending,
    botsPending: roster.isPending,
    busy: limits.isFetching || refresh.isPending,
    refreshFailed: refresh.isError,
    readFailed,
    quotaStale: limits.isError && limits.data !== undefined,
    responseAt: limits.dataUpdatedAt,
    botsReadFailed: roster.isError,
    botsResponseAt: roster.dataUpdatedAt,
    refresh: () => {
      void catalog.refetch();
      void roster.refetch();
      if (hasApiKey) {
        void consumptionDay.refetch();
        void consumptionMonth.refetch();
      }
      refresh.mutate();
    },
  };
}

/**
 * The body of the reading: status banner, read date, measured providers,
 * then those that will never have a reading. No `Dialog`: it is the caller that
 * chooses its frame.
 */
export function ProviderLimitsPanel({ limits, onNavigate }: { limits: ProviderLimits; onNavigate?: () => void }) {
  const { t, locale, formatNumber, plural } = useT();
  // Slugs whose expand was toggled by hand: a row's effective state
  // is the default (expanded when the limits cannot be read) XOR this toggle.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());

  if (!limits.canView || limits.runtimeId === null) return null;
  if (limits.pending) return <PanelSkeleton label={t("providerLimits.loading")} />;
  /*
    No provider connected: the panel withdraws. It then has only an « n/d »
    to say, and a link to /settings/models that home and the Models screen
    already make, in context.
  */
  if (limits.providers.length === 0 && !limits.readFailed) return null;

  const { providers, snapshots, status } = limits;
  // Limits readable: rows collapsed. Otherwise the bot tokens are the row's only
  // useful data, so it opens on its own.
  const hasLimits = status === "ok" || status === "stale";
  const defaultRowOpen = !hasLimits;
  // Link closed: rereading stays useful, the server settles it in one request.
  const canRefresh = status !== "unsupported";
  const message = limits.readFailed ? t("providerLimits.readFailed") : limits.refreshFailed
    ? t("providerLimits.error")
    : statusMessage(status, limits.reason, limits.error, t);
  const headerText = limits.fetchedAt
    ? t("providerLimits.readAt", { minutes: elapsedMinutes(limits.fetchedAt) })
    : status === "loading" || limits.busy
      ? t("providerLimits.loading")
      : t("providerLimits.botsOnly");

  /*
    One block per provider, and every block has the same shape, on the model
    of the reference app: an account row (icon, name · plan or « Clé API », in
    service), then either one row per window on a shared grid (label,
    gauge, value, reset), or a sentence when there is nothing to
    measure. Before, a subscription took a large figure, an API key took
    cards, and the rest a chevron list: three layouts for one
    question, « où est mon mur ».
  */
  const rows = providers.map((provider) => {
    const snapshot = snapshots.get(provider.slug)
      ?? unavailableSnapshot(provider.slug, hasLimits ? t("providerLimits.providerUnavailable") : null);
    const percent = primaryWindow(snapshot)?.usedPercent ?? null;
    const kind: ProviderRowKind = percent !== null ? "measured" : snapshot.source === "api_key" ? "apiKey" : "unmeasured";
    return {
      provider,
      snapshot,
      kind,
      percent,
      // This provider really serves: a bot resolves it, or the runtime would
      // serve it on the next turn. It is the one one looks at first, and
      // the only one that lights the sidebar.
      inService: limits.inService.has(provider.slug),
      notice: kind === "unmeasured" ? unmeasuredNotice(snapshot, provider.name, t) : null,
      bots: limits.providerBots.filter((bot) => bot.provider === provider.slug),
      open: toggled.has(provider.slug) ? !defaultRowOpen : defaultRowOpen,
      toggle: () => setToggled((current) => {
        const next = new Set(current);
        if (next.has(provider.slug)) next.delete(provider.slug); else next.add(provider.slug);
        return next;
      }),
    };
  });
  // In service first, then the most constrained: the question put to this screen
  // is « où est MON mur », not « dans quel ordre le catalogue les liste ». A
  // connected but unused account keeps its row, under the ones that work.
  const byServiceThenPercent = (a: { inService: boolean; percent: number | null }, b: typeof a) =>
    Number(b.inService) - Number(a.inService) || (b.percent ?? -1) - (a.percent ?? -1);
  const readable = rows.filter((row) => row.kind !== "unmeasured").sort(byServiceThenPercent);
  const unmeasured = rows.filter((row) => row.kind === "unmeasured").sort(byServiceThenPercent);
  // The provider IN SERVICE is read first, even with no reading: opening on
  // a quota nobody uses made one read a wall that is not ours.
  const unmeasuredFirst = !readable.some((row) => row.inService) && unmeasured.some((row) => row.inService);
  const botListProps = {
    loading: limits.botsPending,
    empty: limits.botsReadFailed ? t("botsTable.unavailable") : t("providerLimits.noBots"),
    loadingLabel: t("providerLimits.botsLoading"),
    estimated: t("providerLimits.estimated"),
  };
  const compact = (value: number) => formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
  const consumptionOf = (slug: string, window: "day" | "month") =>
    limits.consumption[window]?.get(slug) ?? { runs: 0, inputTokens: 0, outputTokens: 0, tokens: 0 };

  const renderRow = (row: (typeof rows)[number]) => (
    <section
      key={row.provider.slug}
      data-provider-row={row.provider.slug}
      data-provider-kind={row.kind}
      className="rounded-xl border border-border/60 px-3 pt-2.5 pb-1"
    >
      <header className="flex min-h-6 min-w-0 items-center gap-2">
        <ProviderIcon provider={row.provider.slug} name={row.provider.name} decorative />
        <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{row.provider.name}</h3>
        {row.kind === "apiKey" ? (
          <span className="shrink-0 text-xs text-muted-foreground">· {t("providerLimits.apiKey")}</span>
        ) : row.snapshot.plan ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">· {row.snapshot.plan}</span>
        ) : null}
        {row.inService ? (
          <span className="ms-auto inline-flex shrink-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-pos-700" />
            {t("providerLimits.inService")}
          </span>
        ) : null}
      </header>

      {row.kind === "measured" ? (
        <div className={LIMIT_GRID}>
          {row.snapshot.windows.filter((window) => window.usedPercent !== null).map((window, index) => {
            const used = window.usedPercent!;
            const reset = resetLabel(window.resetAt, t);
            return (
              <Fragment key={`${window.label}-${index}`}>
                <span className="min-w-0 truncate text-xs text-muted-foreground" title={window.label}>{window.label}</span>
                <UsageBar
                  value={used}
                  label={t("providerLimits.usedLabel", { percent: Math.round(used), reset: reset ?? t("providerLimits.resetUnknown") })}
                />
                <span className={cn("text-end text-xs font-medium tabular-nums", percentTone(used))}>
                  {t("providerLimits.usedPercentValue", { percent: Math.round(used) })}
                </span>
                <span className="text-end text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {reset ? t("providerLimits.resetIn", { reset }) : null}
                </span>
              </Fragment>
            );
          })}
        </div>
      ) : row.kind === "apiKey" ? (
        <>
          <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{t("providerLimits.apiKeyNote")}</p>
          {limits.consumption.failed ? (
            <p role="status" className="mt-2 text-xs text-warn-700">{t("providerLimits.usageFailed")}</p>
          ) : limits.consumption.pending ? (
            <p role="status" className="mt-2 text-xs text-muted-foreground">{t("providerLimits.usageLoading")}</p>
          ) : (
            <dl className={LIMIT_GRID}>
              {(["day", "month"] as const).map((window) => {
                const usage = consumptionOf(row.provider.slug, window);
                const split = t("providerLimits.usageSplit", { input: compact(usage.inputTokens), output: compact(usage.outputTokens) });
                return (
                  <Fragment key={window}>
                    <dt className="min-w-0 truncate text-xs text-muted-foreground">
                      {t(window === "day" ? "providerLimits.usageDay" : "providerLimits.usageMonth")}
                    </dt>
                    {/* The input / output detail on hover, like a window's detail
                        in the reference app: the row stays a single height. */}
                    <dd className="col-span-2 min-w-0 truncate text-xs text-foreground tabular-nums" title={split}>
                      <span className="font-medium">{t("providerLimits.usageTokens", { tokens: compact(usage.tokens) })}</span>
                      <span className="sr-only"> · {split}</span>
                    </dd>
                    <dd className="text-end text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      {plural(usage.runs, { one: t("providerLimits.usageRunsOne"), other: t("providerLimits.usageRunsMany", { count: formatNumber(usage.runs) }) })}
                    </dd>
                  </Fragment>
                );
              })}
            </dl>
          )}
        </>
      ) : row.notice ? (
        // The runtime's raw text is a diagnostic (often English): it
        // stays on hover, the visible sentence is localized.
        <p className="mt-1.5 text-xs leading-snug text-muted-foreground" title={row.snapshot.unavailableReason ?? undefined}>
          {row.notice}
        </p>
      ) : null}

      <BotsDisclosure
        label={t("providerLimits.botsUsage")}
        ariaLabel={`${row.provider.name} · ${t("providerLimits.botsUsage")}`}
        open={row.open}
        onToggle={row.toggle}
      />
      {row.open ? <BotUsageList bots={row.bots} className="mb-2 rounded-lg bg-surface p-2.5" {...botListProps} /> : null}
    </section>
  );

  const readableSection = readable.length > 0 ? (
    <div className="flex flex-col gap-2">{readable.map(renderRow)}</div>
  ) : null;
  const unmeasuredSection = unmeasured.length > 0 ? (
    <section className="flex flex-col gap-2">
      <h3 className="px-0.5 text-xs text-muted-foreground">{t("providerLimits.unmeasured")}</h3>
      {unmeasured.map(renderRow)}
    </section>
  ) : null;

  return (
    <div data-provider-limits-panel="">
      {limits.quotaStale && <p role="status" className="mb-2 text-xs text-warn-700">{t("dashboardMetrics.stale", { date: new Date(limits.responseAt).toLocaleString(locale) })}</p>}
      {limits.botsReadFailed && limits.botsResponseAt > 0 && <p role="status" className="mb-2 text-xs text-warn-700">{t("botsTable.stale", { date: new Date(limits.botsResponseAt).toLocaleString(locale) })}</p>}
      {message ? (
        <StatusBanner status={status} message={message}>
          {status === "disconnected" ? (
            <Link to="/settings/runtime" className={BANNER_LINK} onClick={onNavigate}>
              {t("providerLimits.openLink")}
            </Link>
          ) : null}
        </StatusBanner>
      ) : null}

      {/* When the read happened, and what to redo it with. The visible label
          is contained in the accessible name (WCAG 2.5.3), it does not contradict it. */}
      <div className="mb-1 flex min-h-11 items-center justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" role="status">{headerText}</p>
        <button
          type="button"
          onClick={limits.refresh}
          disabled={limits.busy || !canRefresh}
          aria-label={t("providerLimits.refresh")}
          className="openedbot-press inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
        >
          <RefreshCw className={cn("size-3.5", limits.busy && "animate-spin")} aria-hidden />
          {t("providerLimits.refreshShort")}
        </button>
      </div>

      <div className="flex flex-col gap-4">
        {unmeasuredFirst ? unmeasuredSection : readableSection}
        {unmeasuredFirst ? readableSection : unmeasuredSection}
      </div>
    </div>
  );
}
