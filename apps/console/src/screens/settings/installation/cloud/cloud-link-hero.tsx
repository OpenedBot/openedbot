import { type ReactNode } from "react";
import { IconCloud, IconServer } from "@tabler/icons-react";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";
import { DeployEnvironmentBadge } from "../../../../components/deploy-environment-badge";
import { linkKind, useDeployEnvironment } from "../../../../lib/platform/deploy-environment";
import { displayedRuntimeHealth } from "../../../../lib/runtime/runtime-health";
import { useT } from "../../../../lib/i18n";
import type { RuntimePublicDto } from "@openedbot/contracts-api";
import type { RuntimeHealthStatus } from "@openedbot/contracts-api";
import { ACTIONS, SettingsCard, ToneBadge } from "../../../../components/settings/primitives";
import { HEALTH_LABEL } from "./cloud-shared";

/**
 * The link's thread: the only thing this screen has to show first.
 *
 * The subject is a machine that belongs to the client, elsewhere, and that opens
 * a connection to openedbot itself. The thread reads in the direction of the call
 * (host toward openedbot over the link, openedbot toward the gateway directly), and carries the state
 * on it: solid and green when the link is open, cut and blue when the host
 * has not presented itself (nothing is broken on openedbot's side: it waits), red when
 * the link has been replaced from another address. A table said the same
 * thing in three lines that had to be read; the thread is seen.
 */
type WireTone = "open" | "closed" | "idle" | "alarm";
const WIRE_TONE: Record<WireTone, { line: string; text: string; dot: string }> = {
  open: { line: "bg-pos-700", text: "text-pos-700", dot: "border-pos-700 bg-pos-soft" },
  closed: { line: "bg-info-700", text: "text-info-700", dot: "border-info-700 bg-info-soft" },
  idle: { line: "bg-border", text: "text-muted-foreground", dot: "border-border bg-surface-sunken" },
  alarm: { line: "bg-destructive", text: "text-destructive-text", dot: "border-destructive bg-neg-soft" },
};

type LinkEndpointProps = { icon: typeof IconServer; title: string; caption: string };

function LinkEndpoint({ icon: Icon, title, caption }: LinkEndpointProps) {
  return (
    <div className="flex w-20 flex-col items-center gap-1.5 text-center sm:w-24">
      <span className="grid size-11 place-items-center rounded-xl border border-border bg-surface-sunken text-foreground">
        <Icon aria-hidden className="size-5" stroke={1.5} />
      </span>
      <span className="text-sm leading-tight font-medium">{title}</span>
      <span className="text-xs leading-4 text-muted-foreground">{caption}</span>
    </div>
  );
}

function LinkWire({
  from,
  to,
  tone,
  label,
  detail,
}: {
  from: LinkEndpointProps;
  to: LinkEndpointProps;
  tone: WireTone;
  label: string;
  detail?: ReactNode;
}) {
  const style = WIRE_TONE[tone];
  const broken = tone !== "open";
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 sm:gap-x-5">
      <LinkEndpoint {...from} />
      {/* `pt-[21px]`: the thread passes through the center of the two icons (44 px). */}
      <div className="flex min-w-0 flex-col items-center gap-2 pt-[21px]">
        <div aria-hidden className={cn("flex w-full items-center", style.text)}>
          <span className={cn("h-0.5 flex-1 rounded-full", style.line)} />
          {broken ? <span className={cn("mx-1.5 size-2.5 shrink-0 rounded-full border-2", style.dot)} /> : null}
          <span className={cn("h-0.5 flex-1 rounded-full", style.line, broken && "opacity-40")} />
          <span className={cn("size-0 border-y-[5px] border-l-[7px] border-y-transparent border-l-current", broken && "opacity-40")} />
        </div>
        <p className={cn("text-center text-xs font-medium", style.text)}>{label}</p>
        {detail ? <p className="text-center text-xs leading-4 text-muted-foreground">{detail}</p> : null}
      </div>
      <LinkEndpoint {...to} />
    </div>
  );
}

/**
 * The lead card: the runtime that serves the runs, its thread, its gestures.
 *
 * With no runtime, it says there is none and points at the section that
 * declares one: it does not offer a second « Connecter » button, which would make
 * two paths for a single gesture.
 */
export function RuntimeLinkHero({
  runtime,
  actions,
  children,
}: {
  runtime: RuntimePublicDto | null;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { t, formatDate } = useT();
  const isMobile = useIsMobile();
  const isConnector = runtime?.reachability === "connector";
  const isDirect = runtime?.reachability === "direct";
  const hijackSuspectedAt = isConnector ? runtime?.link?.hijackSuspectedAt ?? null : null;
  const environment = useDeployEnvironment();
  const kind = isConnector ? linkKind(runtime?.link?.origin, environment) : null;
  const displayed = runtime ? displayedRuntimeHealth(runtime) : "unknown";
  const status: RuntimeHealthStatus = displayed === "not_configured" ? "unknown" : displayed;
  const tone: WireTone = !runtime
    ? "idle"
    : hijackSuspectedAt
      ? "alarm"
      : status === "healthy"
        ? "open"
        : status === "unknown"
          ? "idle"
          : "closed";
  const label = runtime ? t(HEALTH_LABEL[status]) : "aucun lien";
  const detail = !runtime
    ? null
    : isConnector
      ? runtime.link?.lastSeenAt
        ? `dernier signe de vie ${formatDate(runtime.link.lastSeenAt)}`
        : "jamais présenté"
      : runtime.lastCheckedAt ? `dernier test ${formatDate(runtime.lastCheckedAt)}` : null;
  const from: LinkEndpointProps = isDirect
    ? { icon: IconCloud, title: "openedbot", caption: "HTTPS" }
    : { icon: IconServer, title: "votre hôte", caption: "gateway privé" };
  const to: LinkEndpointProps = isDirect
    ? { icon: IconServer, title: "gateway", caption: "votre hôte" }
    : { icon: IconCloud, title: "openedbot", caption: "relais" };
  const title = runtime?.name ?? t("onboarding.completion.runtime_missing_title");
  const caption = !runtime ? "Déclarez un runtime dans Runtimes."
    : isConnector ? "Joint par sa connexion sortante : il n’a ni URL ni token à modifier ici."
    : "openedbot joint votre gateway par votre bord HTTPS public.";
  return (
    <SettingsCard aria-labelledby="runtime-hero-title" className="space-y-5">
      <h2 className="sr-only">{runtime ? "Runtime actif" : title}</h2>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p id="runtime-hero-title" className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
            <span className="truncate">{title}</span>
          </p>
          <p className="mt-0.5 max-w-[60ch] text-xs leading-5 text-muted-foreground">{caption}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* The whole range here, prod included: one host can be linked
              to several openedbots, and it is on this card that they get mixed up. */}
          <DeployEnvironmentBadge />
          <ToneBadge tone={kind?.tone ?? "neutral"}>{isDirect ? "Accès direct" : kind ? `Lien ${kind.label}` : "Lien openedbot"}</ToneBadge>
        </div>
      </div>
      {isDirect ? <p className="text-center text-sm">{t("cloudRuntimeSettings.addedFlow")}</p> : null}
      <LinkWire from={from} to={to} tone={tone} label={label} detail={detail} />
      {children}
      {actions && !isMobile ? <div className={ACTIONS}>{actions}</div> : null}
    </SettingsCard>
  );
}
