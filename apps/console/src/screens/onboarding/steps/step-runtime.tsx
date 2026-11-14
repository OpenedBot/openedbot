import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { directProbePassed } from "../../../components/runtime-direct";
import { RuntimeReplacement } from "../../settings/installation/cloud";
import { CheckCircle2, Loader2, Plug } from "lucide-react";
import type { RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue, toast } from "@openedbot/browser-ui-kit";
import { ObButton, Field, FieldDescription, FieldGroup, FieldLabel } from "@openedbot/browser-ui-kit/components/onboarding";
import { api, errorMessage, queryKeys } from "../../../lib/api";
import { EMPTY_RUNTIME_DRAFT, readOnboardingDraft, writeOnboardingDraft } from "../../../lib/session/onboarding-draft";
import { useT } from "../../../lib/i18n";
import { modelsByRelease } from "../../../lib/bots/model-catalog";
import { defaultTierModel } from "@openedbot/runtimes/domain/runtime/default-model";
import { ProviderConfigDialog } from "../../settings/installation/models";
import { StepFooter, StepHeading } from "../components/step-shell";

const MODEL_VERIFY_POLL_MS = 1_000;
const MODEL_VERIFY_TIMEOUT_MS = 3 * 60_000;

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
      const saved = await api.saveRuntimeModelSelection(runtime!.id!, { provider: providerSlug, model: modelId });
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

  return (
    <div className="flex flex-col gap-8 pt-2 sm:pt-6">
      <StepHeading
        title={t("onboarding.runtime.title")}
        description={t("onboarding.runtime.description")}
      />
      {configuration.isPending ? <p role="status">{t("onboarding.runtime.machineLoading")}</p> : null}
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
          {runtimeProbe.isPending ? <p className="flex items-center gap-2" role="status"><Loader2 className="size-4 animate-spin" aria-hidden />{t("onboarding.runtime.machineChecking")}</p> : null}
          {runtimeVerified ? <p className="flex items-center gap-2 text-pos-700" role="status"><CheckCircle2 className="size-4" aria-hidden />{t("onboarding.runtime.machineVerified")}</p> : null}
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

      {runtimeVerified && modelCatalog.isPending ? <p className="flex items-center gap-2" role="status"><Loader2 className="size-4 animate-spin" aria-hidden />{t("onboarding.runtime.catalogLoading")}</p> : null}
      {modelCatalog.error ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive-text" role="alert">{errorMessage(modelCatalog.error, t("onboarding.runtime.catalogUnavailable"))}</p>
          <ObButton type="button" variant="secondary" disabled={modelCatalog.isFetching} onClick={() => void modelCatalog.refetch()}>{t("common.retry")}</ObButton>
        </div>
      ) : null}
      {modelCatalog.data ? (
        <FieldGroup>
          <Field data-disabled={providerOptions.length === 0 || undefined}>
            <FieldLabel htmlFor="onboarding-provider">{t("onboarding.runtime.providerLabel")}</FieldLabel>
            <FieldDescription>{t("onboarding.runtime.providerHint")}</FieldDescription>
            <Select
              value={providerSlug}
              disabled={providerOptions.length === 0}
              onValueChange={(slug) => {
                const provider = providerOptions.find((candidate) => candidate.slug === slug) ?? null;
                setProviderSlug(slug);
                setModelId(provider && isUsable(provider) ? defaultModel(provider) : "");
              }}
            >
              <SelectTrigger id="onboarding-provider">
                <SelectValue placeholder={t("onboarding.runtime.providerPlaceholder")} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {readyOptions.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>{t("onboarding.runtime.providerGroupReady")}</SelectLabel>
                    {readyOptions.map((provider) => (
                      <SelectItem key={provider.slug} value={provider.slug}>{provider.name}</SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
                {readyOptions.length > 0 && connectOptions.length > 0 ? <SelectSeparator /> : null}
                {connectOptions.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>{t("onboarding.runtime.providerGroupToConnect")}</SelectLabel>
                    {connectOptions.map((provider) => (
                      <SelectItem key={provider.slug} value={provider.slug}>{provider.name}</SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
          </Field>

          {selectedProvider && !selectedUsable ? (
            // The chosen provider does not answer yet: linking it is THE next
            // gesture, right under it, not a parallel form.
            <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
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
            <Field>
              <FieldLabel htmlFor="onboarding-model">{t("onboarding.runtime.modelLabel")}</FieldLabel>
              <Select value={modelId} onValueChange={setModelId} disabled={selectedUsable.models.length === 0}>
                <SelectTrigger id="onboarding-model">
                  <SelectValue placeholder={t("onboarding.runtime.modelPlaceholder")} />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectGroup>
                    {modelsByRelease(selectedUsable.models).map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        <span className="block max-w-[min(28rem,75vw)] truncate font-mono">{model.id}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          {providerOptions.length === 0 ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive-text" role="alert">
              {t("onboarding.runtime.providerMissing")}
            </p>
          ) : null}
        </FieldGroup>
      ) : null}

      <StepFooter
        hint={ready
          ? t("onboarding.runtime.footerReady")
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
