import { Fragment, type ComponentType, type ReactNode } from "react";
import {
  IconBug,
  IconCloudOff,
  IconFileUnknown,
  IconHandStop,
  IconLock,
  IconPlugConnectedX,
  IconServerBolt,
  type IconProps,
} from "@tabler/icons-react";
import type { MessageKey } from "@openedbot/browser-i18n";
import { cn, useIsMobile } from "@openedbot/browser-ui-kit";
import { ApiError } from "../lib/api";
import { useFallbackT } from "../lib/i18n";
import { BUTTON, CopyButton } from "./settings/primitives";

/** The code set when the request never reached the API (`api.ts`). */
const API_UNAVAILABLE = "API_UNAVAILABLE";

/**
 * The nature of a failure: what decides everything else on the screen.
 *
 * A single red frame for the seven cases said the same thing of a sleeping
 * API, of a missing permission and of a server crash: three outages that
 * call for NEITHER the same gesture, NOR the same urgency. The nature comes from the pair
 * (error class, HTTP status), the only two things one observes without
 * guessing anything.
 */
export type FailureKind =
  /** The request never left (`API_UNAVAILABLE`, status 0). */
  | "offline"
  /** 401 / 403: the API answered, and it refuses access. */
  | "denied"
  /** 404: the API answered, and the object does not exist. */
  | "missing"
  /** Other 4xx: the API answered, and it refuses the request as it stands. */
  | "refused"
  /** 502 / 503 / 504: it stops beyond the API, toward the runtime. */
  | "upstream"
  /** 500 and other 5xx: the API itself failed. */
  | "fault"
  /** Not an `ApiError`: a render exception, nothing was requested. */
  | "crash";

export type FailureDetail = {
  kind: FailureKind;
  message: string;
  requestId: string | null;
  facts: ReadonlyArray<readonly [string, string]>;
};

/**
 * What one can say of an error, without ever inventing.
 *
 * A programming exception (`crypto.randomUUID is not a function`)
 * describes our code and not the operator's gesture: it does not become the
 * screen's sentence. Only an `ApiError` (a refusal the API wrote) has the
 * right to speak.
 */
export function classifyFailure(error: unknown): FailureDetail {
  if (!(error instanceof ApiError)) {
    return { kind: "crash", message: "", requestId: null, facts: [] };
  }
  // An unreachable API has neither a status nor a reference: the request never
  // left. Showing « HTTP 0 » would name a state that does not exist, and
  // `API_UNAVAILABLE` is a code WE set, not one the API returned.
  if (error.code === API_UNAVAILABLE || error.status === 0) {
    return { kind: "offline", message: error.message, requestId: null, facts: [] };
  }
  const facts: Array<readonly [string, string]> = [];
  if (error.code) facts.push(["code", error.code]);
  facts.push(["HTTP", String(error.status)]);
  if (error.requestId) facts.push(["ref", error.requestId]);
  return {
    kind: kindOfStatus(error.status),
    message: error.message,
    requestId: error.requestId ?? null,
    facts,
  };
}

function kindOfStatus(status: number): FailureKind {
  if (status === 401 || status === 403) return "denied";
  if (status === 404) return "missing";
  if (status >= 400 && status < 500) return "refused";
  if (status === 502 || status === 503 || status === 504) return "upstream";
  return "fault";
}

export type HopKey = "browser" | "api" | "runtime";

/** A journey: its steps, and whether the link toward the last one was crossed. */
export type FailurePathShape = { hops: readonly HopKey[]; crossedIntoStop: boolean };

/**
 * The journey of an openedbot request, and where it stops according to the failure's nature.
 *
 * openedbot is a relay (browser, API, connector link, runtime) and the API
 * already distinguishes a link outage from a gateway response
 * (`X-OpenedBot-Relay-Stage`). This journey is therefore a FACT of the product, not a
 * decoration: it answers the only question an operator cannot
 * guess, « jusqu'où est-ce allé », and that is what decides the next gesture.
 *
 * `crossedIntoStop` separates the two kinds of stop: a CROSSED link leads to
 * a response (a refusal is still a response), an UNCROSSED link means the
 * next step saw nothing pass. The previous links are crossed by
 * construction, otherwise the stop would have been earlier.
 */
const PATHS: Record<FailureKind, FailurePathShape | null> = {
  offline: { hops: ["browser", "api"], crossedIntoStop: false },
  denied: { hops: ["browser", "api"], crossedIntoStop: true },
  missing: { hops: ["browser", "api"], crossedIntoStop: true },
  refused: { hops: ["browser", "api"], crossedIntoStop: true },
  fault: { hops: ["browser", "api"], crossedIntoStop: true },
  upstream: { hops: ["browser", "api", "runtime"], crossedIntoStop: false },
  // Nothing was requested: a journey would draw a trip that did not take place.
  crash: null,
};

const HOP_LABELS: Record<HopKey, MessageKey> = {
  browser: "errorState.hopBrowser",
  api: "errorState.hopApi",
  runtime: "errorState.hopRuntime",
};

/**
 * Two tones, not seven (the « Couleur sémantique » rule in `DESIGN.md`):
 *
 * - `info`, the informative blue: the API did what it had to, or the journey
 *   stops outside our code (sleeping cloud, access refused, object absent,
 *   silent runtime). Nothing is broken on our side, the screen informs.
 * - `danger`, the red of the « Supprimer » buttons (`--destructive-text`,
 *   `bg-neg-soft`): our code failed (500, render exception). The same
 *   red as the irreversible action, because it says the same thing: here, one
 *   does not go back on one's own.
 *
 * The title and the icon stay neutral, as on any empty screen:
 * the tint goes only on what carries the state: the journey step where it
 * stops, the HTTP status in the card footer, and the reference button,
 * built like the « Supprimer » button but in the tone.
 */
export type FailureTone = "info" | "danger";
type Tone = FailureTone;

const TONES: Record<Tone, { accent: string; chip: string; button: string }> = {
  info: {
    accent: "text-info-700",
    chip: "border-info-700/30 bg-info-soft text-info-700",
    button: BUTTON.info,
  },
  danger: {
    accent: "text-destructive-text",
    chip: "border-destructive/30 bg-neg-soft text-destructive-text",
    button: BUTTON.danger,
  },
};

const LOOKS: Record<FailureKind, {
  titleKey: MessageKey;
  pathKey: MessageKey | null;
  icon: ComponentType<IconProps>;
  tone: Tone;
}> = {
  offline: { titleKey: "errorState.offlineTitle", pathKey: "errorState.offlinePath", icon: IconCloudOff, tone: "info" },
  denied: { titleKey: "errorState.deniedTitle", pathKey: "errorState.deniedPath", icon: IconLock, tone: "info" },
  missing: { titleKey: "errorState.missingTitle", pathKey: "errorState.missingPath", icon: IconFileUnknown, tone: "info" },
  refused: { titleKey: "errorState.refusedTitle", pathKey: "errorState.refusedPath", icon: IconHandStop, tone: "info" },
  upstream: { titleKey: "errorState.upstreamTitle", pathKey: "errorState.upstreamPath", icon: IconPlugConnectedX, tone: "info" },
  fault: { titleKey: "errorState.faultTitle", pathKey: "errorState.faultPath", icon: IconServerBolt, tone: "danger" },
  crash: { titleKey: "errorState.crashTitle", pathKey: null, icon: IconBug, tone: "danger" },
};

/** The reference is promoted only where passing it on IS the next gesture. */
function referenceIsThePoint(kind: FailureKind): boolean {
  return kind === "fault" || kind === "upstream";
}

/** A fact in the card footer; `status`: the one that carries the state, as a chip. */
export type FailureFact = { label: string; value: string; status?: boolean };

/**
 * A screen's failure, told according to its nature.
 *
 * Four things, in this order: what happened (the title, specific to the
 * nature), what the API says about it (its sentence, never rewritten), how far the
 * request went (the journey), and what to act with: the screen's gesture, plus the
 * reference when passing it on is all that is left to do.
 *
 * A screen that knows its cause better than the HTTP status (the Modèles screen knows
 * it is the RUNTIME, and which one) keeps the title, the icon and adds its facts
 * at the head of the card footer; the nature, the tone and the journey stay those of
 * the observed error.
 */
export function FailureState({
  error,
  fallback,
  title,
  icon,
  facts: extraFacts = [],
  action,
  art,
  className,
  placement = "pane",
}: {
  error: unknown;
  /** The screen's sentence, when the error carries none that can be read. */
  fallback: string;
  /** The screen's title, when it knows more than the error's nature. */
  title?: string;
  icon?: ComponentType<IconProps>;
  /** The facts that belong to the screen, written before those of the error. */
  facts?: ReadonlyArray<FailureFact>;
  action?: ReactNode;
  className?: string;
  /**
   * `pane`: the settings card, centred in the panel.
   * `page`: the screen itself gave way (render boundary, 500). The text
   * fills the page, aligned like a message, with no card and no icon.
   */
  placement?: "page" | "pane";
  /** `page` only: a decorative illustration beside the text. */
  art?: ReactNode;
}) {
  const { t } = useFallbackT();
  const detail = classifyFailure(error);
  const look = LOOKS[detail.kind];
  const promoted = detail.requestId !== null && referenceIsThePoint(detail.kind);
  // The promoted reference is not repeated in the technical line: the same
  // value written twice reads as two values.
  const facts = (promoted ? detail.facts.filter(([label]) => label !== "ref") : detail.facts)
    // The HTTP status is the only fact of the error that carries the state.
    .map(([label, value]): FailureFact => ({ label, value, status: label === "HTTP" }));
  const shape = PATHS[detail.kind];
  return (
    <FailureSurface
      icon={icon ?? look.icon}
      title={title ?? t(look.titleKey)}
      description={detail.message || fallback}
      tone={look.tone}
      path={shape && look.pathKey ? { shape, label: t(look.pathKey) } : null}
      facts={[...extraFacts, ...facts]}
      reference={promoted ? detail.requestId : null}
      action={action}
      art={art}
      className={className}
      placement={placement}
    />
  );
}

/**
 * The card itself, deciding nothing: a screen that already knows its cause
 * (the runtime did not pass its last check) gives it to the card ready
 * made, and speaks in the same voice as a screen whose API refused the request.
 *
 * Two placements. `pane` takes `EmptyState`'s geometry: a card
 * centred, an icon, a title, a sentence, a gesture. The edge is solid, not
 * dotted: the dotted edge is reserved for emptiness WITHOUT a cause (`DESIGN.md`). The
 * card footer carries the technical line, separated from the rest by a rule.
 *
 * `page` is the screen that gave way. A card floating in the middle of the void reads
 * as a dialog nobody opened. The title holds the
 * page, aligned to the left, at a message's width; no icon, no
 * chip. The gesture comes next, then the technical line if there is one.
 */
export function FailureSurface({
  icon: Icon,
  title,
  description,
  tone: toneName,
  path,
  facts,
  reference = null,
  action,
  art,
  className,
  placement = "pane",
}: {
  icon: ComponentType<IconProps>;
  title: string;
  description: string;
  tone: FailureTone;
  /** The journey and its sentence (read instead of the diagram); `null`: nothing was requested. */
  path: { shape: FailurePathShape; label: string } | null;
  facts: ReadonlyArray<FailureFact>;
  /** The reference to pass on, when passing it on is the gesture. */
  reference?: string | null;
  action?: ReactNode;
  className?: string;
  placement?: "page" | "pane";
  art?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const tone = TONES[toneName];
  if (placement === "page") {
    return (
      <FailurePage
        title={title}
        description={description}
        tone={tone}
        path={path}
        facts={facts}
        reference={reference}
        action={action}
        art={art}
        className={className}
        isMobile={isMobile}
      />
    );
  }
  return (
    <section
      role="alert"
      className={cn(
        // `flex-1` + `items-center`: the card centres in what the
        // scroller leaves free under the header (`SettingsPane` is `min-h-full`).
        "flex w-full min-h-0 flex-1 items-center justify-center self-stretch py-8",
        // `SettingsPane`'s mobile scroller is at `px-0`: the margin is on the
        // content, as for `Note` and the grouped lists.
        isMobile ? "mx-4" : undefined,
        className,
      )}
    >
      <div
        className={cn(
          "flex w-full max-w-md flex-col items-center overflow-hidden text-center",
          isMobile ? "rounded-[20px] bg-[var(--openedbot-grouped-card)]" : "rounded-xl border border-border bg-background",
        )}
      >
        <div className="flex w-full flex-col items-center gap-3 px-6 pb-6 pt-8">
          <span
            aria-hidden
            className="flex size-12 items-center justify-center rounded-full bg-surface-sunken text-muted-foreground"
          >
            <Icon size={24} stroke={1.75} />
          </span>
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
            <p className="max-w-[46ch] text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
          {path ? <FailurePath shape={path.shape} label={path.label} accent={tone.accent} /> : null}
          {reference ? <Reference value={reference} button={tone.button} /> : null}
          {action ? <div className="flex flex-wrap items-center justify-center gap-2 pt-1">{action}</div> : null}
        </div>
        {facts.length > 0 ? (
          <dl className="flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-t border-border bg-surface-sunken/60 px-6 py-2.5 font-mono text-[11px] text-muted-foreground">
            {facts.map(({ label, value, status }) => (
              <div
                key={label}
                className={cn(
                  "flex items-center gap-1.5",
                  status ? cn("rounded-md border px-1.5 py-0.5", tone.chip) : undefined,
                )}
              >
                <dt className={cn("uppercase tracking-wide", status ? undefined : "opacity-70")}>{label}</dt>
                <dd className={status ? "font-semibold" : undefined}>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </section>
  );
}

type FailureToneClasses = (typeof TONES)[FailureTone];

/**
 * The screen that gave way, full frame.
 *
 * The title is the only strong element: a sentence, on the left, at the width
 * of a thread message. The gesture comes right after. The journey, the reference
 * and the technical line form the receipt, below. No card: the void
 * around it is the conversation that is no longer there.
 */
function FailurePage({
  title,
  description,
  tone,
  path,
  facts,
  reference,
  action,
  art,
  className,
  isMobile,
}: {
  title: string;
  description: string;
  tone: FailureToneClasses;
  path: { shape: FailurePathShape; label: string } | null;
  facts: ReadonlyArray<FailureFact>;
  reference: string | null;
  action?: ReactNode;
  art?: ReactNode;
  className?: string;
  isMobile: boolean;
}) {
  return (
    <section
      role="alert"
      className={cn(
        "flex w-full min-h-0 flex-1 flex-col items-start justify-center",
        // With an illustration the text keeps its column and the art takes
        // the right of the page on a wide screen, above the text on a phone.
        art ? "gap-8 md:flex-row-reverse md:items-center md:justify-center md:gap-16" : undefined,
        "px-6 pt-[max(3rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] sm:px-12",
        className,
      )}
    >
      {art ?? null}
      <div className="flex w-full max-w-[26rem] flex-col items-start gap-5">
        <div className="flex flex-col gap-3">
          <h1 className="text-balance text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
          <p className="max-w-[34ch] text-base leading-6 text-muted-foreground">{description}</p>
        </div>
        {action ? (
          <div
            className={cn(
              "flex gap-2",
              isMobile ? "w-full flex-col [&>*]:w-full" : "flex-row flex-wrap",
            )}
          >
            {action}
          </div>
        ) : null}
        {path || reference || facts.length > 0 ? (
          <div className="flex flex-col items-start gap-3">
            {path ? <FailurePath shape={path.shape} label={path.label} accent={tone.accent} /> : null}
            {reference ? <Reference value={reference} button={BUTTON.secondary} align="start" /> : null}
            {facts.length > 0 ? <FailureFacts facts={facts} tone={tone} /> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function FailureFacts({ facts, tone }: { facts: ReadonlyArray<FailureFact>; tone: FailureToneClasses }) {
  return (
    <dl className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11px] text-muted-foreground">
      {facts.map(({ label, value, status }) => (
        <div
          key={label}
          className={cn(
            "flex items-center gap-1.5",
            status ? cn("rounded-md border px-1.5 py-0.5", tone.chip) : undefined,
          )}
        >
          <dt className={status ? undefined : "opacity-70"}>{label}</dt>
          <dd className={status ? "font-semibold" : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The journey, drawn. `role="img"` with the nature's sentence as `aria-label`:
 * a screen reader hears « la requête n'est pas partie » rather than spelling
 * the segments one by one.
 *
 * Each step is a chip; the step where it stops takes the nature's tint,
 * a step never reached stays dotted. The stroke between two
 * chips says whether the link was crossed.
 */
function FailurePath({ shape, label, accent }: { shape: FailurePathShape; label: string; accent: string }) {
  const { t } = useFallbackT();
  const stop = shape.hops.length - 1;
  return (
    <p
      role="img"
      aria-label={label}
      className="flex items-center py-1 font-mono text-[11px] leading-none"
    >
      {shape.hops.map((hop, index) => {
        const reached = index < stop || shape.crossedIntoStop;
        const isStop = index === stop;
        return (
          <Fragment key={hop}>
            {index > 0 ? <PathSegment crossed={reached} /> : null}
            <span
              className={cn(
                "rounded-full border px-2.5 py-1",
                // What worked is green; the step that answered with a
                // refusal or an outage takes the tone; a step never reached
                // stays dotted, with no colour: it did nothing.
                isStop && reached
                  ? cn("border-current font-medium", accent)
                  : reached
                    ? "border-pos-700/40 bg-pos-soft text-pos-700"
                    : "border-dashed border-border text-muted-foreground/60",
              )}
            >
              {t(HOP_LABELS[hop])}
            </span>
          </Fragment>
        );
      })}
    </p>
  );
}

/**
 * A crossed link is a solid green stroke; an uncrossed link is a
 * red break: that is where it breaks, whatever the nature.
 */
function PathSegment({ crossed }: { crossed: boolean }) {
  if (crossed) return <span aria-hidden className="block h-px w-6 bg-pos-700/40" />;
  return (
    <span aria-hidden className="flex items-center gap-1 text-destructive-text">
      <span className="block h-0 w-2.5 border-t border-dashed border-current" />
      <span className="text-[10px] leading-none">×</span>
      <span className="block h-0 w-2.5 border-t border-dashed border-current" />
    </span>
  );
}

/**
 * The reference, when passing it on is the gesture. It leaves the technical
 * line to become selectable with a click and copyable with a gesture:
 * it is the only content of the screen one copies elsewhere.
 */
function Reference({
  value,
  button,
  align = "center",
}: {
  value: string;
  button: string;
  align?: "start" | "center";
}) {
  const { t } = useFallbackT();
  const start = align === "start";
  return (
    <div className={cn("flex w-full flex-col gap-2 pt-1", start ? "items-start" : "items-center")}>
      <p className={cn("max-w-[46ch] text-xs leading-5 text-muted-foreground", start ? "text-left" : "text-center")}>
        {t("errorState.transmit")}
      </p>
      <div className={cn("flex max-w-full flex-wrap gap-2", start ? "items-center justify-start" : "items-center justify-center")}>
        <code className="min-w-0 max-w-full select-all truncate rounded-md border border-border bg-surface-sunken/60 px-2.5 py-1.5 font-mono text-xs leading-5">
          {value}
        </code>
        <CopyButton
          value={value}
          copyLabel={t("errorState.copyReference")}
          copiedLabel={t("errorState.referenceCopied")}
          className={cn(button, "shrink-0 px-2.5 py-1 text-xs")}
          copiedClassName={cn(BUTTON.success, "shrink-0 px-2.5 py-1 text-xs")}
        />
      </div>
    </div>
  );
}
