import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, CircleCheck, Copy, Loader2, Maximize2, Search, X } from "lucide-react";
import { RollText, cn } from "@openedbot/browser-ui-kit";
import type { ApprovalRequestDto } from "@openedbot/contracts-api";
import type { WebSearchQuery } from "@openedbot/execution/domain/agent-web-search";
import {
  formatToolDuration,
  isToolLogCut,
  toolFailureSummary,
  toolGroupLog,
  toolGroupLogText,
  toolGroupPreviews,
  toolGroupStatus,
  toolLabel,
  type ToolGroup,
  type ToolGroupStatus,
} from "@openedbot/conversation/domain/thread-tools";
import { useT } from "../lib/i18n";
import { usePrefersReducedMotion } from "../lib/platform/use-reduced-motion";
import { ActivityDisclosure } from "./activity-disclosure";
import { SearchSources } from "./thread-search-sources";
import { partialFailureLabel } from "./thread-tool-labels";
import { ToolInspectDialog } from "./thread-tool-inspect";
import { toolKindIcon } from "./thread-tool-state-icon";

/** A completed call folds its panel away this long after it completes (pulseview `finish()`). */
export const TOOL_RESULT_FOLD_DELAY_MS = 900;
/**
 * A closed panel keeps its log lines this long, so the 140 ms close animation
 * (`agent-activity.css`) still shows them, then drops them from the DOM.
 */
const LOG_UNMOUNT_DELAY_MS = 160;
/** How long "Copied" stays on the copy button. */
const COPY_FEEDBACK_MS = 1600;
/** Within this distance of the bottom, the log keeps following new lines. */
const FOLLOW_SLACK_PX = 24;

const STATUS_TONE: Record<ToolGroupStatus, string> = {
  running: "text-info-700",
  done: "text-pos-700",
  failed: "text-destructive-text",
  partial: "text-warn-700",
};

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

function StatusGlyph({ status }: { status: ToolGroupStatus }) {
  if (status === "running") return <Loader2 aria-hidden className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />;
  if (status === "failed") return <X aria-hidden className="size-3 shrink-0" />;
  if (status === "partial") return <AlertTriangle aria-hidden className="size-3 shrink-0" />;
  return <CircleCheck aria-hidden className="size-3 shrink-0" />;
}

/**
 * One tool step of the Agent Activity feed, as component 12 "Tool Result" of
 * streaming-ui.pulseview.app, on BoardUI tokens: a full-width trigger (glyph,
 * title, meta, technical name, rolled status, chevron) over a panel whose log
 * follows itself while the call runs, then folds away 900 ms after the call
 * completes.
 *
 * What the panel shows is what the runtime sent, never a simulation: the
 * command (`tool.call.preview`), the bounded output excerpt of
 * `tool.result`, then the full result attached at the end of the run. A
 * group (`terminal ×7`) appends each call to the same log, which is why it
 * scrolls and follows. A failure stays open on its error: openedbot's rule is that
 * an error reads without a click. The operator's click always wins over the
 * automatic open and fold.
 *
 * A web search tells what it searched and what it found: its query stays in
 * the meta once the call completes (next to its duration), and the panel
 * lists its sources instead of the raw JSON.
 */
export const ToolResult = memo(function ToolResult({
  group,
  searches,
  approvals,
  onSeeBotErrors,
}: {
  group: ToolGroup;
  /** The queries this group ran (`pairWebSearchCalls`), in call order. */
  searches?: readonly WebSearchQuery[];
  /** Decisions tied to these calls: the detail dialog counts their wait. */
  approvals: readonly ApprovalRequestDto[];
  onSeeBotErrors?: () => void;
}) {
  const { t, locale, plural, formatNumber } = useT();
  const reducedMotion = usePrefersReducedMotion();
  const status = toolGroupStatus(group);
  const lines = useMemo(() => toolGroupLog(group, locale), [group, locale]);
  const hasLog = lines.length > 0;
  const logCut = isToolLogCut(lines);
  const needsEye = status === "failed" || status === "partial";
  const found = searches?.filter((query) => query.sources.length > 0 || query.error !== null) ?? [];
  const hasPanel = hasLog || found.length > 0;

  const [autoOpen, setAutoOpen] = useState(() => hasPanel && (status === "running" || needsEye));
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [folding, setFolding] = useState(false);
  const previousStatus = useRef(status);
  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = status;
    if (status === "running" || needsEye) {
      setFolding(false);
      if (hasPanel) setAutoOpen(true);
    } else if (previous === "running") {
      // Output that arrives only with the completion (no preview while it
      // ran) is still read before the fold.
      if (hasPanel) setAutoOpen(true);
      setFolding(true);
    }
  }, [status, needsEye, hasPanel]);
  useEffect(() => {
    if (!folding) return;
    const timer = window.setTimeout(() => {
      setAutoOpen(false);
      setFolding(false);
    }, TOOL_RESULT_FOLD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [folding]);
  const open = userOpen ?? autoOpen;

  // A folded panel holds no log lines: every past turn keeps its Tool Results
  // mounted (folded, `inert`), and up to TOOL_LOG_MAX_LINES lines each would
  // swell the thread's node count (OHB-88). The lines mount with the open and
  // leave once the close animation has played.
  const [linesMounted, setLinesMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setLinesMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setLinesMounted(false), LOG_UNMOUNT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [open]);
  const showLines = open || linesMounted;

  // The log follows its last line while the operator has not scrolled up.
  // The scroll runs in a frame, after the commit: no geometry read during it.
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastTop = useRef(0);
  // A cut log keeps its length: the hidden count still moves as lines arrive.
  const logSignature = `${lines.length}:${lines.find((line) => line.hidden !== undefined)?.hidden ?? 0}:${lines.at(-1)?.text ?? ""}`;
  useEffect(() => {
    if (!open || !follow.current) return;
    const frame = window.requestAnimationFrame(() => {
      const node = viewport.current;
      if (!node) return;
      const top = node.scrollHeight;
      if (typeof node.scrollTo === "function") node.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
      else node.scrollTop = top;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [logSignature, open, reducedMotion]);
  const onLogScroll = () => {
    const node = viewport.current;
    if (!node) return;
    const top = node.scrollTop;
    // A smooth scroll toward the bottom only ever raises `scrollTop`: only a
    // move up is the operator taking the log back.
    if (node.scrollHeight - top - node.clientHeight <= FOLLOW_SLACK_PX) follow.current = true;
    else if (top < lastTop.current) follow.current = false;
    lastTop.current = top;
  };

  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (copy === "idle") return;
    const timer = window.setTimeout(() => setCopy("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copy]);
  const onCopy = () => {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      setCopy("failed");
      return;
    }
    // The whole log, not the panel's excerpt: built on the click, from what
    // the thread already holds, so a render never pays for the uncut text.
    clipboard.writeText(toolGroupLogText(group, locale)).then(() => setCopy("done"), () => setCopy("failed"));
  };
  const copyLabel = logCut ? t("threadTimeline.toolResultCopyFull") : t("threadTimeline.toolResultCopy");
  const [inspecting, setInspecting] = useState(false);

  const human = toolLabel(locale, group.tool);
  const title = human ?? group.tool;
  const reason = toolFailureSummary(group);
  const previews = toolGroupPreviews(group);
  const statusText = status === "partial"
    ? partialFailureLabel(t, plural, group.failures ?? 0, group.count)
    : status === "failed"
      ? t("threadTimeline.toolStatusFailed")
      : status === "done"
        ? t("threadTimeline.toolStatusDone")
        : t("threadTimeline.toolStatusRunning");
  // The meta rolls to its final value with the status: the command while it
  // runs, then how long it took, or why it failed.
  const searched = searches?.at(-1)?.query ?? null;
  const duration = typeof group.durationMs === "number" ? formatToolDuration(group.durationMs, formatNumber) : null;
  const meta = reason
    ?? (searched !== null
      ? status !== "running" && duration !== null ? `${searched} · ${duration}` : searched
      : null)
    ?? (status === "running"
      ? firstLine(previews.at(-1) ?? "")
      : typeof group.durationMs === "number"
        ? formatToolDuration(group.durationMs, formatNumber)
        : firstLine(previews.at(-1) ?? ""));
  const Icon = toolKindIcon(group.tool);
  const panelId = useId();

  return (
    <div
      data-tool-result=""
      data-state={status}
      aria-busy={status === "running"}
      className="w-full min-w-0 text-body-regular"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setUserOpen(!open)}
        className="group flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <span aria-hidden className="grid size-4 shrink-0 place-items-center text-text-tertiary">
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className={cn("min-w-0 truncate font-medium text-text-primary", !human && "font-mono text-[13px]")}>{title}</span>
          {meta ? (
            <span
              data-tool-meta=""
              data-tool-failure-reason={reason ? "" : undefined}
              title={reason ? group.errorMessages?.find((message) => message.trim() !== "") : undefined}
              className={cn("min-w-0 truncate text-xs", reason ? "text-destructive-text" : "text-text-tertiary")}
            >
              <RollText value={meta} />
            </span>
          ) : null}
          {human || group.count > 1 ? (
            <span data-tool-name="" className="min-w-0 shrink-0 truncate font-mono text-[11px] text-text-tertiary">
              {human ? group.tool : null}
              {group.count > 1 ? <span className="font-semibold tabular-nums text-text-secondary">{human ? " " : ""}×{group.count}</span> : null}
            </span>
          ) : null}
        </span>
        <span
          data-tool-status=""
          data-tool-partial-failure={status === "partial" ? "" : undefined}
          className={cn("inline-flex shrink-0 items-center gap-1 text-[11px] font-medium", STATUS_TONE[status])}
        >
          <StatusGlyph status={status} />
          <RollText value={statusText} />
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "ohb-activity-chevron size-3.5 shrink-0 text-text-tertiary group-hover:text-text-secondary",
            open && "rotate-180",
          )}
        />
      </button>
      <ActivityDisclosure open={open} id={panelId}>
        <div className="ps-[26px] pt-1.5">
          <div className="overflow-hidden rounded-xl bg-background-tertiary-default">
            {found.length > 0 ? (
              <div data-tool-search="" className="space-y-1 px-1.5 py-2">
                {found.map((query) => (
                  <div key={query.id} className="min-w-0">
                    {found.length > 1 ? (
                      <p className="flex min-h-7 min-w-0 items-center gap-2.5 px-1.5 text-xs text-text-secondary">
                        <Search aria-hidden strokeWidth={1.7} className="size-3.5 shrink-0 text-text-tertiary" />
                        <span data-search-query="" className="min-w-0 truncate">{query.query}</span>
                      </p>
                    ) : null}
                    {showLines ? <SearchSources query={query} className="ps-0" /> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div
                ref={viewport}
                data-tool-result-log=""
                role="region"
                aria-label={t("threadTimeline.toolResultLog", { tool: title })}
                // Focusable: a keyboard reader scrolls the log with the arrows.
                tabIndex={0}
                onScroll={onLogScroll}
                className="ohb-tool-log no-scrollbar overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus-ring"
              >
                <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-text-secondary">
                  {hasLog ? (showLines ? lines.map((line, index) => (
                    <span
                      // Lines only ever append: their index is their identity.
                      key={index}
                      data-tool-log-line={line.tone}
                      data-tool-error-inline={line.tone === "error" ? "" : undefined}
                      data-tool-log-hidden={line.hidden !== undefined ? String(line.hidden) : undefined}
                      className={cn(
                        "block min-h-5",
                        line.tone === "command" && "text-text-primary",
                        line.tone === "error" && "text-destructive-text",
                        line.hidden !== undefined && "my-1 border-y border-dashed border-border-table text-center italic text-text-tertiary",
                      )}
                    >
                      {line.text}
                    </span>
                  )) : null) : (
                    <span className="block italic text-text-tertiary">{t("threadTimeline.toolErrorUnknown")}</span>
                  )}
                </pre>
              </div>
            )}
            <div className="flex items-center gap-0.5 px-2 pb-1.5">
              <button
                type="button"
                data-tool-copy={copy}
                aria-label={copy === "done" ? t("threadTimeline.toolResultCopied") : copy === "failed" ? t("threadTimeline.toolResultCopyFailed") : copyLabel}
                title={copyLabel}
                onClick={onCopy}
                disabled={!hasLog}
                className="grid size-7 place-items-center rounded-md text-text-tertiary outline-none transition-[color,background-color,transform] duration-150 hover:bg-background-tertiary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring active:scale-90 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                {copy === "done" ? <Check aria-hidden className="size-3.5" /> : copy === "failed" ? <X aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
              </button>
              <button
                type="button"
                data-tool-inspect=""
                aria-label={t("threadTimeline.toolInspectOpen", { tool: title })}
                title={t("threadTimeline.toolInspectOpen", { tool: title })}
                onClick={() => setInspecting(true)}
                className="grid size-7 place-items-center rounded-md text-text-tertiary outline-none transition-[color,background-color,transform] duration-150 hover:bg-background-tertiary-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                <Maximize2 aria-hidden className="size-3.5" />
              </button>
              <span aria-hidden className={cn("ms-auto text-[11px]", status === "running" ? "text-text-tertiary" : STATUS_TONE[status])}>
                <RollText value={statusText} />
              </span>
            </div>
          </div>
        </div>
      </ActivityDisclosure>
      {inspecting ? (
        <ToolInspectDialog
          group={group}
          label={title}
          approvals={approvals}
          onSeeBotErrors={onSeeBotErrors}
          open
          onClose={() => setInspecting(false)}
        />
      ) : null}
    </div>
  );
});
