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
import { automaticRuntimeModel } from "@/lib/bots/model-catalog";
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
  MODELS_COLUMN,
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

/** The « aucun fournisseur » value that `ProviderPreferenceCombobox` returns. */
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
    // During a model's background check, one rereads faster
    // so the progress stays honest.
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
  // The mode is a piece of the organization's data, not a view: it survives
  // reload and it GOVERNS the worker's resolution. `pendingMode` serves
  // only to display the choice during its round trip, never to replace it.
  const [pendingMode, setPendingMode] = useState<AssignmentMode | null>(null);
  // Desktop: the full provider catalog, opened in a window from
  // « Connecter un fournisseur ». The page lists only the connected ones.
  const [catalogOpen, setCatalogOpen] = useState(false);
  // The provider whose connection window is open: chosen in the
  // catalog, « Gérer » or « Réparer » on its row, or a disconnected
  // provider chosen in the default model's list.
  const [connectSlug, setConnectSlug] = useState<string | null>(null);
  // A server older than 0072 sends nothing: `per_bot`, the previous
  // behavior, rather than a silent switch of every bot to global.
  const savedMode: AssignmentMode =
    configuration.data?.modelAssignmentMode === "global" ? "global" : "perBot";
  const mode: AssignmentMode = pendingMode ?? savedMode;
  const saveMode = useMutation({
    mutationFn: (next: AssignmentMode) => api.saveModelAssignmentMode(next === "global" ? "global" : "per_bot"),
    onSuccess: (saved) => {
      queryClient.setQueryData<RuntimeConfigurationDto>(queryKeys.runtimeConfiguration, (current) =>
        current ? { ...current, modelAssignmentMode: saved } : current);
      // The mode changes what the next run will send: the composer and the thread
      // read the same configuration, they must reread it.
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
    // Unreachable runtime and a failed catalog: reread through the whole outage,
    // not at all as soon as it answers. It is this reread that lifts the veil.
    refetchInterval: (query) =>
      query.state.status === "error" && displayedRuntimeHealth(runtime) === "unreachable" ? RUNTIME_POLL_MS : false,
  });
  // The selectors' draft: nothing leaves until « Enregistrer » is pressed.
  const [draft, setDraft] = useState<Preference | null>(null);

  const stored: Preference = {
    provider: runtime?.selectedProvider ?? null,
    model: runtime?.selectedModel ?? null,
    effort: runtime?.reasoningEffort ?? null,
  };
  const preference = draft ?? stored;
  const dirty = draft !== null && !samePreference(draft, stored);
  const modelSelection = runtime?.modelSelection ?? null;
  // Stable reference: the provider table (TanStack Table) re-renders in
  // a loop on a fresh `[]` at every render.
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
    // The single entry of `GET /api/runtime`: the model indicator under the
    // composer, mounted behind the settings sheet, reads it too.
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
      // 202: the proof runs in the background, success will be said at its end.
      if (!saved.modelSelection) toast.success(t("modelsSettings.saveSuccess"));
    },
    // The draft stays: the operator can retry without retyping everything.
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

  // A check's outcome is read by comparing the configuration's previous
  // and current `modelSelection`, not by guessing.
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
   * After a successful connection (API key or OAuth), the provider just
   * linked becomes the run preference, but only if the saved
   * preference is empty or points at a provider that has become unusable.
   * The cache is reread (the invalidations have just been awaited) rather than
   * the props, which can be one render behind.
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
    // Not a gesture on the selectors: the connection has just made this choice
    // possible, so it leaves at once (the proof runs in the background).
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
    The screen's opening verdict.

    It waits until EVERYTHING is read: the configuration and, if there is a runtime, its
    catalog: otherwise an intermediate render would announce « aucun runtime »
    during the first request, then contradict itself.
  */
  const stillReading = configuration.isPending || (runtimeId !== null && catalog.isPending);
  // `catalog.data`, not `catalog.error`: TanStack keeps the data when
  // a REFRESH fails. Closing on that erased a catalog still
  // in hand, and with it the only button that allowed a retry.
  const readiness = runtimeReadiness({ runtime, catalog: catalog.data ?? null });
  if (stillReading) {
    return <SettingsPane><CatalogSkeleton label={t("modelsSettings.loading")} /></SettingsPane>;
  }
  // `no_provider` does not close the screen: what is missing is repaired in the provider
  // directory, further down this page. Closing would send the user
  // to a Runtime screen that can do nothing about it.
  if (readiness.state !== "ready" && readiness.state !== "no_provider") {
    return (
      <RuntimeNotReady
        readiness={readiness}
        runtime={runtime}
        catalogError={catalog.error}
      />
    );
  }

  // Offline: the connector link is closed (a living fact, reread every
  // 3 s), or the runtime is marked unreachable AND the catalog has just failed.
  // `unreachable` alone is not enough: it stays in the database after a past outage.
  const liveHealth = displayedRuntimeHealth(runtime);
  const offlineStatus: RuntimeOffline["status"] | null =
    liveHealth === "disconnected" || (liveHealth === "unreachable" && catalog.error !== null)
      ? liveHealth
      : null;
  // The request whose success lifts the veil: the configuration for the link,
  // the catalog for an unreachable runtime. The countdown starts from it.
  const offlineQuery = offlineStatus === "disconnected" ? configuration : catalog;
  const offline: RuntimeOffline | null = offlineStatus
    ? {
        status: offlineStatus,
        since: offlineStatus === "disconnected" ? runtime?.link?.lastSeenAt ?? null : null,
        lastAttemptAt: Math.max(offlineQuery.dataUpdatedAt, offlineQuery.errorUpdatedAt),
        checking: offlineQuery.isFetching,
      }
    : null;
  // What the runs use: the model IN SERVICE, neither the draft nor the
  // check in progress.
  const hermesDecides = stored.provider === null;
  const currentCatalog = catalog.data ?? null;
  const storedModel = providers
    .find((provider) => provider.slug === stored.provider)
    ?.models.find((model) => model.id === stored.model) ?? null;
  // With no preference, the model the worker will pick: the host's default,
  // or openedbot's own pick when the host has none (`automaticModel`).
  const automatic = automaticRuntimeModel(currentCatalog);
  const effective = currentCatalog
    ? hermesDecides
      ? { provider: automatic.provider, model: automatic.model, effort: null }
      : { provider: stored.provider, model: stored.model, effort: stored.effort }
    : null;
  const effectiveModel = currentCatalog
    ? hermesDecides
      ? providers
          .find((provider) => provider.slug === automatic.provider)
          ?.models.find((model) => model.id === automatic.model) ?? null
      : storedModel
    : null;
  // An authenticated provider does not guarantee that Hermes has already reported ITS
  // own top-level default (`/api/model/options`): the two travel
  // separately from Hermes. Without that, « Hermes décide » would stay a badge
  // that is true above a « - · - » that looks like missing data.
  const hermesDefaultPending = hermesDecides && currentCatalog !== null &&
    (automatic.provider === null || automatic.model === null);
  const automaticChosenBy = automatic.chosenBy;
  // « runtime prêt » speaks only of the gateway: a provider down under the
  // chosen model must be seen beside it, otherwise the screen is green and the runs fail.
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

  // « Réparer » from the incident window opens the down provider's access.
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
      <div className={MODELS_COLUMN}>
      {/* A single title (the modal's, or this `h1` on the page); underneath, the
          runtime whose models one sets, and on the right the reread of the
          Hermes catalog. */}
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
            {/* With no authenticated provider, no model choice is
                runnable: the server refuses the selection (409) and a run
                would fall back to the runtime's default. The page then reduces
                to a single call: connect a provider. */}
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
              <div className="flex flex-col gap-8">
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
                  automaticChosenBy={automaticChosenBy}
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
      </div>
    </SettingsPane>
    </ProviderIncidentsContext.Provider>
  );
}
