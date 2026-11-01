import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronDown, Info, RefreshCw, Unplug } from "lucide-react";
import type { ProviderUsageSnapshotDto, ProviderUsageWindowDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { resolveBotProvider } from "@openedbot/runtimes/domain/runtime/bot-provider";
import { isKeylessProvider } from "@openedbot/runtimes/domain/runtime/keyless-providers";
import { Skeleton, cn } from "@openedbot/browser-ui-kit";
import { api, queryKeys, runtimesQueryOptions } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { BotFace } from "../bot-face";
import { BUTTON } from "../settings/primitives";
import { ProviderIcon } from "../provider-icon";
import { UsageBar } from "../usage-bar";
import { useSecondaryReadsReady } from "../../lib/after-first-paint";

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

type ProviderBot = {
  id: string;
  name: string;
  face: Parameters<typeof BotFace>[0]["face"];
  provider: string | null;
};

/** La seule action d'une bannière du panneau : `BUTTON.secondary` pleine largeur (44 pt sur mobile). */
const BANNER_LINK = `${BUTTON.secondary} w-full`;

/**
 * Seuil d'alerte de la barre latérale : le même que celui qui colore le
 * chiffre (`percentTone`). La pastille apparaît donc exactement quand le
 * nombre s'écrirait en avertissement, jamais pour un quota au repos.
 */
const ALERT_PERCENT = 80;

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
  return limits.peak !== null;
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
  const readFailed = limits.isError || catalog.isError || roster.isError;

  return {
    canView,
    runtimeId,
    providers,
    snapshots,
    providerBots,
    inService,
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
  const { t, locale } = useT();
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
    Deux populations, pas une liste homogène. Un fournisseur sans endpoint de
    relevé n'est pas « en attente d'une valeur » : il n'en aura jamais. Lui
    donner la même ligne qu'un abonnement mesuré, jauge et pourcentage compris,
    dépense l'écran à répéter « rien à dire ». Le mesuré prend la scène ; le
    reste se replie en note.
  */
  const rows = providers.map((provider) => {
    const snapshot = snapshots.get(provider.slug)
      ?? unavailableSnapshot(provider.slug, hasLimits ? t("providerLimits.providerUnavailable") : null);
    return {
      provider,
      percent: primaryWindow(snapshot)?.usedPercent ?? null,
      reset: resetLabel(primaryWindow(snapshot)?.resetAt ?? null, t),
      reason: snapshot.unavailableReason,
      // `unsupported` est définitif : l'hôte n'a aucun endpoint de compte à
      // interroger (tier anonyme, clé API sans API de facturation). Ce n'est
      // pas un « n/d » à réessayer, et la ligne ne doit pas le suggérer.
      unsupported: snapshot.source === "unsupported",
      // Ce fournisseur sert vraiment : un bot le résout, ou le runtime le
      // servirait au prochain tour. C'est lui que l'on regarde en premier, et
      // lui seul qui allume la barre latérale.
      inService: limits.inService.has(provider.slug),
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
    Number(b.inService) - Number(a.inService) || (b.percent ?? 0) - (a.percent ?? 0);
  const measured = rows.filter((row) => row.percent !== null).sort(byServiceThenPercent);
  const unmeasured = rows.filter((row) => row.percent === null).sort(byServiceThenPercent);
  // Une explication par nature d'absence, pas par ligne : « jamais mesurable »
  // et « pas lu cette fois » ne se corrigent pas de la même façon. Le texte
  // brut du runtime est un diagnostic (souvent anglais) : il reste en `title`.
  // Un tier anonyme a sa raison exacte, nommée : elle vaut mieux qu'une
  // catégorie, et elle explique aussi pourquoi aucune clé ne lui est demandée.
  const keylessNotes = unmeasured
    .filter((row) => row.unsupported && isKeylessProvider(row.provider.slug))
    .map((row) => t("providerLimits.providerKeyless", { provider: row.provider.name }));
  const unsupportedCount = unmeasured.filter((row) => row.unsupported && !isKeylessProvider(row.provider.slug)).length;
  const unavailableCount = unmeasured.filter((row) => !row.unsupported && row.reason !== null).length;
  const unmeasuredNotes = [
    ...keylessNotes,
    unsupportedCount > 0 ? t(unsupportedCount > 1 ? "providerLimits.providersUnsupported" : "providerLimits.providerUnsupported") : null,
    unavailableCount > 0 ? t(unavailableCount > 1 ? "providerLimits.providersUnavailable" : "providerLimits.providerUnavailable") : null,
  ].filter((note): note is string => note !== null);
  const botListProps = {
    loading: limits.botsPending,
    empty: limits.botsReadFailed ? t("botsTable.unavailable") : t("providerLimits.noBots"),
    loadingLabel: t("providerLimits.botsLoading"),
    estimated: t("providerLimits.estimated"),
  };

  /*
    Le fournisseur EN SERVICE se lit en premier, même sans relevé : quand plus
    aucun compte mesuré ne sert, ouvrir sur un quota que personne n'utilise
    faisait lire un mur qui n'est pas le nôtre.
  */
  const serviceFirst = !measured.some((row) => row.inService) && unmeasured.some((row) => row.inService);

  const measuredSection = (
    <>
      {measured.map((row) => (
        <section key={row.provider.slug} className="border-t border-border/70 py-4 first:border-t-0 first:pt-2">
          {/* Le nombre est posé au mur que la barre vise : bord droit de la
              jauge, là où 100 % tomberait. */}
          <div className="flex items-center gap-2.5">
            <ProviderIcon provider={row.provider.slug} name={row.provider.name} decorative />
            <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{row.provider.name}</h3>
            {row.inService ? (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] leading-4 text-muted-foreground">
                {t("providerLimits.inService")}
              </span>
            ) : null}
            <span className={cn("shrink-0 text-2xl leading-none font-medium tracking-tight tabular-nums", percentTone(row.percent!))}>
              {t("providerLimits.usedPercentValue", { percent: Math.round(row.percent!) })}
            </span>
          </div>
          <UsageBar
            className="mt-3"
            value={row.percent!}
            label={t("providerLimits.usedLabel", { percent: Math.round(row.percent!), reset: row.reset ?? t("providerLimits.resetUnknown") })}
          />
          <div className="mt-3 flex min-h-11 items-center justify-between gap-3">
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {row.reset ? t("providerLimits.resetIn", { reset: row.reset }) : null}
            </p>
            <BotsDisclosure
              label={t("providerLimits.botsUsage")}
              ariaLabel={`${row.provider.name} · ${t("providerLimits.botsUsage")}`}
              open={row.open}
              onToggle={row.toggle}
            />
          </div>
          {row.open ? <BotUsageList bots={row.bots} className="rounded-lg bg-surface p-3" {...botListProps} /> : null}
        </section>
      ))}
    </>
  );

  const unmeasuredSection = (
    <>
      {unmeasured.length > 0 ? (
        <section className={cn(measured.length > 0 ? "pt-2" : "pt-3")}>
          <h3 className="pb-2 text-xs text-muted-foreground">{t("providerLimits.unmeasured")}</h3>
          <ul className="overflow-hidden rounded-xl border border-border/60 bg-surface">
            {unmeasured.map((row) => (
              <li key={row.provider.slug} className="border-b border-border/60 last:border-b-0">
                <button
                  type="button"
                  aria-expanded={row.open}
                  onClick={row.toggle}
                  // Le texte du runtime est souvent anglais : diagnostic au survol,
                  // pas copie d'interface. Le groupe porte l'explication localisée.
                  title={row.reason ?? undefined}
                  className="ohb-press flex min-h-11 w-full items-center gap-2.5 px-3 text-left outline-none ohb-row hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <ProviderIcon provider={row.provider.slug} name={row.provider.name} decorative />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.provider.name}</span>
                  {row.inService ? (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] leading-4 text-muted-foreground">
                      {t("providerLimits.inService")}
                    </span>
                  ) : null}
                  {/* « Sans relevé » est déjà le titre de la section, et la note
                      du bas dit pourquoi : répéter « non mesurable » sur chaque
                      ligne ne fait que remplir la largeur. Un « n/d », lui,
                      reste écrit : il dit une lecture qui A ÉCHOUÉ cette fois,
                      donc quelque chose qui peut revenir au prochain essai. */}
                  {row.unsupported ? null : (
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {t("providerLimits.unavailable")}
                    </span>
                  )}
                  <span className="sr-only">· {t("providerLimits.botsUsage")}</span>
                  <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", row.open && "rotate-180")} aria-hidden />
                </button>
                {row.open ? <BotUsageList bots={row.bots} className="border-t border-border/60 px-3 py-2.5" {...botListProps} /> : null}
              </li>
            ))}
          </ul>
          {unmeasuredNotes.map((note) => (
            <p key={note} className="pt-2 text-xs leading-snug text-muted-foreground">{note}</p>
          ))}
        </section>
      ) : null}
    </>
  );

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
      <div className="mb-2 flex min-h-11 items-center justify-between gap-2">
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

      {serviceFirst ? unmeasuredSection : null}
      {measuredSection}
      {serviceFirst ? null : unmeasuredSection}
    </div>
  );
}

/** Seuils : la couleur du chiffre et celle de la jauge disent la même chose. */
export function percentTone(percent: number): string {
  if (percent > 95) return "text-destructive-text";
  if (percent > ALERT_PERCENT) return "text-warn-700";
  return "text-foreground";
}

/** Dépli des jetons bots : un libellé, pas un chevron seul à deviner. */
function BotsDisclosure({
  label,
  ariaLabel,
  open,
  onToggle,
}: {
  label: string;
  ariaLabel: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-expanded={open}
      onClick={onToggle}
      className="ohb-press inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
      {label}
    </button>
  );
}

/** Bannière d'état du panneau : une icône, le message, puis l'action éventuelle. */
function StatusBanner({ status, message, children }: { status: string; message: string; children?: ReactNode }) {
  const Icon = status === "disconnected" ? Unplug : status === "error" ? AlertTriangle : Info;
  const isError = status === "error";
  return (
    <div
      role="status"
      data-provider-limits-banner={status}
      className={cn(
        "mt-2 mb-1 space-y-2.5 rounded-xl border p-3",
        isError ? "border-neg-100 bg-neg-soft" : "border-border/70 bg-surface",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-0.5 size-4 shrink-0", isError ? "text-destructive-text" : "text-muted-foreground")} aria-hidden />
        <p className="min-w-0 flex-1 text-sm leading-snug text-foreground">{message}</p>
      </div>
      {children}
    </div>
  );
}

function PanelSkeleton({ label }: { label: string }) {
  return (
    <section aria-busy="true" aria-label={label}>
      <Skeleton className="mb-3 h-3 w-16" />
      <Skeleton className="h-8 w-full" />
    </section>
  );
}

function peakUsedPercent(
  providers: RuntimeModelProviderDto[],
  snapshots: Map<string, ProviderUsageSnapshotDto>,
): number | null {
  let peak: number | null = null;
  for (const provider of providers) {
    const snapshot = snapshots.get(provider.slug);
    const used = snapshot ? primaryWindow(snapshot)?.usedPercent ?? null : null;
    if (typeof used !== "number") continue;
    peak = peak === null ? used : Math.max(peak, used);
  }
  return peak;
}

/**
 * Ligne « n/d » d'un fournisseur sans sonde. La raison n'est posée que lorsque
 * les limites se lisent par ailleurs : lien fermé ou runtime muet, la bannière
 * l'explique déjà pour tous.
 */
function unavailableSnapshot(provider: string, unavailableReason: string | null): ProviderUsageSnapshotDto {
  return { provider, source: "unavailable", plan: null, windows: [], details: [], unavailableReason };
}

function primaryWindow(snapshot: ProviderUsageSnapshotDto): ProviderUsageWindowDto | null {
  return snapshot.windows.find((window) => /week|hebdo|7[- ]?day/i.test(window.label)) ?? snapshot.windows[0] ?? null;
}

/** `null` = pas de date de réinitialisation lisible : la ligne n'affiche rien. */
export function resetLabel(value: string | null, t: ReturnType<typeof useT>["t"]): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = Math.ceil(ms / 3_600_000);
  return hours >= 24 ? t("providerLimits.resetDays", { days: Math.ceil(hours / 24) }) : t("providerLimits.resetHours", { hours });
}

function elapsedMinutes(value: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
}

function statusMessage(
  status: string,
  reason: string | null,
  error: string | null,
  t: ReturnType<typeof useT>["t"],
): string | null {
  if (status === "unsupported") return t("providerLimits.featureAbsent");
  if (status === "disconnected") return t("providerLimits.linkClosed");
  if (status === "error") return error ?? t("providerLimits.error");
  return null;
}

function BotUsageList({
  bots,
  loading,
  empty,
  loadingLabel,
  estimated,
  className,
}: {
  bots: ProviderBot[];
  loading: boolean;
  empty: string;
  loadingLabel: string;
  estimated: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <p className="pb-1 text-[11px] leading-snug text-muted-foreground">{estimated}</p>
      {loading ? <p className="text-xs text-muted-foreground" role="status">{loadingLabel}</p> : bots.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : bots.map((bot) => (
        <div key={bot.id} className="flex min-h-8 items-center gap-2.5 text-xs">
          <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-foreground">{bot.name}</span>
        </div>
      ))}
    </div>
  );
}
