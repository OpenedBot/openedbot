import type { RunDto } from "@openedbot/contracts-api";
import type { MessageKey } from "../i18n";
import { isProviderAuthRequiredCode } from "../runtime/provider-auth";

/**
 * A member (or a lone bot) whose provider refuses the configured model.
 *
 * The stable code `MODEL_UNAVAILABLE` (DEV-328) is the only source: never the
 * upstream text, which changes from one provider to another. A single module decides,
 * so that the thread bubble, the toast and the crew badge say the same
 * thing.
 */

/**
 * Same value as `MODEL_UNAVAILABLE_CODE` from `@openedbot/contracts-errors`: the
 * console does not depend on that package, one more constant is not worth a
 * dependency (and a modified `bun.lock`). A test pins the equality.
 */
export const MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE";

export function isModelUnavailableCode(code: unknown): boolean {
  return code === MODEL_UNAVAILABLE;
}

type TranslateFn = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * « <membre> ne peut pas répondre : le modèle <modèle> n'est plus
 * disponible. » Without a known model (a run still without `model`), it is not
 * invented: the sentence names only « son modèle ».
 */
export function modelUnavailableMessage(t: TranslateFn, name: string, model: string | null | undefined): string {
  const named = typeof model === "string" && model.trim() !== "" ? model.trim() : null;
  return named
    ? t("threadTimeline.modelUnavailable", { name, model: named })
    : t("threadTimeline.modelUnavailableNoModel", { name });
}

/**
 * The text of a failed run for a toast or the composer banner, in the
 * operator's language: a refused model (`MODEL_UNAVAILABLE`) or a refused
 * provider login (`PROVIDER_AUTH_REQUIRED`). `null` for any other code (the
 * caller then keeps the run's raw text, unchanged).
 *
 * `authProvider` is the readable name of the provider to reconnect, read by
 * the caller from the run's `run.error` event (`RunDto` has none). Without
 * it the sentence says "its provider" rather than show the run's stored
 * French-only `error` with a raw slug.
 */
export function readableRunFailure(
  t: TranslateFn,
  run: Pick<RunDto, "error"> & Partial<Pick<RunDto, "errorCode" | "model">>,
  name: string,
  authProvider?: string | null,
): string | null {
  if (isModelUnavailableCode(run.errorCode)) return modelUnavailableMessage(t, name, run.model);
  if (isProviderAuthRequiredCode(run.errorCode)) {
    const provider = authProvider?.trim();
    return provider
      ? t("threadTimeline.providerAuthRequired", { name, provider })
      : t("threadTimeline.providerAuthRequiredGeneric", { name });
  }
  return null;
}

type RunErrorEventLike = { runId: string; type: string; payload: Readonly<Record<string, unknown>> };

/**
 * A failed run the thread already explains in place, with the action that
 * fixes it (`ModelUnavailableNotice`, `ProviderAuthNotice`). The bot screen
 * must not also raise the blocking "Conversation indisponible" modal for it:
 * the modal blurs the thread, hides that notice and offers only "Fermer",
 * while the conversation itself is fine and the next send may succeed.
 *
 * The code is read on the run, else on its `run.error` event (same fallback
 * as the timeline): the run status can land before its `errorCode`.
 */
export function runFailureExplainedInThread(
  run: Pick<RunDto, "id"> & Partial<Pick<RunDto, "errorCode">>,
  events: readonly RunErrorEventLike[] | undefined,
): boolean {
  const explained = (code: unknown) => isModelUnavailableCode(code) || isProviderAuthRequiredCode(code);
  if (explained(run.errorCode)) return true;
  return (events ?? []).some((event) =>
    event.runId === run.id && event.type === "run.error" && explained(event.payload.errorCode));
}

export type ModelUnavailableState = { runId: string; model: string | null };

type RunLike = Pick<RunDto, "id" | "botId" | "status" | "createdAt"> & Partial<Pick<RunDto, "errorCode" | "model">>;

/**
 * Per bot: the refused model for as long as its latest finished turn is this failure.
 * A later successful turn clears the alert (the model was corrected); a turn
 * in progress or cancelled does not decide, it has not proved anything yet.
 */
export function modelUnavailableByBot(runs: readonly RunLike[]): Map<string, ModelUnavailableState> {
  const latest = new Map<string, RunLike>();
  // `createdAt` orders them; on a tie (or with no date) the array order, already
  // chronological on the API side, breaks it: `>=` keeps the later one.
  for (const run of runs) {
    if (!run.botId || (run.status !== "completed" && run.status !== "failed")) continue;
    const seen = latest.get(run.botId);
    if (!seen || (run.createdAt ?? "") >= (seen.createdAt ?? "")) latest.set(run.botId, run);
  }
  const result = new Map<string, ModelUnavailableState>();
  for (const [botId, run] of latest) {
    if (run.status === "failed" && isModelUnavailableCode(run.errorCode)) {
      result.set(botId, { runId: run.id, model: run.model?.trim() || null });
    }
  }
  return result;
}
