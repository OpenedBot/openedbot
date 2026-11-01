import { Skeleton, useIsMobile } from "@openedbot/browser-ui-kit";
import type { RuntimeModelDto } from "@openedbot/contracts-api";
import { useT } from "../../../../lib/i18n";
import { SettingsCard, ToneBadge } from "../../../../components/settings/primitives";

/**
 * La silhouette du catalogue pendant sa lecture : les trois blocs de la page
 * sur bureau (modèle par défaut, modèle des bots, fournisseurs), ou la carte
 * de préférence + l’annuaire en rangées sur mobile.
 */
export function CatalogSkeleton({ label }: { label: string }) {
  const isMobile = useIsMobile();
  if (!isMobile) {
    return (
      <div role="status" aria-label={label} className="flex flex-col gap-4">
        <Skeleton className="h-5 w-72 motion-reduce:animate-none" />
        <SettingsCard className="space-y-3">
          <Skeleton className="h-4 w-40 motion-reduce:animate-none" />
          <Skeleton className="h-11 w-full rounded-[10px] motion-reduce:animate-none" />
        </SettingsCard>
        <SettingsCard className="space-y-3">
          <Skeleton className="h-4 w-32 motion-reduce:animate-none" />
          <Skeleton className="h-14 w-full rounded-xl motion-reduce:animate-none" />
        </SettingsCard>
        <SettingsCard className="space-y-3">
          <Skeleton className="h-4 w-48 motion-reduce:animate-none" />
          <Skeleton className="h-12 w-full rounded-xl motion-reduce:animate-none" />
        </SettingsCard>
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
