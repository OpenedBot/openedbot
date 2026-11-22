import type { AgentPlanLimit } from "@openedbot/browser-ui-kit";
import type { useT } from "../lib/i18n";
import { remainingPercent, resetLabel, type ProviderLimits } from "./dashboard/provider-limits-panel";

type Translate = ReturnType<typeof useT>["t"];

/**
 * The plan limits of the providers IN SERVICE, one line per window
 * (5 h, week, ...), like the bottom of the BoardUI card. A connected account
 * that nothing uses stays in the Quotas tab: it is not this thread's wall.
 */
export function planLimits(limits: ProviderLimits, t: Translate): { label: string; rows: AgentPlanLimit[] } | null {
  const serviced = limits.providers
    .filter((provider) => limits.inService.has(provider.slug))
    .map((provider) => {
      const snapshot = limits.snapshots.get(provider.slug);
      const windows = (snapshot?.windows ?? []).filter((window) => window.usedPercent !== null);
      return { provider, plan: snapshot?.plan ?? null, windows };
    })
    .filter((entry) => entry.windows.length > 0);
  if (serviced.length === 0) return null;
  const single = serviced.length === 1 ? serviced[0]! : null;
  const rows = serviced.flatMap(({ provider, windows }) => windows.map((window, index): AgentPlanLimit => {
    const reset = resetLabel(window.resetAt, t);
    return {
      id: `${provider.slug}:${index}`,
      label: single ? window.label : `${provider.name} · ${window.label}`,
      // The gauge empties like the rail ring: full = everything remains.
      used: remainingPercent(window.usedPercent ?? 0) / 100,
      resets: reset ? t("providerLimits.resetIn", { reset }) : null,
    };
  }));
  return {
    label: single
      ? t("threadContext.planLimits", { plan: single.plan ?? single.provider.name })
      : t("threadContext.planLimitsAll"),
    rows,
  };
}
