import { useEffect, useRef } from "react";
import type { MessageKey } from "@openedbot/browser-i18n";
import { useIsMobile } from "@openedbot/browser-ui-kit";
import { ApiError } from "../lib/api";
import { useAccountLayout } from "../lib/shell/account-layout";
import { useT } from "../lib/i18n";
import { conversationDiagnostic, type DiagnosticKind } from "../lib/run/conversation-diagnostic";
import { useOpenSettings } from "../lib/shell/settings-overlay";
import { FailureState } from "./failure-state";
import { BUTTON } from "./settings/primitives";

/** What each diagnostic kind says; `unknown` is the banner's, about a failed turn. */
const KIND_MESSAGE: Record<DiagnosticKind, MessageKey> = {
  runtime: "mvp.noMachine",
  models: "mvp.providerProblem",
  permissions: "mvp.permissionsProblem",
  unknown: "mvp.unknownError",
};

export function ConversationDiagnostic({
  code,
  reference,
  onRetry,
  onPermissions,
  retrying = false,
  floating = false,
}: {
  code?: string | null;
  reference?: string;
  onRetry: () => void;
  onPermissions?: () => void;
  retrying?: boolean;
  floating?: boolean;
}) {
  const { t } = useT();
  const layout = useAccountLayout();
  const mobile = useIsMobile();
  const kind = conversationDiagnostic(code);
  return (
    <section
      role="status"
      aria-label={t("mvp.diagnostic")}
      className={`mx-4 mb-2 shrink-0 rounded-xl border border-border bg-background px-3 py-2 text-sm ${floating && layout === "c" && !mobile ? "mt-[72px]" : "mt-2"}`}
    >
      <p>{t(KIND_MESSAGE[kind])}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <DiagnosticAction kind={kind} onPermissions={onPermissions} className={BUTTON.small} />
        <button
          className={BUTTON.small}
          type="button"
          disabled={retrying}
          onClick={onRetry}
        >
          {t("mvp.retry")}
        </button>
      </div>
      {reference ? (
        <p className="mt-1 break-all text-xs text-muted-foreground">
          {t("mvp.reference")}: {reference}
          {code ? ` / ${code}` : ""}
        </p>
      ) : null}
    </section>
  );
}

/** The kind's own gesture: open the matching settings, or the bot's approvals. None for `unknown`. */
function DiagnosticAction({
  kind,
  onPermissions,
  className,
}: {
  kind: DiagnosticKind;
  onPermissions?: () => void;
  className: string;
}) {
  const { t } = useT();
  const settings = useOpenSettings();
  if (kind === "unknown") return null;
  return (
    <button
      className={className}
      type="button"
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
      {t(
        kind === "runtime"
          ? "mvp.runtimeAction"
          : kind === "models"
            ? "mvp.modelsAction"
            : "mvp.permissionsAction",
      )}
    </button>
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
  const description = kind === "unknown" ? t("conversation.readFailed") : t(KIND_MESSAGE[kind]);
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
