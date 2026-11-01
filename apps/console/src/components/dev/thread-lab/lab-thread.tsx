/**
 * Thread lab prototype thread (dev only): the "Assistant" template of
 * streaming-ui.pulseview.app/templates (plain assistant text, a work block
 * that folds to "Worked for Ns" once done, an action row, follow-ups) read
 * from the same product events as `ThreadTimeline` through `deriveLabTurns`.
 *
 * Each slot of a turn (working indicator, work block, answer text) takes one
 * of several approaches from streaming-ui.pulseview.app/responses
 * (`LabResponseStyle`). The markdown stays the console's own
 * (`threadMarkdownSetup`), so the comparison is about layout and motion.
 */
import { ArrowDown, Check, Copy, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import { isLabRunLive, type LabAssistantTurn, type LabTurn } from "../../../lib/dev/thread-lab-script";
import { elapsedSeconds, LabActivity, type LabActivityStyle } from "./lab-activity";
import { LabAnswer, type LabTextMode } from "./lab-answer";
import type { LabIndicatorStyle } from "./lab-indicators";

/** The approach picked for each slot of an assistant turn. */
export type LabResponseStyle = {
  indicator: LabIndicatorStyle;
  activity: LabActivityStyle;
  text: LabTextMode;
};

/** Distance to the bottom under which the thread keeps following the stream. */
const PIN_SLACK_PX = 24;

export function LabThread({
  turns,
  responseStyle,
  centered,
  followUps,
  starters,
  onPick,
  onRegenerate,
}: {
  turns: readonly LabTurn[];
  responseStyle: LabResponseStyle;
  /** Pulseview's centered `max-w-3xl` column instead of the console's full width. */
  centered: boolean;
  followUps: readonly string[];
  starters: readonly string[];
  onPick: (text: string) => void;
  onRegenerate: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // Follow the live edge only while the reader is already there.
  useEffect(() => {
    const node = content.current;
    const viewport = scroller.current;
    if (!node || !viewport) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (!pinned.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight;
      });
    });
    observer.observe(node);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const onScroll = () => {
    const viewport = scroller.current;
    if (!viewport) return;
    const bottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= PIN_SLACK_PX;
    pinned.current = bottom;
    setAtBottom(bottom);
  };

  const toBottom = () => {
    const viewport = scroller.current;
    if (!viewport) return;
    pinned.current = true;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  };

  const last = turns[turns.length - 1]?.assistant ?? null;
  const settled = last !== null && !isLabRunLive(last.status);
  const column = centered ? "mx-auto w-full max-w-3xl" : "w-full";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} role="log" aria-label="Fil prototype" className="min-h-0 flex-1 overflow-y-auto">
        <div ref={content} className={cn("flex flex-col gap-6 px-4 pt-5 pb-8 sm:px-6", column, turns.length === 0 && "min-h-full justify-center")}>
          {turns.length === 0 ? (
            <LabWelcome starters={starters} onPick={onPick} />
          ) : (
            turns.map((turn, index) => (
              <div key={turn.user.id} className="flex flex-col gap-4">
                <LabUserBubble text={turn.user.text} />
                {turn.assistant ? (
                  <LabAssistant
                    turn={turn.assistant}
                    responseStyle={responseStyle}
                    isLast={index === turns.length - 1}
                    onRegenerate={onRegenerate}
                  />
                ) : null}
              </div>
            ))
          )}
          {settled && last?.answer && followUps.length > 0 ? <LabSuggestions items={followUps} onPick={onPick} /> : null}
        </div>
      </div>
      <button
        type="button"
        aria-label="Aller en bas"
        onClick={toBottom}
        className={cn(
          "absolute bottom-3 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-border-button-default bg-background-primary-default text-foreground-icon-secondary shadow-dropdown transition-[opacity,translate] duration-200 hover:text-foreground-icon-primary",
          atBottom ? "pointer-events-none translate-y-1 opacity-0" : "opacity-100",
        )}
      >
        <ArrowDown className="size-4" aria-hidden />
      </button>
    </div>
  );
}

function LabWelcome({ starters, onPick }: { starters: readonly string[]; onPick: (text: string) => void }) {
  return (
    <div className="flex animate-in flex-col items-center gap-4 text-center duration-300 fade-in-0 slide-in-from-bottom-1">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-title-2-medium tracking-[-0.01em] text-text-primary">Que voulez-vous tester ?</h2>
        <p className="text-body-regular text-text-secondary">Chaque scénario rejoue les mêmes événements que le worker.</p>
      </div>
      <LabSuggestions items={starters} onPick={onPick} className="justify-center" />
    </div>
  );
}

function LabSuggestions({ items, onPick, className }: { items: readonly string[]; onPick: (text: string) => void; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {items.map((item, index) => (
        <button
          key={item}
          type="button"
          onClick={() => onPick(item)}
          style={{ animationDelay: `${index * 60}ms` }}
          className="animate-in rounded-full bg-background-primary-default px-3.5 py-2 text-body-2-medium text-text-secondary shadow-xs transition-colors duration-300 fill-mode-both fade-in-0 slide-in-from-bottom-1 hover:bg-background-primary-hover hover:text-text-primary"
        >
          {item}
        </button>
      ))}
    </div>
  );
}

const LabUserBubble = memo(function LabUserBubble({ text }: { text: string }) {
  return (
    <div className="grid animate-in grid-cols-[minmax(72px,1fr)_auto] duration-200 fade-in-0 slide-in-from-bottom-1">
      <div className="col-start-2 max-w-[min(520px,100%)] rounded-2xl bg-background-primary-default px-3.5 py-[11px] text-body-regular leading-6 break-words whitespace-pre-wrap text-text-primary shadow-card">
        {text}
      </div>
    </div>
  );
});

function LabAssistant({
  turn,
  responseStyle,
  isLast,
  onRegenerate,
}: {
  turn: LabAssistantTurn;
  responseStyle: LabResponseStyle;
  isLast: boolean;
  onRegenerate: () => void;
}) {
  const live = isLabRunLive(turn.status);
  return (
    <div className="group/message flex min-w-0 flex-col gap-3">
      {turn.activity.length > 0 || (live && !turn.answer) ? (
        <LabActivity style={responseStyle.activity} indicator={responseStyle.indicator} turn={turn} live={live} />
      ) : null}
      {turn.answer ? <LabAnswer text={turn.answer} live={live} mode={responseStyle.text} /> : null}
      {turn.errorMessage ? (
        <p role="alert" className="rounded-2lg border border-border-button-default bg-background-primary-default px-3 py-2 text-body-2-regular text-text-destructive">
          {turn.errorMessage}
        </p>
      ) : null}
      {turn.cancelled ? <p className="text-body-2-regular text-text-tertiary">Arrêté.</p> : null}
      {!live && turn.answer ? <LabActionBar text={turn.answer} isLast={isLast} model={turn.model} turn={turn} onRegenerate={onRegenerate} /> : null}
    </div>
  );
}

function LabActionBar({
  text,
  isLast,
  model,
  turn,
  onRegenerate,
}: {
  text: string;
  isLast: boolean;
  model: string | null;
  turn: LabAssistantTurn;
  onRegenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const icon = "grid size-7 place-items-center rounded-md text-foreground-icon-secondary transition-colors hover:bg-background-tertiary-default hover:text-foreground-icon-primary data-[active]:text-text-primary";
  return (
    <div className={cn("-ms-1 flex items-center gap-0.5 pt-1 transition-opacity duration-200", !isLast && "opacity-0 group-hover/message:opacity-100 focus-within:opacity-100")}>
      <button
        type="button"
        aria-label={copied ? "Copié" : "Copier"}
        className={icon}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? <Check className="size-4 animate-in duration-200 fade-in-0 zoom-in-50" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      </button>
      <button type="button" aria-label="Bonne réponse" data-active={vote === "up" ? "" : undefined} className={icon} onClick={() => setVote((value) => (value === "up" ? null : "up"))}>
        <ThumbsUp className="size-4" aria-hidden />
      </button>
      <button type="button" aria-label="Mauvaise réponse" data-active={vote === "down" ? "" : undefined} className={icon} onClick={() => setVote((value) => (value === "down" ? null : "down"))}>
        <ThumbsDown className="size-4" aria-hidden />
      </button>
      {isLast ? (
        <button type="button" aria-label="Régénérer" className={icon} onClick={onRegenerate}>
          <RefreshCw className="size-4" aria-hidden />
        </button>
      ) : null}
      <span className="ms-2 text-caption-1-regular text-text-tertiary tabular-nums">
        {elapsedSeconds(turn)} s{model ? ` · ${model}` : ""}
      </span>
    </div>
  );
}
