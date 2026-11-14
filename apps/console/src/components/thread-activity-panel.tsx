import { AlertTriangle, CheckCircle2, Circle, Loader2, ShieldAlert, XCircle } from "lucide-react";
import type { RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { ApprovalRequestDto } from "@openedbot/contracts-api";
import { buildThreadActivity, type ActivityToolState } from "../lib/thread/thread-activity";
import { useT, type MessageKey } from "../lib/i18n";

const RUN_STATUS_KEYS: Record<RunDto["status"], MessageKey> = {
  queued: "workflowOverview.runStatus.queued", pending: "workflowOverview.runStatus.queued",
  starting: "workflowOverview.runStatus.starting", running: "workflowOverview.runStatus.running",
  awaiting_approval: "workflowOverview.runStatus.awaitingApproval", completed: "workflowOverview.runStatus.completed",
  failed: "workflowOverview.runStatus.failed", cancelled: "workflowOverview.runStatus.cancelled",
};
const TOOL_STATE_KEYS: Record<ActivityToolState, MessageKey> = {
  running: "threadActivity.toolRunning", completed: "threadActivity.toolCompleted",
  failed: "threadActivity.toolFailed", interrupted: "threadActivity.toolInterrupted",
  result_missing: "threadActivity.toolResultMissing",
};

function StatusIcon({ state }: { state: ActivityToolState }) {
  if (state === "running") return <Loader2 className="size-3.5 animate-spin" aria-hidden />;
  if (state === "completed") return <CheckCircle2 className="size-3.5 text-pos-700" aria-hidden />;
  if (state === "result_missing") return <AlertTriangle className="size-3.5 text-warn-700" aria-hidden />;
  return <XCircle className="size-3.5 text-destructive-text" aria-hidden />;
}

export type ThreadActivitySnapshot = {
  runs: readonly RunDto[];
  events: readonly StoredProductEvent[];
  approvals: readonly ApprovalRequestDto[];
};

/** Runs / tools / gates: a page of the wheel, no longer a separate dialog. */
export function ThreadActivityList({
  runs,
  events,
  approvals,
}: ThreadActivitySnapshot) {
  const { t, formatDate } = useT();
  const activity = buildThreadActivity(runs, events, approvals);
  if (activity.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t("threadActivity.empty")}</p>;
  }
  // A salon turn with no tool teaches nothing: fourteen « Aucun
  // outil appelé » cards hide the only call that matters. One details only the
  // runs that called a tool or raised an authorization.
  const detailed = activity.filter((item) => item.tools.length > 0 || item.approvals.length > 0);
  const quiet = activity.length - detailed.length;
  if (detailed.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t("threadActivity.noTools")}</p>;
  }
  return (
    <ol className="space-y-3">
      {quiet > 0 ? (
        <li className="text-xs text-muted-foreground">
          {t("threadActivity.quietRuns", { count: String(quiet) })}
        </li>
      ) : null}
      {detailed.map(({ run, tools, approvals: runApprovals }) => {
        const position = activity.findIndex((item) => item.run.id === run.id);
        return (
        <li key={run.id} className="rounded-xl border border-border/70 p-3" data-run-id={run.id}>
          <header className="flex items-center gap-2 text-sm">
            {["queued", "pending", "starting", "running"].includes(run.status) ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : run.status === "completed" ? (
              <CheckCircle2 className="size-4 text-pos-700" aria-hidden />
            ) : run.status === "failed" || run.status === "cancelled" ? (
              <XCircle className="size-4 text-destructive-text" aria-hidden />
            ) : (
              <Circle className="size-4 text-warn-700" aria-hidden />
            )}
            <span className="font-medium">{t("threadActivity.run", { index: position + 1 })}</span>
            <span className="text-muted-foreground">{t(RUN_STATUS_KEYS[run.status])}</span>
            <time className="ml-auto text-xs text-muted-foreground" dateTime={run.createdAt}>
              {formatDate(run.createdAt)}
            </time>
          </header>
          {tools.length ? (
            <ul className="mt-3 space-y-2">
              {tools.map((tool) => (
                <li key={tool.key} className="rounded-lg bg-muted/40 px-2.5 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <StatusIcon state={tool.state} />
                    <code className="font-medium">{tool.tool}</code>
                    <span className="ml-auto text-muted-foreground">{t(TOOL_STATE_KEYS[tool.state])}</span>
                  </div>
                  {tool.preview ? (
                    <pre className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{tool.preview}</pre>
                  ) : null}
                  {tool.result ? (
                    <pre className="scrollbar-subtle mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background/70 p-2">
                      {tool.result}
                    </pre>
                  ) : null}
                  {tool.errorMessage ? (
                    <p className="mt-1 whitespace-pre-wrap break-words text-destructive-text">
                      <span className="font-medium">{t("threadTimeline.toolErrorLabel")}</span> {tool.errorMessage}
                    </p>
                  ) : null}
                  {tool.truncated ? <p className="mt-1 text-warn-700">{t("threadActivity.resultTruncated")}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">{t("threadActivity.noTools")}</p>
          )}
          {runApprovals.map((approval) => (
            <div key={approval.id} className="mt-2 flex gap-2 rounded-lg border border-warn-500/40 p-2 text-xs">
              <ShieldAlert className="size-3.5 shrink-0 text-warn-700" aria-hidden />
              <div className="min-w-0">
                <p className="font-medium">{approval.action}</p>
                <p className="text-muted-foreground">
                  {t("threadActivity.approval", {
                    status: approval.status,
                    choices: approval.choices.filter((choice) => choice === "once" || choice === "deny").join(", ") || "-",
                  })}
                </p>
              </div>
            </div>
          ))}
        </li>
        );
      })}
    </ol>
  );
}
