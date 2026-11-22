import type { RuntimePublicDto } from "@openedbot/contracts-api";
import type { Locale, MessageKey } from "@openedbot/browser-i18n";
import { ApiError, userFacingError } from "../api";
import { displayedRuntimeHealth, runtimeHealthLabel } from "./runtime-health";

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * Why a bot's conversation cannot send, in one sentence: the composer's tab,
 * the edit refusal and a send refused before it leaves all say it.
 *
 * Without a usable machine the sentence names the machine's problem: none
 * linked, its link closed, or the state its last check reported (« token
 * refusé », « aucun fournisseur »…) in the words of the sidebar's runtime
 * status. Otherwise it is the error that holds the conversation.
 */
export function conversationBlockedMessage(
  t: Translate,
  locale: Locale,
  { runtime, runtimeUnavailable, error }: {
    runtime: RuntimePublicDto | undefined;
    runtimeUnavailable: boolean;
    error: unknown;
  },
): string {
  if (runtimeUnavailable && !runtime) return t("mvp.noMachine");
  const health = displayedRuntimeHealth(runtime);
  if (runtimeUnavailable && health === "disconnected") return t("conversation.linkUnavailable");
  if (runtimeUnavailable && runtime) {
    const state = runtimeHealthLabel(runtime, null, locale);
    const name = runtime.name?.trim();
    return name ? t("runtimeRail.named", { name, state }) : t("runtimeRail.unnamed", { state });
  }
  if (error instanceof ApiError && error.code === "RUNTIME_LINK_UNAVAILABLE") return t("conversation.linkUnavailable");
  return userFacingError(error, t("conversation.loadFailed"));
}
