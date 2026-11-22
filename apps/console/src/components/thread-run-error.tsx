import type { MessageAuthorBot } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { useT } from "../lib/i18n";
import { isModelUnavailableCode } from "../lib/run/model-unavailable";
import { isProviderAuthRequiredCode, providerAuthRequiredSlug } from "../lib/runtime/provider-auth";
import { eventText } from "../lib/thread/thread-event-text";
import { RunFailureFooter, RunFailureNotice } from "./conversation-diagnostic";
import { ModelUnavailableNotice, ProviderAuthNotice } from "./thread-messages";

/**
 * A `run.error` in the thread: the turn that failed, where its reply would be.
 * A refused provider login or model keeps its dedicated notice and action;
 * any other failure speaks through its diagnostic kind (`RunFailureNotice`).
 * Each carries the retry (the operator message's « Régénérer », when the
 * screen offers it) and the reference.
 */
export function RunErrorEntry({
  event,
  run,
  author,
  question,
  onRegenerate,
  onPermissions,
  findTargetId,
  findActive,
}: {
  event: StoredProductEvent;
  run?: { errorCode?: string | null; model?: string | null };
  author: MessageAuthorBot | null | undefined;
  /** The operator's message that started the run. */
  question?: { id: string; text: string };
  onRegenerate?: (messageId: string) => void;
  onPermissions?: () => void;
  findTargetId: string;
  findActive: boolean;
}) {
  const { t } = useT();
  // The code comes from the event (direct), otherwise from the run (reread).
  const code = typeof event.payload.errorCode === "string" ? event.payload.errorCode : run?.errorCode;
  const authProvider = isProviderAuthRequiredCode(code) ? providerAuthRequiredSlug(event.payload) : null;
  const retry = question && onRegenerate ? () => onRegenerate(question.id) : undefined;
  const name = author?.name ?? author?.slug ?? t("threadTimeline.unknownBot");
  const footer = <RunFailureFooter runId={event.runId} code={code} question={question?.text} onRetry={retry} />;
  if (authProvider) {
    return (
      <ProviderAuthNotice name={name} provider={authProvider} findTargetId={findTargetId} findActive={findActive}>
        {footer}
      </ProviderAuthNotice>
    );
  }
  if (isModelUnavailableCode(code)) {
    return (
      <ModelUnavailableNotice
        name={name}
        model={run?.model ?? (typeof event.payload.model === "string" ? event.payload.model : null)}
        botId={author?.id ?? null}
        findTargetId={findTargetId}
        findActive={findActive}
      >
        {footer}
      </ModelUnavailableNotice>
    );
  }
  return (
    <RunFailureNotice
      runId={event.runId}
      code={code}
      text={eventText(event) || t("threadTimeline.runtimeErrorFallback")}
      question={question?.text}
      onRetry={retry}
      onPermissions={onPermissions}
      findTargetId={findTargetId}
      findActive={findActive}
    />
  );
}
