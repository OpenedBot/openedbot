import type { ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import type { BotFaceSpec } from "@openedbot/contracts-api";
import { BotFace } from "../bot-face";
import { useT } from "../../lib/i18n";
import { streamDuration, useElapsed } from "./agent-feed";
import { StreamIcon } from "./stream-icons";

/*
 * The heavy feed of the reference app's chat (the streaming-ui template: `FeedRow`,
 * `DotsLoader`, `Sparks`, `AgentsHeader`), on the thread tokens. A bot run
 * of openedbot maps onto it: web searches and visited pages keep their two
 * line rows, a tool call is a one line row of the same look, a sentence the
 * bot wrote between two tools is a status line.
 */

export type StreamSite = { letter: string; color: string; name: string };

/** Who wrote a feed message: the bot of the turn, drawn with its own face. */
export type StreamSpeaker = { id: string; name: string; face?: BotFaceSpec | null };

/** A page a search found, for the panel's unfolded search row. */
export type StreamSource = { title: string; url: string; domain: string };

export type StreamFeedItem =
  | { id: string; kind: "search"; query: string; results: number; sites: StreamSite[]; sources?: StreamSource[]; pending?: boolean }
  | { id: string; kind: "visit"; url: string }
  /** `detail`: the call's error, or its output excerpt, unfolded in the panel. */
  | { id: string; kind: "tool"; label: string; pending?: boolean; failed?: boolean; detail?: string }
  /** grok's agent message: what the bot said between two steps, in its bubble. */
  | { id: string; kind: "msg"; agent: StreamSpeaker; text: string }
  | { id: string; kind: "status"; text: string };

/** The bot's face at a feed size (grok's `AgentOrb`). */
export function StreamSpeakerFace({ agent, size }: { agent: StreamSpeaker; size: number }) {
  return (
    <span aria-hidden="true" className="grid shrink-0 place-items-center overflow-hidden rounded-full" style={{ width: size, height: size }}>
      <BotFace name={agent.name} seed={agent.id} face={agent.face} className="size-full" />
    </span>
  );
}

/** A favicon stand-in: the site's initial on a colour drawn from its name (real favicons are third-party assets). */
export function streamSite(domain: string): StreamSite {
  const name = domain.replace(/^www\./, "");
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { letter: (name.charAt(0) || "?").toUpperCase(), color: `hsl(${hash % 360} 62% 46%)`, name };
}

export function StreamFavicon({ site, size = 16 }: { site: StreamSite; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full leading-none font-semibold text-white"
      style={{ width: size, height: size, background: site.color, fontSize: size * 0.55 }}
    >
      {site.letter}
    </span>
  );
}

function FaviconStack({ sites }: { sites: StreamSite[] }) {
  return (
    <span className="flex" title={sites.map((site) => site.name).join(", ")}>
      {sites.map((site, index) => (
        <span
          key={index}
          className="grid size-[18px] place-items-center rounded-full"
          style={{ background: "var(--stream-raised)", boxShadow: "0 0 0 1px var(--stream-base)", marginLeft: index ? -10 : 0 }}
        >
          <StreamFavicon site={site} />
        </span>
      ))}
    </span>
  );
}

/** One row of the live feed: its content slides down from -10 px (150 ms) inside the blurring wrapper. */
export function StreamFeedRow({ item, full = false }: { item: StreamFeedItem; full?: boolean }) {
  const { t, plural } = useT();
  const slide = full ? "" : "stream-row-in";
  if (item.kind === "search") {
    const pending = !full && item.pending;
    return (
      <div data-feed-row="search" className={cn("flex items-center gap-[10px] py-[3px] ps-0.5", slide)}>
        <StreamIcon name="browser" className={cn("size-4 shrink-0", pending && "stream-pulse")} />
        <div className={cn("min-w-0 flex-1", pending && "stream-pulse")}>
          <div className="truncate text-[13px] leading-[16.25px] text-[var(--stream-fg2)]">
            {pending ? t("threadTimeline.streamSearching") : t("threadTimeline.streamSearched")}
          </div>
          <div className="truncate font-[family-name:var(--stream-mono)] text-[13px] leading-[16.25px] text-[var(--stream-fg)]">{item.query}</div>
        </div>
        <span className={cn("flex shrink-0 items-center gap-2 text-[14px] leading-[21px] tabular-nums text-[var(--stream-fg2)] transition-opacity duration-150", pending && "opacity-0")}>
          <span className="max-sm:hidden">
            {pending
              ? t("threadTimeline.streamNoResult")
              : plural(item.results, {
                  one: t("threadTimeline.streamResults_one", { count: item.results }),
                  other: t("threadTimeline.streamResults_other", { count: item.results }),
                })}
          </span>
          {!pending && item.sites.length ? <FaviconStack sites={item.sites} /> : null}
        </span>
      </div>
    );
  }
  if (item.kind === "visit") {
    return (
      <div data-feed-row="visit" className={cn("flex items-center gap-[10px] py-[3px] ps-0.5", slide)}>
        <StreamIcon name="browser" className="size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-[16.25px] text-[var(--stream-fg2)]">{t("threadTimeline.streamVisited")}</div>
          <div className="truncate font-[family-name:var(--stream-mono)] text-[13px] leading-[16.25px] text-[var(--stream-fg)]">{item.url}</div>
        </div>
      </div>
    );
  }
  if (item.kind === "tool") {
    const pending = !full && item.pending;
    return (
      <div data-feed-row="tool" className={cn("flex items-center gap-[10px] py-[3px] ps-0.5", slide)}>
        <StreamIcon name="doc" className={cn("size-4 shrink-0", pending && "stream-pulse")} />
        <div
          className={cn(
            "min-w-0 flex-1 truncate text-[13px] leading-[16.25px]",
            item.failed ? "text-destructive-text" : "text-[var(--stream-fg2)]",
            pending && "stream-pulse",
          )}
        >
          {item.label}
        </div>
      </div>
    );
  }
  if (item.kind === "msg") {
    // grok's `FeedRow` for an agent: its face, its name in bold, its words in
    // the raised bubble (cut to two lines while the feed rolls).
    return (
      <div data-feed-row="msg" className={cn("flex gap-[10px] py-[3px] ps-0.5", slide)}>
        <div className="pt-0.5">
          <StreamSpeakerFace agent={item.agent} size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-[5px] text-[13px] leading-4 font-bold text-[var(--stream-fg2)]">{item.agent.name}</div>
          <div className="rounded-[4px_16px_16px_16px] bg-[var(--stream-raised)] px-[10px] py-[7px]">
            <p className={cn("text-[14px] leading-[19.25px] whitespace-pre-line text-[var(--stream-fg)]", !full && "line-clamp-2")}>{item.text}</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <p data-feed-row="status" className={cn("py-[2px] text-[15px] leading-[22.5px] text-[var(--stream-fg2)]", !full && "stream-status-in")}>
      {item.text}
    </p>
  );
}

/**
 * the reference app's 3 × 3 dot loader (a Lottie on the site): a wave of opacity runs
 * across the grid while the agents are still being called.
 */
export function StreamDotsLoader() {
  const xs = [5.6, 12, 18.4];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" data-stream-dots="" className="size-6" fill="currentColor">
      {xs.flatMap((y, row) =>
        xs.map((x, column) => (
          <circle key={`${row}${column}`} cx={x} cy={y} r={1.6} className="stream-dot" style={{ animationDelay: `${(row + column) * 150}ms` }} />
        )),
      )}
    </svg>
  );
}

/** Four sparks twinkling at the corners of the lead avatar while the agents work. */
function Sparks() {
  const corners: ReadonlyArray<readonly [number, number]> = [[5.6, 5.6], [18.4, 5.6], [5.6, 18.4], [18.4, 18.4]];
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="pointer-events-none absolute -top-[3px] -left-[3px] size-6 text-[var(--stream-fg)]" fill="currentColor">
      {corners.map(([x, y], index) => (
        <circle key={index} cx={x} cy={y} r={1.3} className="stream-twinkle" style={{ animationDelay: `${index * 400}ms`, transformOrigin: `${x}px ${y}px` }} />
      ))}
    </svg>
  );
}

export type StreamAgent = { id: string; avatar: ReactNode };

/**
 * The line above the feed, the reference app's `AgentsHeader`. Before any step:
 * « Réflexion pendant Ns » behind the bulb for a beat (`pre`), then the dot
 * loader with « Les agents réfléchissent • Ns » until the avatars spring in;
 * « Réflexions » while the answer streams; « Réflexion : Ns » once done
 * (hover swaps the bulb for the panel glyph; a click opens the log).
 */
export function StreamAgentsHeader({
  agents,
  started,
  running,
  streaming,
  seconds,
  pre = false,
  open,
  onOpen,
  controls,
  trailing,
}: {
  /** Who has joined so far: the bots of the turn, each with its face. */
  agents: readonly StreamAgent[];
  started: number;
  running: boolean;
  /** The answer is streaming below: « Réflexions ». */
  streaming: boolean;
  /** The run's own duration once it has one. */
  seconds?: number | null;
  pre?: boolean;
  /** The log under the header is open. */
  open?: boolean;
  onOpen?: () => void;
  /** The id of the log the header opens. */
  controls?: string;
  /** After the label: the failures of the turn. */
  trailing?: ReactNode;
}) {
  const { t } = useT();
  const secs = useElapsed(started, running);
  const openable = !running && onOpen !== undefined;
  const joined = agents.length > 0;
  const label = running
    ? pre
      ? t("threadTimeline.streamThinkingFor", { duration: streamDuration(secs) })
      // grok's solo label for one bot; « Les agents réfléchissent » once several have joined.
      : agents.length > 1 ? t("threadTimeline.streamAgentsThinking") : t("threadTimeline.streamThinking")
    : streaming || seconds == null
      // No duration to tell (an old turn without one): « Réflexions », never a made-up « 1s ».
      ? t("threadTimeline.streamThoughts")
      : t("threadTimeline.streamThoughtFor", { duration: streamDuration(seconds) });
  return (
    <button
      type="button"
      data-activity-head=""
      aria-expanded={openable ? open === true : undefined}
      aria-controls={openable ? controls : undefined}
      onClick={openable ? onOpen : undefined}
      className={cn(
        "group flex h-[23px] w-full min-w-0 items-center whitespace-nowrap text-start text-[15px] leading-[22.5px] text-[var(--stream-fg2)] outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        openable ? "cursor-pointer" : "cursor-default",
      )}
    >
      {pre && running ? (
        <span className="me-1 grid size-4 place-items-center">
          <StreamIcon name="bulb" className="size-4" />
        </span>
      ) : running ? (
        <span className="relative me-1.5 flex h-[22px] items-center transition-[width] duration-300" style={{ width: 22 + Math.max(0, agents.length - 1) * 12 }}>
          <span className={cn("absolute inset-y-0 -left-1 flex items-center text-[var(--stream-fg)] transition-opacity duration-150", joined && "opacity-0")}>
            <StreamDotsLoader />
          </span>
          <span className={cn("absolute inset-0 transition-opacity duration-500 ease-out", joined ? "opacity-100" : "opacity-0")}>
            {agents.map((agent, index) => (
              <span
                key={agent.id}
                className="stream-spring absolute top-0 grid size-[22px] place-items-center rounded-full bg-[var(--stream-base)]"
                style={{ left: index * 12, zIndex: 10 - index }}
              >
                <span className="grid size-[18px] place-items-center overflow-hidden rounded-full">{agent.avatar}</span>
                {index === 0 ? <Sparks /> : null}
              </span>
            ))}
          </span>
        </span>
      ) : (
        <span className="relative me-1 grid size-4 place-items-center">
          <StreamIcon name="bulb" className={cn("size-4 transition-opacity duration-150", openable && "group-hover:opacity-0")} />
          {openable ? <StreamIcon name="panel" className="absolute size-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100" /> : null}
        </span>
      )}
      <span data-activity-summary="" className={cn("shrink-0 transition-colors", openable && "group-hover:text-[var(--stream-fg)]")}>{label}</span>
      {running && !pre ? (
        <>
          <span className="mx-1">•</span>
          <span data-thinking-elapsed="" className="tabular-nums">{secs}s</span>
        </>
      ) : null}
      {trailing}
    </button>
  );
}
