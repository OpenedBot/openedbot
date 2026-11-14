import type { ReactNode } from "react";
import { AlertTriangle, ChevronDown, Info, Unplug } from "lucide-react";
import type { ProviderUsageSnapshotDto, ProviderUsageWindowDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { isKeylessProvider } from "@openedbot/runtimes/domain/runtime/keyless-providers";
import { Skeleton, cn } from "@openedbot/browser-ui-kit";
import type { useT } from "../../lib/i18n";
import { BotFace } from "../bot-face";

/**
 * The display pieces of the limits panel (`provider-limits-panel.tsx`):
 * thresholds, banners, rows and lists. Taken out of the panel so it keeps
 * its size; the limits calculation stays there.
 */

/**
 * The sidebar's alert threshold: the same one that colours the
 * figure (`percentTone`). The pill therefore appears exactly when the
 * number would be written as a warning, never for a quota at rest.
 */
export const ALERT_PERCENT = 80;

export type ProviderBot = {
  id: string;
  name: string;
  face: Parameters<typeof BotFace>[0]["face"];
  provider: string | null;
};

export type ProviderRowKind = "measured" | "apiKey" | "unmeasured";

/** The shared grid of the rows: label, gauge, value, reset (the reference app `LimitWindows`). */
export const LIMIT_GRID = "mt-2 grid grid-cols-[minmax(0,6.5rem)_minmax(3rem,1fr)_auto_auto] items-center gap-x-3 gap-y-2";

/**
 * The sentence of a provider with no reading, like `limitsNotice` in the reference app:
 * a single row that says why, instead of an « n/d ». `null` when the
 * panel banner already explains it for everyone (link closed, silent runtime).
 */
export function unmeasuredNotice(snapshot: ProviderUsageSnapshotDto, name: string, t: ReturnType<typeof useT>["t"]): string | null {
  if (snapshot.source === "unsupported") {
    // An anonymous tier has its exact reason, named: it also explains
    // why no key is asked of it.
    return isKeylessProvider(snapshot.provider)
      ? t("providerLimits.providerKeyless", { provider: name })
      : t("providerLimits.providerUnsupported");
  }
  return snapshot.unavailableReason !== null ? t("providerLimits.providerUnavailable") : null;
}

/** Thresholds: the figure's colour and the gauge's say the same thing. */
export function percentTone(percent: number): string {
  if (percent > 95) return "text-destructive-text";
  if (percent > ALERT_PERCENT) return "text-warn-700";
  return "text-foreground";
}

/** Expand of the bot tokens: a label, not a lone chevron to guess at. */
export function BotsDisclosure({
  label,
  ariaLabel,
  open,
  onToggle,
}: {
  label: string;
  ariaLabel: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-expanded={open}
      onClick={onToggle}
      className="openedbot-press -ms-1.5 mt-1 inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-11"
    >
      <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} aria-hidden />
      {label}
    </button>
  );
}

/** The panel's status banner: an icon, the message, then the action if any. */
export function StatusBanner({ status, message, children }: { status: string; message: string; children?: ReactNode }) {
  const Icon = status === "disconnected" ? Unplug : status === "error" ? AlertTriangle : Info;
  const isError = status === "error";
  return (
    <div
      role="status"
      data-provider-limits-banner={status}
      className={cn(
        "mt-2 mb-1 space-y-2.5 rounded-xl border p-3",
        isError ? "border-neg-100 bg-neg-soft" : "border-border/70 bg-surface",
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-0.5 size-4 shrink-0", isError ? "text-destructive-text" : "text-muted-foreground")} aria-hidden />
        <p className="min-w-0 flex-1 text-sm leading-snug text-foreground">{message}</p>
      </div>
      {children}
    </div>
  );
}

export function PanelSkeleton({ label }: { label: string }) {
  return (
    <section aria-busy="true" aria-label={label}>
      <Skeleton className="mb-3 h-3 w-16" />
      <Skeleton className="h-8 w-full" />
    </section>
  );
}

export function peakUsedPercent(
  providers: RuntimeModelProviderDto[],
  snapshots: Map<string, ProviderUsageSnapshotDto>,
): number | null {
  let peak: number | null = null;
  for (const provider of providers) {
    const snapshot = snapshots.get(provider.slug);
    const used = snapshot ? primaryWindow(snapshot)?.usedPercent ?? null : null;
    if (typeof used !== "number") continue;
    peak = peak === null ? used : Math.max(peak, used);
  }
  return peak;
}

/**
 * The « n/d » row of a provider with no probe. The reason is set only when
 * the limits can be read otherwise: link closed or silent runtime, the banner
 * already explains it for everyone.
 */
export function unavailableSnapshot(provider: string, unavailableReason: string | null): ProviderUsageSnapshotDto {
  return { provider, source: "unavailable", plan: null, windows: [], details: [], unavailableReason };
}

export function primaryWindow(snapshot: ProviderUsageSnapshotDto): ProviderUsageWindowDto | null {
  return snapshot.windows.find((window) => /week|hebdo|7[- ]?day/i.test(window.label)) ?? snapshot.windows[0] ?? null;
}

/** `null` = no readable reset date: the row shows nothing. */
export function resetLabel(value: string | null, t: ReturnType<typeof useT>["t"]): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const hours = Math.ceil(ms / 3_600_000);
  return hours >= 24 ? t("providerLimits.resetDays", { days: Math.ceil(hours / 24) }) : t("providerLimits.resetHours", { hours });
}

export function elapsedMinutes(value: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
}

export function statusMessage(
  status: string,
  reason: string | null,
  error: string | null,
  t: ReturnType<typeof useT>["t"],
): string | null {
  if (status === "unsupported") return t("providerLimits.featureAbsent");
  if (status === "disconnected") return t("providerLimits.linkClosed");
  if (status === "error") return error ?? t("providerLimits.error");
  return null;
}

export function BotUsageList({
  bots,
  loading,
  empty,
  loadingLabel,
  estimated,
  className,
}: {
  bots: ProviderBot[];
  loading: boolean;
  empty: string;
  loadingLabel: string;
  estimated: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <p className="pb-1 text-[11px] leading-snug text-muted-foreground">{estimated}</p>
      {loading ? <p className="text-xs text-muted-foreground" role="status">{loadingLabel}</p> : bots.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : bots.map((bot) => (
        <div key={bot.id} className="flex min-h-8 items-center gap-2.5 text-xs">
          <BotFace name={bot.name} seed={bot.id} face={bot.face} className="size-5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-foreground">{bot.name}</span>
        </div>
      ))}
    </div>
  );
}
