import { Fragment, useMemo, useState } from "react";
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
import {
  ALERT_PERCENT, BotUsageList, BotsDisclosure, LIMIT_GRID, PanelSkeleton, StatusBanner, elapsedMinutes, peakUsedPercent,
  primaryWindow, statusMessage, unavailableSnapshot, unmeasuredNotice, percentTone, resetLabel, type ProviderBot, type ProviderRowKind,
} from "./provider-limits-parts";
export { percentTone, resetLabel } from "./provider-limits-parts";

/**
 * Le relevé des abonnements fournisseur, et lui seul.
 *
 * Une seule lecture, deux points d'entrée : l'onglet du composer la porte en
 * permanence (c'est là qu'on décide de dépenser), et le pied de la barre
 * latérale ne se montre qu'en alerte (`providerLimitsAlerting`). Avant, les
 * deux surfaces rendaient les mêmes fenêtres depuis la même clé de cache : le
 * doublon coûtait un emplacement fixe pour un nombre qui ne bouge qu'aux
 * extrêmes.
 */

/** Ce qu'openedbot a compté sur les runs terminés d'un fournisseur, sur une fenêtre. */
export type ProviderConsumption = { runs: number; inputTokens: number; outputTokens: number; tokens: number };

/** Les deux fenêtres lues pour un compte à clé API : la journée et le mois. */
const CONSUMPTION_DAYS = { day: 1, month: 30 } as const;

/**
 * Les jetons par fournisseur, à partir de la ventilation par modèle : un run
 * ne garde que son modèle, et c'est le catalogue du runtime qui dit quel
 * fournisseur le sert (le même résolveur que pour les bots). Un modèle
 * qu'aucun fournisseur branché ne revendique n'est attribué à personne.
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


/** La seule action d'une bannière du panneau : `BUTTON.secondary` pleine largeur (44 pt sur mobile). */
const BANNER_LINK = `${BUTTON.secondary} w-full`;


/**
 * Y a-t-il quelque chose à faire ? Deux cas, et deux seulement : on approche du
 * mur, ou on ne sait pas dire à quelle distance il est. Un relevé calme, ou un
 * parc entièrement non mesurable, ne justifient pas d'occuper la barre.
 *
 * Le mur n'est celui de personne s'il appartient à un fournisseur EN SERVICE
 * nulle part. Un compte ChatGPT resté branché mais qu'aucun bot n'utilise
 * peut afficher 100 % sans qu'il y ait rien à faire : ce n'est pas ce mur-là
 * qu'on va heurter au prochain tour. Le pic d'alerte est donc celui des seuls
 * fournisseurs qui portent un bot, ou que le runtime servirait maintenant.
 */
export function providerLimitsAlerting(limits: ProviderLimits): boolean {
  if (limits.servicePeak !== null && limits.servicePeak > ALERT_PERCENT) return true;
  return limits.status === "error" || limits.status === "disconnected";
}

/**
 * Le relevé a-t-il quelque chose à montrer ? Au moins un compte mesuré, ou une
 * lecture cassée qu'on peut réparer (lien fermé, erreur). Un parc entièrement
 * non mesurable (OAuth sans API de compte, tier anonyme) ne donnerait qu'une
 * liste de « sans relevé » et un bouton Actualiser qui ne ramènera jamais rien :
 * l'onglet Quotas du composer se retire alors, et revient seul au premier
 * compte mesuré.
 */
export function providerLimitsWorthShowing(limits: ProviderLimits): boolean {
  if (!limits.canView || limits.runtimeId === null || limits.pending) return false;
  if (limits.readFailed || limits.status === "error" || limits.status === "disconnected") return true;
  return limits.peak !== null || limits.hasApiKey;
}

export type ProviderLimits = ReturnType<typeof useProviderLimits>;

/**
 * Les lectures du panneau. `active` vaut pour le détail seul : les jetons bots
 * ne partent qu'une fois le panneau visible. Quota, catalogue et roster partent
 * dès le montage : l'alerte de la barre latérale doit exister sans clic, et
 * elle a besoin de savoir quels fournisseurs sont réellement en service.
 */
export function useProviderLimits(_active: boolean) {
  const queryClient = useQueryClient();
  const auth = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const canView = auth.data?.session.role === "owner" || auth.data?.session.role === "admin";
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled: canView });
  const secondaryReady = useSecondaryReadsReady();
  const runtime = runtimes.data?.runtimes[0] ?? null;
  const runtimeId = runtime?.id ?? null;
  const limits = useQuery({
    queryKey: queryKeys.runtimeProviderUsage(runtimeId ?? "none"),
    queryFn: () => api.runtimeProviderUsage(runtimeId!),
    enabled: canView && runtimeId !== null && secondaryReady,
    staleTime: 60_000,
    refetchInterval: (query) => query.state.data?.status === "loading" || query.state.data?.status === "stale" ? 2_000 : 120_000,
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
  // Le roster dit QUI utilise quel fournisseur : l'alerte de la barre latérale
  // en dépend, donc il est lu même panneau fermé (la barre l'a déjà en cache).
  // Les jetons bots, eux, ne servent qu'au récap déplié.
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster, enabled: canView, retry: false });
  /*
    La consommation n'a de sens que pour un compte à clé API : il est facturé
    sur ces jetons, il n'a pas d'autre relevé. Sous un abonnement elle se
    lirait comme sa facture, ce qu'elle n'est pas (voir plus bas). Elle ne
    part donc que si le relevé a trouvé une clé API.
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
    Qui tourne sur quel fournisseur, et rien de plus. Les jetons par bot ont
    quitté ce panneau : une somme sur sept jours n'est pas un quota, elle ne se
    compare à aucune des jauges voisines, et posée sous un abonnement elle se
    lisait comme sa consommation réelle.
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
    « Réellement branché » n'est pas `authenticated` : ce booléen est vrai aussi
    pour les fournisseurs intégrés (`moa`, badge « Intégré » dans /settings/models),
    qui ne portent aucun accès et n'ont donc ni abonnement ni relevé. Le catalogue
    calcule déjà le prédicat côté API (`provesInference` = accès posé ET non
    intégré, runtime-model-routes.ts), et l'onboarding y ajoute la même garde
    « au moins un modèle ». On ne redéclare pas la règle ici, on la consomme.
  */
  const providers = (catalog.data?.providers ?? [])
    .filter((provider) => provider.provesInference && provider.models.length > 0);
  const snapshots = new Map((limits.data?.providers ?? []).map((snapshot) => [snapshot.provider, snapshot]));

  /*
    « En service » : le fournisseur que le runtime servirait au prochain tour,
    et ceux que des bots vivants résolvent déjà. Un compte resté branché mais
    qu'aucun bot n'utilise n'est pas le mur qu'on va heurter : il garde sa
    ligne dans le panneau, mais il n'allume pas la barre latérale.
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
    /** Le runtime n'est pas encore connu : `runtimeId` nul ne veut pas encore dire « aucun runtime ». */
    runtimePending: canView && runtimes.isPending,
    providers,
    snapshots,
    providerBots,
    inService,
    consumption,
    /** Un compte à clé API branché : il a sa consommation à montrer, même sans quota. */
    hasApiKey: providers.some((provider) => snapshots.get(provider.slug)?.source === "api_key"),
    peak: peakUsedPercent(providers, snapshots),
    /** Le pic des seuls fournisseurs en service : c'est lui qui alerte. */
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
 * Le corps du relevé : bannière d'état, date de lecture, fournisseurs mesurés,
 * puis ceux qui n'auront jamais de relevé. Sans `Dialog` : c'est l'appelant qui
 * choisit son cadre.
 */
export function ProviderLimitsPanel({ limits, onNavigate }: { limits: ProviderLimits; onNavigate?: () => void }) {
  const { t, locale, formatNumber, plural } = useT();
  // Slugs dont le dépli a été basculé à la main : l'état effectif d'une ligne
  // est le défaut (déplié quand les limites ne se lisent pas) XOR ce bascule.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());

  if (!limits.canView || limits.runtimeId === null) return null;
  if (limits.pending) return <PanelSkeleton label={t("providerLimits.loading")} />;
  /*
    Aucun fournisseur branché : le panneau se retire. Il n'a alors qu'un « n/d »
    à dire, et un renvoi vers /settings/models que l'accueil et l'écran Modèles
    font déjà, en contexte.
  */
  if (limits.providers.length === 0 && !limits.readFailed) return null;

  const { providers, snapshots, status } = limits;
  // Limites lisibles : lignes repliées. Sinon les jetons bots sont la seule
  // donnée utile de la ligne, donc elle s'ouvre d'elle-même.
  const hasLimits = status === "ok" || status === "stale";
  const defaultRowOpen = !hasLimits;
  // Lien fermé : relire reste utile, le serveur retranche en une requête.
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
    Un bloc par fournisseur, et tous les blocs ont la même forme, sur le modèle
    de t3code : une ligne de compte (icône, nom · forfait ou « Clé API », en
    service), puis soit une ligne par fenêtre sur une grille commune (libellé,
    jauge, valeur, réinitialisation), soit une phrase quand il n'y a rien à
    mesurer. Avant, un abonnement prenait un grand chiffre, une clé API des
    cartes, et le reste une liste à chevrons : trois mises en page pour une
    seule question, « où est mon mur ».
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
      // Ce fournisseur sert vraiment : un bot le résout, ou le runtime le
      // servirait au prochain tour. C'est lui que l'on regarde en premier, et
      // lui seul qui allume la barre latérale.
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
  // En service d'abord, puis le plus contraint : la question posée à cet écran
  // est « où est MON mur », pas « dans quel ordre le catalogue les liste ». Un
  // compte branché mais inutilisé garde sa ligne, sous celles qui travaillent.
  const byServiceThenPercent = (a: { inService: boolean; percent: number | null }, b: typeof a) =>
    Number(b.inService) - Number(a.inService) || (b.percent ?? -1) - (a.percent ?? -1);
  const readable = rows.filter((row) => row.kind !== "unmeasured").sort(byServiceThenPercent);
  const unmeasured = rows.filter((row) => row.kind === "unmeasured").sort(byServiceThenPercent);
  // Le fournisseur EN SERVICE se lit en premier, même sans relevé : ouvrir sur
  // un quota que personne n'utilise faisait lire un mur qui n'est pas le nôtre.
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
                    {/* Le détail entrée / sortie au survol, comme le détail d'une
                        fenêtre chez t3code : la ligne reste d'une seule hauteur. */}
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
        // Le texte brut du runtime est un diagnostic (souvent anglais) : il
        // reste au survol, la phrase visible est localisée.
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

      {/* Quand la lecture a eu lieu, et de quoi la refaire. Le libellé visible
          tient dans le nom accessible (WCAG 2.5.3), il ne le contredit pas. */}
      <div className="mb-1 flex min-h-11 items-center justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" role="status">{headerText}</p>
        <button
          type="button"
          onClick={limits.refresh}
          disabled={limits.busy || !canRefresh}
          aria-label={t("providerLimits.refresh")}
          className="ohb-press inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
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
