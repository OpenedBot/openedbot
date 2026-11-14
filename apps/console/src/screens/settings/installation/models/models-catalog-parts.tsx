import { cn, Skeleton, useIsMobile } from "@openedbot/browser-ui-kit";
import type { ReactNode } from "react";
import type { RuntimeModelDto } from "@openedbot/contracts-api";
import { useT } from "../../../../lib/i18n";
import { CARD_DESCRIPTION, CARD_TITLE, SETTINGS_INSET, SETTINGS_SHELL, SETTINGS_SHELL_HEADER, SettingsCard, ToneBadge } from "../../../../components/settings/primitives";
import { BOT_TABLE_BOT_CELL, BOT_TABLE_GRID, BOT_TABLE_HEAD, MODELS_COLUMN } from "./models-shared";

/** A settings card's header in the skeleton: the fixed title, its sentence, an optional slot on the right. */
function SkeletonCardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className={cn("flex items-start justify-between gap-3", SETTINGS_SHELL_HEADER)}>
      <div className="min-w-0">
        <p className={CARD_TITLE}>{title}</p>
        {description ? <p className={CARD_DESCRIPTION}>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** A `ListRow` in the skeleton: the fixed label, its control pulsing on the right. */
function SkeletonListRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-48 text-sm font-medium text-foreground">{label}</div>
      <div className="ml-auto flex max-w-full items-center justify-end">{children}</div>
    </div>
  );
}

/**
 * The Models screen skeleton during its read, at the desktop page's
 * geometry: the header (runtime, pills, reread), then
 * `DefaultModelCard`, `BotModelsCard` and `ConnectedProviders`. The fixed titles
 * are written as they are; only what depends on the data pulses. On mobile,
 * the preference card + the directory in rows.
 */
export function CatalogSkeleton({ label }: { label: string }) {
  const { t } = useT();
  const isMobile = useIsMobile();
  if (!isMobile) {
    return (
      <div role="status" aria-label={label} className={MODELS_COLUMN} data-models-skeleton="">
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

        <div className="flex flex-col gap-8">
          <section data-settings-card="" className={SETTINGS_SHELL}>
            <SkeletonCardHeader title={t("modelsSettings.defaultModelTitle")} description={t("modelsSettings.defaultModelDescription")} />
            <div className={cn(SETTINGS_INSET, "divide-y divide-border/60")}>
              <SkeletonListRow label={t("modelsSettings.inServiceLabel")}>
                <Skeleton className="h-4 w-44" />
              </SkeletonListRow>
              {[t("modelsSettings.mobileProviderLabel"), t("modelsSettings.mobileModelLabel"), t("modelsSettings.perBotColumnEffort")].map((field) => (
                <SkeletonListRow key={field} label={field}>
                  <Skeleton className="h-11 w-72 max-w-full rounded-[10px]" />
                </SkeletonListRow>
              ))}
            </div>
          </section>

          <section data-settings-card="" className={SETTINGS_SHELL}>
            <SkeletonCardHeader
              title={t("modelsSettings.botModelsTitle")}
              action={<Skeleton className="h-8 w-56 shrink-0 rounded-lg" />}
            />
            <div className={cn(SETTINGS_INSET, "@container")}>
              <div className={cn(BOT_TABLE_GRID, BOT_TABLE_HEAD)}>
                <span>{t("modelsSettings.perBotColumnBot")}</span>
                <span>{t("modelsSettings.perBotColumnModel")}</span>
                <span>{t("modelsSettings.perBotColumnEffort")}</span>
              </div>
              <div className="divide-y divide-border/60">
                {[0, 1, 2].map((index) => (
                  <div key={index} className={cn(BOT_TABLE_GRID, "px-4 py-3")}>
                    <div className={cn("flex min-w-0 items-center gap-3", BOT_TABLE_BOT_CELL)}>
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
          </section>

          {/* The title carries the connected-provider count: it pulses. */}
          <section data-settings-card="" className={SETTINGS_SHELL}>
            <div className={cn("flex items-center justify-between gap-3", SETTINGS_SHELL_HEADER)}>
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-8 w-48 rounded-lg" />
            </div>
            <div className={cn(SETTINGS_INSET, "divide-y divide-border/60")}>
              {[0, 1, 2].map((index) => (
                <div key={index} className="flex min-h-14 items-center gap-3 px-4 py-3">
                  <Skeleton className="size-1.5 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-28" />
                  </div>
                  <Skeleton className="h-8 w-16 shrink-0 rounded-lg" />
                </div>
              ))}
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
