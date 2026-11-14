import type { BotDto, ToolErrorDto } from "@openedbot/contracts-api";
import { toolErrorCode } from "@openedbot/conversation/domain/tool-error";
import { useT } from "../lib/i18n";
import { conversationPath } from "../lib/thread/conversation-href";

export function BotToolErrorRow({ bot, row }: { bot: Pick<BotDto, "id" | "threadId">; row: ToolErrorDto }) {
  const { t, formatDate } = useT();
  return (
    <li className="rounded-md border border-border px-3 py-2 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-mono text-xs">{row.tool}</span>
        <time className="shrink-0 text-xs text-muted-foreground" dateTime={row.occurredAt}>
          {formatDate(row.occurredAt, { dateStyle: "short", timeStyle: "short" })}
        </time>
      </div>
      <p className="mt-1 text-sm text-text-primary">
        {t(toolErrorSummaryKey(row))}
      </p>
      {row.errorMessage ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t("botCapabilities.errorsDetails")}</summary>
          <p className="mt-2 whitespace-pre-wrap break-words font-mono">{row.errorMessage}</p>
        </details>
      ) : <p className="mt-1 text-xs text-muted-foreground">{t("botCapabilities.errorsNoMessage")}</p>}
      <a
        href={conversationPath(bot.id, row.threadId === bot.threadId ? undefined : row.threadId, `run:${row.runId}`)}
        className="mt-1 inline-flex min-h-11 items-center text-xs underline underline-offset-2 sm:min-h-0"
      >
        {t("botCapabilities.errorsOpenRun")}
      </a>
    </li>
  );
}

function toolErrorSummaryKey(row: ToolErrorDto) {
  const code = row.errorCode ?? toolErrorCode(row.errorMessage);
  switch (code) {
    case "PYTHON_DEPENDENCY_MISSING": return "botCapabilities.errorPythonDependency";
    case "APPROVAL_REQUIRED": return "botCapabilities.errorApprovalRequired";
    default: return "botCapabilities.errorExecutionFailed";
  }
}
