import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useT } from "../lib/i18n";

/** Seconds before each automatic retry: a link that bounces comes back fast, a stopped host does not. */
export const RUNTIME_RETRY_DELAYS = [10, 20, 30, 60] as const;
const RESTORED_MS = 4000;

export function runtimeRetryDelay(attempt: number): number {
  return RUNTIME_RETRY_DELAYS[Math.min(attempt, RUNTIME_RETRY_DELAYS.length - 1)]!;
}

/** `HH:MM` of the link's last sign of life, or null when it never showed up. */
export function formatOfflineSince(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "fr-FR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function PulseDot({ className }: { className: string }) {
  return (
    <span className="relative inline-flex size-2 shrink-0" aria-hidden>
      <span className={`absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none ${className}`} />
      <span className={`relative size-2 rounded-full ${className}`} />
    </span>
  );
}

// BoardUI Composer Panel status tab (boardui.com/components/composer-panel):
// rounded at the top only, its lower part tucked under the composer card,
// which `Composer` places 28 px in from each side (`notice`).
const TAB = "flex min-h-[46px] items-start gap-2 rounded-t-2xl px-3 pt-2 pb-5 text-xs leading-5";
const TAB_ACTION =
  "shrink-0 cursor-pointer rounded-md px-1.5 font-medium outline-none hover:underline focus-visible:ring-2 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60";

type TabPalette = {
  surface: string;
  style?: CSSProperties;
  strong: string;
  soft: string;
  faint: string;
  dot: string;
  ring: string;
};

/**
 * The tab and the badge wear the bot's colour, the exact `--bot-tint` of the
 * user bubbles, white on it: a generic danger red sat next to the bot's own
 * red and read as a mismatched shade. A bot without a coloured face keeps the
 * BoardUI grey tab, with an amber dot as the only alarm.
 */
export function runtimeTabPalette(tint: string | null | undefined): TabPalette {
  if (tint) {
    return {
      surface: "",
      style: { backgroundColor: tint },
      strong: "text-white",
      soft: "text-white/85",
      faint: "text-white/75",
      dot: "bg-white",
      ring: "focus-visible:ring-white/70",
    };
  }
  return {
    surface: "bg-background-tertiary-default",
    strong: "text-text-primary",
    soft: "text-text-secondary",
    faint: "text-text-tertiary",
    dot: "bg-warn-700",
    ring: "focus-visible:ring-ring",
  };
}

/**
 * The runtime is down while the thread is open. Before, a blurred modal said
 * so once, then the whole sentence ended up truncated in the composer's
 * placeholder. Now the thread stays readable and a status tab on the
 * composer says what is going on, retries by itself with a growing delay and
 * lets the operator retry now or open the runtime settings. When the runtime
 * comes back it says so for a few seconds, then leaves.
 *
 * A hook, not a component: the tab is only mounted while it has something to
 * say, but the countdown and the `offline` -> online edge must outlive it.
 * Returns the tab for `Composer`'s `notice`, or null.
 */
export function useRuntimeOfflineNotice({
  offline,
  since,
  retrying,
  tint,
  onRetry,
  onOpenRuntime,
}: {
  offline: boolean;
  /** `link.lastSeenAt` of the connector, ISO. */
  since: string | null | undefined;
  retrying: boolean;
  /** The bot's bubble colour (`botBubbleColor`), or null for the grey tab. */
  tint?: string | null;
  onRetry: () => void;
  onOpenRuntime: () => void;
}): ReactNode {
  const { t, locale } = useT();
  const [attempt, setAttempt] = useState(0);
  const [left, setLeft] = useState(() => runtimeRetryDelay(0));
  const [restored, setRestored] = useState(false);
  const wasOffline = useRef(offline);
  const retry = useRef(onRetry);
  retry.current = onRetry;

  useEffect(() => {
    if (offline) {
      setRestored(false);
    } else if (wasOffline.current) {
      setAttempt(0);
      setLeft(runtimeRetryDelay(0));
      setRestored(true);
    }
    wasOffline.current = offline;
  }, [offline]);

  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(() => setRestored(false), RESTORED_MS);
    return () => window.clearTimeout(timer);
  }, [restored]);

  // One tick per second while offline and idle; a retry in flight pauses the countdown.
  useEffect(() => {
    if (!offline || retrying) return;
    const timer = window.setInterval(() => setLeft((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [offline, retrying]);

  useEffect(() => {
    if (!offline || retrying || left > 0) return;
    const next = attempt + 1;
    setAttempt(next);
    setLeft(runtimeRetryDelay(next));
    retry.current();
  }, [attempt, left, offline, retrying]);

  const palette = runtimeTabPalette(tint);
  if (restored && !offline) {
    return (
      <div role="status" data-runtime-notice="restored" className={`${TAB} ${palette.surface} ${palette.soft}`} style={palette.style}>
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${tint ? palette.dot : "bg-pos-700"}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("runtimeOffline.restored")}</span>
      </div>
    );
  }
  if (!offline) return null;

  const time = formatOfflineSince(since, locale);
  const manualRetry = () => {
    setLeft(runtimeRetryDelay(attempt));
    onRetry();
  };
  return (
    <div role="alert" data-runtime-notice="offline" className={`${TAB} ${palette.surface}`} style={palette.style}>
      <span className="mt-1.5"><PulseDot className={palette.dot} /></span>
      <p className="min-w-0 flex-1 truncate">
        <span className={`font-medium ${palette.strong}`}>
          {retrying ? t("runtimeOffline.retrying") : t("runtimeOffline.title")}
        </span>
        {time ? <span className={palette.faint}> {t("runtimeOffline.since", { time })}</span> : null}
        <span className="sr-only"> {t("runtimeOffline.body")}</span>
      </p>
      <button type="button" className={`${TAB_ACTION} ${palette.ring} ${palette.strong}`} disabled={retrying} onClick={manualRetry}>
        {retrying ? t("runtimeOffline.retrying") : t("runtimeOffline.retryIn", { seconds: left })}
      </button>
      <button type="button" className={`${TAB_ACTION} ${palette.ring} ${palette.soft}`} onClick={onOpenRuntime}>
        {t("runtimeOffline.details")}
      </button>
    </div>
  );
}

/** The one signal left in the top bar while the runtime is away, on every thread. */
export function RuntimeOfflineBadge({
  since,
  retrying,
  tint,
  onClick,
}: {
  since: string | null | undefined;
  retrying: boolean;
  /** Same colour as the composer's tab: the bot's bubble colour, or grey. */
  tint?: string | null;
  onClick: () => void;
}) {
  const { t, locale } = useT();
  const time = formatOfflineSince(since, locale);
  const palette = runtimeTabPalette(tint);
  return (
    <button
      type="button"
      onClick={onClick}
      title={time ? t("runtimeOffline.badgeTitle", { time }) : t("runtimeOffline.title")}
      style={palette.style}
      className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-border-focus-ring ${palette.surface} ${tint ? palette.strong : palette.soft}`}
    >
      <PulseDot className={palette.dot} />
      {retrying ? t("runtimeOffline.retrying") : t("runtimeOffline.badge")}
    </button>
  );
}
