import { ApiError } from "../api";
import type { MessageKey } from "../i18n";

/**
 * Why a conversation's thread could not be read, for the line that replaces
 * it with its retry, in a bot's thread as in a room.
 */
export function threadReadFailureMessage(t: (key: MessageKey) => string, error: unknown): string {
  return error instanceof ApiError && error.code === "DATABASE_MIGRATION_REQUIRED"
    ? t("conversation.migrationRequired")
    : t("conversation.loadFailed");
}
