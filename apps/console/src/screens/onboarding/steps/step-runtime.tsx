import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { directProbePassed } from "../../../components/runtime-direct";
import { RuntimeReplacement } from "../../settings/installation/cloud";
import { CheckCircle2, Loader2, Plug } from "lucide-react";
import { DEFAULT_REASONING_EFFORT, HERMES_REASONING_EFFORTS, type HermesReasoningEffort, type RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { cn, CommandGroup, CommandItem, Skeleton, SkeletonRegion, toast } from "@openedbot/browser-ui-kit";
import { ObButton, FieldLabel } from "@openedbot/browser-ui-kit/components/onboarding";
import { api, errorMessage, queryKeys } from "../../../lib/api";
import { EMPTY_RUNTIME_DRAFT, readOnboardingDraft, writeOnboardingDraft } from "../../../lib/session/onboarding-draft";
import { useT } from "../../../lib/i18n";
import { defaultTierModel } from "@openedbot/runtimes/domain/runtime/default-model";
import { ProviderConfigDialog } from "../../settings/installation/models";
import { ModelPreferenceCombobox } from "../../settings/installation/models/models-provider-combobox";
import { SearchCombobox } from "../../settings/installation/models/models-search-combobox";
import { ProviderIcon } from "../../../components/provider-icon";
import { effortLabel } from "../../../lib/bots/effort-label";
import { RiFlashlightFill } from "@remixicon/react";
import { CARD_DESCRIPTION, CARD_TITLE, SETTINGS_INSET, SETTINGS_SHELL, SETTINGS_SHELL_HEADER } from "../../../components/settings/primitives";
import { StepFooter, StepHeading } from "../components/step-shell";

const MODEL_VERIFY_POLL_MS = 1_000;
const MODEL_VERIFY_TIMEOUT_MS = 3 * 60_000;
/** Past this wait, the status line says why it can last (a host that just restarted reconnects within a minute). */
const SLOW_WAIT_MS = 10_000;

type Translate = ReturnType<typeof useT>["t"];

/**
 * Step « Configuration »: the machine, the AI provider and the runtime's
 * model, and nothing else. The choice is saved on the runtime
 * (`saveRuntimeModelSelection`); a model never proved on this runtime is proved
 * in the background (`watchModelProof`), without holding the operator. The first
 * bot is created afterwards in the application and starts from this model.
 */
export function StepRuntime({
  onFinish,
  onSkip,
}: {
  onFinish: () => Promise<void>;
  onSkip: () => Promise<void>;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const configuration = useQuery({
    queryKey: queryKeys.runtimeConfiguration,
    queryFn: api.runtimeConfiguration,
  });
  const runtime = configuration.data?.runtime ?? null;
  // The choice not yet saved starts again from the local draft, otherwise an F5
  // picks it back up empty.
  const [draft] = useState(() => readOnboardingDraft()?.runtime ?? EMPTY_RUNTIME_DRAFT);
  const [busy, setBusy] = useState(false);
  // Provider and model taken as they are: the effects below
  // replace them automatically if the reread catalog no longer offers them.
  const [providerSlug, setProviderSlug] = useState(draft.providerSlug);
  const [modelId, setModelId] = useState(draft.modelId);
  // `null`: the runtime decides. Starts from the effort already saved on the runtime.
  const [effort, setEffort] = useState<HermesReasoningEffort | null>(null);
  useEffect(() => {
    if (runtime) setEffort(runtime.reasoningEffort);
  }, [runtime?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [providerDialogSlug, setProviderDialogSlug] = useState<string | null>(null);

  // A row in the database is not proof of availability. This probe
  // replays on mount and closes bot creation in case of an outage.
  const runtimeProbe = useQuery({
    queryKey: ["onboarding", "runtime-probe", runtime?.id ?? "none"],
    queryFn: async () => runtime?.reachability === "direct" && runtime.id ? api.testDirectRuntime(runtime.id) : api.testRuntime(),
    enabled: Boolean(runtime?.id),
    retry: false,
    staleTime: 0,
  });
  const runtimeVerified = runtime?.reachability === "direct"
    ? Boolean(runtimeProbe.data && "steps" in runtimeProbe.data && directProbePassed(runtimeProbe.data))
    : runtimeProbe.data?.ok === true;

  const modelCatalog = useQuery({
    queryKey: queryKeys.runtimeModels(runtime?.id ?? "none"),
    queryFn: () => api.runtimeModels(runtime!.id!),
    enabled: Boolean(runtime?.id && runtimeVerified),
    retry: false,
  });
  /**
   * ONE list of providers, not two: those that already answer (« Prêt ») at the
   * head, then those the operator can link from here (« À connecter »), on a
   * runtime joined by the link and only there, since the key goes through it.
   * Choosing a provider to connect offers to connect it; the model is
   * chosen only once the provider is ready.
   */
  const providerOptions = useMemo(() => {
    const providers = modelCatalog.data?.providers ?? [];
    const usable = providers.filter(isUsable);
    const connectable = runtime?.reachability === "connector"
      ? providers.filter((provider) => !isUsable(provider) && isConnectable(provider))
      : [];
    return [...usable, ...connectable];
  }, [modelCatalog.data, runtime?.reachability]);
  const readyOptions = providerOptions.filter(isUsable);
  const connectOptions = providerOptions.filter((provider) => !isUsable(provider));
  const selectedProvider = providerOptions.find((provider) => provider.slug === providerSlug) ?? null;
  const selectedUsable = selectedProvider && isUsable(selectedProvider) ? selectedProvider : null;
  const selectedModel = selectedUsable?.models.find((model) => model.id === modelId) ?? null;

  useEffect(() => {
    if (providerOptions.length === 0) {
      setProviderSlug("");
      setModelId("");
      return;
    }
    if (providerOptions.some((provider) => provider.slug === providerSlug)) return;
    const usable = providerOptions.filter(isUsable);
    const preferred = usable.find((provider) => provider.slug === runtime?.selectedProvider)
      ?? usable.find((provider) => provider.slug === modelCatalog.data?.currentProvider)
      ?? providerOptions[0]!;
    setProviderSlug(preferred.slug);
    setModelId(defaultModel(preferred, runtime?.selectedModel));
  }, [modelCatalog.data?.currentProvider, providerOptions, providerSlug, runtime?.selectedModel, runtime?.selectedProvider]);

  useEffect(() => {
    if (!selectedUsable) return;
    if (!selectedUsable.models.some((model) => model.id === modelId)) setModelId(defaultModel(selectedUsable));
  }, [modelId, selectedUsable]);

  useEffect(() => {
    writeOnboardingDraft({ runtime: { providerSlug, modelId } });
  }, [modelId, providerSlug]);

  const saveSelection = useMutation({
    mutationFn: async () => {
      const saved = await api.saveRuntimeModelSelection(runtime!.id!, {
        provider: providerSlug,
        model: modelId,
        reasoningEffort: selectedModel?.reasoning ? effort : null,
      });
      const status = saved.modelSelection?.status;
      // 202: the server proves the model with a real trial (about ten
      // seconds for a large model). The welcome does not wait: the proof
      // continues on the server side, and a toast that survives navigation says
      // the outcome, so the runtime does not keep the old model in silence.
      if (status === "queued" || status === "running") {
        void watchModelProof({ provider: providerSlug, model: modelId, queryClient, runtimeId: runtime!.id!, t });
      }
      return saved;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeModels(runtime!.id!) });
    },
  });

  const handleFinish = async () => {
    if (busy || !runtime?.id || !runtimeVerified || !selectedUsable || !selectedModel) return;
    setBusy(true);
    try {
      try {
        await saveSelection.mutateAsync();
      } catch {
        // The save's failure shows under the button (`saveSelection.error`).
        return;
      }
      await onFinish();
    } finally {
      setBusy(false);
    }
  };

  const providerToConfigure: RuntimeModelProviderDto | null = modelCatalog.data?.providers
    .find((provider) => provider.slug === providerDialogSlug) ?? null;
  const ready = Boolean(!configuration.error && !modelCatalog.error && runtime?.id && runtimeVerified && selectedUsable && selectedModel);
  // Probe then catalog: ONE status line follows them in the machine card, and
  // the fields keep their final place as a silhouette until the catalog lands.
  const probing = Boolean(runtime?.id) && runtimeProbe.isPending;
  const catalogLoading = runtimeVerified && modelCatalog.isPending;
  const waiting = probing || catalogLoading;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), SLOW_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  return (
    <div className="flex flex-col gap-8 pt-2 sm:pt-6">
      <StepHeading
        title={t("onboarding.runtime.title")}
        description={t("onboarding.runtime.description")}
      />
      {configuration.isPending ? (
        <SkeletonRegion label={t("onboarding.runtime.machineLoading")} className="space-y-3 rounded-lg border bg-muted/30 px-4 py-3">
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-1/2" />
        </SkeletonRegion>
      ) : null}
      {configuration.error ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive-text" role="alert">{errorMessage(configuration.error, t("onboarding.runtime.machineLoadFailed"))}</p>
          <ObButton type="button" variant="secondary" disabled={configuration.isFetching} onClick={() => void configuration.refetch()}>{t("common.retry")}</ObButton>
        </div>
      ) : null}
      {configuration.isSuccess && !runtime ? (
        <>
          <p className="text-sm text-muted-foreground">{t("onboarding.runtime.machineIntro")}</p>
          <RuntimeReplacement activeId={null} initiallyAdding />
        </>
      ) : null}

      {runtime ? (
        <div className="space-y-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
          <p>{t("onboarding.runtime.machineLabel")} : <strong>{runtime.name}</strong> · {runtime.reachability === "direct" ? t("onboarding.runtime.machineDirect") : t("onboarding.runtime.machineConnector")}</p>
          {waiting ? (
            <p className="flex items-center gap-2 text-muted-foreground" role="status">
              <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
              {probing ? t("onboarding.runtime.machineChecking") : t("onboarding.runtime.catalogLoading")}
            </p>
          ) : null}
          {waiting && slow ? <p className="text-caption text-muted-foreground">{t("onboarding.runtime.machineSlow")}</p> : null}
          {runtimeVerified && !catalogLoading ? <p className="flex items-center gap-2 text-pos-700" role="status"><CheckCircle2 className="size-4" aria-hidden />{t("onboarding.runtime.machineVerified")}</p> : null}
          {/*
            A host that does not offer `provider_management` over the outgoing link
            will receive no credential from this interface: say so here,
            before the provider dialog discovers it.
          */}
          {runtimeVerified && runtime.management.kind === "manual" ? (
            <p className="text-muted-foreground" role="note">{t("onboarding.runtime.ownedRuntimeHint")}</p>
          ) : null}
          {runtimeProbe.error ? <p className="text-destructive-text" role="alert">{errorMessage(runtimeProbe.error, t("onboarding.runtime.machineUnreachable"))}</p> : null}
          {!runtimeProbe.isPending && !runtimeVerified ? <ObButton type="button" variant="secondary" onClick={() => void runtimeProbe.refetch()}>{t("common.retry")}</ObButton> : null}
        </div>
      ) : null}

      {waiting ? (
        // The card already in its final shape: real title and sentence, a
        // silhouette in place of each field (`h-11`, `rounded-[10px]` of the trigger).
        <AiCard t={t}>
          <div aria-hidden className="flex flex-col gap-4">
            <Skeleton className="h-11 rounded-[10px]" />
            <div className="flex flex-col gap-2">
              <FieldLabel>{t("onboarding.runtime.modelLabel")}</FieldLabel>
              <Skeleton className="h-11 rounded-[10px]" />
            </div>
          </div>
        </AiCard>
      ) : null}
      {modelCatalog.error ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive-text" role="alert">{errorMessage(modelCatalog.error, t("onboarding.runtime.catalogUnavailable"))}</p>
          <ObButton type="button" variant="secondary" disabled={modelCatalog.isFetching} onClick={() => void modelCatalog.refetch()}>{t("common.retry")}</ObButton>
        </div>
      ) : null}
      {modelCatalog.data ? (
        <AiCard t={t}>
          <div className="flex flex-col gap-4">
            <SearchCombobox
              id="onboarding-provider"
              triggerLabel={selectedProvider ? (
                <span className="flex min-w-0 items-center gap-2.5">
                  <ProviderIcon provider={selectedProvider.slug} name={selectedProvider.name} decorative withTitle={false} />
                  <span className="truncate">{selectedProvider.name}</span>
                </span>
              ) : <span className="text-muted-foreground">{t("onboarding.runtime.providerPlaceholder")}</span>}
              disabled={providerOptions.length === 0}
              inline
              searchPlaceholder={t("modelsSettings.providerSearchPlaceholder")}
              emptyText={t("modelsSettings.providerSearchEmpty")}
            >
              {(close) => {
                const pick = (provider: RuntimeModelProviderDto) => {
                  close();
                  setProviderSlug(provider.slug);
                  setModelId(isUsable(provider) ? defaultModel(provider) : "");
                };
                return (
                  <>
                    {readyOptions.length > 0 ? (
                      <CommandGroup heading={t("onboarding.runtime.providerGroupReady")}>
                        {readyOptions.map((provider) => (
                          <CommandItem
                            key={provider.slug}
                            value={`${provider.name} ${provider.slug}`}
                            data-checked={provider.slug === providerSlug ? true : undefined}
                            onSelect={() => pick(provider)}
                          >
                            <ProviderIcon provider={provider.slug} name={provider.name} decorative withTitle={false} />
                            <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ) : null}
                    {connectOptions.length > 0 ? (
                      <CommandGroup heading={t("onboarding.runtime.providerGroupToConnect")}>
                        {connectOptions.map((provider) => (
                          <CommandItem
                            key={provider.slug}
                            value={`${provider.name} ${provider.slug}`}
                            data-checked={provider.slug === providerSlug ? true : undefined}
                            className="text-muted-foreground"
                            onSelect={() => pick(provider)}
                          >
                            <ProviderIcon provider={provider.slug} name={provider.name} decorative withTitle={false} className="opacity-60" />
                            <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                            <Plug aria-hidden className="size-3.5 text-muted-foreground/70" />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ) : null}
                  </>
                );
              }}
            </SearchCombobox>

            {selectedProvider && !selectedUsable ? (
              // The chosen provider does not answer yet: linking it is THE next
              // gesture, right under it, not a parallel form.
              <div className="flex flex-col gap-3 rounded-[10px] bg-muted/40 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <p className="text-muted-foreground">{t("onboarding.runtime.providerNotConnected", { provider: selectedProvider.name })}</p>
                <ObButton
                  type="button"
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => setProviderDialogSlug(selectedProvider.slug)}
                >
                  <Plug aria-hidden />
                  {t("onboarding.runtime.providerConnect", { provider: selectedProvider.name })}
                </ObButton>
              </div>
            ) : null}

            {selectedUsable ? (
              <div className="flex flex-col gap-2">
                <FieldLabel htmlFor="onboarding-model">{t("onboarding.runtime.modelLabel")}</FieldLabel>
                <ModelPreferenceCombobox
                  id="onboarding-model"
                  models={selectedUsable.models}
                  value={modelId || null}
                  disabled={selectedUsable.models.length === 0}
                  onValueChange={setModelId}
                  inline
                  showFast
                />
              </div>
            ) : null}

            {selectedModel ? (
              // The effort follows the model: a model that does not reason gets
              // no control, only the sentence that says why.
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel id="onboarding-effort">{t("onboarding.runtime.effortLabel")}</FieldLabel>
                  {selectedModel.fast ? (
                    <span className="flex shrink-0 items-center gap-1 text-caption text-muted-foreground">
                      <RiFlashlightFill aria-hidden className="size-3.5 text-accent-500" />
                      {t("onboarding.runtime.fastPerBot")}
                    </span>
                  ) : null}
                </div>
                {selectedModel.reasoning ? (
                  <>
                    <EffortSegments
                      t={t}
                      value={effort ?? DEFAULT_REASONING_EFFORT}
                      disabled={saveSelection.isPending}
                      onChange={setEffort}
                    />
                    <p className="text-caption text-muted-foreground" aria-live="polite">
                      {t(EFFORT_HINTS[effort ?? DEFAULT_REASONING_EFFORT])}
                    </p>
                  </>
                ) : (
                  <p className="text-caption text-muted-foreground">{t("composer.modelNoEffort")}</p>
                )}
              </div>
            ) : null}

            {providerOptions.length === 0 ? (
              <p className="text-sm text-destructive-text" role="alert">
                {t("onboarding.runtime.providerMissing")}
              </p>
            ) : null}
          </div>
        </AiCard>
      ) : null}

      <StepFooter
        hint={ready
          ? t("onboarding.runtime.footerReady")
          : waiting
            ? t("onboarding.runtime.footerWaiting")
            : selectedProvider && !selectedUsable
            ? t("onboarding.runtime.footerConnect", { provider: selectedProvider.name })
            : t("onboarding.runtime.footerMissing")}
      >
        <ObButton type="button" disabled={busy || !ready || saveSelection.isPending} onClick={() => void handleFinish()}>
          {saveSelection.isPending
            ? t("onboarding.runtime.testing")
            : busy ? t("onboarding.runtime.finishing") : t("onboarding.runtime.finish")}
        </ObButton>
        <ObButton type="button" variant="ghost" disabled={busy} onClick={() => void onSkip()}>{t("onboarding.runtime.skip")}</ObButton>
      </StepFooter>
      {saveSelection.error ? <p className="text-sm text-destructive-text" role="alert">{errorMessage(saveSelection.error, t("onboarding.runtime.selectionFailed"))}</p> : null}

      {runtime?.reachability === "connector" && providerToConfigure ? (
        <ProviderConfigDialog
          runtime={runtime}
          provider={providerToConfigure}
          hermesProfile={modelCatalog.data?.hermesProfile ?? null}
          onClose={() => setProviderDialogSlug(null)}
          onConnected={(slug) => {
            setProviderDialogSlug(null);
            void modelCatalog.refetch().then(({ data }) => {
              const provider = data?.providers.find((candidate) => candidate.slug === slug && isUsable(candidate)) ?? null;
              if (!provider) return;
              setProviderSlug(provider.slug);
              setModelId(defaultModel(provider));
            });
          }}
        />
      ) : null}
    </div>
  );
}

/** A provider that answers: a proved inference and at least one model. */
/**
 * Follows the model's proof outside React: the step unmounts as soon as « Terminer »,
 * the toast and this loop stay. A reload interrupts it without losing
 * anything: the proof lives in the database and the Models page shows its state.
 */
async function watchModelProof({ provider, model, queryClient, runtimeId, t }: {
  provider: string;
  model: string;
  queryClient: QueryClient;
  runtimeId: string;
  t: Translate;
}): Promise<void> {
  const settled = (async () => {
    const deadline = Date.now() + MODEL_VERIFY_TIMEOUT_MS;
    for (;;) {
      if (Date.now() >= deadline) throw new Error(t("onboarding.runtime.verifyTimeout"));
      await new Promise((resolve) => setTimeout(resolve, MODEL_VERIFY_POLL_MS));
      // A read that never comes back must not leave the toast
      // loading: the deadline also bounds the request in flight.
      let expiry: ReturnType<typeof setTimeout> | undefined;
      const current = await Promise.race([
        api.runtimeConfiguration(),
        new Promise<never>((_, reject) => {
          expiry = setTimeout(() => reject(new Error(t("onboarding.runtime.verifyTimeout"))), Math.max(0, deadline - Date.now()));
        }),
      ]).finally(() => clearTimeout(expiry));
      const selection = current.runtime?.modelSelection ?? null;
      if (selection === null) {
        if (current.runtime?.selectedProvider === provider && current.runtime.selectedModel === model) return;
        throw new Error(t("onboarding.runtime.selectionNotApplied"));
      }
      if (selection.status === "failed") {
        throw new Error(selection.error?.message || t("onboarding.runtime.selectionFailed"));
      }
    }
  })();
  try {
    await toast.promise(settled, {
      loading: t("onboarding.runtime.modelCheckPending", { model }),
      success: t("onboarding.runtime.modelCheckPassed", { model }),
      error: (error) => ({
        title: t("onboarding.runtime.modelCheckFailed", { model }),
        description: errorMessage(error, t("onboarding.runtime.selectionFailed")),
      }),
    });
  } catch {
    // The failure is already in the toast; nothing else to do here.
  } finally {
    await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
    await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeModels(runtimeId) });
  }
}

/**
 * The AI choice as a settings card (`SETTINGS_SHELL` › `SETTINGS_INSET`): the
 * tray carries the title and its sentence, the white inset the fields. The
 * title labels the provider field.
 */
function AiCard({ t, children }: { t: Translate; children: ReactNode }) {
  return (
    <section className={SETTINGS_SHELL}>
      <div className={SETTINGS_SHELL_HEADER}>
        <label htmlFor="onboarding-provider" className={CARD_TITLE}>{t("onboarding.runtime.providerLabel")}</label>
        <p className={CARD_DESCRIPTION}>{t("onboarding.runtime.providerHint")}</p>
      </div>
      <div className={cn(SETTINGS_INSET, "p-3")}>{children}</div>
    </section>
  );
}

/** What each level changes, said in the user's terms: speed, quality, cost. */
const EFFORT_HINTS = {
  none: "onboarding.runtime.effortHintNone",
  minimal: "onboarding.runtime.effortHintMinimal",
  low: "onboarding.runtime.effortHintLow",
  medium: "onboarding.runtime.effortHintMedium",
  high: "onboarding.runtime.effortHintHigh",
  xhigh: "onboarding.runtime.effortHintXhigh",
} as const satisfies Record<HermesReasoningEffort, string>;

/**
 * The six Hermes levels as one segmented radio group: the white thumb slides
 * to the chosen level (the only motion, answering the click), a dot marks the
 * runtime default. Arrows, Home and End move the choice, as in a native group.
 */
function EffortSegments({ t, value, disabled, onChange }: {
  t: Translate;
  value: HermesReasoningEffort;
  disabled: boolean;
  onChange: (effort: HermesReasoningEffort) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const count = HERMES_REASONING_EFFORTS.length;
  const index = HERMES_REASONING_EFFORTS.indexOf(value);
  const move = (next: number) => {
    const target = (next + count) % count;
    onChange(HERMES_REASONING_EFFORTS[target]!);
    buttons.current[target]?.focus();
  };
  return (
    <div role="radiogroup" aria-labelledby="onboarding-effort" className="relative grid grid-cols-6 rounded-[10px] bg-muted p-0.5">
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 rounded-[8px] bg-card shadow-[var(--shadow-xs)] transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{ width: `calc((100% - 0.25rem) / ${count})`, transform: `translateX(${index * 100}%)` }}
      />
      {HERMES_REASONING_EFFORTS.map((level, position) => {
        const label = effortLabel(t, level);
        const isDefault = level === DEFAULT_REASONING_EFFORT;
        return (
          <button
            key={level}
            ref={(element) => { buttons.current[position] = element; }}
            type="button"
            role="radio"
            aria-checked={position === index}
            aria-label={isDefault ? `${label}, ${t("composer.modelEffortDefault")}` : label}
            tabIndex={position === index ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(level)}
            onKeyDown={(event) => {
              const next = { ArrowRight: position + 1, ArrowDown: position + 1, ArrowLeft: position - 1, ArrowUp: position - 1, Home: 0, End: count - 1 }[event.key];
              if (next === undefined) return;
              event.preventDefault();
              move(next);
            }}
            className={cn(
              "relative z-10 flex h-8 items-center justify-center rounded-[8px] px-1 text-caption font-medium whitespace-nowrap outline-none transition-colors duration-150",
              "focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed",
              position === index ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {isDefault ? <span aria-hidden className="absolute bottom-0.5 size-1 rounded-full bg-current opacity-40" /> : null}
          </button>
        );
      })}
    </div>
  );
}

function isUsable(provider: RuntimeModelProviderDto): boolean {
  return provider.provesInference && provider.models.length > 0;
}

/** A provider the operator can link from the console: a key or an account to set. */
function isConnectable(provider: RuntimeModelProviderDto): boolean {
  return !provider.alwaysAuthenticated && (provider.acceptsApiKey || provider.acceptsOauth || !provider.authenticated);
}

/**
 * The model offered by default: the one already chosen on the runtime, otherwise the provider's
 * current range (Sonnet, Luna, Flash), otherwise the runtime's default,
 * otherwise the first.
 */
function defaultModel(provider: RuntimeModelProviderDto, preferred?: string | null): string {
  return provider.models.find((model) => model.id === preferred)?.id
    ?? defaultTierModel(provider.models)?.id
    ?? provider.models.find((model) => model.isRuntimeDefault)?.id
    ?? provider.models[0]?.id
    ?? "";
}
