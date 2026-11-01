import type { ApprovalRequestDto } from "@openedbot/contracts-api";
import { Dialog } from "@openedbot/browser-ui-kit";
import {
  approvalWaitMs,
  formatToolDuration,
  parseToolResult,
  toolGroupStatus,
  toolInputLanguage,
  type ParsedToolResult,
  type ToolAttachment,
  type ToolCall,
  type ToolGroup,
} from "@openedbot/conversation/domain/thread-tools";
import { useT } from "../lib/i18n";
import { CodeBlock } from "./thread-markdown";
import { BUTTON } from "./settings/primitives";
import { ToolStateIcon } from "./thread-tool-state-icon";

export function ToolInspectDialog({
  group,
  label,
  approvals,
  open,
  onClose,
  onSeeBotErrors,
}: {
  group: ToolGroup;
  label: string;
  approvals: readonly ApprovalRequestDto[];
  open: boolean;
  onClose: () => void;
  onSeeBotErrors?: () => void;
}) {
  const { t, plural, formatNumber } = useT();
  const status = toolGroupStatus(group);
  const failures = group.failures ?? (group.failed ? group.count : 0);
  const statusText = status === "partial"
    ? plural(failures, {
        one: t("threadTimeline.toolPartialFailure_one", { count: failures, total: group.count }),
        other: t("threadTimeline.toolPartialFailure_other", { count: failures, total: group.count }),
      })
    : status === "failed"
      ? t("threadTimeline.toolFailed")
      : status === "done"
        ? t("threadTimeline.toolDone")
        : t("threadTimeline.toolRunning");
  const waitMs = approvalWaitMs({ approvals });
  const calls = group.calls;
  const detailCalls = calls.length > 0 ? calls : [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={label}
      description={plural(group.count, {
        one: t("threadTimeline.toolInspectCount_one", { count: group.count, tool: group.tool }),
        other: t("threadTimeline.toolInspectCount_other", { count: group.count, tool: group.tool }),
      })}
      closeLabel={t("common.close")}
      className="max-w-3xl"
      footer={(
        <div className="flex flex-wrap justify-end gap-2">
          {onSeeBotErrors ? (
            <button
              type="button"
              className={BUTTON.secondary}
              onClick={() => {
                onClose();
                onSeeBotErrors();
              }}
            >
              {t("threadTimeline.toolInspectBotErrors")}
            </button>
          ) : null}
          <button type="button" className={BUTTON.primary} onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-3 text-sm">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <ToolStateIcon
            done={group.done}
            failed={status === "failed"}
            partial={status === "partial"}
            tool={group.tool}
          />
          {statusText}
        </span>
        {typeof group.durationMs === "number" ? (
          <span className="tabular-nums">{formatToolDuration(group.durationMs, formatNumber)}</span>
        ) : null}
        {waitMs !== null ? (
          <span className="text-muted-foreground">
            {t("threadTimeline.toolInspectApprovalWait", { duration: formatToolDuration(waitMs, formatNumber) })}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex max-h-[60vh] flex-col gap-4 overflow-y-auto pe-1">
        {detailCalls.map((call, index) => (
          <ToolCallDetail key={`${group.tool}:${index}`} call={call} tool={group.tool} index={index} count={group.count} />
        ))}
        {detailCalls.length === 0 ? <p className="text-sm text-muted-foreground">{t("threadTimeline.toolInspectEmpty")}</p> : null}
      </div>
    </Dialog>
  );
}

function ToolCallDetail({ call, tool, index, count }: {
  call: ToolCall;
  tool: string;
  index: number;
  count: number;
}) {
  const { t } = useT();
  const attachment = call.attachment && !("ambiguous" in call.attachment) ? call.attachment : null;
  const input = attachment?.input ?? call.preview ?? null;
  const inputLabel = attachment?.input ? t("threadTimeline.toolInspectInput") : t("threadTimeline.toolInspectExcerpt");
  const result = attachment?.result ?? null;
  const parsed = result ? parseToolResult(tool, result) : null;
  const errorMessage = call.errorMessage ?? attachment?.errorMessage ?? parsed?.error ?? null;
  const hasVisibleDetail = Boolean(input || result || errorMessage || (call.attachment && "ambiguous" in call.attachment));
  const failure = call.failed ? errorMessage : null;

  return (
    <section data-tool-call-detail={index + 1} className="flex min-w-0 flex-col gap-3">
      {count > 1 ? (
        <h3 className="border-b border-border pb-1 text-sm font-medium text-foreground">
          {t("threadTimeline.toolInspectCall", { index: index + 1, count })}
        </h3>
      ) : null}
      {call.failed ? <ErrorPanel message={failure} /> : null}
      {input ? (
        <DetailSection title={inputLabel}>
          <CodeBlock language={toolInputLanguage(tool, input)} source={input} />
        </DetailSection>
      ) : null}
      {call.attachment && "ambiguous" in call.attachment ? (
        <p className="text-xs italic text-muted-foreground">{t("threadTimeline.resultUnattributable")}</p>
      ) : null}
      {result ? <ResultSection tool={tool} result={result} attachment={attachment} parsed={parsed} /> : null}
      {attachment?.truncated ? (
        <span className="text-xs italic text-muted-foreground">{t("threadTimeline.resultTruncated")}</span>
      ) : null}
      {!hasVisibleDetail ? <p className="text-sm text-muted-foreground">{t("threadTimeline.toolInspectEmpty")}</p> : null}
    </section>
  );
}

function ErrorPanel({ message }: { message: string | null }) {
  const { t } = useT();
  return (
    <section data-tool-error-messages="" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
      <h4 className="text-sm font-medium text-destructive-text">{t("threadTimeline.toolInspectError")}</h4>
      {message ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-destructive-text">{message}</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-destructive-text">{t("threadTimeline.toolErrorUnknown")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("threadTimeline.toolErrorUnknownHint")}</p>
        </>
      )}
    </section>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      {children}
    </section>
  );
}

function ResultSection({ tool, result, attachment, parsed }: {
  tool: string;
  result: string;
  attachment: Exclude<ToolAttachment, { ambiguous: true }> | null;
  parsed: ParsedToolResult | null;
}) {
  const { t } = useT();
  const bareTool = tool.replace(/^mcp__.+?__/, "");
  return (
    <DetailSection title={t("threadTimeline.toolInspectOutput")}>
      {bareTool === "web_extract" && parsed?.webResults ? (
        <WebExtractResult results={parsed.webResults} result={result} />
      ) : bareTool === "execute_code" && parsed ? (
        <ExecuteCodeResult parsed={parsed} attachment={attachment} />
      ) : bareTool === "terminal" || bareTool === "shell" ? (
        <TerminalResult result={result} parsed={parsed} attachment={attachment} />
      ) : (
        <GenericResult result={result} truncated={attachment?.truncated === true} />
      )}
    </DetailSection>
  );
}

function ExecuteCodeResult({ parsed, attachment }: {
  parsed: ParsedToolResult;
  attachment: Exclude<ToolAttachment, { ambiguous: true }> | null;
}) {
  const { t } = useT();
  const exitCode = attachment?.exitCode ?? parsed.exitCode;
  return (
    <div className="flex flex-col gap-2">
      <ResultMetadata parsed={parsed} status={attachment?.status ?? parsed.status} exitCode={exitCode} />
      {parsed.output ? (
        <div className="flex flex-col gap-1">
          <h5 className="text-xs font-medium text-muted-foreground">{t("threadTimeline.toolInspectStdout")}</h5>
          <CodeBlock language="text" source={parsed.output} />
        </div>
      ) : <p className="text-xs italic text-muted-foreground">{t("threadTimeline.toolInspectNoOutput")}</p>}
    </div>
  );
}

function TerminalResult({ result, parsed, attachment }: {
  result: string;
  parsed: ParsedToolResult | null;
  attachment: Exclude<ToolAttachment, { ambiguous: true }> | null;
}) {
  const { t } = useT();
  if (!parsed) return <GenericResult result={result} truncated={attachment?.truncated === true} />;
  const exitCode = attachment?.exitCode ?? parsed.exitCode;
  return (
    <div className="flex flex-col gap-2">
      <ResultMetadata parsed={parsed} status={attachment?.status ?? parsed.status} exitCode={exitCode} />
      {parsed.output ? (
        <div className="flex flex-col gap-1">
          <h5 className="text-xs font-medium text-muted-foreground">{t("threadTimeline.toolInspectStdout")}</h5>
          <CodeBlock language="text" source={parsed.output} />
        </div>
      ) : <p className="text-xs italic text-muted-foreground">{t("threadTimeline.toolInspectNoOutput")}</p>}
    </div>
  );
}

function WebExtractResult({ results, result }: { results: NonNullable<ParsedToolResult["webResults"]>; result: string }) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {results.map((item, index) => (
          <li key={`${item.url}:${index}`} className="min-w-0 rounded-lg border border-border/60 bg-muted/40 p-2.5 text-xs">
            <p className="break-all font-mono text-foreground">{item.url}</p>
            {item.title ? <p className="mt-1 break-words">{item.title}</p> : null}
            {item.error ? <p className="mt-1 whitespace-pre-wrap break-words text-destructive-text"><span className="font-medium">{t("threadTimeline.toolErrorLabel")}</span> {item.error}</p> : null}
          </li>
        ))}
      </ul>
      <CodeBlock language="json" source={result} />
    </div>
  );
}

function GenericResult({ result, truncated }: { result: string; truncated: boolean }) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-1">
      <CodeBlock language="text" source={result} />
      {truncated ? <span className="text-xs italic text-muted-foreground">{t("threadTimeline.resultTruncated")}</span> : null}
    </div>
  );
}

function ResultMetadata({ parsed, status, exitCode }: {
  parsed: ParsedToolResult;
  status?: string;
  exitCode?: number;
}) {
  const { t, formatNumber } = useT();
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {status ? <Metadata label={t("threadTimeline.toolInspectStatus")} value={status} /> : null}
      {exitCode !== undefined ? <Metadata label={t("threadTimeline.toolInspectExitCode", { code: exitCode })} value="" /> : null}
      {typeof parsed.durationSeconds === "number" ? <Metadata label={t("threadTimeline.toolInspectDuration")} value={`${formatNumber(parsed.durationSeconds, { maximumFractionDigits: 2 })} s`} /> : null}
      {typeof parsed.toolCallsMade === "number" ? (
        <Metadata label={t("threadTimeline.toolInspectToolCalls")} value={formatNumber(parsed.toolCallsMade)} />
      ) : null}
    </dl>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return <div className="flex gap-1"><dt className="font-medium">{label}</dt>{value ? <dd>{value}</dd> : null}</div>;
}

