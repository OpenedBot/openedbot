import { useEffect, useRef } from "react";
import type { MessageKey } from "@openedbot/browser-i18n";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { ApiError } from "../lib/api";
import { useAccountLayout } from "../lib/shell/account-layout";
import { useT } from "../lib/i18n";
import { conversationDiagnostic, type DiagnosticKind } from "../lib/run/conversation-diagnostic";
import { useOpenSettings } from "../lib/shell/settings-overlay";
import { useThreadEditAvailability } from "../lib/thread/thread-edit-availability";
import { FailureState } from "./failure-state";
import { BUTTON } from "./settings/primitives";

/** What each diagnostic kind says; an unknown kind keeps the failure's own words. */
const KIND_MESSAGE: Record<Exclude<DiagnosticKind, "unknown">, MessageKey> = {
  runtime: "mvp.noMachine",
  models: "mvp.providerProblem",
  permissions: "mvp.permissionsProblem",
};

const ACTION_LABEL: Record<Exclude<DiagnosticKind, "unknown">, MessageKey> = {
  runtime: "mvp.runtimeAction",
  models: "mvp.modelsAction",
  permissions: "mvp.permissionsAction",
};

/** The kind's own gesture: open the matching settings, or the bot's approvals. None for `unknown`. */
function DiagnosticAction({
  kind,
  onPermissions,
  className,
  label,
}: {
  kind: DiagnosticKind;
  onPermissions?: () => void;
  className: string;
  /** Accessible name when the visible one is not enough (several failed turns). */
  label?: string;
}) {
  const { t } = useT();
  const settings = useOpenSettings();
  if (kind === "unknown") return null;
  return (
    <button
      className={className}
      type="button"
      aria-label={label}
      onClick={() =>
        kind === "permissions" && onPermissions
          ? onPermissions()
          : settings(
              kind === "models"
                ? "/settings/models"
                : kind === "permissions"
                  ? "/settings/policies"
                  : "/settings/runtime",
            )
      }
    >
      {t(ACTION_LABEL[kind])}
    </button>
  );
}

/** A link-like action inside a failed turn's red bubble (`ProviderAuthNotice`'s). */
const BUBBLE_ACTION =
  "cursor-pointer underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60";

/**
 * The end of a failed turn's bubble: the kind's gesture, a retry where the
 * screen can replay the turn, and the reference to pass on (run id and error
 * code), selectable. `question` is the operator's message of that turn: it
 * names the actions when the thread holds several failed turns.
 */
export function RunFailureFooter({
  runId,
  code,
  question,
  onRetry,
  kind = "unknown",
  onPermissions,
}: {
  runId: string;
  code?: string | null;
  question?: string | null;
  onRetry?: () => void;
  /** Whose gesture to offer; the dedicated notices carry their own and leave it out. */
  kind?: DiagnosticKind;
  onPermissions?: () => void;
}) {
  const { t } = useT();
  // Replay is the message's « Régénérer »: same availability (no run in progress, no gate).
  const canRetry = useThreadEditAvailability((state) => state.canEdit);
  const excerpt = question?.trim().replace(/\s+/g, " ");
  const turn = excerpt ? (excerpt.length > 40 ? `${excerpt.slice(0, 40)}…` : excerpt) : null;
  const label = (name: string) => (turn ? t("threadTimeline.runFailureFor", { action: name, question: turn }) : undefined);
  return (
    <>
      {kind !== "unknown" || onRetry ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {kind !== "unknown" ? (
            <DiagnosticAction kind={kind} onPermissions={onPermissions} className={BUBBLE_ACTION} label={label(t(ACTION_LABEL[kind]))} />
          ) : null}
          {onRetry ? (
            <button
              type="button"
              className={BUBBLE_ACTION}
              disabled={!canRetry}
              aria-label={label(t("conversation.retry"))}
              onClick={onRetry}
            >
              {t("conversation.retry")}
            </button>
          ) : null}
        </div>
      ) : null}
      <p className="select-text break-all text-xs font-normal text-white/80">
        {t("mvp.reference")}: {runId}
        {code ? ` / ${code}` : ""}
      </p>
    </>
  );
}

/**
 * A failed turn, where its reply would be. The sentence follows the
 * diagnostic kind; for an unknown kind it is the run's own text. Not an
 * alert: the conversation still works and the next send may succeed.
 */
export function RunFailureNotice({
  runId,
  code,
  text,
  question,
  onRetry,
  onPermissions,
  findTargetId,
  findActive = false,
}: {
  runId: string;
  code?: string | null;
  text: string;
  question?: string | null;
  onRetry?: () => void;
  onPermissions?: () => void;
  findTargetId: string;
  findActive?: boolean;
}) {
  const { t } = useT();
  const kind = conversationDiagnostic(code);
  return (
    <div
      role="status"
      data-run-failure={runId}
      data-thread-find-target={findTargetId}
      className={`flex max-w-[85%] flex-col items-start gap-1.5 self-start rounded-2xl rounded-bl-md bg-destructive px-3.5 py-2.5 text-sm font-medium text-white ${findActive ? "ring-2 ring-primary ring-offset-2" : ""}`}
    >
      <p>{kind === "unknown" ? text : t(KIND_MESSAGE[kind])}</p>
      <RunFailureFooter runId={runId} code={code} question={question} onRetry={onRetry} kind={kind} onPermissions={onPermissions} />
    </div>
  );
}

/**
 * A read the conversation needs has failed: the screen cannot work, so it is
 * a page in place of the thread and the composer, not a strip above them. The
 * shell and the pane header stay, so the user can leave.
 *
 * The sentence and the extra gesture follow the diagnostic kind; the nature
 * of the failure (path, reference to pass on, code) is `FailureState`'s.
 */
export function ConversationErrorPage({
  error,
  retrying,
  onRetry,
  onPermissions,
}: {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  onPermissions?: () => void;
}) {
  const { t } = useT();
  const layout = useAccountLayout();
  const mobile = useIsMobile();
  const kind = conversationDiagnostic(error instanceof ApiError ? error.code : null);
  const description = kind !== "unknown" ? t(KIND_MESSAGE[kind]) : error instanceof ApiError && error.code === "DATABASE_MIGRATION_REQUIRED" ? t("conversation.migrationRequired") : t("conversation.readFailed");
  const retryRef = useRef<HTMLButtonElement>(null);
  // The thread or the composer that held the focus is gone, and a disabled
  // button drops it during a retry: it lands on the retry button when the page
  // appears and after a retry that failed again. A focus the user placed
  // elsewhere (the sidebar) is left alone.
  useEffect(() => {
    if (retrying) return;
    const active = document.activeElement;
    if (active === null || active === document.body) retryRef.current?.focus();
  }, [retrying]);
  return (
    <FailureState
      error={error}
      title={t("conversation.unavailable")}
      description={description}
      fallback={description}
      placement="page"
      // Rail shell (« c »): the pane header floats over the pane (72 px, `BoardHeader`).
      className={layout === "c" && !mobile ? "pt-[72px]" : undefined}
      action={
        <>
          <button
            ref={retryRef}
            type="button"
            className={BUTTON.primary}
            disabled={retrying}
            aria-busy={retrying || undefined}
            onClick={onRetry}
          >
            {retrying ? t("conversation.retrying") : t("conversation.retry")}
          </button>
          <DiagnosticAction kind={kind} onPermissions={onPermissions} className={BUTTON.secondary} />
        </>
      }
    />
  );
}
