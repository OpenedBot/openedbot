import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconRefresh } from "@tabler/icons-react";
import { cn, toast } from "@openedbot/browser-ui-kit";
import { api, errorMessage, queryKeys } from "../../../../lib/api";
import { connectorUpgradeLevel, hermesUpdate } from "../../../../lib/runtime/connector-upgrade";
import { AUTO_UPGRADE_COMMAND } from "../../../../lib/runtime/auto-upgrade";
import { useT } from "../../../../lib/i18n";
import type { RuntimeEnrollmentTicketDto, RuntimeLinkVerifyDto, RuntimeConnectorDto, RuntimeLinkDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { ACTIONS, BUTTON, CopyButton, Note } from "../../../../components/settings/primitives";
import { RuntimeEnrollmentDialog } from "./cloud-enrollment";

/**
 * At most a minute and a quarter for a hung-up host to come back: an
 * up-to-date connector redials in one second, an old one keeps its backoff (60 s
 * at most).
 */
const LINK_RECONNECT_WAIT_MS = 75_000;

/** « Réessayer » on a closed link: past this delay with no link, it is a failure. */
const LINK_RETRY_WAIT_MS = 5_000;

type LinkCheck =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "reconnecting"; previousGeneration: string | null }
  | { phase: "retrying" }
  | { phase: "done"; result: RuntimeLinkVerifyDto; repaired: boolean }
  | { phase: "waiting" }
  | { phase: "retry_failed" };

/**
 * « Vérifier le lien »: a single gesture, which decides on its own. WebSocket ping of the
 * link, then a probe of the gateway if it answers. A silent link is hung up by openedbot
 * (4005): the screen waits for the host to come back under a NEW generation,
 * then checks again. `connected` would prove nothing: it is already `true` before
 * the cut, and the reread may never see the `false`.
 */

export function RuntimeLinkCheck({ runtime, retiredOrigin = null }: { runtime: RuntimePublicDto; retiredOrigin?: string | null }) {
  const { t, formatDate } = useT();
  const queryClient = useQueryClient();
  const [check, setCheck] = useState<LinkCheck>({ phase: "idle" });
  const { mutate: runVerify } = useMutation({
    mutationFn: (_input: { repaired: boolean; retry: boolean }) => {
      if (!runtime.id) throw new Error("runtime");
      return api.verifyRuntimeLink(runtime.id);
    },
    onMutate: () => setCheck({ phase: "checking" }),
    onSuccess: (result, input) => {
      if (result.outcome === "reconnect_requested") {
        setCheck({ phase: "reconnecting", previousGeneration: result.generation });
        return;
      }
      // The host reconnected during the read: we probe the connection that holds the link.
      if (result.outcome === "generation_changed" && input.retry) {
        runVerify({ repaired: input.repaired, retry: false });
        return;
      }
      setCheck({ phase: "done", result, repaired: input.repaired });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
    },
    onError: (error) => {
      setCheck({ phase: "idle" });
      toast.error(errorMessage(error, t("cloudRuntimeSettings.linkVerifyFailed")));
    },
  });

  const waitingFor = check.phase === "reconnecting" || check.phase === "retrying" ? check.phase : null;
  useEffect(() => {
    if (waitingFor === null) return;
    // The usual reread ticks every 5 s: too slow for a one-second redial.
    const poll = setInterval(() => void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration }), 1_000);
    const giveUp =
      waitingFor === "retrying"
        ? setTimeout(() => setCheck({ phase: "retry_failed" }), LINK_RETRY_WAIT_MS)
        : setTimeout(() => setCheck({ phase: "waiting" }), LINK_RECONNECT_WAIT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [waitingFor, queryClient]);

  const generation = runtime.link?.connected ? runtime.link.generation ?? "connected" : null;
  const previousGeneration = check.phase === "reconnecting" ? check.previousGeneration : undefined;
  useEffect(() => {
    if (generation === null) return;
    // A link that returns after the 5 s give-up replaces the failure with the real verdict.
    if (check.phase === "retrying" || check.phase === "retry_failed") {
      runVerify({ repaired: true, retry: true });
      return;
    }
    if (previousGeneration === undefined || generation === previousGeneration) return;
    runVerify({ repaired: true, retry: true });
  }, [check.phase, generation, previousGeneration, runVerify]);

  const doctor = <code className="font-mono">sudo edge-setup doctor</code>;
  const startRetry = (): void => {
    setCheck({ phase: "retrying" });
    void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeConfiguration });
  };
  let verdict: ReactNode = null;
  if (check.phase === "checking") {
    verdict = <Note role="status">{t("cloudRuntimeSettings.linkVerifyChecking")}</Note>;
  } else if (check.phase === "reconnecting") {
    verdict = <Note tone="info" role="status">{t("cloudRuntimeSettings.linkVerifyReconnecting")}</Note>;
  } else if (check.phase === "retrying") {
    verdict = <Note tone="info" role="status">{t("cloudRuntimeSettings.linkRetrying")}</Note>;
  } else if (check.phase === "retry_failed") {
    verdict = retiredOrigin ? (
      <Note tone="danger" role="alert">{t("cloudRuntimeSettings.linkOriginRetiredRetry", { origin: retiredOrigin })}</Note>
    ) : (
      <Note tone="danger" role="alert">
        <span className="block">{t("cloudRuntimeSettings.linkRetryFailed")} {doctor}</span>
        <span className="block">{t("cloudRuntimeSettings.linkVerifyDoctorHint")}</span>
      </Note>
    );
  } else if (check.phase === "waiting") {
    verdict = (
      <Note tone="warning" role="status">
        <span className="block">{t("cloudRuntimeSettings.linkVerifyWaiting")} {doctor}</span>
        <span className="block">{t("cloudRuntimeSettings.linkVerifyDoctorHint")}</span>
      </Note>
    );
  } else if (check.phase === "done") {
    const { result, repaired } = check;
    if (result.outcome === "alive") {
      const linkLine = repaired
        ? t("cloudRuntimeSettings.linkVerifyRepaired")
        : result.rttMs === null
          ? t("cloudRuntimeSettings.linkVerifyAliveBusy")
          : t("cloudRuntimeSettings.linkVerifyAlive", { rtt: String(result.rttMs) });
      verdict = (
        <Note tone={result.gateway?.ok === false ? "warning" : "success"} role="status">
          <span className="block">{linkLine}</span>
          <span className="block">
            {result.gateway?.ok === false
              ? t("cloudRuntimeSettings.linkVerifyGatewayFailed", { message: result.gateway.message })
              : t("cloudRuntimeSettings.linkVerifyGatewayOk")}
          </span>
        </Note>
      );
    } else if (result.outcome === "no_link") {
      verdict = (
        <Note tone="warning" role="status">
          <span className="block">{t("cloudRuntimeSettings.linkVerifyUnreachable")} {doctor}</span>
          <span className="block">{t("cloudRuntimeSettings.linkVerifyDoctorHint")}</span>
          {result.lastSeenAt ? (
            <span className="block">{t("cloudRuntimeSettings.linkVerifyLastSeen", { date: formatDate(result.lastSeenAt) })}</span>
          ) : null}
        </Note>
      );
    } else if (result.outcome === "owner_unavailable") {
      verdict = <Note tone="warning" role="status">{t("cloudRuntimeSettings.linkVerifyOwnerUnavailable")}</Note>;
    } else {
      verdict = <Note role="status">{t("cloudRuntimeSettings.linkVerifyIndeterminate")}</Note>;
    }
  }

  const busy = check.phase === "checking" || check.phase === "reconnecting" || check.phase === "retrying";
  const isClosed = runtime.link?.connected !== true;
  const showClosedHint = isClosed && check.phase === "idle" && !retiredOrigin;
  return (
    <div className="space-y-3">
      <div className={ACTIONS}>
        <button
          type="button"
          className={cn(BUTTON.secondary, "gap-2", busy && "[&_svg]:animate-spin")}
          disabled={busy}
          onClick={isClosed ? startRetry : () => runVerify({ repaired: false, retry: true })}
        >
          <IconRefresh className="size-4" aria-hidden /> {t(isClosed ? "cloudRuntimeSettings.linkRetry" : "cloudRuntimeSettings.linkVerify")}
        </button>
      </div>
      {showClosedHint ? (
        <Note tone="warning" role="status">
          <span className="block">{t("cloudRuntimeSettings.linkClosedHint")}</span>
          <span className="block">{t("cloudRuntimeSettings.linkClosedDoctorHint")} {doctor}</span>
          {runtime.link?.lastSeenAt ? (
            <span className="block">{t("cloudRuntimeSettings.linkVerifyLastSeen", { date: formatDate(runtime.link.lastSeenAt) })}</span>
          ) : null}
        </Note>
      ) : null}
      {verdict}
    </div>
  );
}

/**
 * The host's connector is behind. openedbot cannot upgrade it (release boundary):
 * the card hands the owner the one command to run on the host. Below the
 * minimum is a warning, a newer release alone is information.
 */
export function ConnectorUpgradeNotice({ connector, connected, autoUpgrade }: {
  connector: RuntimeConnectorDto | null | undefined;
  connected: boolean;
  /** The host announces `auto_upgrade`: it will install this version on its own. */
  autoUpgrade: boolean;
}) {
  const { t } = useT();
  const level = connectorUpgradeLevel(connector);
  if (!connector || !level) return null;
  const target = connector.latestVersion ?? connector.minimumVersion ?? t("connectorUpgrade.unknownVersion");
  return (
    <Note tone={level === "outdated" ? "warning" : "info"} role="status" className="space-y-2">
      <span className="block font-medium">
        {t(level === "outdated" ? "connectorUpgrade.outdatedTitle" : "connectorUpgrade.availableTitle")}
      </span>
      <span className="block">
        {t("connectorUpgrade.versions", { installed: connector.version ?? connector.agent, target })}
      </span>
      {autoUpgrade ? (
        <span data-auto-upgrade="on" className="block">{t("connectorUpgrade.autoActive")}</span>
      ) : null}
      <NoticeCommand command={connector.upgradeCommand} />
      <span className="block">{t(connected ? "connectorUpgrade.selfServe" : "connectorUpgrade.selfServeClosed")}</span>
      {autoUpgrade ? null : (
        <span data-auto-upgrade="off" className="block space-y-2 border-t border-current/15 pt-2">
          <span className="block font-medium">{t("connectorUpgrade.autoOffTitle")}</span>
          <span className="block">{t("connectorUpgrade.autoOffHelp")}</span>
          <NoticeCommand command={AUTO_UPGRADE_COMMAND} />
        </span>
      )}
    </Note>
  );
}

function NoticeCommand({ command }: { command: string }) {
  const { t } = useT();
  return (
    <span className="flex items-center gap-2">
      <code className="scrollbar-subtle block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-surface-sunken px-3 py-2 font-mono text-xs leading-5 text-foreground">
        {command}
      </code>
      <CopyButton
        value={command}
        copyLabel={t("connectorUpgrade.copy")}
        copiedLabel={t("connectorUpgrade.copied")}
        className={cn(BUTTON.small, "shrink-0")}
      />
    </span>
  );
}

/**
 * A newer Hermes ships with the latest edge-setup release. Information only:
 * Hermes is installed by `edge-setup up`, on the host, and openedbot never
 * runs it. `upgrade` alone leaves Hermes as it is, so it is only the first
 * step, while the host's edge-setup is behind the release that pins `latest`.
 */
export function HermesUpdateNotice({ link }: { link: RuntimeLinkDto | null | undefined }) {
  const { t } = useT();
  const update = hermesUpdate(link);
  if (!update) return null;
  const edgeSetupBehind = link?.connector?.updateAvailable === true || link?.connector?.outdated === true;
  // An API older than `upCommand` still gets the right command.
  const up = update.upCommand ?? "sudo edge-setup up --yes";
  return (
    <Note tone="info" role="status" className="space-y-2">
      <span className="block font-medium">{t("connectorUpgrade.hermesTitle")}</span>
      <span className="block">{t("connectorUpgrade.hermesVersions", { current: update.current!, latest: update.latest! })}</span>
      {edgeSetupBehind ? (
        <>
          <CommandLine title={t("connectorUpgrade.hermesStepUpgrade")} command={update.upgradeCommand} />
          <CommandLine title={t("connectorUpgrade.hermesStepUp", { latest: update.latest! })} command={up} />
        </>
      ) : (
        <CommandLine title={t("connectorUpgrade.hermesInstall", { latest: update.latest! })} command={up} />
      )}
      <span className="block">{t("connectorUpgrade.hermesHow")}</span>
    </Note>
  );
}

function CommandLine({ title, command }: { title: string; command: string }) {
  const { t } = useT();
  return (
    <span className="block space-y-1">
      <span className="block font-medium">{title}</span>
      <span className="flex items-center gap-2">
        <code className="scrollbar-subtle block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-surface-sunken px-3 py-2 font-mono text-xs leading-5 text-foreground">
          {command}
        </code>
        <CopyButton
          value={command}
          copyLabel={t("connectorUpgrade.copy")}
          copiedLabel={t("connectorUpgrade.copied")}
          className={cn(BUTTON.small, "shrink-0")}
        />
      </span>
    </span>
  );
}

/**
 * The host's last signed origin is no longer accepted. `upgrade` reconnects
 * to that same origin, so it cannot bring the link back: the card says so
 * and hands the owner a fresh enrollment ticket plus the current command.
 */
export function RetiredLinkNotice({ runtime }: { runtime: RuntimePublicDto }) {
  const { t } = useT();
  const origin = runtime.link?.origin ?? null;
  const command = runtime.link?.relinkCommand ?? null;
  const upgrade = runtime.link?.connector?.upgradeCommand ?? "sudo edge-setup upgrade --yes";
  const me = useQuery({ queryKey: queryKeys.authMe, queryFn: api.authMe });
  const readOnly = Boolean(me.data?.session.impersonation);
  const [ticket, setTicket] = useState<RuntimeEnrollmentTicketDto | null>(null);
  const enroll = useMutation({
    mutationFn: () => api.openRuntimeEnrollment({ name: runtime.name?.trim() || "runtime" }),
    onSuccess: (opened) => setTicket(opened),
    onError: (error) => toast.error(errorMessage(error, t("cloudRuntimeSettings.linkOriginRetiredFailed"))),
  });
  if (!origin || !command || runtime.link?.originRetired !== true) return null;
  return (
    <>
      <Note tone="danger" role="alert" className="space-y-3">
        <span className="block font-medium">{t("cloudRuntimeSettings.linkOriginRetiredTitle")}</span>
        <span className="block">{t("cloudRuntimeSettings.linkOriginRetiredBody", { origin })}</span>
        <CommandLine title={t("cloudRuntimeSettings.linkOriginRetiredStepUpgrade")} command={upgrade} />
        <span className="block space-y-2">
          <span className="block font-medium">{t("cloudRuntimeSettings.linkOriginRetiredStepTicket")}</span>
          <span className="block">{t("cloudRuntimeSettings.linkOriginRetiredTicketHelp")}</span>
          {readOnly ? (
            <span className="block">{t("cloudRuntimeSettings.linkOriginRetiredTicketReadonly")}</span>
          ) : (
            <button type="button" className={BUTTON.primary} disabled={enroll.isPending} onClick={() => enroll.mutate()}>
              {enroll.isPending ? t("cloudRuntimeSettings.linkOriginRetiredTicketBusy") : t("cloudRuntimeSettings.linkOriginRetiredTicket")}
            </button>
          )}
        </span>
        <CommandLine title={t("cloudRuntimeSettings.linkOriginRetiredStepRelink")} command={command} />
      </Note>
      {ticket ? (
        <RuntimeEnrollmentDialog ticket={ticket} onDone={() => setTicket(null)} onCancel={() => setTicket(null)} />
      ) : null}
    </>
  );
}
