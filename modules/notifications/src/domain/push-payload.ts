import type { Locale } from "@openedbot/contracts-locale";
import { t } from "@openedbot/contracts-i18n";

export type PushEventType = "approval.requested" | "run.completed" | "run.error";

export type WebPushPayload = {
  title: string;
  body: string;
  url: string;
};

/**
 * Corps public : le type d'événement, jamais le texte du fil ni un détail
 * d'erreur. Le titre est le nom du bot, déjà borné à l'écriture de l'outbox.
 */
export function webPushPayload(input: {
  botName: string;
  eventType: PushEventType;
  botId: string | null;
  locale: Locale;
  /** URL segment of the workspace: its slug (a legacy UUID is still understood by the console). */
  workspace?: string;
}): WebPushPayload {
  const title = input.botName.trim() || "openedbot";
  return {
    title,
    body: pushEventBody(input.eventType, input.locale),
    url: pushEventUrl(input.eventType, input.botId, input.workspace),
  };
}

export function pushEventUrl(eventType: PushEventType, botId: string | null, workspace?: string): string {
  const path = eventType === "approval.requested" ? "/decisions" : botId ? `/bot/${botId}` : "/";
  return workspace ? `/o/${encodeURIComponent(workspace)}${path}` : path;
}

export function pushEventBody(eventType: PushEventType, locale: Locale): string {
  if (eventType === "approval.requested") return t(locale, "pushNotifications.approvalRequested");
  if (eventType === "run.completed") return t(locale, "pushNotifications.runCompleted");
  return t(locale, "pushNotifications.runError");
}

export function isPushEventType(value: unknown): value is PushEventType {
  return value === "approval.requested" || value === "run.completed" || value === "run.error";
}

/**
 * Outdated connector notice (0101): runtime name and versions, never a token
 * or an address. The link opens the runtime settings of the workspace.
 */
export function connectorUpgradePushPayload(input: {
  runtimeName: string | null;
  installedVersion: string;
  targetVersion: string;
  locale: Locale;
  workspace: string;
}): WebPushPayload {
  const runtime = input.runtimeName?.trim() || "openedbot";
  return {
    title: t(input.locale, "pushNotifications.connectorOutdatedTitle", { runtime }),
    body: t(input.locale, "pushNotifications.connectorOutdated", {
      installed: input.installedVersion,
      target: input.targetVersion,
    }),
    url: `/o/${encodeURIComponent(input.workspace)}/settings/runtime`,
  };
}
