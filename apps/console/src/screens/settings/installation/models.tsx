import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconRefresh } from "@tabler/icons-react";
import { Badge, cn, toast, useIsMobile } from "@openedbot/browser-ui-kit";
import type {
  RuntimeConfigurationDto,
  RuntimeModelCatalogDto,
  RuntimeModelSelectionStateDto,
  RuntimePublicDto,
} from "@openedbot/contracts-api";
import { visibleRosterItems } from "@/lib/thread/thread-visibility";
import { ApiError, api, queryKeys } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import {
  BUTTON,
  CardHeading,
  Note,
  SectionHeading,
  SettingsCard,
  ToneBadge,
} from "../../../components/settings/primitives";
import { SettingsPane } from "../pane";
import { runtimeReadiness } from "./models/models-readiness";
import {
  activeProviderIncident,
  ProviderIncidentDialog,
  ProviderIncidentsContext,
} from "../../../components/provider-incident-banner";
import { displayedRuntimeHealth, runtimeHealthLabel } from "../../../lib/runtime/runtime-health";
import {
  NONE,
  RUNTIME_POLL_MS,
  SELECTION_POLL_MS,
  type AssignmentMode,
  type Preference,
  type RuntimeOffline,
} from "./models/models-shared";
import { CatalogSkeleton } from "./models/models-catalog-parts";
import { RuntimeNotReady, RuntimeOfflineVeil } from "./models/models-offline";
import { ModelsMobile } from "./models/models-mobile";
import { BotModelsCard, DefaultModelCard, preferenceForProvider } from "./models/models-preference-panel";
import { ConnectedProviders, ProviderCatalogDialog } from "./models/models-provider-directory";
import { ProviderConfigDialog } from "./models/models-provider-dialog";
import {
  clearProviderReconnect,
  holdProviderReconnect,
  freshProviderReconnect,
  releaseProviderReconnect,
  useProviderReconnectRequest,
} from "../../../lib/runtime/provider-auth";

export { ProviderConfigDialog } from "./models/models-provider-dialog";
export { ProviderPreferenceCombobox } from "./models/models-provider-combobox";

/** La valeur « aucun fournisseur » que rend `ProviderPreferenceCombobox`. */
export const PROVIDER_PREFERENCE_NONE = NONE;

function samePreference(a: Preference, b: Preference): boolean {
  return a.provider === b.provider && a.model === b.model && a.effort === b.effort;
}

export function ModelsSettings() {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  // The active runtime and its reachability come from the same configuration.
  const configuration = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
    // The connector can reconnect while this screen and its dialog stay open.
    // Pendant la vérification en arrière-plan d'un modèle, on relit plus vite
    // pour que la progression reste honnête.
    refetchInterval: (query) => {
      const status = query.state.data?.runtime?.modelSelection?.status;
      return status === "queued" || status === "running" ? SELECTION_POLL_MS : RUNTIME_POLL_MS;
    },
    refetchOnWindowFocus: true,
  });
  const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
  const activeBots = useMemo(
    () => visibleRosterItems(roster.data?.bots ?? []).filter((bot) => bot.archivedAt === null),
    [roster.data],
  );
  const overriddenBots = activeBots.filter((bot) => bot.model !== null || bot.reasoningEffort !== null);
  // Le mode est une donnée de l'organisation, pas une vue : il survit au
  // rechargement et il GOUVERNE la résolution du worker. `pendingMode` ne sert
  // qu'à afficher le choix pendant son aller-retour, jamais à le remplacer.
  const [pendingMode, setPendingMode] = useState<AssignmentMode | null>(null);
  // Bureau : le catalogue complet des fournisseurs, ouvert en fenêtre depuis
  // « Connecter un fournisseur ». La page ne liste que les connectés.
  const [catalogOpen, setCatalogOpen] = useState(false);
  // Le fournisseur dont la fenêtre de connexion est ouverte : choisi dans le
  // catalogue, « Gérer » ou « Réparer » sur sa ligne, ou un fournisseur non
  // connecté choisi dans la liste du modèle par défaut.
  const [connectSlug, setConnectSlug] = useState<string | null>(null);
  // Un serveur antérieur à la 0072 n'envoie rien : `per_bot`, le comportement
  // d'avant, plutôt qu'une bascule silencieuse de tous les bots vers le global.
  const savedMode: AssignmentMode =
    configuration.data?.modelAssignmentMode === "global" ? "global" : "perBot";
  const mode: AssignmentMode = pendingMode ?? savedMode;
  const saveMode = useMutation({
    mutationFn: (next: AssignmentMode) => api.saveModelAssignmentMode(next === "global" ? "global" : "per_bot"),
    onSuccess: (saved) => {
      queryClient.setQueryData<RuntimeConfigurationDto>(queryKeys.runtimeConfiguration, (current) =>
        current ? { ...current, modelAssignmentMode: saved } : current);
      // Le mode change ce que le prochain run enverra : le composer et le fil
      // lisent la même configuration, ils doivent la relire.
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
      toast.success(t("modelsSettings.modeSaved"));
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t("modelsSettings.modeSaveFailed"));
    },
    onSettled: () => setPendingMode(null),
  });
  const chooseMode = (next: AssignmentMode) => {
    if (next === mode || saveMode.isPending) return;
    setPendingMode(next);
    saveMode.mutate(next);
  };
  const runtime = configuration.data?.runtime ?? null;
  const runtimeId = runtime?.id ?? null;
  const reachability = runtime?.reachability ?? null;
  const catalog = useQuery({
    queryKey: queryKeys.runtimeModels(runtimeId ?? "none"),
    queryFn: () => api.runtimeModels(runtimeId!),
    enabled: runtimeId !== null,
    // Runtime injoignable et catalogue en échec : relu pendant toute la panne,
    // plus du tout dès qu'il répond. C'est cette relecture qui lève le voile.
    refetchInterval: (query) =>
      query.state.status === "error" && displayedRuntimeHealth(runtime) === "unreachable" ? RUNTIME_POLL_MS : false,
  });
  // Le brouillon des sélecteurs : rien ne part tant que « Enregistrer » n'est pas pressé.
  const [draft, setDraft] = useState<Preference | null>(null);

  const stored: Preference = {
    provider: runtime?.selectedProvider ?? null,
    model: runtime?.selectedModel ?? null,
    effort: runtime?.reasoningEffort ?? null,
  };
  const preference = draft ?? stored;
  const dirty = draft !== null && !samePreference(draft, stored);
  const modelSelection = runtime?.modelSelection ?? null;
  // Référence stable : le tableau fournisseurs (TanStack Table) re-rend en
  // boucle sur un `[]` neuf à chaque rendu.
  const providers = useMemo(() => catalog.data?.providers ?? [], [catalog.data]);
  // "Reconnect <provider>" from a failed turn: that provider's dialog opens
  // over the screen once the catalogue lists it (`provider-auth.ts`).
  const reconnectRequest = useProviderReconnectRequest();
  const reconnectSlug = freshProviderReconnect(reconnectRequest);
  const reconnectProvider = reconnectSlug ? providers.find((entry) => entry.slug === reconnectSlug) ?? null : null;
  // The incident dialog would say the same thing over it (the failed login
  // recorded an `auth` incident), then again once it closes: not on this visit.
  const [reconnectShown, setReconnectShown] = useState(false);
  useEffect(() => {
    if (!reconnectProvider) return;
    setReconnectShown(true);
    holdProviderReconnect();
    // Unmounted with the dialog open: release it rather than clear it, so a
    // StrictMode remount or a catalogue refetch holds it again at once.
    return releaseProviderReconnect;
  }, [reconnectProvider]);
  // A pending request holds it too, so it does not flash before the catalogue
  // loads; a provider the catalogue does not list clears the request and lets it show.
  const incidentDialog = !reconnectShown && !reconnectSlug;
  useEffect(() => {
    if (!reconnectRequest) return;
    // Stale, or a catalogue that does not list it: the screen alone stays.
    if (!freshProviderReconnect(reconnectRequest)) clearProviderReconnect();
    else if (catalog.data && !catalog.data.providers.some((entry) => entry.slug === reconnectRequest.provider)) clearProviderReconnect();
  }, [reconnectRequest, catalog.data]);
  const activeProvider = providers.find((provider) => provider.slug === preference.provider) ?? null;
  const activeModel = activeProvider?.models.find((model) => model.id === preference.model) ?? null;

  const writeRuntime = (saved: RuntimePublicDto) => {
    // L'unique entrée de `GET /api/runtime` : l'indicateur de modèle sous le
    // composer, monté derrière la feuille de réglages, la lit aussi.
    queryClient.setQueryData<RuntimeConfigurationDto>(queryKeys.runtimeConfiguration, (current) =>
      current ? { ...current, runtime: saved } : current,
    );
  };
  const save = useMutation({
    mutationFn: (next: Preference) => api.saveRuntimeModelSelection(runtimeId!, {
      provider: next.provider,
      model: next.model,
      reasoningEffort: next.effort,
    }),
    onSuccess: (saved) => {
      writeRuntime(saved);
      setDraft(null);
      // 202 : la preuve tourne en arrière-plan, le succès se dira à son terme.
      if (!saved.modelSelection) toast.success(t("modelsSettings.saveSuccess"));
    },
    // Le brouillon reste : l'opérateur peut réessayer sans tout resaisir.
    onError: (error: Error) => {
      toast.error(error.message || t("modelsSettings.saveFailed"));
    },
  });
  const cancelSelection = useMutation({
    mutationFn: () => api.cancelRuntimeModelSelection(runtimeId!),
    onSuccess: writeRuntime,
    onError: (error: Error) => {
      toast.error(error.message || t("modelsSettings.saveFailed"));
    },
  });

  const edit = (next: Preference) => setDraft(next);
  const saveDraft = () => {
    if (draft && dirty && !save.isPending) save.mutate(draft);
  };
  const retrySelection = () => {
    if (!modelSelection || save.isPending) return;
    save.mutate({
      provider: modelSelection.provider,
      model: modelSelection.model,
      effort: modelSelection.reasoningEffort,
    });
  };
  const selectionBusy = save.isPending || cancelSelection.isPending;

  // L'issue d'une vérification se lit en comparant la `modelSelection`
  // précédente et l'actuelle de la configuration, pas en devinant.
  const previousSelection = useRef<RuntimeModelSelectionStateDto | null>(null);
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = modelSelection;
    if (!previous || previous === modelSelection) return;
    if (modelSelection === null) {
      const applied = previous.status !== "failed" &&
        runtime?.selectedProvider === previous.provider &&
        runtime?.selectedModel === previous.model &&
        (runtime?.reasoningEffort ?? null) === previous.reasoningEffort;
      if (!applied) return;
      toast.success(t("modelsSettings.selectionApplied", { model: previous.model ?? t("modelsSettings.defaultBadge") }));
      if (runtimeId) void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeModels(runtimeId) });
    } else if (modelSelection.status === "failed" && previous.status !== "failed") {
      toast.error(t("modelsSettings.selectionFailed", {
        model: modelSelection.model ?? t("modelsSettings.defaultBadge"),
        message: modelSelection.error?.message ?? t("modelsSettings.saveFailed"),
      }));
    }
  }, [modelSelection, runtime?.selectedProvider, runtime?.selectedModel, runtime?.reasoningEffort, runtimeId, queryClient, t]);

  /**
   * Après une connexion réussie (clé API ou OAuth), le fournisseur tout juste
   * relié devient la préférence de run, mais seulement si la préférence
   * enregistrée est vide ou pointe vers un fournisseur devenu inutilisable.
   * On relit le cache (les invalidations viennent d'être attendues) plutôt que
   * les props, qui peuvent être en retard d'un rendu.
   */
  const handleProviderConnected = (slug: string) => {
    if (!runtimeId) return;
    const freshCatalog = queryClient.getQueryData<RuntimeModelCatalogDto>(queryKeys.runtimeModels(runtimeId));
    const freshRuntime = queryClient
      .getQueryData<RuntimeConfigurationDto>(queryKeys.runtimeConfiguration)
      ?.runtime ?? runtime;
    const connectedProvider = freshCatalog?.providers.find((entry) => entry.slug === slug) ?? null;
    const next = preferenceForProvider(connectedProvider, slug);
    if (!connectedProvider?.authenticated || next.model === null) return;
    const storedProvider = freshRuntime?.selectedProvider ?? null;
    const storedUsable = storedProvider !== null &&
      (freshCatalog?.providers.some((entry) => entry.slug === storedProvider && entry.authenticated) ?? false);
    if (storedUsable) return;
    toast.success(t("modelsSettings.autoSelected", { provider: connectedProvider.name, model: next.model }));
    // Pas un geste sur les sélecteurs : la connexion vient de rendre ce choix
    // possible, il part donc tout de suite (la preuve tourne en arrière-plan).
    save.mutate(next);
  };

  const reconnectDialog = runtime && reconnectProvider ? (
    <ProviderConfigDialog
      runtime={runtime}
      provider={reconnectProvider}
      hermesProfile={catalog.data?.hermesProfile ?? null}
      onClose={clearProviderReconnect}
      onConnected={(slug) => {
        clearProviderReconnect();
        handleProviderConnected(slug);
      }}
    />
  ) : null;

  if (configuration.error) {
    return <SettingsPane><Note tone="danger" role="alert">{t("modelsSettings.registryFailed")}</Note></SettingsPane>;
  }

  /*
    Le verdict d'ouverture de l'écran.

    Il attend que TOUT soit lu : la configuration et, s'il y a un runtime, son
    catalogue : sinon un rendu intermédiaire annoncerait « aucun runtime »
    pendant la première requête, puis se contredirait.
  */
  const stillReading = configuration.isPending || (runtimeId !== null && catalog.isPending);
  // `catalog.data`, pas `catalog.error` : TanStack conserve les données quand
  // un RAFRAÎCHISSEMENT échoue. Fermer là-dessus effaçait un catalogue encore
  // en main, et avec lui le seul bouton qui permettait de réessayer.
  const readiness = runtimeReadiness({ runtime, catalog: catalog.data ?? null });
  if (stillReading) {
    return <SettingsPane><CatalogSkeleton label={t("modelsSettings.loading")} /></SettingsPane>;
  }
  // `no_provider` ne ferme pas l'écran : ce qui manque se répare dans l'annuaire
  // des fournisseurs, plus bas dans cette page. Fermer renverrait l'utilisateur
  // vers un écran Runtime qui n'y peut rien.
  if (readiness.state !== "ready" && readiness.state !== "no_provider") {
    return (
      <RuntimeNotReady
        readiness={readiness}
        runtime={runtime}
        catalogError={catalog.error}
      />
    );
  }

  // Hors ligne : le lien connecteur est fermé (fait vivant, relu toutes les
  // 3 s), ou le runtime est noté injoignable ET le catalogue vient d'échouer.
  // `unreachable` seul ne suffit pas : il reste en base après une panne passée.
  const liveHealth = displayedRuntimeHealth(runtime);
  const offlineStatus: RuntimeOffline["status"] | null =
    liveHealth === "disconnected" || (liveHealth === "unreachable" && catalog.error !== null)
      ? liveHealth
      : null;
  // La requête dont la réussite lève le voile : la configuration pour le lien,
  // le catalogue pour un runtime injoignable. Le compte à rebours part d'elle.
  const offlineQuery = offlineStatus === "disconnected" ? configuration : catalog;
  const offline: RuntimeOffline | null = offlineStatus
    ? {
        status: offlineStatus,
        since: offlineStatus === "disconnected" ? runtime?.link?.lastSeenAt ?? null : null,
        lastAttemptAt: Math.max(offlineQuery.dataUpdatedAt, offlineQuery.errorUpdatedAt),
        checking: offlineQuery.isFetching,
      }
    : null;
  // Ce que les runs utilisent : le modèle EN SERVICE, ni le brouillon ni la
  // vérification en cours.
  const hermesDecides = stored.provider === null;
  const currentCatalog = catalog.data ?? null;
  const storedModel = providers
    .find((provider) => provider.slug === stored.provider)
    ?.models.find((model) => model.id === stored.model) ?? null;
  const effective = currentCatalog
    ? hermesDecides
      ? { provider: currentCatalog.currentProvider, model: currentCatalog.runtimeDefaultModel, effort: null }
      : { provider: stored.provider, model: stored.model, effort: stored.effort }
    : null;
  const effectiveModel = currentCatalog
    ? hermesDecides
      ? providers
          .find((provider) => provider.slug === currentCatalog.currentProvider)
          ?.models.find((model) => model.id === currentCatalog.runtimeDefaultModel) ?? null
      : storedModel
    : null;
  // Un provider authentifié ne garantit pas que Hermes ait déjà remonté SON
  // propre défaut top-level (`/api/model/options`) : les deux voyagent
  // séparément depuis Hermes. Sans ça, « Hermes décide » resterait un badge
  // vrai au-dessus d'un « - · - » qui ressemble à une donnée manquante.
  const hermesDefaultPending = hermesDecides && currentCatalog !== null &&
    (currentCatalog.currentProvider === null || currentCatalog.runtimeDefaultModel === null);
  // « runtime prêt » ne parle que du gateway : un fournisseur en panne sous le
  // modèle choisi doit se voir à côté, sinon l'écran est vert et les runs échouent.
  const effectiveIncident = activeProviderIncident(runtime?.providerIncidents, effective?.provider);
  const incidentBadge = effectiveIncident ? (
    <ToneBadge tone="danger">
      {t(effectiveIncident.kind === "quota" ? "providerIncidents.badgeQuota" : "providerIncidents.badgeAuth", {
        provider: effectiveIncident.provider,
      })}
    </ToneBadge>
  ) : null;

  if (isMobile) {
    return (
      <ProviderIncidentsContext.Provider value={runtime?.providerIncidents ?? []}>
      <ModelsMobile
        runtime={runtime}
        runtimeId={runtimeId}
        reachability={reachability}
        providers={providers}
        catalog={currentCatalog}
        catalogFetching={catalog.isFetching}
        onRefresh={() => void catalog.refetch()}
        preference={preference}
        effective={effective}
        hermesDecides={hermesDecides}
        hermesDefaultPending={hermesDefaultPending}
        saving={save.isPending}
        onEdit={edit}
        dirty={dirty}
        onSave={saveDraft}
        onReset={() => setDraft(null)}
        modelSelection={modelSelection}
        selectionBusy={selectionBusy}
        onCancelSelection={() => cancelSelection.mutate()}
        onRetrySelection={retrySelection}
        bots={activeBots}
        overriddenBots={overriddenBots}
        rosterPending={roster.isPending}
        rosterError={roster.error !== null}
        readinessNoProvider={readiness.state === "no_provider"}
        onProviderConnected={handleProviderConnected}
        offline={offline}
        incidentDialog={incidentDialog}
      />
      {reconnectDialog}
      </ProviderIncidentsContext.Provider>
    );
  }

  // « Réparer » depuis la fenêtre d'incident ouvre l'accès du fournisseur en panne.
  const firstIncident = (runtime?.providerIncidents ?? []).find((incident) => new Date(incident.until).getTime() > Date.now()) ?? null;
  const refreshButton = (
    <button
      type="button"
      className={cn(BUTTON.secondary, "size-8 px-0", catalog.isFetching && "[&_svg]:animate-spin")}
      disabled={catalog.isFetching}
      onClick={() => void catalog.refetch()}
      aria-label={t("modelsSettings.refreshAria")}
      title={catalog.isFetching ? t("modelsSettings.refreshing") : t("modelsSettings.refresh")}
      data-models-refresh=""
    >
      <IconRefresh aria-hidden className="size-4" />
    </button>
  );

  return (
    <ProviderIncidentsContext.Provider value={runtime?.providerIncidents ?? []}>
    <SettingsPane>
      {/* Un seul titre (celui de la modale, ou ce `h1` en page) ; dessous, le
          runtime dont on règle les modèles, et à droite la relecture du
          catalogue Hermes. */}
      <SectionHeading
        title={t("modelsSettings.title")}
        description={runtime ? (
          <span className="flex flex-wrap items-center gap-2" data-models-runtime="">
            <span className="font-medium text-foreground">{runtime.name}</span>
            {reachability ? (
              <Badge variant="outline">
                {reachability === "direct" ? t("runtimeDirect.direct") : t("modelsSettings.reachabilityLink")}
              </Badge>
            ) : null}
            <ToneBadge tone={runtime.lastHealthStatus === "healthy" ? "success" : "warning"}>
              {runtimeHealthLabel(runtime, null, locale)}
            </ToneBadge>
            {incidentBadge}
            {readiness.state === "ready" && !readiness.pinned
              ? <ToneBadge tone="info">{t("modelsSettings.unpinnedBadge")}</ToneBadge>
              : null}
            {runtime.management.kind === "hermes_dashboard" ? <Badge variant="outline">Hermes Dashboard</Badge> : null}
          </span>
        ) : t("modelsSettings.description")}
        action={runtimeId ? refreshButton : null}
      />
      {incidentDialog ? (
        <ProviderIncidentDialog
          incidents={runtime?.providerIncidents}
          onReconnect={firstIncident ? () => setConnectSlug(firstIncident.provider) : undefined}
        />
      ) : null}
      {reconnectDialog}

      {catalog.data && runtime && runtimeId && effective ? (
        <>
          {catalog.error && !offlineStatus ? (
            <Note tone="danger" role="alert">
              {catalog.error instanceof Error ? catalog.error.message : t("modelsSettings.catalogFailed")}
            </Note>
          ) : null}

          <RuntimeOfflineVeil
            offline={offline}
            runtime={runtime}
            onRetry={() => void catalog.refetch()}
          >
            {/* Sans fournisseur authentifié, aucun choix de modèle n'est
                exécutable : le serveur refuse la sélection (409) et un run
                retomberait sur le défaut du runtime. La page se réduit alors
                à un seul appel : connecter un fournisseur. */}
            {readiness.state === "no_provider" ? (
              <SettingsCard className="space-y-3" data-models-no-provider="">
                <CardHeading
                  title={t("modelsSettings.noProviderTitle")}
                  description={t("modelsSettings.noProviderCallDescription")}
                />
                <button type="button" className={BUTTON.primary} onClick={() => setCatalogOpen(true)}>
                  {t("modelsSettings.providerConnectNew")}
                </button>
              </SettingsCard>
            ) : (
              <div className="flex flex-col gap-4">
                <DefaultModelCard
                  providers={providers}
                  preference={preference}
                  saving={save.isPending}
                  edit={edit}
                  dirty={dirty}
                  onSave={saveDraft}
                  onReset={() => setDraft(null)}
                  onConnectProvider={setConnectSlug}
                  activeProvider={activeProvider}
                  activeModel={activeModel}
                  modelSelection={modelSelection}
                  selectionBusy={selectionBusy}
                  onCancelSelection={() => cancelSelection.mutate()}
                  onRetrySelection={retrySelection}
                  incidentBadge={incidentBadge}
                  hermesDecides={hermesDecides}
                  hermesDefaultPending={hermesDefaultPending}
                  effective={effective}
                  effectiveModel={effectiveModel}
                  effectiveIncident={effectiveIncident}
                />
                <BotModelsCard
                  mode={mode}
                  modePending={saveMode.isPending}
                  chooseMode={chooseMode}
                  overriddenBots={overriddenBots}
                  activeBots={activeBots}
                  rosterPending={roster.isPending}
                  rosterError={roster.error !== null}
                  providers={providers}
                  globalModel={effective.model}
                  globalProvider={effective.provider}
                />
                <ConnectedProviders
                  providers={providers}
                  defaultProvider={effective.provider}
                  onManage={setConnectSlug}
                  onBrowse={() => setCatalogOpen(true)}
                />
              </div>
            )}
          </RuntimeOfflineVeil>

          <ProviderCatalogDialog
            open={catalogOpen}
            providers={providers}
            onClose={() => setCatalogOpen(false)}
            onPick={(slug) => {
              setCatalogOpen(false);
              setConnectSlug(slug);
            }}
          />
          <ProviderConfigDialog
            runtime={runtime}
            provider={providers.find((entry) => entry.slug === connectSlug) ?? null}
            hermesProfile={catalog.data.hermesProfile}
            onClose={() => setConnectSlug(null)}
            onConnected={handleProviderConnected}
          />
        </>
      ) : null}
    </SettingsPane>
    </ProviderIncidentsContext.Provider>
  );
}
