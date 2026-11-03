import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { isHermesReasoningEffort, type HermesReasoningEffort } from "@openedbot/contracts-api";
import { catalogModelView, resolveThreadModel, runtimeGlobalModel } from "@/lib/bots/model-catalog";
import { api, queryKeys, runtimesQueryOptions } from "../../lib/api";
import { displayedRuntimeHealth } from "../../lib/runtime/runtime-health";
import { ComposerModelPicker } from "../composer-model-picker";

/** The model a bot will be created with: `null` follows the runtime's model. */
export type DraftModelChoice = {
  model: string | null;
  provider: string | null;
  effort: HermesReasoningEffort | null;
};

export const DRAFT_MODEL_DEFAULT: DraftModelChoice = { model: null, provider: null, effort: null };

/**
 * Le sélecteur de modèle d'un bot qui n'existe pas encore (l'accueil `/`) :
 * le même catalogue et le même panneau que le composer (`ThreadModelPicker`),
 * mais le choix reste dans le formulaire et part avec la création. Rien
 * choisi : le bot suivra le modèle du runtime, que le déclencheur nomme.
 */
export function DraftModelPicker({ value, onChange }: {
  value: DraftModelChoice;
  onChange: (next: DraftModelChoice) => void;
}) {
  const runtimes = useQuery(runtimesQueryOptions());
  const assignment = useQuery({ queryKey: queryKeys.runtimeConfiguration, queryFn: api.runtimeConfiguration });
  const globalOnly = assignment.data?.modelAssignmentMode === "global";
  const runtime = runtimes.data?.runtimes[0] ?? null;
  const catalog = useQuery({
    queryKey: queryKeys.runtimeModels(runtime?.id ?? "none"),
    queryFn: () => api.runtimeModels(runtime!.id!),
    enabled: Boolean(runtime?.id) && displayedRuntimeHealth(runtime) !== "disconnected",
    staleTime: 30_000,
  });
  const view = useMemo(() => catalogModelView(catalog.data?.providers ?? []), [catalog.data?.providers]);
  const globalModel = runtimeGlobalModel(runtime, catalog.data);
  const resolved = resolveThreadModel({
    botModel: value.model,
    botEffort: value.effort,
    globalModel,
    globalEffort: runtime?.reasoningEffort ?? null,
    catalog: view,
  });

  const selectModel = (model: string | null) => {
    const effectiveId = model ?? globalModel;
    onChange({
      model,
      provider: model ? view.groups.find((group) => group.models.some((entry) => entry.id === model))?.slug ?? null : null,
      effort: effectiveId && view.reasoningIds.has(effectiveId) && isHermesReasoningEffort(value.effort) ? value.effort : null,
    });
  };

  return (
    <ComposerModelPicker
      providers={catalog.data?.providers ?? []}
      selectedModel={value.model}
      effectiveModel={resolved?.model ?? null}
      effectiveEffort={resolved?.effort ?? null}
      globalModel={globalModel}
      supportsEffort={resolved ? view.reasoningIds.has(resolved.model) : false}
      disabled={false}
      variant="header"
      globalOnly={globalOnly && value.model === null}
      loading={runtimes.isPending || catalog.isLoading || assignment.isPending}
      saving={false}
      error={runtimes.isError || catalog.isError || (!runtimes.isPending && runtime === null)}
      onModelChange={selectModel}
      onEffortChange={(effort) => onChange({ ...value, effort })}
      onEffortCommit={(effort) => onChange({ ...value, effort })}
    />
  );
}
