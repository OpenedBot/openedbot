import { cn, Skeleton, useIsMobile } from "@openedbot/browser-ui-kit";
import type { RuntimeModelDto } from "@openedbot/contracts-api";
import { useT } from "../../../../lib/i18n";
import { CardHeading, SETTINGS_SHELL, SETTINGS_SHELL_HEADER, SettingsCard, ToneBadge } from "../../../../components/settings/primitives";

// Les colonnes du tableau des bots (`PerBotModelsTable`) : la silhouette les
// reprend pour que les sélecteurs ne glissent pas à l'arrivée des données.
const BOT_TABLE_COLUMNS = "sm:grid-cols-[minmax(10rem,24rem)_18rem_11rem]";

/**
 * La silhouette de l'écran Modèles pendant sa lecture, à la géométrie de la
 * page sur bureau : l'en-tête (runtime, pastilles, relecture), puis
 * `DefaultModelCard`, `BotModelsCard` et `ConnectedProviders`. Les titres fixes
 * sont écrits tels quels ; seul ce qui dépend des données pulse. Sur mobile,
 * la carte de préférence + l’annuaire en rangées.
 */
export function CatalogSkeleton({ label }: { label: string }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  if (!isMobile) {
    return (
      <div role="status" aria-label={label} className="flex flex-col gap-8" data-models-skeleton="">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-base font-semibold tracking-tight">{t("modelsSettings.title")}</p>
            <div className="mt-0.5 flex h-5 items-center gap-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          </div>
          <Skeleton className="size-8 shrink-0 rounded-lg" />
        </div>

        <div className="flex flex-col gap-4">
          <SettingsCard className="space-y-4">
            <CardHeading title={t("modelsSettings.defaultModelTitle")} description={t("modelsSettings.defaultModelDescription")} />
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(8rem,11rem)]">
              {[t("modelsSettings.mobileProviderLabel"), t("modelsSettings.mobileModelLabel"), t("modelsSettings.mobileEffortLabel")].map((field) => (
                <div key={field} className="min-w-0 space-y-1.5">
                  <p className="text-sm font-medium leading-none">{field}</p>
                  <Skeleton className="h-11 w-full rounded-[10px]" />
                </div>
              ))}
            </div>
            {/* La ligne « Choisi ici » porte des pastilles : sa hauteur est la leur. */}
            <div className="flex h-[22px] items-center">
              <Skeleton className="h-3 w-24" />
            </div>
          </SettingsCard>

          <SettingsCard className="space-y-4">
            <CardHeading title={t("modelsSettings.botModelsTitle")} />
            <div className="grid gap-2 sm:grid-cols-2">
              {[0, 1].map((index) => (
                <div key={index} className="flex items-start gap-3 rounded-xl border border-border px-3 py-2.5">
                  <Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
                  <div className="flex h-10 min-w-0 flex-1 flex-col justify-center gap-2">
                    <Skeleton className="h-4 w-56" />
                    <Skeleton className="h-3 w-72 max-w-full" />
                  </div>
                </div>
              ))}
            </div>
            <div className="overflow-hidden rounded-xl border border-border">
              <div className={cn("hidden gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground sm:grid", BOT_TABLE_COLUMNS)}>
                <span>{t("modelsSettings.perBotColumnBot")}</span>
                <span>{t("modelsSettings.perBotColumnModel")}</span>
                <span>{t("modelsSettings.perBotColumnEffort")}</span>
              </div>
              <div className="divide-y divide-border">
                {[0, 1, 2].map((index) => (
                  <div key={index} className={cn("grid items-center gap-3 px-4 py-3", BOT_TABLE_COLUMNS)}>
                    <div className="flex min-w-0 items-center gap-3">
                      <Skeleton className="size-8 shrink-0 rounded-lg" />
                      <div className="min-w-0 space-y-1.5">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                    </div>
                    <Skeleton className="h-11 w-full rounded-[10px]" />
                    <Skeleton className="h-11 w-full rounded-[10px]" />
                  </div>
                ))}
              </div>
            </div>
          </SettingsCard>

          {/* Le titre porte le nombre de fournisseurs connectés : il pulse, donc
              pas de `CardHeading` (qui veut un texte), mais la même coque. */}
          <section data-settings-card="" className={SETTINGS_SHELL}>
            <div className={cn("flex items-center justify-between gap-3", SETTINGS_SHELL_HEADER)}>
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-8 w-48 rounded-lg" />
            </div>
            <div className="border-t border-border/60 p-4">
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {[0, 1, 2].map((index) => (
                  <div key={index} className="flex items-center gap-3 px-4 py-2.5">
                    <Skeleton className="size-1.5 shrink-0 rounded-full" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-28" />
                    </div>
                    <Skeleton className="h-8 w-16 shrink-0 rounded-lg" />
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-4">
      <SettingsCard className="space-y-5">
        <Skeleton className="h-24 w-full rounded-xl motion-reduce:animate-none" />
        <div className="grid gap-4">
          {[0, 1, 2].map((index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-4 w-24 motion-reduce:animate-none" />
              <Skeleton className="h-9 w-full motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      </SettingsCard>
      <SettingsCard className="space-y-2">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex min-h-12 items-center gap-2 px-2">
            <Skeleton className="size-1.5 shrink-0 rounded-full motion-reduce:animate-none" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-32 motion-reduce:animate-none" />
              <Skeleton className="h-3 w-48 motion-reduce:animate-none" />
            </div>
            <Skeleton className="h-5 w-24 shrink-0 rounded-full motion-reduce:animate-none" />
          </div>
        ))}
      </SettingsCard>
    </div>
  );
}

export function ModelBadges({ model }: { model: RuntimeModelDto }) {
  const { t, formatNumber } = useT();
  return (
    <div className="flex flex-wrap gap-2">
      {model.isRuntimeDefault ? <ToneBadge tone="info">{t("modelsSettings.defaultBadge")}</ToneBadge> : null}
      {model.fast ? <ToneBadge tone="neutral">{t("modelsSettings.fast")}</ToneBadge> : null}
      {model.reasoning ? <ToneBadge tone="neutral">{t("modelsSettings.reasoning")}</ToneBadge> : null}
      {model.freeTier?.tokensPerDay ? <ToneBadge tone="success">{t("modelsSettings.freeTier", { count: formatNumber(model.freeTier.tokensPerDay) })}</ToneBadge> : null}
    </div>
  );
}
