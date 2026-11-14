/**
 * Thread lab work block (dev only): four ways to show the narration and the
 * tool calls of one turn, from streaming-ui.pulseview.app/responses.
 *
 * - `fold`: the "Assistant" template, open while live, folded to
 *   "Worked for N s" once done (a failed tool keeps it open).
 * - `feed`: "Agent Activity", a fixed viewport the list glides up through,
 *   folding into a one-line summary.
 * - `chips`: "Tool Chips", one compact row per call with its argument in an
 *   inline chip, under a "N calls, M messages" toggle.
 * - `tasks`: "Task List", each call a task whose title shimmers while it
 *   runs and settles to a check or a cross.
 */
import { Check, ChevronDown, ChevronRight, Sparkles, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@openedbot/browser-ui-kit";
import type { LabActivityPart, LabAssistantTurn, LabToolPart } from "../../../lib/dev/thread-lab-script";
import { toolKindIcon, ToolStateIcon } from "../../thread-tool-state-icon";
import { LabIndicator, type LabIndicatorStyle } from "./lab-indicators";

export type LabActivityStyle = "fold" | "feed" | "chips" | "tasks";

export const LAB_ACTIVITY_STYLES: ReadonlyArray<{ value: LabActivityStyle; label: string }> = [
  { value: "fold", label: "Repli « A travaillé » (Assistant)" },
  { value: "feed", label: "Agent Activity (fenêtre glissante)" },
  { value: "chips", label: "Tool Chips (lignes compactes)" },
  { value: "tasks", label: "Task List (tâches)" },
];

type ActivityProps = {
  turn: LabAssistantTurn;
  live: boolean;
  indicator: LabIndicatorStyle;
};

export function LabActivity({ style, ...props }: ActivityProps & { style: LabActivityStyle }) {
  if (style === "feed") return <FeedActivity {...props} />;
  if (style === "chips") return <ChipsActivity {...props} />;
  if (style === "tasks") return <TasksActivity {...props} />;
  return <FoldActivity {...props} />;
}

export function elapsedSeconds(turn: LabAssistantTurn): number {
  const start = Date.parse(turn.startedAt);
  const end = turn.endedAt ? Date.parse(turn.endedAt) : Date.now();
  return Math.max(1, Math.round((end - start) / 1000));
}

function toolParts(turn: LabAssistantTurn): LabToolPart[] {
  return turn.activity.filter((part): part is LabToolPart => part.kind === "tool");
}

/** What the agent says it is doing, else the tool it runs, else that it thinks. */
function liveLabel(turn: LabAssistantTurn): string {
  if (turn.liveNote) return turn.liveNote;
  const running = toolParts(turn).reverse().find((part) => part.status === "running");
  return running ? `Utilise ${running.tool}` : "Réfléchit";
}

function workedSummary(turn: LabAssistantTurn): string {
  const tools = toolParts(turn).length;
  return `A travaillé ${elapsedSeconds(turn)} s${tools ? ` · ${tools} outil${tools > 1 ? "s" : ""}` : ""}`;
}

/** Open while live, folded once done unless a tool failed; the operator's click wins. */
function useSettledFold(live: boolean, failed: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(true);
  const touched = useRef(false);
  useLayoutEffect(() => {
    if (!live && !touched.current) setOpen(failed);
  }, [live, failed]);
  return [open, () => {
    touched.current = true;
    setOpen((value) => !value);
  }];
}

function hasFailure(turn: LabAssistantTurn): boolean {
  return toolParts(turn).some((part) => part.status === "error");
}

function SummaryToggle({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex w-fit origin-left items-center gap-2 py-1 text-body-2-medium text-text-secondary transition-[color,scale] hover:text-text-primary active:scale-[0.98]"
    >
      {children}
      <ChevronDown className={cn("size-4 transition-transform duration-200", !open && "-rotate-90")} aria-hidden />
    </button>
  );
}

/* ------------------------------------------------------------------ fold */

function FoldActivity({ turn, live, indicator }: ActivityProps) {
  const [open, toggle] = useSettledFold(live, hasFailure(turn));
  return (
    <div className="flex flex-col">
      {live ? (
        <LabIndicator style={indicator} label={liveLabel(turn)} startedAt={turn.startedAt} />
      ) : (
        <SummaryToggle open={open} onToggle={toggle}>{workedSummary(turn)}</SummaryToggle>
      )}
      {open && turn.activity.length > 0 ? (
        <GuideList className="ms-[7px] mt-1">
          {turn.activity.map((part) => <TraceRow key={part.id} part={part} />)}
        </GuideList>
      ) : null}
    </div>
  );
}

/** Pulseview's `AgentLog`: a curved guide strokes into each row. */
function GuideList({ children, className }: { children: ReactNode[]; className?: string }) {
  return (
    <ul className={cn("flex flex-col", className)}>
      {children.map((child, index) => (
        <li key={index} className="relative animate-in ps-4 duration-300 fade-in-0 slide-in-from-bottom-1">
          <span aria-hidden className="absolute inset-y-0 start-0 w-3 text-foreground-icon-quaternary">
            <svg width="12" height="15" viewBox="0 0 12 15" fill="none" className="absolute start-0 top-0">
              <path d="M0.5 0 V8 Q0.5 14 6.5 14 H11.5" stroke="currentColor" />
            </svg>
            {index < children.length - 1 ? <span className="absolute top-2 bottom-0 start-0 w-px bg-current" /> : null}
          </span>
          <div className="py-[3px]">{child}</div>
        </li>
      ))}
    </ul>
  );
}

function TraceRow({ part }: { part: LabActivityPart }) {
  if (part.kind === "narration") return <span className="text-body-2-regular text-text-tertiary">{part.text}</span>;
  return <ToolTraceRow part={part} />;
}

function toolMeta(part: LabToolPart): string | null {
  if (part.status === "error") return "échec";
  return part.durationMs !== null ? `${(part.durationMs / 1000).toFixed(1)} s` : null;
}

function toolOutput(part: LabToolPart): string | null {
  return part.result ?? part.excerpt ?? part.errorMessage;
}

/** Pulseview's `TraceRow`: status icon, name + argument, meta, expandable output. */
function ToolTraceRow({ part }: { part: LabToolPart }) {
  const output = toolOutput(part);
  const [open, setOpen] = useState(false);
  const running = part.status === "running";
  const failed = part.status === "error";
  const meta = toolMeta(part);
  const line = (
    <>
      <span className="grid size-4 shrink-0 place-items-center">
        <ToolStateIcon done={!running} failed={failed} tool={part.tool} />
      </span>
      <span className={cn("min-w-0 truncate", running && "openedbot-agent-label")}>
        <span className="text-text-primary">{part.tool}</span>
        {part.preview ? <span className="ms-1.5 font-mono text-[12.5px]">{part.preview}</span> : null}
      </span>
      {meta ? <span className={cn("shrink-0 tabular-nums", failed ? "text-text-destructive" : "text-text-tertiary")}>{meta}</span> : null}
      {output ? <ChevronRight className={cn("size-3.5 shrink-0 transition-transform duration-200", open && "rotate-90")} aria-hidden /> : null}
    </>
  );
  const rowClass = cn("flex w-fit max-w-full items-center gap-2 text-body-2-regular text-text-secondary", failed && "text-text-destructive");
  return (
    <div>
      {output ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className={cn(rowClass, "transition-colors hover:text-text-primary")}>
          {line}
        </button>
      ) : (
        <div className={rowClass}>{line}</div>
      )}
      {output && open ? <OutputPre text={output} /> : null}
    </div>
  );
}

function OutputPre({ text }: { text: string }) {
  return (
    <pre className="no-scrollbar mt-2 mb-1 max-h-56 animate-in overflow-auto rounded-lg border border-border-button-default bg-background-primary-default px-3 py-2 font-mono text-[12px] leading-5 text-text-secondary duration-200 fade-in-0">
      {text.split("\n").map((line, index) => (
        <div key={index} className={cn(/✓|pass/i.test(line) && "text-emerald-600 dark:text-emerald-400", /✗|fail|error/i.test(line) && "text-text-destructive")}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/* ------------------------------------------------------------------ feed */

/** Pulseview's Agent Activity viewport height. */
const FEED_MAX_PX = 208;

function FeedActivity({ turn, live, indicator }: ActivityProps) {
  const [open, toggle] = useSettledFold(live, hasFailure(turn));
  const list = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(0);

  // The list glides up so its newest row stays in view; a transform, never a scroll.
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setListHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  const overflow = Math.max(0, listHeight - FEED_MAX_PX);
  const capped = live && overflow > 0;
  return (
    <div className="flex flex-col">
      {live ? (
        <LabIndicator style={indicator} label={liveLabel(turn)} startedAt={turn.startedAt} />
      ) : (
        <SummaryToggle open={open} onToggle={toggle}>{workedSummary(turn)}</SummaryToggle>
      )}
      {open && turn.activity.length > 0 ? (
        <div
          className={cn("overflow-hidden", capped && "lab-feed-mask")}
          style={capped ? { height: FEED_MAX_PX } : undefined}
        >
          <div
            ref={list}
            role="list"
            className="flex flex-col gap-0.5 py-2 transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            style={{ transform: capped ? `translateY(-${overflow}px)` : undefined }}
          >
            {turn.activity.map((part) => (
              <div key={part.id} role="listitem" className="animate-in duration-300 fade-in-0 slide-in-from-bottom-2">
                <TraceRow part={part} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- chips */

function ChipsActivity({ turn, live, indicator }: ActivityProps) {
  const [open, setOpen] = useState(true);
  const tools = toolParts(turn).length;
  const notes = turn.activity.length - tools;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-lg px-1.5 py-1 text-body-2-regular text-text-secondary transition-colors hover:bg-background-tertiary-default"
      >
        <ChevronDown className={cn("size-3 transition-transform duration-200", !open && "-rotate-90")} aria-hidden />
        <span className="tabular-nums">
          {tools} appel{tools > 1 ? "s" : ""} d'outil{tools > 1 ? "s" : ""}, {notes} message{notes > 1 ? "s" : ""}
        </span>
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300 motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="-mx-1 overflow-hidden px-1.5 pb-1">
          <div className="mt-1.5 flex flex-col gap-1">
            {turn.activity.map((part) => <ChipRow key={part.id} part={part} />)}
          </div>
        </div>
      </div>
      {live ? <LabIndicator style={indicator} label={liveLabel(turn)} startedAt={turn.startedAt} /> : null}
    </div>
  );
}

function ChipRow({ part }: { part: LabActivityPart }) {
  const [open, setOpen] = useState(false);
  const tool = part.kind === "tool" ? part : null;
  const Icon = tool ? toolKindIcon(tool.tool) : Sparkles;
  const output = tool ? toolOutput(tool) : part.kind === "narration" ? part.text : null;
  const running = tool?.status === "running";
  const failed = tool?.status === "error";
  return (
    <div className="animate-in duration-300 fade-in-0 slide-in-from-bottom-1">
      <button
        type="button"
        aria-expanded={open}
        disabled={!output}
        onClick={() => setOpen((value) => !value)}
        className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-lg px-[3px] text-left transition-colors hover:bg-background-tertiary-default disabled:hover:bg-transparent"
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center text-foreground-icon-tertiary">
          {running || failed ? (
            <ToolStateIcon done={!running} failed={failed} />
          ) : (
            <>
              <Icon className="size-3.5 transition-opacity duration-100 group-hover/row:opacity-0" aria-hidden />
              <ChevronDown
                className={cn("absolute size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover/row:opacity-100", !open && "-rotate-90")}
                aria-hidden
              />
            </>
          )}
        </span>
        <span className={cn("shrink-0 text-body-2-medium text-text-primary", running && "openedbot-agent-label")}>
          {tool ? tool.tool : "Pense"}
        </span>
        <span
          className={cn(
            "min-w-0 truncate rounded-md bg-background-tertiary-default px-1.5 py-0.5 text-caption-1-regular text-text-secondary",
            tool && "font-mono",
          )}
        >
          {tool ? tool.preview ?? tool.tool : part.kind === "narration" ? part.text : ""}
        </span>
        {tool && toolMeta(tool) ? (
          <span className={cn("ms-auto shrink-0 text-caption-1-regular tabular-nums", failed ? "text-text-destructive" : "text-text-tertiary")}>
            {toolMeta(tool)}
          </span>
        ) : null}
      </button>
      {open && output ? (
        <div className="ms-6 mt-1 mb-1.5 border-s border-separator-border ps-3 text-body-2-regular text-text-secondary">
          {tool ? <OutputPre text={output} /> : output}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- tasks */

function TasksActivity({ turn, live, indicator }: ActivityProps) {
  const [open, toggle] = useSettledFold(live, hasFailure(turn));
  const tools = toolParts(turn);
  const done = tools.filter((part) => part.status !== "running").length;
  return (
    <div className="flex flex-col gap-1.5">
      {live ? (
        <LabIndicator style={indicator} label={liveLabel(turn)} startedAt={turn.startedAt} />
      ) : (
        <SummaryToggle open={open} onToggle={toggle}>{workedSummary(turn)}</SummaryToggle>
      )}
      {open && turn.activity.length > 0 ? (
        <div className="overflow-hidden rounded-2lg border border-border-button-default bg-background-primary-default">
          <div className="flex items-center justify-between border-b border-separator-border px-3 py-2 text-caption-1-regular text-text-tertiary">
            <span>Tâches</span>
            <span className="tabular-nums">{done}/{tools.length}</span>
          </div>
          <ul className="flex flex-col">
            {turn.activity.map((part) => (
              <li key={part.id} className="animate-in border-b border-separator-border duration-300 last:border-b-0 fade-in-0 slide-in-from-bottom-1">
                <TaskRow part={part} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function TaskRow({ part }: { part: LabActivityPart }) {
  const [open, setOpen] = useState(false);
  if (part.kind === "narration") {
    return <p className="px-3 py-2 ps-10 text-body-2-regular text-text-tertiary">{part.text}</p>;
  }
  const running = part.status === "running";
  const failed = part.status === "error";
  const output = toolOutput(part);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        disabled={!output}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-background-primary-hover disabled:hover:bg-transparent"
      >
        <span
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded-full border",
            running && "border-border-button-hover",
            !running && !failed && "border-transparent bg-text-primary text-background-primary-default",
            failed && "border-transparent bg-text-destructive text-white",
          )}
        >
          {running ? <ToolStateIcon done={false} failed={false} /> : failed ? <X className="size-3" aria-hidden /> : <Check className="size-3 animate-in duration-200 zoom-in-50" aria-hidden />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate text-body-2-medium text-text-primary", running && "openedbot-agent-label")}>{part.tool}</span>
          {part.preview ? <span className="truncate font-mono text-caption-1-regular text-text-tertiary">{part.preview}</span> : null}
        </span>
        {toolMeta(part) ? (
          <span className={cn("shrink-0 text-caption-1-regular tabular-nums", failed ? "text-text-destructive" : "text-text-tertiary")}>{toolMeta(part)}</span>
        ) : null}
      </button>
      {open && output ? <div className="px-3 pb-2 ps-11"><OutputPre text={output} /></div> : null}
    </div>
  );
}
