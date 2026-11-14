import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { RosterDto } from "@openedbot/contracts-api";
import type { ThreadSnapshot } from "@openedbot/contracts-api";
import { activeOrganizationId, cloudSessionRevision, subscribeCloudSession } from "../lib/session/cloud-session";
import { api, queryKeys, type ThreadView } from "../lib/api";
import { conversationPath } from "../lib/thread/conversation-href";
import { readNewestThreadSnapshot } from "../lib/stream/thread-stream-safety";
import { subscribeToOrganizationEvents } from "../lib/stream/use-thread-stream";
import { useT } from "../lib/i18n";
import {
  handleWorkflowPageNotification,
  markWebWorkflowNotificationSeen,
  pageNotificationForeground,
  readWebNotificationCursor,
  readWebNotificationPreference,
  recordWebNotificationCursor,
  webNotificationPermissionState,
  webWorkflowNotificationWasSeen,
  WEB_NOTIFICATION_PREFERENCE_EVENT,
} from "../lib/run/web-workflow-notifications";

/**
 * Global bridge from the SSE stream to the browser Notification API.
 *
 * It lives above the routes: a workflow stays observable when one leaves
 * its thread for Réglages. It creates no Service Worker and therefore can
 * deliver nothing once the page is closed: that boundary is shown in
 * settings, never hidden by this component with no interface.
 */
export function WebWorkflowNotificationBridge() {
  const { locale, t } = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [revision, setRevision] = useState(() => cloudSessionRevision());
  const [preference, setPreference] = useState(readWebNotificationPreference);

  useEffect(() => {
    const reloadPreference = () => setPreference(readWebNotificationPreference());
    const stopSession = subscribeCloudSession(() => setRevision(cloudSessionRevision()));
    window.addEventListener(WEB_NOTIFICATION_PREFERENCE_EVENT, reloadPreference);
    window.addEventListener("storage", reloadPreference);
    return () => {
      stopSession();
      window.removeEventListener(WEB_NOTIFICATION_PREFERENCE_EVENT, reloadPreference);
      window.removeEventListener("storage", reloadPreference);
    };
  }, []);

  useEffect(() => {
    const organizationId = activeOrganizationId();
    if (!organizationId || !preference.enabledAt || webNotificationPermissionState(preference) !== "enabled") return;
    let disposed = false;
    // The SSE callbacks are synchronous. The chain keeps the order of the reads
    // and of the checkpoints, even when two transitions arrive in the same
    // poller tick.
    let chain = Promise.resolve();
    const stop = subscribeToOrganizationEvents((event) => {
      if (event.organizationId !== organizationId) return;
      chain = chain.then(async () => {
        if (disposed) return;
        try {
          await handleWorkflowPageNotification(event, {
            enabledAt: preference.enabledAt!,
            loadThread: async (threadId) => {
              const key = queryKeys.thread(threadId);
              const snapshot = await readNewestThreadSnapshot(
                () => api.thread(threadId),
                () => queryClient.getQueryData<ThreadView>(key),
              );
              queryClient.setQueryData<ThreadView>(key, snapshot as ThreadView);
              return snapshot as ThreadSnapshot;
            },
            resolveThreadRoute: async (threadId) => {
              const roster = await queryClient.fetchQuery<RosterDto>({
                queryKey: queryKeys.roster,
                queryFn: api.roster,
                staleTime: 0,
              });
              const bot = roster.bots.find((candidate) => candidate.threadId === threadId);
              if (bot) return `/bot/${encodeURIComponent(bot.id)}`;
              const group = roster.groups?.find((candidate) => candidate.threadId === threadId);
              if (group) return `/g/${encodeURIComponent(group.id)}`;
              // Fallback: neither a bot's permanent thread nor a salon's,
              // it is a message-variant branch. The thread itself says
              // which bot it belongs to, which is better than the old
              // scan of the task cache: that cache no longer exists, and its
              // fallback therefore never resolved anything anymore.
              const thread = await queryClient
                .fetchQuery({ queryKey: queryKeys.thread(threadId), queryFn: () => api.thread(threadId) })
                .catch(() => null);
              if (!thread?.botId) return null;
              return conversationPath(thread.botId, threadId);
            },
            isPageForeground: pageNotificationForeground,
            wasSeen: (workflowId, sequence) =>
              webWorkflowNotificationWasSeen(organizationId, workflowId, sequence),
            markSeen: (workflowId, sequence) =>
              markWebWorkflowNotificationSeen(organizationId, workflowId, sequence),
            show: ({ title, body, tag }) => {
              // The route stays in this page closure: it does not go
              // into the payload handed to the operating system.
              const notification = new Notification(title, { body, tag });
              return {
                close: () => notification.close(),
                setOnClick: (listener) => { notification.onclick = listener; },
              };
            },
            open: (route) => {
              window.focus();
              void navigate({ to: route });
            },
            content: {
              approvalTitle: t("settingsNotifications.notificationApprovalTitle"),
              completedTitle: t("settingsNotifications.notificationCompletedTitle"),
              attentionTitle: t("settingsNotifications.notificationAttentionTitle"),
              approvalBody: t("settingsNotifications.notificationApprovalBody"),
              outcomeBody: t("settingsNotifications.notificationOutcomeBody"),
            },
          });
        } finally {
          // An invalid or unreadable event must not block the whole stream.
          // Its workflow state stays recoverable in the thread and the history.
          recordWebNotificationCursor(organizationId, event.cursor);
        }
      }).catch((error) => {
        console.error("La notification locale du workflow n'a pas pu être traitée.", error);
      });
    }, () => {}, readWebNotificationCursor(organizationId));
    return () => {
      disposed = true;
      stop();
    };
  }, [locale, navigate, preference.enabled, preference.enabledAt, queryClient, revision, t]);

  return null;
}
