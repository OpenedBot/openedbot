import { useEffect, useState } from "react";
import type { SupportEventDto, SupportHistoryDto, SupportThreadSummaryDto } from "@openedbot/contracts-api";
import { api } from "./api";
import { readCloudSession } from "./cloud-session";
import { readSupportSession } from "./support-session";
import { openSupportStream, type SupportStreamHandle } from "./support-stream";
import { useSecondaryReadsReady } from "./after-first-paint";

/**
 * La veille du guichet, panneau FERMÉ.
 *
 * Le panneau n'est monté qu'à l'ouverture, et c'est voulu. Mais quelqu'un qui
 * attend une réponse ne va pas rouvrir un panneau toutes les dix minutes pour
 * voir si elle est arrivée : sans ce guetteur, la réponse du staff n'existait
 * que pour celui qui avait le panneau sous les yeux.
 *
 * Trois règles tiennent ce fichier.
 *
 * 1. **Rien ne coûte rien à qui n'a rien.** Un visiteur qui n'a ni jeton ni
 *    session n'a aucun fil : aucune requête ne part, aucun flux ne s'ouvre.
 *    La bulle reste ce qu'elle était, un bouton.
 * 2. **Le compteur vient du SERVEUR.** `unreadCount` est calculé en base
 *    (les réponses arrivées après `guest_read_at`), parce que le client était
 *    fermé quand elles sont arrivées. Le flux ne fait qu'INCRÉMENTER ce que le
 *    serveur a déjà dit, en s'abonnant au curseur que l'historique rend : sans
 *    ce curseur, le rejeu du fil compterait une deuxième fois.
 * 3. **UN seul flux par onglet.** Le guetteur rend la main dès que le panneau
 *    s'ouvre : c'est lui qui tient alors le fil, et deux flux sur la même
 *    conversation feraient deux fois le travail. À la fermeture, le guetteur
 *    relit l'historique plutôt que de deviner : le panneau a marqué le fil lu,
 *    et la vérité de cette lecture est en base.
 */

let unread = 0;
let stream: SupportStreamHandle | null = null;
const listeners = new Set<() => void>();

function publish(next: number): void {
  const value = Math.max(0, next);
  if (value === unread) return;
  unread = value;
  for (const listener of listeners) listener();
}

function closeStream(): void {
  stream?.close();
  stream = null;
}

/** Le total des réponses non lues, tous fils confondus. */
export function sumSupportUnread(history: SupportHistoryDto): number {
  return history.conversations.reduce((total, conversation) => total + conversation.unreadCount, 0);
}

/**
 * Le fil à surveiller : le plus récemment actif.
 *
 * Un seul, pas tous : le flux du guichet est indexé par conversation, et
 * quelqu'un qui attend une réponse l'attend sur son dernier fil. Les autres
 * gardent le compte que le serveur a rendu.
 */
export function supportWatchTarget(history: SupportHistoryDto): SupportThreadSummaryDto | null {
  return history.conversations[0] ?? null;
}

/** Vrai quand la trame est une réponse du staff, donc quelque chose à signaler. */
export function isStaffReply(event: SupportEventDto): boolean {
  return event.type === "support.message" && event.payload.author === "staff";
}

export function supportUnreadCount(): number {
  return unread;
}

/** Le compteur, pour la bulle et pour le bouton d'en-tête. */
export function useSupportUnread(): number {
  const [value, setValue] = useState(unread);
  useEffect(() => {
    const listener = () => setValue(unread);
    listeners.add(listener);
    // Une réponse arrivée entre le premier rendu et l'abonnement serait sinon
    // perdue : les deux portes du panneau ne se montent pas au même instant.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}

/**
 * Le guetteur lui-même, monté UNE fois par `SupportLauncher`.
 *
 * `panelOpen` n'est pas une dépendance de confort : c'est le passage de
 * relais. Panneau ouvert, le guetteur se retire et remet le compteur à zéro,
 * puisque ce qui est à l'écran est lu.
 */
export function useSupportWatch(panelOpen: boolean): void {
  const secondaryReady = useSecondaryReadsReady();
  useEffect(() => {
    if (!secondaryReady && !panelOpen) return;
    if (panelOpen) {
      closeStream();
      publish(0);
      return;
    }
    const token = readSupportSession()?.token ?? null;
    // Une session locale suffit à DÉCIDER DE DEMANDER ; c'est le serveur qui
    // décide de répondre, sur la session qu'il lit lui-même.
    if (!token && readCloudSession() === null) {
      publish(0);
      return;
    }
    let cancelled = false;
    void api.support
      .history(token)
      .then((history) => {
        if (cancelled) return;
        publish(sumSupportUnread(history));
        const target = supportWatchTarget(history);
        if (!target) return;
        closeStream();
        stream = openSupportStream({
          conversationId: target.conversationId,
          // Le jeton n'ouvre QUE le fil de ce navigateur. Pour un fil trouvé
          // par le compte, il ne vaut rien : la session prend la relève.
          token: readSupportSession()?.conversationId === target.conversationId ? token : null,
          cursor: target.cursor,
          handlers: {
            onEvent: (event) => {
              if (isStaffReply(event)) publish(unread + 1);
            },
          },
        });
      })
      .catch(() => {
        // Le guichet injoignable ne doit pas faire de bruit sur un écran qui
        // parle d'autre chose. La bulle reste un bouton.
      });
    return () => {
      cancelled = true;
      closeStream();
    };
  }, [panelOpen, secondaryReady]);
}
