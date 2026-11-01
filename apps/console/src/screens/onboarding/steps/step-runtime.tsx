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
 * Étape « Configuration » : la machine, le fournisseur d'IA et le modèle du
 * runtime, et rien d'autre. Le choix est enregistré sur le runtime
 * (`saveRuntimeModelSelection`) ; un modèle jamais prouvé sur ce runtime l'est
 * en arrière-plan (`watchModelProof`), sans retenir l'opérateur. Le premier
 * bot se crée ensuite dans l'application et part de ce modèle.
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
  // Le choix pas encore enregistré repart du brouillon local, sinon un F5 le
  // reprend à vide.
  const [draft] = useState(() => readOnboardingDraft()?.runtime ?? EMPTY_RUNTIME_DRAFT);
  const [busy, setBusy] = useState(false);
  // Fournisseur et modèle repris tels quels : les effets ci-dessous les
  // remplacent d'office si le catalogue relu ne les propose plus.
  const [providerSlug, setProviderSlug] = useState(draft.providerSlug);
  const [modelId, setModelId] = useState(draft.modelId);
  const [providerDialogSlug, setProviderDialogSlug] = useState<string | null>(null);

  // Une ligne en base n'est pas une preuve de disponibilité. Cette sonde se
  // rejoue au montage et ferme la création du bot en cas de panne.
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
   * UNE liste de fournisseurs, pas deux : ceux qui répondent déjà (« Prêt ») en
   * tête, puis ceux que l'opérateur peut relier d'ici (« À connecter »), sur un
   * runtime joint par le lien et seulement là, puisque la clé passe par lui.
   * Choisir un fournisseur à connecter propose de le connecter ; le modèle ne
   * se choisit qu'une fois le fournisseur prêt.
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
      // 202 : le serveur prouve le modèle par un vrai essai (une dizaine de
      // secondes pour un grand modèle). L'accueil n'attend pas : la preuve
      // continue côté serveur, et un toast qui survit à la navigation en dit
      // l'issue, pour que le runtime ne garde pas l'ancien modèle en silence.
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
        // L'échec de l'enregistrement s'affiche sous le bouton (`saveSelection.error`).
        return;
      }
      await onFinish();
    } finally {
      setBusy(false);
    }
  };

  const providerToConfigure: RuntimeModelProviderDto | null = modelCatalog.data?.providers
    .find((provider) => provider.slug === providerDialogSlug) ?? null;
  const ready = Boolean(runtime?.id && runtimeVerified && selectedUsable && selectedModel);

  return (
    <div className="flex flex-col gap-8 pt-2 sm:pt-6">
      <StepHeading
        title={t("onboarding.runtime.title")}
        description={t("onboarding.runtime.description")}
      />
      {configuration.isPending ? <p role="status">{t("onboarding.runtime.machineLoading")}</p> : null}
      {!configuration.isPending && !runtime ? (
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
            Un hôte qui n'offre pas `provider_management` par le lien sortant
            ne recevra aucun credential depuis cette interface : le dire ici,
            avant que le dialogue fournisseur ne le découvre.
          */}
          {runtimeVerified && runtime.management.kind === "manual" ? (
            <p className="text-muted-foreground" role="note">{t("onboarding.runtime.ownedRuntimeHint")}</p>
          ) : null}
          {runtimeProbe.error ? <p className="text-destructive-text" role="alert">{errorMessage(runtimeProbe.error, t("onboarding.runtime.machineUnreachable"))}</p> : null}
          {!runtimeProbe.isPending && !runtimeVerified ? <ObButton type="button" variant="secondary" onClick={() => void runtimeProbe.refetch()}>{t("common.retry")}</ObButton> : null}
        </div>
      ) : null}

      {runtimeVerified && modelCatalog.isPending ? <p className="flex items-center gap-2" role="status"><Loader2 className="size-4 animate-spin" aria-hidden />{t("onboarding.runtime.catalogLoading")}</p> : null}
      {modelCatalog.error ? <p className="text-sm text-destructive-text" role="alert">{errorMessage(modelCatalog.error, t("onboarding.runtime.catalogUnavailable"))}</p> : null}
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
            // Le fournisseur choisi ne répond pas encore : le relier est LE geste
            // suivant, juste sous lui, pas un formulaire parallèle.
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

/** Un fournisseur qui répond : une inférence prouvée et au moins un modèle. */
/**
 * Suit la preuve du modèle hors de React : l'étape se démonte dès « Terminer »,
 * le toast et cette boucle restent. Un rechargement l'interrompt sans rien
 * perdre : la preuve vit en base et la page Modèles en affiche l'état.
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
      // Une lecture qui ne revient jamais ne doit pas laisser le toast en
      // chargement : l'échéance borne aussi la requête en vol.
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
    // L'échec est déjà dans le toast ; rien d'autre à faire ici.
  } finally {
    await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
    await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeModels(runtimeId) });
  }
}

function isUsable(provider: RuntimeModelProviderDto): boolean {
  return provider.provesInference && provider.models.length > 0;
}

/** Un fournisseur que l'opérateur peut relier depuis la console : une clé ou un compte à poser. */
function isConnectable(provider: RuntimeModelProviderDto): boolean {
  return !provider.alwaysAuthenticated && (provider.acceptsApiKey || provider.acceptsOauth || !provider.authenticated);
}

/**
 * Le modèle proposé d'office : celui déjà choisi sur le runtime, sinon la gamme
 * courante du fournisseur (Sonnet, Luna, Flash), sinon le défaut du runtime,
 * sinon le premier.
 */
function defaultModel(provider: RuntimeModelProviderDto, preferred?: string | null): string {
  return provider.models.find((model) => model.id === preferred)?.id
    ?? defaultTierModel(provider.models)?.id
    ?? provider.models.find((model) => model.isRuntimeDefault)?.id
    ?? provider.models[0]?.id
    ?? "";
}
