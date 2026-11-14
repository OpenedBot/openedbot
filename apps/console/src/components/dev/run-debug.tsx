import { useState } from "react";
import type { ToolCall } from "@openedbot/conversation/domain/thread-tools";

/**
 * Dev only (`import.meta.env.DEV === true`, like the run timing under a
 * reply): the turn's tool calls as the runtime reported them, at the foot of
 * the « Réflexions » panel. Status, exit code, duration, the full command and
 * the raw result (traceback, `hint`, stderr) that the product rows summarise
 * as « Échec ». « Copy JSON » puts the whole diagnosis on the clipboard, to
 * paste in a bug report. Nothing is fetched: these are the calls the thread
 * already holds, so the full result appears once the run attached it.
 */
export const SHOW_RUN_DEBUG = import.meta.env.DEV === true;

export function runDebugReport(calls: readonly ToolCall[]) {
  return calls.map((call, index) => {
    const attachment = call.attachment && !("ambiguous" in call.attachment) ? call.attachment : null;
    return {
      index: index + 1,
      tool: call.tool,
      status: !call.done ? "running" : call.failed ? "failed" : "done",
      exitCode: attachment?.exitCode ?? null,
      durationMs: call.durationMs ?? null,
      errorMessage: call.errorMessage ?? attachment?.errorMessage ?? null,
      input: attachment?.input ?? call.preview ?? null,
      result: parsedOrRaw(attachment?.result ?? call.resultExcerpt ?? null),
      truncated: attachment?.truncated === true,
      attached: attachment !== null,
      ambiguous: Boolean(call.attachment && "ambiguous" in call.attachment),
    };
  });
}

function parsedOrRaw(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function RunDebugSection({ calls }: { calls: readonly ToolCall[] }) {
  const [copied, setCopied] = useState(false);
  if (!SHOW_RUN_DEBUG || calls.length === 0) return null;
  const report = runDebugReport(calls);
  const copy = () => {
    void navigator.clipboard?.writeText(JSON.stringify(report, null, 2)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <section data-run-debug="" className="mt-4 border-t border-dashed border-[var(--stream-line)] pt-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="flex-1 font-[family-name:var(--stream-mono)] text-[12px] tracking-wide text-[var(--stream-fg2)] uppercase">Debug (dev)</span>
        <button
          type="button"
          onClick={copy}
          className="rounded-md px-2 py-1 text-[12px] text-[var(--stream-fg2)] hover:bg-[var(--stream-hover)] hover:text-[var(--stream-fg)]"
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
      {report.map((entry) => (
        <details key={entry.index} data-run-debug-call={entry.index} open={entry.status === "failed"} className="mb-2 rounded-lg border border-[var(--stream-line)] bg-[var(--stream-side)] px-3 py-2">
          <summary className="cursor-pointer font-[family-name:var(--stream-mono)] text-[12px] leading-[18px] text-[var(--stream-fg)]">
            #{entry.index} {entry.tool} · <span className={entry.status === "failed" ? "text-destructive-text" : undefined}>{entry.status}</span>
            {entry.exitCode !== null ? ` · exit ${entry.exitCode}` : ""}
            {entry.durationMs !== null ? ` · ${entry.durationMs} ms` : ""}
            {entry.attached ? "" : " · result not attached yet"}
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto font-[family-name:var(--stream-mono)] text-[12px] leading-[18px] whitespace-pre-wrap break-words text-[var(--stream-fg2)]">
            {JSON.stringify({ errorMessage: entry.errorMessage, input: entry.input, result: entry.result, truncated: entry.truncated }, null, 2)}
          </pre>
        </details>
      ))}
    </section>
  );
}
