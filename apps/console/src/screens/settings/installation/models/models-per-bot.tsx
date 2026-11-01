import { useContext, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cn,
  DotMatrix,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from "@openedbot/browser-ui-kit";
import {
  HERMES_REASONING_EFFORT_LABELS,
  HERMES_REASONING_EFFORTS,
  type HermesReasoningEffort,
} from "@openedbot/contracts-api";
import type { BotDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { catalogModelView } from "@/lib/bots/model-catalog";
import { BotFace } from "../../../../components/bot-face";
import { Note } from "../../../../components/settings/primitives";
import { activeProviderIncident, ProviderIncidentsContext } from "../../../../components/provider-incident-banner";
import { NONE } from "./models-shared";

/**
 * En mode global, des bots gardent leur propre modèle, ignoré par le worker :
 * le dire et offrir la sortie : tout remettre au modèle par défaut, d'un coup.
 * Une seule requête : la base est remise à zéro avant la réponse, puis les
 * profils hôte s'alignent en arrière-plan (`ProfileModelSyncProgress`). Le
 * PATCH bot par bot payait une écriture hôte d'environ 2 s par bot, en série.
 */
export function GlobalOverridesNote({ bots }: { bots: BotDto[] }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const clear = useMutation({
    mutationFn: api.resetBotModelOverrides,
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.botProfileModelSync, { sync: result.sync });
      toast.success(t("modelsSettings.clearOverridesDone"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
    onError: (error: Error) => toast.error(error.message || t("modelsSettings.clearOverridesFailed")),
  });
  return (
    // Paire BoardUI `status-yellow` (yellow-200 / yellow-800, `warn-100` /
    // `warn-700` dans app.css), sans bordure, à la largeur de son texte.
    <Note tone="warning" className="w-fit min-w-0 border-0 bg-warn-100 text-warn-700">
      <span>{t("modelsSettings.overridesIgnoredNote", { count: bots.length })} </span>
      <button
        type="button"
        className="cursor-pointer font-bold underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={clear.isPending}
        onClick={() => clear.mutate()}
      >
        {clear.isPending ? t("modelsSettings.clearingOverrides") : t("modelsSettings.clearOverridesToDefault")}
      </button>
    </Note>
  );
}

const SYNC_POLL_MS = 500;

/**
 * L'alignement des profils hôte qui suit « Repasser tous les bots au modèle
 * global » : une vraie barre, `done / total` lus sur le serveur tant qu'il
 * tourne. Relu au montage, il reprend après un rechargement de la page.
 */
export function ProfileModelSyncProgress() {
  const { t } = useT();
  const sync = useQuery({
    queryKey: queryKeys.botProfileModelSync,
    queryFn: api.botProfileModelSync,
    refetchInterval: (query) => (query.state.data?.sync?.status === "running" ? SYNC_POLL_MS : false),
  });
  const current = sync.data?.sync ?? null;
  // Seule une fin vue en cours de route s'annonce : pas l'alignement d'hier relu au montage.
  const seenRunning = useRef<string | null>(null);
  useEffect(() => {
    if (!current) return;
    if (current.status === "running") {
      seenRunning.current = current.id;
      return;
    }
    if (seenRunning.current !== current.id) return;
    seenRunning.current = null;
    if (current.failed > 0) toast.warning(t("modelsSettings.profileSyncFailed", { count: current.failed }));
    else toast.success(t("modelsSettings.profileSyncDone"));
  }, [current, t]);
  if (current?.status !== "running") return null;
  const percent = current.total === 0 ? 100 : Math.round((current.done / current.total) * 100);
  const label = t("modelsSettings.profileSyncProgress", { done: current.done, total: current.total });
  return (
    <div className="flex w-full min-w-0 max-w-sm flex-col gap-1.5" role="status">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={current.total}
        aria-valuenow={current.done}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Le modèle de chaque bot actif, avec son effort, sur bureau.
 * « Modèle par défaut » (valeur nulle) = suivre le choix du dessus ; tout
 * autre choix est envoyé par le worker avec CHAQUE run du bot, et prime, en
 * mode « Un modèle par bot » seulement. En mode global (`inactive`), le
 * tableau reste lisible mais grisé : le worker ignore ces choix
 * (`modules/roster/src/sql/bots.ts`), sans les effacer.
 *
 * Les options viennent du catalogue des fournisseurs AUTHENTIFIÉS : c'est la
 * condition pour que le worker honore le choix au lieu de retomber en silence
 * sur le défaut du runtime (`resolveRunnableSelection`). Un modèle hérité qui
 * n'y figure plus reste listé, marqué introuvable, pour être vu et corrigé.
 */
export function PerBotModelsTable({
  bots,
  rosterPending,
  rosterError,
  providers,
  globalModel,
  globalProvider,
  inactive,
}: {
  bots: BotDto[];
  rosterPending: boolean;
  rosterError: boolean;
  providers: RuntimeModelProviderDto[];
  globalModel: string | null;
  /** Le fournisseur du choix global : celui des bots qui le suivent. */
  globalProvider: string | null;
  /** Mode global : le worker ignore ces choix, le tableau est grisé et figé. */
  inactive: boolean;
}) {
  const { t } = useT();
  const incidents = useContext(ProviderIncidentsContext);
  const queryClient = useQueryClient();
  const { groups: modelGroups, knownIds: knownModelIds, reasoningIds: reasoningModelIds } = catalogModelView(
    providers,
    [globalModel, ...bots.map((bot) => bot.model)],
  );

  const save = useMutation({
    mutationFn: (input: { bot: BotDto; model: string | null; effort: HermesReasoningEffort | null }) =>
      api.updateBot(input.bot.id, { model: input.model, reasoningEffort: input.effort }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
    onSuccess: (_data, input) => toast.success(t("modelsSettings.perBotSaved", { name: input.bot.name })),
    onError: (error: Error) => toast.error(error.message || t("modelsSettings.saveFailed")),
  });

  if (rosterError) {
    return <Note tone="danger" role="alert">{t("modelsSettings.perBotRosterFailed")}</Note>;
  }

  return (
    <div className="space-y-3" data-bot-models-inactive={inactive ? "" : undefined}>
      {inactive && bots.length > 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">{t("modelsSettings.botTableInactiveHint")}</p>
      ) : null}
      {rosterPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => <Skeleton key={index} className="h-12 w-full motion-reduce:animate-none" />)}
        </div>
      ) : bots.length === 0 ? (
        <Note tone="neutral">{t("modelsSettings.perBotEmpty")}</Note>
      ) : (
        <div className={cn("overflow-hidden rounded-xl border border-border", inactive && "opacity-60")}>
          {/* Une table, pas une rangée élastique : sur un grand écran, les
              sélecteurs collés au bord droit flottaient à un demi-mètre du nom
              du bot. Des colonnes nommées et bornées gardent la ligne lisible
              à toutes les largeurs. */}
          <div className="hidden gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(10rem,24rem)_18rem_11rem]">
            <span>{t("modelsSettings.perBotColumnBot")}</span>
            <span>{t("modelsSettings.perBotColumnModel")}</span>
            <span>{t("modelsSettings.perBotColumnEffort")}</span>
          </div>
          <ul className="divide-y divide-border">
            {bots.map((bot) => {
              const pendingRow = save.isPending && save.variables?.bot.id === bot.id;
              const modelValue = bot.model ?? NONE;
              const unknownModel = bot.model !== null && !knownModelIds.has(bot.model);
              // L'effort ne se choisit que si le modèle EFFECTIF du bot raisonne :
              // le worker retire l'effort d'un modèle qui ne raisonne pas.
              const effectiveModelId = bot.model ?? globalModel;
              const effortPickable = effectiveModelId !== null && reasoningModelIds.has(effectiveModelId);
              // En « Par bot », plus d'encart « ce qu'un run utilisera » : la panne
              // d'un fournisseur se lit sur la ligne du bot qu'elle fera échouer,
              // via le fournisseur authentifié qui liste son modèle.
              const rowProvider = bot.model === null
                ? globalProvider
                : providers.find((provider) => provider.authenticated && provider.models.some((model) => model.id === bot.model))?.slug ?? null;
              const rowIncident = activeProviderIncident(incidents, rowProvider);
              return (
                <li
                  key={bot.id}
                  className="grid items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(10rem,24rem)_18rem_11rem]"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-8 shrink-0" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{bot.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">@{bot.slug}</span>
                    </span>
                    {pendingRow ? (
                      <DotMatrix state="syncing" label={t("modelsSettings.saving")} className="size-4 shrink-0 text-muted-foreground" />
                    ) : null}
                  </span>
                  <Select
                    value={modelValue}
                    disabled={inactive || save.isPending}
                    onValueChange={(value) => {
                      const model = value === NONE ? null : value;
                      const nextEffective = model ?? globalModel;
                      save.mutate({
                        bot,
                        model,
                        // Un modèle qui ne raisonne pas perd l'effort stocké, comme au run.
                        effort:
                          nextEffective !== null && reasoningModelIds.has(nextEffective)
                            ? (bot.reasoningEffort as HermesReasoningEffort | null)
                            : null,
                      });
                    }}
                  >
                    <SelectTrigger
                      aria-label={t("modelsSettings.perBotModelAria", { name: bot.name })}
                      // `line-clamp-1` du trigger ne tient pas sous `display: flex` :
                      // « Modèle par défaut · <id> » passait sur deux lignes.
                      className="w-full *:data-[slot=select-value]:block! *:data-[slot=select-value]:truncate"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent side="bottom" avoidCollisions={false} rows={6}>
                      <SelectGroup>
                        <SelectItem value={NONE}>
                          {globalModel === null
                            ? t("modelsSettings.perBotDefaultOption")
                            : t("modelsSettings.perBotDefaultOptionNamed", { model: globalModel })}
                        </SelectItem>
                      </SelectGroup>
                      {unknownModel ? (
                        <SelectGroup>
                          <SelectItem value={bot.model!}>
                            {t("modelsSettings.perBotUnknownModel", { model: bot.model! })}
                          </SelectItem>
                        </SelectGroup>
                      ) : null}
                      {modelGroups.map((group) => (
                        <SelectGroup key={group.slug}>
                          <SelectLabel>{group.name}</SelectLabel>
                          {group.models.map((model) => (
                            <SelectItem key={model.id} value={model.id}>{model.id}</SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={bot.reasoningEffort ?? NONE}
                    disabled={inactive || save.isPending || !effortPickable}
                    onValueChange={(value) =>
                      save.mutate({
                        bot,
                        model: bot.model,
                        effort: value === NONE ? null : (value as HermesReasoningEffort),
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label={t("modelsSettings.perBotEffortAria", { name: bot.name })}
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent side="bottom" avoidCollisions={false} rows={6}>
                      <SelectGroup>
                        <SelectItem value={NONE}>{t("modelsSettings.perBotEffortDefault")}</SelectItem>
                        {HERMES_REASONING_EFFORTS.map((effort) => (
                          <SelectItem key={effort} value={effort}>{HERMES_REASONING_EFFORT_LABELS[effort]}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {unknownModel ? (
                    <p className="text-xs leading-5 text-warn-700 sm:col-span-full">{t("modelsSettings.perBotUnknownHint")}</p>
                  ) : null}
                  {rowIncident ? (
                    <p className="text-xs leading-5 text-destructive-text sm:col-span-full" role="status">
                      {t("providerIncidents.runsWillFail", { provider: rowIncident.provider })}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {modelGroups.length === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">{t("modelsSettings.perBotNoProviders")}</p>
      ) : null}
    </div>
  );
}
