import { useState } from "react";
import { ChevronDown, Globe, X } from "lucide-react";
import { cn } from "@openedbot/browser-ui-kit";
import { useT } from "../../lib/i18n";
import { StreamIcon } from "./stream-icons";
import { StreamFavicon, streamSite, StreamSpeakerFace, type StreamFeedItem, type StreamSpeaker } from "./stream-feed";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";
import { RunDebugSection } from "../dev/run-debug";

/*
 * the reference app's right panel, « Réflexions » (the streaming-ui template:
 * `SidePanel`, `PanelGroup`, `PanelRow`, `PanelBubble`): a turn's whole log,
 * one group per run of the same speaker. It opens in the thread's canvas
 * (`attachment-canvas.tsx`, `openPanel`), beside the conversation.
 */

/** A message folds to six lines past this many characters (grok's `PanelBubble`). */
const LONG_MESSAGE = 280;

type Group = { agent: StreamSpeaker | null; items: StreamFeedItem[] };

/** Réflexions keeps the log's order: a new group each time the speaker changes. */
export function thoughtGroups(items: readonly StreamFeedItem[], speaker: StreamSpeaker | null): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const who = item.kind === "msg" ? item.agent : speaker;
    const last = groups[groups.length - 1];
    if (last && last.agent?.id === who?.id) last.items.push(item);
    else groups.push({ agent: who, items: [item] });
  }
  return groups;
}

const ROW_ICON = "relative grid size-5 shrink-0 place-items-center text-[var(--stream-fg2)]";

/** A search or a page: the label over the query (italic) or the url; a search unfolds into the pages it found. */
function PanelRow({ item }: { item: Extract<StreamFeedItem, { kind: "search" | "visit" }> }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const search = item.kind === "search";
  const sources = search ? item.sources ?? [] : [];
  const unfolds = sources.length > 0;
  return (
    <div data-thoughts-row={item.kind}>
      <button
        type="button"
        disabled={!unfolds}
        aria-expanded={unfolds ? open : undefined}
        onClick={() => setOpen((value) => !value)}
        className="group/srow flex w-full items-center gap-2 px-1 py-1.5 text-start disabled:cursor-default"
      >
        <span className={ROW_ICON}>
          <Globe className={cn("size-3.5 transition-opacity duration-150", unfolds && (open ? "opacity-0" : "group-hover/srow:opacity-0"))} strokeWidth={2} />
          {unfolds ? (
            <ChevronDown className={cn("absolute size-3.5 transition-all duration-150", open ? "rotate-180 opacity-100" : "opacity-0 group-hover/srow:opacity-100")} strokeWidth={2} />
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] leading-[19.5px] text-[var(--stream-fg2)]">
            {search ? t("threadTimeline.streamSearched") : t("threadTimeline.streamVisited")}
          </span>
          <span className={cn("line-clamp-1 text-[14px] leading-[21px] font-medium text-[var(--stream-fg)]", search && "italic")}>
            {search ? item.query : item.url}
          </span>
        </span>
        {search ? (
          <span className="shrink-0 rounded border border-[var(--stream-line)] px-1.5 py-0.5 font-[family-name:var(--stream-mono)] text-[13px] leading-[19.5px] tabular-nums text-[var(--stream-fg2)]">
            {item.results}
          </span>
        ) : null}
      </button>
      {open && unfolds ? (
        <div className="stream-enter ms-7 mb-2 overflow-hidden rounded-xl border border-[var(--stream-line)]">
          {sources.map((source, index) => (
            <a
              key={`${source.url}:${index}`}
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              className={cn("block px-3 py-2.5 transition-colors hover:bg-[var(--stream-hover)]", index > 0 && "border-t border-[var(--stream-line)]")}
            >
              <span className="line-clamp-2 text-[14px] leading-[20px] font-[550] text-[var(--stream-fg)]">{source.title || source.domain}</span>
              <span className="mt-1.5 flex items-center gap-1.5 text-[13px] leading-4 text-[var(--stream-fg2)]">
                <StreamFavicon site={streamSite(source.domain)} size={14} />
                {source.domain}
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** An agent's message: its bubble, folded to six lines behind « Afficher plus ». */
function PanelBubble({ text }: { text: string }) {
  const { t } = useT();
  const [more, setMore] = useState(false);
  const long = text.length > LONG_MESSAGE;
  return (
    <div data-thoughts-row="msg" className="my-1 ms-7 rounded-[4px_16px_16px_16px] bg-[var(--stream-raised)] px-[10px] py-[7px]">
      <p className={cn("text-[14px] leading-[19.25px] whitespace-pre-line text-[var(--stream-fg)]", long && !more && "line-clamp-6")}>{text}</p>
      {long ? (
        <button type="button" onClick={() => setMore((value) => !value)} className="mt-1 text-[13px] font-medium text-[var(--stream-fg2)] hover:text-[var(--stream-fg)]">
          {more ? t("threadTimeline.streamShowLess") : t("threadTimeline.streamShowMore")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A tool call, which grok has no row for: the bulb row's shape with the
 * document glyph and the masked label; a failure reads in the danger ink,
 * and the call's error or output unfolds in a mono card, never in the label.
 */
function PanelTool({ item }: { item: Extract<StreamFeedItem, { kind: "tool" }> }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const unfolds = Boolean(item.detail);
  return (
    <div data-thoughts-row="tool" data-failed={item.failed ? "" : undefined}>
      <button
        type="button"
        disabled={!unfolds}
        aria-expanded={unfolds ? open : undefined}
        onClick={() => setOpen((value) => !value)}
        className="group/trow flex w-full items-center gap-2 px-1 py-1.5 text-start disabled:cursor-default"
      >
        <span className={ROW_ICON}>
          <StreamIcon name="doc" className={cn("size-3.5 transition-opacity duration-150", unfolds && (open ? "opacity-0" : "group-hover/trow:opacity-0"))} />
          {unfolds ? (
            <ChevronDown className={cn("absolute size-3.5 transition-all duration-150", open ? "rotate-180 opacity-100" : "opacity-0 group-hover/trow:opacity-100")} strokeWidth={2} />
          ) : null}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[14px] leading-[21px]", item.failed ? "text-destructive-text" : "text-[var(--stream-fg)]")}>{item.label}</span>
        {item.failed ? <span className="shrink-0 text-[13px] leading-[19.5px] text-destructive-text">{t("threadTimeline.streamFailed")}</span> : null}
      </button>
      {open && item.detail ? (
        <pre className="stream-enter ms-7 mb-2 max-h-60 overflow-auto rounded-xl border border-[var(--stream-line)] bg-[var(--stream-side)] px-3 py-2.5 font-[family-name:var(--stream-mono)] text-[12px] leading-[18px] whitespace-pre-wrap break-words text-[var(--stream-fg2)]">
          {item.detail}
        </pre>
      ) : null}
    </div>
  );
}

function PanelItem({ item }: { item: StreamFeedItem }) {
  if (item.kind === "search" || item.kind === "visit") return <PanelRow item={item} />;
  if (item.kind === "msg") return <PanelBubble text={item.text} />;
  if (item.kind === "tool") return <PanelTool item={item} />;
  return (
    <div data-thoughts-row="status" className="flex items-center gap-2 px-1 py-1.5 text-[14px] leading-[21px] text-[var(--stream-fg)]">
      <span className={ROW_ICON}>
        <StreamIcon name="bulb" className="size-3.5" />
      </span>
      {item.text}
    </div>
  );
}

function PanelGroup({ group }: { group: Group }) {
  const [open, setOpen] = useState(true);
  return (
    <section data-thoughts-group="" className="pb-2">
      {group.agent ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-1 py-2 text-start">
          <StreamSpeakerFace agent={group.agent} size={14} />
          <span className="flex-1 text-[13px] leading-[19.5px] font-[550] text-[var(--stream-fg)]">{group.agent.name}</span>
          <ChevronDown className={cn("size-3.5 text-[var(--stream-fg2)] transition-transform", open && "rotate-180")} strokeWidth={2} />
        </button>
      ) : null}
      {open ? group.items.map((item) => <PanelItem key={item.id} item={item} />) : null}
    </section>
  );
}

/** The panel itself: a 64 px header (the bot's face, « Réflexions », close), then the groups. */
export function StreamThoughtsPanel({ items, speaker, onClose, calls = [] }: {
  items: readonly StreamFeedItem[];
  speaker: StreamSpeaker | null;
  onClose: () => void;
  /** The turn's raw tool calls, for the dev-only debug section. */
  calls?: readonly ToolCall[];
}) {
  const { t } = useT();
  return (
    <div data-thoughts-panel="" className="flex h-full min-h-0 w-full flex-col bg-[var(--stream-base)] text-[var(--stream-fg)]">
      <div className="flex h-16 shrink-0 items-center gap-2 ps-4 pe-3">
        {speaker ? (
          <span className="grid size-[22px] place-items-center rounded-full bg-[var(--stream-base)]">
            <StreamSpeakerFace agent={speaker} size={18} />
          </span>
        ) : null}
        <span className="flex-1 text-[15px] leading-[22.5px] font-[550]">{t("threadTimeline.streamThoughts")}</span>
        <button
          type="button"
          aria-label={t("threadTimeline.streamClose")}
          onClick={onClose}
          className="grid size-8 shrink-0 place-items-center rounded-full text-[var(--stream-fg2)] outline-none transition-colors hover:bg-[var(--stream-hover)] hover:text-[var(--stream-fg)] focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        >
          <X className="size-[18px]" />
        </button>
      </div>
      <div className="stream-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {thoughtGroups(items, speaker).map((group, index) => <PanelGroup key={`${group.agent?.id ?? "log"}:${index}`} group={group} />)}
        <RunDebugSection calls={calls} />
      </div>
    </div>
  );
}
