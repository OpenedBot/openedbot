import { useState } from "react";
import { type QueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Dialog, cn } from "@openedbot/browser-ui-kit";
import { api, queryKeys } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { ProviderIcon } from "../provider-icon";
import { ProviderLimitsPanel, providerLimitsAlerting, useProviderLimits, type ProviderLimits } from "./provider-limits-panel";
import { BUTTON } from "../settings/primitives";

/**
 * Rereads the limits with a forced probe and puts them in the cache: to run
 * after a provider access is set or renewed, otherwise the card keeps the
 * previous reading for up to two minutes (measured on 05-09 on openai-codex).
 */
export async function refreshProviderLimits(queryClient: QueryClient, runtimeId: string): Promise<void> {
  try {
    const data = await api.runtimeProviderUsage(runtimeId, true);
    queryClient.setQueryData(queryKeys.runtimeProviderUsage(runtimeId), data);
  } catch {
    await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeProviderUsage(runtimeId) });
  }
}

/** The full reading in a modal: the foot-of-bar card and the rail open it. */
export function ProviderLimitsDialog({ open, onClose, limits }: { open: boolean; onClose: () => void; limits: ProviderLimits }) {
  const { t } = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("providerLimits.title")}
      description={t("providerLimits.subtitle")}
      closeLabel={t("providerLimits.close")}
      bodyClassName="px-5 pt-2 pb-5"
      footer={
        // Nothing to confirm here: the modal is for reading. Brand blue would go to
        // the least important action on the screen.
        <button
          type="button"
          onClick={onClose}
          className={`${BUTTON.secondary} w-full sm:w-auto`}
        >
          {t("providerLimits.close")}
        </button>
      }
    >
      <ProviderLimitsPanel limits={limits} onNavigate={onClose} />
    </Dialog>
  );
}

/**
 * The quota alert at the foot of the sidebar.
 *
 * It shows only when there is something to do: the wall is approaching,
 * or the reading can no longer be read (`providerLimitsAlerting`). The full reading
 * lives permanently in the composer's tab, above the field where one
 * decides to spend. A weekly quota moves slowly: giving it a
 * fixed slot mostly taught people to ignore the area, and the day the
 * number mattered it read like the six days it did not.
 */
export function ProviderLimitsCard({ compact = false }: { compact?: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const limits = useProviderLimits(open);

  if (!limits.canView || limits.runtimeId === null) return null;
  // Silent until the read has happened: a pill that appears then
  // fades is worse than silence for an alert.
  if (limits.pending || (limits.providers.length === 0 && !limits.readFailed)) return null;
  // `open` holds the card: a reread that drops back under the threshold would
  // otherwise dismiss the modal under the finger of whoever just opened it.
  if (!open && !providerLimitsAlerting(limits)) return null;

  // The pill's figure is the one that lit it: the peak of the
  // providers IN SERVICE. Showing the global peak would read « 100 % » because
  // of an account no bot uses any more.
  const peakLabel = limits.servicePeak === null
    ? t("providerLimits.unavailable")
    : t("providerLimits.peak", { percent: Math.round(limits.servicePeak) });
  // Only providers that carry a reading enter the pill:
  // a « non mesurable » icon adds nothing to an alert.
  const marks = limits.providers.filter((provider) => {
    const snapshot = limits.snapshots.get(provider.slug);
    return snapshot !== undefined && snapshot.windows.some((window) => window.usedPercent !== null);
  });
  const extraMarks = Math.max(0, marks.length - 3);

  return (
    <>
      {/* The peak is the card's only figure: it goes into the accessible
          name, otherwise a screen reader never hears it. */}
      <button
        type="button"
        data-provider-limits=""
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t("providerLimits.open")} · ${peakLabel}`}
        onClick={() => setOpen(true)}
        className={cn(
          "openedbot-press mb-2 flex min-h-11 w-full items-center gap-2 rounded-xl border border-warn-100 bg-warn-soft px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          compact && "mx-0",
        )}
      >
        <span className="shrink-0 text-xs font-semibold tracking-wide text-sidebar-foreground">{t("providerLimits.title")}</span>
        <span className="flex min-w-0 flex-1 items-center justify-center gap-1">
          {marks.slice(0, 3).map((provider) => (
            <ProviderIcon key={provider.slug} provider={provider.slug} name={provider.name} decorative className="size-5" />
          ))}
          {extraMarks > 0 ? <span className="text-[10px] text-sidebar-muted-foreground">+{extraMarks}</span> : null}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">{peakLabel}</span>
        <ChevronRight className="size-4 shrink-0 text-sidebar-muted-foreground" aria-hidden />
      </button>

      <ProviderLimitsDialog open={open} onClose={() => setOpen(false)} limits={limits} />
    </>
  );
}
