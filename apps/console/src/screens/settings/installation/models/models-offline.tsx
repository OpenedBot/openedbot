import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { IconPlugConnectedX, IconServerBolt } from "@tabler/icons-react";
import { cn, DotMatrix, useIsMobile } from "@openedbot/browser-ui-kit";
import type { RuntimePublicDto } from "@openedbot/contracts-api";
import type { RuntimeHealthStatus } from "@openedbot/contracts-api";
import { ageSince } from "@openedbot/browser-i18n";
import { useT } from "../../../../lib/i18n";
import { BUTTON, EmptyState } from "../../../../components/settings/primitives";
import { SettingsPane } from "../../pane";
import { type RuntimeReadiness } from "./models-readiness";
import { FailureState, FailureSurface } from "../../../../components/failure-state";
import { runtimeHealthStatusLabel } from "../../../../lib/runtime/runtime-health";
import { RUNTIME_POLL_MS, type RuntimeOffline } from "./models-shared";

/**
 * The runtime no longer answers: what is underneath dates from its last answer.
 *
 * The content stays in place, blurred, so the screen keeps its shape, but
 * no gesture gets through (`inert`), like `ConversationAvailability`. The card
 * is `sticky`: on a catalog taller than the window, it stays in view
 * during the scroll. Configuration (link) or catalog (unreachable
 * runtime) are reread every 3 s; the veil lifts at the first
 * reread that proves the return, and its timer is unmounted with it.
 */
export function RuntimeOfflineVeil({
  offline,
  runtime,
  onRetry,
  className,
  children,
}: {
  offline: RuntimeOffline | null;
  runtime: RuntimePublicDto | null;
  onRetry: () => void;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useT();
  const blocked = offline !== null;
  const name = runtime?.name ?? "Hermes";
  return (
    // `flex-1`: the veil goes down to the bottom of the panel, even on short content.
    <div className="relative flex-1" data-runtime-offline={offline?.status}>
      <div
        inert={blocked}
        aria-hidden={blocked || undefined}
        className={cn(
          "transition-[filter,opacity] duration-300 motion-reduce:transition-none",
          className,
          blocked && "pointer-events-none select-none opacity-60 blur-sm",
        )}
      >
        {children}
      </div>
      {offline ? (
        <div className="absolute inset-0 z-20 bg-background/40 px-4 pt-6">
          {/* Centered in the visible part of the panel: a sticky's `top` is
              measured on the scroller, minus half the card (~18rem).
              Without a transform, the card never climbs onto the header. */}
          <div className="sticky top-[calc(50%-9rem)] mx-auto w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-[var(--shadow-elevated)]">
            <div role="alert" className="flex items-start gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warn-soft text-warn-700">
                <IconPlugConnectedX aria-hidden className="size-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-semibold">{t("modelsSettings.offlineTitle")}</h2>
                <p className="mt-1 break-words text-sm text-muted-foreground">
                  {t(offline.status === "disconnected" ? "modelsSettings.offlineDisconnected" : "modelsSettings.offlineUnreachable", { runtime: name })}
                </p>
              </div>
            </div>
            <RuntimeOfflineClock offline={offline} />
            <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
              {offline.status === "unreachable" ? (
                <button type="button" className={BUTTON.secondary} disabled={offline.checking} onClick={onRetry}>
                  {offline.checking ? t("modelsSettings.refreshing") : t("errorState.retry")}
                </button>
              ) : null}
              <Link to="/settings/runtime" className={BUTTON.primary}>
                {t("modelsSettings.openRuntimeSettings")}
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where the request stops, from the runtime's last check.
 *
 * A runtime that has REFUSED (token, capacity, provider) was reached: the
 * link to it is crossed and it is the one that answers no. An unreachable runtime
 * or one with a closed link saw nothing go through. A runtime never tested neither, as far as
 * one knows: a link one has not seen crossed is never drawn.
 */
const RUNTIME_ANSWERED: Readonly<Record<RuntimeHealthStatus, boolean>> = {
  healthy: true,
  unauthorized: true,
  missing_feature: true,
  no_provider: true,
  unreachable: false,
  disconnected: false,
  unknown: false,
};

/**
 * The screen closed over what is missing, and over where it is repaired.
 *
 * A Models screen opened on an unproved runtime lets one choose a model
 * in a catalog that, at best, dates from the last time Hermes
 * answered. Each state therefore names its cause and sends back to Edge, the
 * only place where the URL, the token and the connection are corrected. The text
 * sends back to the runtime's declaration or diagnosis.
 *
 * With no runtime, it is an empty screen: a prompt, in grey. As soon as there is
 * a runtime, there is a cause, and the screen speaks like `FailureState`: the
 * path stops at the runtime, and the card's foot names which one and in which
 * state. Unproved runtime: the cause is the last known check,
 * and it is what decides the path. Unreadable catalog even though the last
 * check had succeeded: the cause is the catalog's living error,
 * with its HTTP status and its reference.
 *
 * In both cases, the card's foot dates the last check
 * (`lastCheckedAt`): « il y a 3 j » alone says whether the displayed state is
 * still information or already a memory.
 */
export function RuntimeNotReady({
  readiness,
  runtime,
  catalogError,
}: {
  readiness: RuntimeReadiness;
  runtime: RuntimePublicDto | null;
  catalogError: unknown;
}) {
  const { t, locale } = useT();
  const isMobile = useIsMobile();
  const cta = readiness.state === "missing"
    ? t("modelsSettings.addRuntime")
    : t("modelsSettings.openRuntimeSettings");
  const action = <Link to="/settings/runtime" className={BUTTON.primary}>{cta}</Link>;
  const runtimeFact = { label: t("errorState.factRuntime"), value: runtime?.name ?? "-" };
  // With no date, no fact: a « vérifié : » would point at a check
  // that never took place.
  const checkedFact = runtime?.lastCheckedAt
    ? [{ label: t("errorState.factChecked"), value: ageSince(locale, runtime.lastCheckedAt) }]
    : [];
  // The last check's sentence, as the system wrote it,
  // never rewritten (`FailureState`'s rule); the generic one only as a fallback.
  const lastHealthError = runtime?.lastHealthError?.trim() || null;
  const body = (() => {
    switch (readiness.state) {
      case "missing":
        return (
          <EmptyState
            icon={<IconServerBolt />}
            title={t("modelsSettings.emptyTitle")}
            description={t("modelsSettings.emptyDescription")}
            actions={isMobile ? undefined : action}
          />
        );
      case "unproven": {
        const answered = RUNTIME_ANSWERED[readiness.status];
        return (
          <FailureSurface
            icon={IconServerBolt}
            title={t("modelsSettings.unprovenTitle")}
            description={lastHealthError ?? t("modelsSettings.unprovenDescription")}
            tone="info"
            path={{
              shape: { hops: ["browser", "api", "runtime"], crossedIntoStop: answered },
              label: t(answered ? "errorState.runtimeAnsweredPath" : "errorState.upstreamPath"),
            }}
            facts={[
              runtimeFact,
              { label: t("errorState.factState"), value: runtimeHealthStatusLabel(readiness.status, locale), status: true },
              ...checkedFact,
            ]}
            action={isMobile ? undefined : action}
          />
        );
      }
      default:
        return (
          <FailureState
            error={catalogError}
            icon={IconServerBolt}
            title={t("modelsSettings.catalogUnreachableTitle")}
            fallback={t("modelsSettings.catalogUnreachableDescription")}
            facts={[runtimeFact, ...checkedFact]}
            action={isMobile ? undefined : action}
          />
        );
    }
  })();
  return <SettingsPane footer={isMobile ? action : undefined}>{body}</SettingsPane>;
}

/**
 * The outage's timer, and the reread's countdown.
 *
 * Mounted with the veil, unmounted with it: the interval is cleared as soon as the
 * runtime comes back, nothing keeps running behind. The duration starts from the
 * server's last known sign of life, otherwise from the veil's opening.
 * `role="timer"` is not a live region: the screen reader does not announce
 * every second.
 */
function RuntimeOfflineClock({ offline }: { offline: RuntimeOffline }) {
  const { t } = useT();
  const [openedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const serverSince = offline.since ? Date.parse(offline.since) : Number.NaN;
  // `min`: a server clock running ahead must not start the duration from the future.
  const since = Number.isFinite(serverSince) ? Math.min(serverSince, openedAt) : openedAt;
  const remaining = Math.ceil((offline.lastAttemptAt + RUNTIME_POLL_MS - now) / 1000);
  // Deadline passed with no request in flight (background tab): one waits for the reread.
  const checking = offline.checking || remaining <= 0;
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${days > 0 || hours > 0 ? `${pad(hours)}:` : ""}${pad(Math.floor((total % 3_600) / 60))}:${pad(total % 60)}`;
  return (
    <div role="timer" className="mt-5 rounded-xl border border-border bg-surface-sunken px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-muted-foreground">{t("modelsSettings.offlineSince")}</span>
        <span className="text-2xl font-semibold tabular-nums tracking-tight">
          {days > 0 ? `${t("modelsSettings.offlineDays", { days })} ` : ""}{clock}
        </span>
      </div>
      <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
        <DotMatrix
          state={checking ? "syncing" : "waiting"}
          label={t(checking ? "modelsSettings.offlineChecking" : "modelsSettings.offlineWaiting")}
          className="size-4"
        />
        {checking ? t("modelsSettings.offlineChecking") : t("modelsSettings.offlineNextCheck", { seconds: remaining })}
      </p>
    </div>
  );
}
