import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { RosterDto } from "@openedbot/contracts-api";
import type { ThreadSnapshot } from "@openedbot/contracts-api";
import { activeOrganizationId, cloudSessionRevision, subscribeCloudSession } from "../lib/cloud-session";
import { api, queryKeys, type ThreadView } from "../lib/api";
import { conversationPath } from "../lib/conversation-href";
import { readNewestThreadSnapshot } from "../lib/thread-stream-safety";
import { subscribeToOrganizationEvents } from "../lib/use-thread-stream";
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
} from "../lib/web-workflow-notifications";

/**
 * Pont global du flux SSE vers l'API Notification du navigateur.
 *
 * Il vit au-dessus des routes : un workflow reste observable quand on quitte
 * son fil pour les Réglages. Il ne crée aucun Service Worker et ne peut donc
 * rien livrer une fois la page fermée : cette frontière est affichée dans les
 * réglages, jamais masquée par ce composant sans interface.
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
    // Les callbacks SSE sont synchrones. La chaîne garde l'ordre des lectures
    // et des checkpoints, même quand deux transitions arrivent dans le même
    // tick du poller.
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
              // Repli : ni le fil permanent d'un bot ni celui d'un salon,
              // c'est une branche de variante de message. Le fil lui-même dit
              // à quel bot il appartient, ce qui vaut mieux que l'ancien
              // balayage du cache des tâches : ce cache n'existe plus, et son
              // repli ne résolvait donc plus jamais rien.
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
              // La route reste dans cette fermeture de page : elle n'entre pas
              // dans le payload remis au système d'exploitation.
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
          // Un événement invalide/illisible ne doit pas bloquer le flux entier.
          // Son état de workflow reste récupérable dans le fil et l'historique.
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
