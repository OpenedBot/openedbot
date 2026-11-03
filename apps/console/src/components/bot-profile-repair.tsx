import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BotProfileStatusDto } from "@openedbot/contracts-api";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  toast,
} from "@openedbot/browser-ui-kit";
import { ApiError, api, queryKeys, runtimesQueryOptions } from "../lib/api";
import { useT } from "../lib/i18n";
import { catalogModelView } from "../lib/bots/model-catalog";
import { BUTTON } from "./settings/primitives";

type RepairMode = "transfer" | "reset";
type ModelPick = { provider: string; model: string };

/**
 * Le profil Hermes d'un bot, prouvé sur le runtime ACTUEL. Seul un bot qui
 * nomme un profil est sondé ; l'état ne se relit qu'au focus, pas en boucle.
 */
export function useBotProfileStatus(
  bot: { id: string; hermesProfile: string | null; profileProvisionStatus?: "preparing" | "failed" | null } | null | undefined,
  enabled = true,
) {
  // Un profil encore en création (ou dont la création a échoué) n'existe pas
  // sur l'hôte : ce n'est pas un runtime remplacé à réparer. La lecture part
  // dès que la création est prouvée.
  const provisioning = Boolean(bot?.profileProvisionStatus);
  return useQuery({
    queryKey: queryKeys.botProfileStatus(bot?.id ?? "none"),
    queryFn: () => api.botProfileStatus(bot!.id),
    enabled: enabled && !provisioning && Boolean(bot?.id && bot.hermesProfile),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/**
 * Bot dont le profil n'existe pas sur le runtime (runtime remplacé) : dit ce
 * qu'openedbot reprend seul et ce qui est resté sur l'ancien hôte, puis propose le
 * transfert ou, si le modèle du bot n'est pas servi ici, la réinitialisation.
 */
export function BotProfileRepair({ bot, status, variant = "overlay", onClose }: {
  bot: { id: string; name: string };
  status: BotProfileStatusDto;
  /**
   * `overlay` : alerte sur le panneau de conversation, tant
   * que l'opérateur n'a ni transféré ni réinitialisé (fil et composer inertes).
   * `inline` : encart dans les réglages du bot, déjà eux-mêmes une boîte.
   */
  variant?: "overlay" | "inline";
  onClose?: () => void;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [pick, setPick] = useState<ModelPick | null>(null);
  const runtimes = useQuery({ ...runtimesQueryOptions(), enabled: status.canRepair });
  const runtimeId = runtimes.data?.runtimes[0]?.id ?? null;
  const repair = useMutation({
    mutationFn: ({ mode, model }: { mode: RepairMode; model: ModelPick | null }) =>
      api.repairBotProfile(bot.id, mode, model ?? {}),
    onSuccess: async (result) => {
      // The recreated profile changes what the composer reads: the bot's model
      // (roster), the runtime's catalog for this profile and its context window.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.roster }),
        queryClient.invalidateQueries({ queryKey: queryKeys.botProfileStatus(bot.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.botCapabilities(bot.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration }),
        ...(runtimeId
          ? [
            queryClient.invalidateQueries({ queryKey: queryKeys.runtimeModels(runtimeId) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.runtimeModelContext(runtimeId, result.profile) }),
          ]
          : []),
      ]);
      toast.success(t(result.mode === "transfer" ? "botProfileRepair.transferred" : "botProfileRepair.resetDone", { name: bot.name }));
    },
  });
  const errorCode = repair.error instanceof ApiError ? repair.error.code : null;
  const modelUnavailable = errorCode === "BOT_MODEL_UNAVAILABLE";
  // Neither the bot nor the runtime names a model: the repair needs the
  // operator's pick, said up front by the status or, from an older status, by
  // the refusal itself.
  const modelRequired = errorCode === "RUNTIME_MODEL_REQUIRED";
  const needsPick = (mode: RepairMode) => Boolean(status.needsModel?.[mode]) || modelRequired;
  const picking = status.canRepair && (needsPick("reset") || needsPick("transfer"));
  const catalog = useQuery({
    queryKey: queryKeys.runtimeModels(runtimeId ?? "none"),
    queryFn: () => api.runtimeModels(runtimeId!),
    enabled: picking && Boolean(runtimeId),
    staleTime: 30_000,
  });
  const groups = useMemo(() => catalogModelView(catalog.data?.providers ?? []).groups, [catalog.data?.providers]);
  const catalogLoading = picking && (runtimes.isLoading || catalog.isLoading);
  const failure = modelUnavailable
    ? t("botProfileRepair.modelUnavailable")
    : modelRequired
      ? null
      : repair.error instanceof ApiError
        ? repair.error.message
        : repair.isError ? t("botProfileRepair.failed") : null;
  const pending = repair.isPending ? repair.variables.mode : null;
  const title = t("botProfileRepair.title", { name: bot.name });
  const description = t("botProfileRepair.body", { profile: status.profile ?? "" });
  const run = (mode: RepairMode) => repair.mutate({ mode, model: needsPick(mode) ? pick : null });
  const blocked = (mode: RepairMode) => repair.isPending || (needsPick(mode) && !pick);
  const pickId = `bot-profile-repair-model-${bot.id}`;

  const modelChoice = picking ? (
    <div className="mt-3 flex flex-col gap-1.5">
      <label htmlFor={pickId} className="text-sm font-medium">{t("botProfileRepair.modelPickLabel")}</label>
      {/* Same control as the per-bot choice in Settings > Models. The catalog
          view lists each model id once, so the id alone names the provider. */}
      <Select
        value={pick?.model ?? ""}
        disabled={repair.isPending || catalogLoading || groups.length === 0}
        onValueChange={(model) => {
          const provider = groups.find((group) => group.models.some((entry) => entry.id === model))?.slug;
          setPick(provider ? { provider, model } : null);
        }}
      >
        <SelectTrigger id={pickId} className="w-full">
          <SelectValue
            placeholder={catalogLoading
              ? t("botProfileRepair.modelPickLoading")
              : groups.length === 0 ? t("botProfileRepair.modelPickEmpty") : t("botProfileRepair.modelPickPlaceholder")}
          />
        </SelectTrigger>
        {/* No `rows` cap: the list takes the height the screen leaves it
            (Radix's available height), flipping above the field when there is
            more room there. */}
        <SelectContent collisionPadding={16}>
          {groups.map((group) => (
            <SelectGroup key={group.slug}>
              <SelectLabel>{group.name}</SelectLabel>
              {group.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>{model.id}</SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t("botProfileRepair.modelPickHint", { name: bot.name })}</p>
    </div>
  ) : null;

  const details = (
    <>
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{t("botProfileRepair.carriedTitle")}</p>
          <ul className="mt-1 list-disc pl-5">
            {status.carried.map((item) => <li key={item}>{t(`botProfileRepair.carried.${item}`)}</li>)}
          </ul>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{t("botProfileRepair.lostTitle")}</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {status.lost.map((item) => <li key={item}>{t(`botProfileRepair.lost.${item}`)}</li>)}
          </ul>
        </div>
      </div>
      {status.canRepair ? (
        <>
          {modelChoice}
          {failure ? <p role="status" className="mt-3 text-sm text-destructive">{failure}</p> : null}
          {/* "On the runtime's model" would be false when the runtime has none. */}
          {needsPick("reset") ? null : <p className="mt-3 text-xs text-muted-foreground">{t("botProfileRepair.resetHint")}</p>}
        </>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">{t("botProfileRepair.unsupported")}</p>
      )}
    </>
  );
  const actions = status.canRepair ? (
    <>
      <button
        type="button"
        className={modelUnavailable ? BUTTON.primary : BUTTON.secondary}
        disabled={blocked("reset")}
        onClick={() => run("reset")}
      >
        {pending === "reset" ? t("botProfileRepair.resetting") : t("botProfileRepair.reset")}
      </button>
      {modelUnavailable ? null : (
        <button type="button" className={BUTTON.primary} disabled={blocked("transfer")} onClick={() => run("transfer")}>
          {pending === "transfer" ? t("botProfileRepair.transferring") : t("botProfileRepair.transfer")}
        </button>
      )}
    </>
  ) : null;

  if (variant === "overlay") {
    return (
      // Cover only the conversation so the sidebar stays available. Returning
      // home leaves the missing profile unchanged and sending locked.
      <div className="absolute inset-0 z-40 flex items-center justify-center overflow-y-auto bg-background/40 p-4 backdrop-blur-sm">
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`bot-profile-repair-${bot.id}`}
          className="my-auto flex w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-[var(--shadow-elevated)]"
        >
          <div className="relative border-b border-border px-5 py-4 pe-12">
            {onClose ? (
              <button
                type="button"
                aria-label={t("notFound.home")}
                title={t("notFound.home")}
                onClick={onClose}
                className="absolute end-3 top-3 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" aria-hidden />
              </button>
            ) : null}
            <h2 id={`bot-profile-repair-${bot.id}`} className="text-base font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
          <div className="px-5 py-4 text-sm text-foreground/80">{details}</div>
          {actions ? <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{actions}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div role="alert" className="w-full rounded-3xl border border-amber-500/40 bg-popover px-5 py-4 shadow-sm">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 mb-3 text-sm text-muted-foreground">{description}</p>
      {details}
      {actions ? <div className="mt-3 flex flex-wrap justify-end gap-2">{actions}</div> : null}
    </div>
  );
}
