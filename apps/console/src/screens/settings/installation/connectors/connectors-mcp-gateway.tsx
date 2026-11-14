import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconRefresh } from "@tabler/icons-react";
import { cn, DotMatrix, useIsMobile } from "@openedbot/browser-ui-kit";
import type { RuntimeGatewayRestartDto, RuntimeGatewayStatusDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../../lib/api";
import { useT } from "../../../../lib/i18n";
import { BUTTON, Note, SettingsCard } from "../../../../components/settings/primitives";
import {
  InsetGroupedSection,
  InsetGroupedStatic,
  insetGroupedRowClassName,
} from "../../../../components/mobile/inset-grouped";
import { McpActionRow } from "./connectors-mcp-mobile";
import { useMcpLiveReload } from "../../../../lib/runtime/mcp-live-reload";
import { useGatewayGracefulRestart } from "../../../../lib/runtime/gateway-graceful-restart";

/**
 * The gateway card: « redémarrage en attente », the button, the progress.
 *
 * The fact comes from the host (a marker set by a real MCP write, and
 * never a guess from here). The restart is a JOB the host proves
 * on `/health`: the bar follows its steps, and « OK » is said only on that
 * proof. A failure at the `health` step stays a failure, even if `systemctl`
 * said yes.
 */
/**
 * The last restart the host reports, unless a change landed after it ended:
 * a green "restarted" next to "restart pending" told two opposite things.
 */
export function freshHostJob(status: RuntimeGatewayStatusDto | undefined): RuntimeGatewayRestartDto | null {
  const hostJob = status?.job ?? null;
  if (!hostJob || hostJob.status === "running" || !status?.restartPending) return hostJob;
  if (!hostJob.finishedAt || !status.pendingSince) return hostJob;
  return Date.parse(hostJob.finishedAt) < Date.parse(status.pendingSince) ? null : hostJob;
}

export function GatewayRestartCard({
  onRestarted,
  onlyWhenPending = false,
}: {
  onRestarted: () => void;
  /**
   * After an MCP gesture on a host that reloads MCP on its own: the card
   * shows only if the host really says a restart is waiting (another
   * cause), or that a restart is in progress.
   */
  onlyWhenPending?: boolean;
}) {
  const { t, formatDate } = useT();
  const liveReload = useMcpLiveReload();
  // An up-to-date host lets the runs in progress finish: the confirmation does not
  // promise a cut that will not happen, and the bar says what one is waiting for.
  const graceful = useGatewayGracefulRestart();
  const description = liveReload ? t("connectorsSettings.gatewayDescriptionLive") : t("connectorsSettings.gatewayDescription");
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.runtimeGateway,
    queryFn: api.runtimeGateway,
    refetchInterval: (query) => (query.state.data?.job?.status === "running" ? 2_000 : false),
  });
  const [jobId, setJobId] = useState<string | null>(null);
  const restart = useMutation({
    mutationFn: api.restartRuntimeGateway,
    onSuccess: (job) => setJobId(job.jobId),
  });
  const job = useQuery({
    queryKey: queryKeys.runtimeGatewayRestart(jobId ?? "none"),
    queryFn: () => api.runtimeGatewayRestart(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      if (query.state.status === "error") return false;
      return query.state.data?.status === "running" ? 1_000 : false;
    },
  });
  // The job one follows: the one just started, otherwise the one the host
  // reports (a restart started from another tab, or just finished).
  const current: RuntimeGatewayRestartDto | undefined = job.data ?? restart.data ?? freshHostJob(status.data) ?? undefined;
  const notifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (current?.status !== "ok" || notifiedRef.current === current.jobId) return;
    notifiedRef.current = current.jobId;
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeGateway });
    onRestarted();
  }, [current, onRestarted, queryClient]);

  const running = current?.status === "running";
  const pending = status.data?.restartPending === true;
  const progress = current === undefined
    ? 0
    : current.status === "ok"
      ? 100
      : current.step === "health" || current.step === "done"
        ? 75
        : 35;
  const stepLabel = current === undefined
    ? null
    : current.status === "ok"
      ? t("connectorsSettings.gatewayStepDone")
      : current.status === "failed"
        ? (current.error ?? t("connectorsSettings.gatewayRestartFailed"))
        : current.step === "health"
          ? t("connectorsSettings.gatewayStepHealth")
          : graceful
            ? t("connectorsSettings.gatewayStepDrain")
            : t("connectorsSettings.gatewayStepRestart");

  const restarting = running || restart.isPending;
  // A restart started from here stays displayed until its proof; an up-to-date
  // host (or the mere memory of an old restart) shows none.
  if (onlyWhenPending && !pending && !restarting && !job.data && !restart.data) return null;
  const startRestart = () => {
    const question = graceful ? t("connectorsSettings.gatewayRestartConfirmGraceful") : t("connectorsSettings.gatewayRestartConfirm");
    if (globalThis.confirm?.(question) === false) return;
    restart.mutate();
  };
  const progressBar = current ? (
    <div
      role="progressbar"
      aria-label={t("connectorsSettings.gatewayProgressLabel")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
    >
      <div
        className={
          current.status === "failed"
            ? "h-full rounded-full bg-destructive transition-[width] duration-500"
            : current.status === "ok"
              ? "h-full rounded-full bg-pos-700 transition-[width] duration-500"
              : "h-full rounded-full bg-primary transition-[width] duration-500"
        }
        style={{ width: `${progress}%` }}
      />
    </div>
  ) : null;

  /*
    Phone: an iOS group, not a card. The card stacked a title, two
    sentences, a large blue button and a green inset to say « rien à faire »:
    a quarter of the screen for a fact that fits on one line. Here the state IS a
    line, and the restart appears only as the last of the group.
  */
  if (isMobile) {
    // The right column of a grouped row carries a short FACT, not a
    // sentence: « Le gateway porte la configuration actuelle. » was
    // truncated there to « Le gateway port… ». The sentence moves down to the group's foot,
    // where it has the full width.
    const stateValue = status.isError
      ? t("connectorsSettings.gatewayLoadError")
      : status.isPending
        ? t("common.loading")
        : pending
          ? t("connectorsSettings.gatewayRestartPending")
          : t("connectorsSettings.gatewayStateUpToDate");
    const footer = pending && status.data
      ? t("connectorsSettings.gatewayRestartPendingDescription", {
          date: formatDate(status.data.pendingSince, { dateStyle: "medium", timeStyle: "short" }),
        })
      : description;
    return (
      <>
        {restart.error ? (
          <Note tone="danger" role="alert">
            {restart.error instanceof Error ? restart.error.message : t("connectorsSettings.gatewayRestartFailed")}
          </Note>
        ) : null}
        {job.error ? <Note tone="danger" role="alert">{t("connectorsSettings.gatewayRestartLost")}</Note> : null}
        <InsetGroupedSection caption={t("connectorsSettings.gatewaySectionCaption")} footer={footer}>
          <InsetGroupedStatic
            label={t("connectorsSettings.gatewayStateLabel")}
            value={stateValue}
            multiline={status.isError}
          />
          {current ? (
            <li>
              <div data-inset-grouped-row="" className={cn(insetGroupedRowClassName, "flex-col items-stretch gap-2 py-3")}>
                {progressBar}
                <p
                  className={cn(
                    "text-[13px] leading-4",
                    current.status === "failed"
                      ? "text-destructive-text"
                      : current.status === "ok"
                        ? "text-pos-700"
                        : "text-[var(--openedbot-grouped-caption)]",
                  )}
                  role={current.status === "failed" ? "alert" : "status"}
                >
                  {stepLabel}
                </p>
              </div>
            </li>
          ) : null}
          <McpActionRow
            icon={IconRefresh}
            label={restarting ? t("connectorsSettings.gatewayRestarting") : t("connectorsSettings.gatewayRestart")}
            disabled={restarting || status.isPending}
            onClick={startRestart}
          />
        </InsetGroupedSection>
      </>
    );
  }

  return (
    <SettingsCard className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold tracking-tight">{t("connectorsSettings.gatewayTitle")}</p>
          <p className="text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        <button type="button" className={BUTTON.primary} disabled={restarting || status.isPending} onClick={startRestart}>
          {restarting ? t("connectorsSettings.gatewayRestarting") : t("connectorsSettings.gatewayRestart")}
        </button>
      </div>
      {status.isError ? (
        <Note tone="danger" role="alert">{t("connectorsSettings.gatewayLoadError")}</Note>
      ) : status.isPending ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : pending ? (
        <Note tone="warning" role="status">
          <strong>{t("connectorsSettings.gatewayRestartPending")}</strong>
          {". "}
          {t("connectorsSettings.gatewayRestartPendingDescription", {
            date: formatDate(status.data.pendingSince, { dateStyle: "medium", timeStyle: "short" }),
          })}
        </Note>
      ) : current === undefined || current.status === "ok" ? (
        <Note tone="success">{t("connectorsSettings.gatewayUpToDate")}</Note>
      ) : null}
      {restart.error ? (
        <Note tone="danger" role="alert">{restart.error instanceof Error ? restart.error.message : t("connectorsSettings.gatewayRestartFailed")}</Note>
      ) : null}
      {job.error ? <Note tone="danger" role="alert">{t("connectorsSettings.gatewayRestartLost")}</Note> : null}
      {current ? (
        <div className="space-y-2">
          {progressBar}
          {current.status === "failed" ? (
            <Note tone="danger" role="alert">{stepLabel}</Note>
          ) : current.status === "ok" ? (
            <Note tone="success" role="status">{stepLabel}</Note>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <DotMatrix state="connecting" label={stepLabel ?? ""} />
              {stepLabel}
            </p>
          )}
        </div>
      ) : null}
    </SettingsCard>
  );
}
