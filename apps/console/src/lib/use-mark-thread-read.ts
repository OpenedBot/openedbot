import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { latestThreadReadThrough, threadHasStreamingRun, type ThreadReadActivity } from "@/lib/thread-read";
import { findRosterThread, markRosterThreadRead } from "@openedbot/conversation/domain/thread-snapshot-mutations";
import type { RosterDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "./api";
import { scheduleInvalidate } from "./query-client";

type ReadVisibility = {
  visibilityState: string;
  hasFocus(): boolean;
};

/**
 * Pendant qu'un run défile, le watermark avance à chaque événement : on ne
 * l'accuse qu'une fois par intervalle, puis au règlement du run avec le
 * dernier watermark. L'ouverture du fil accuse tout de suite.
 */
export const STREAMING_READ_ACK_INTERVAL_MS = 10_000;

export function canAcknowledgeThreadRead(documentState: ReadVisibility | null | undefined): boolean {
  // `document.hasFocus()` is false as soon as the operator clicks another
  // pane (for example Codex next to the browser), even though this visible
  // conversation remains on screen and keeps streaming. Requiring keyboard
  // focus marked the currently open thread unread while its answer was being
  // shown. Page visibility is the browser signal for whether it can be seen.
  return documentState?.visibilityState === "visible";
}

/**
 * Accuse uniquement ce que l'utilisateur a eu la possibilité de voir. Le
 * watermark vient du snapshot, jamais de l'horloge locale, et l'échec remet
 * la tentative en jeu au prochain focus sans masquer le point non lu.
 */
export function useMarkThreadRead(
  threadId: string | undefined,
  activity: ThreadReadActivity | null | undefined,
): void {
  const queryClient = useQueryClient();
  const readThrough = latestThreadReadThrough(activity);
  const streaming = threadHasStreamingRun(activity);
  const submitted = useRef<string | null>(null);
  const ackedThread = useRef<string | null>(null);
  const deferredSince = useRef<number | null>(null);

  useEffect(() => {
    if (!threadId || !readThrough) return;
    const key = `${threadId}:${readThrough}`;
    const acknowledge = () => {
      if (!canAcknowledgeThreadRead(globalThis.document) || submitted.current === key) return;
      submitted.current = key;
      ackedThread.current = threadId;
      deferredSince.current = null;
      void api.markThreadRead(threadId, readThrough)
        .then(() => {
          // Ce que le serveur répondrait, appliqué en cache : la ligne du fil
          // passe en lu. Le relire coûtait un `GET /api/bots` par ouverture
          // de fil.
          const current = queryClient.getQueryData<RosterDto>(queryKeys.roster);
          if (current && findRosterThread(current, threadId)) {
            queryClient.setQueryData<RosterDto>(queryKeys.roster, (roster) => (
              roster ? markRosterThreadRead(roster, threadId) : roster
            ));
            return;
          }
          // Ligne absente du cache (le `GET /api/bots` du démarrage n'est pas
          // encore revenu, ou fil hors roster). Une lecture déjà en vol reste
          // valable : servie après le `POST …/read`, elle reflète `read_at` ;
          // servie avant, la relecture coalescée (sans annuler celle en vol)
          // rattrape. Un `invalidateQueries` immédiat annulait le `/bots` du
          // démarrage et le relançait : deux requêtes pour une.
          scheduleInvalidate(queryKeys.roster);
        })
        .catch(() => {
          if (submitted.current === key) submitted.current = null;
        });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (streaming && ackedThread.current === threadId) {
      // Run en cours sur un fil déjà accusé : on diffère, sans repousser
      // l'échéance à chaque événement.
      const now = Date.now();
      deferredSince.current ??= now;
      const wait = Math.max(0, deferredSince.current + STREAMING_READ_ACK_INTERVAL_MS - now);
      if (wait > 0) timer = setTimeout(acknowledge, wait);
      else acknowledge();
    } else {
      acknowledge();
    }
    globalThis.window?.addEventListener("focus", acknowledge);
    globalThis.document?.addEventListener("visibilitychange", acknowledge);
    return () => {
      if (timer) clearTimeout(timer);
      globalThis.window?.removeEventListener("focus", acknowledge);
      globalThis.document?.removeEventListener("visibilitychange", acknowledge);
    };
  }, [queryClient, readThrough, streaming, threadId]);
}
