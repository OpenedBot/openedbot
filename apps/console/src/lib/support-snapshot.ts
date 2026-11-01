import type { SupportMessageDto, SupportSnapshotDto } from "@openedbot/contracts-api";

/**
 * Comment une trame du guichet modifie l'instantané affiché.
 *
 * Pur, hors React, et testé : c'est ici que se jouent les trois façons
 * d'afficher faux.
 *
 * 1. **Le doublon.** Un message arrive DEUX fois : une fois dans la réponse
 *    du POST (l'instantané rendu par l'API) et une fois par le flux. La clé
 *    est l'identifiant du message, pas sa position.
 * 2. **L'ordre.** Une trame rejouée après une reconnexion peut arriver après
 *    une plus récente déjà appliquée. La liste est donc triée par date puis
 *    par identifiant, jamais simplement concaténée.
 * 3. **Le message optimiste.** La bulle du visiteur s'affiche avant la
 *    réponse du serveur, avec un identifiant temporaire. Quand le vrai
 *    message arrive, le temporaire doit DISPARAÎTRE, sinon le visiteur voit
 *    son texte deux fois.
 */

/** Préfixe des bulles posées avant la réponse du serveur. */
export const PENDING_PREFIX = "pending:";

export function pendingMessage(id: string, body: string): SupportMessageDto {
  return {
    id: `${PENDING_PREFIX}${id}`,
    author: "guest",
    staffName: null,
    body,
    // La bulle optimiste ne porte PAS les captures : elles n'ont pas encore
    // d'identité, et le fil ne les sert que par identifiant. Elles
    // apparaissent avec la réponse du serveur, une seconde plus tard.
    attachments: [],
    createdAt: new Date().toISOString(),
  };
}

export function isPendingMessage(message: SupportMessageDto): boolean {
  return message.id.startsWith(PENDING_PREFIX);
}

function sortMessages(messages: readonly SupportMessageDto[]): SupportMessageDto[] {
  return [...messages].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
    return left.id < right.id ? -1 : 1;
  });
}

export function appendSupportMessage(
  snapshot: SupportSnapshotDto,
  message: SupportMessageDto,
): SupportSnapshotDto {
  if (snapshot.messages.some((existing) => existing.id === message.id)) return snapshot;
  return { ...snapshot, messages: sortMessages([...snapshot.messages, message]) };
}

/**
 * Fusionne l'instantané rendu par le serveur avec les bulles optimistes
 * encore en vol.
 *
 * Une bulle optimiste est retenue tant que le serveur n'a pas rendu un
 * message du visiteur avec le même texte : sinon l'envoi clignoterait entre
 * « affiché » et « disparu » le temps d'un aller-retour.
 */
export function mergeSupportSnapshot(
  previous: SupportSnapshotDto | null,
  next: SupportSnapshotDto,
): SupportSnapshotDto {
  const pending = (previous?.messages ?? []).filter(isPendingMessage).filter(
    (bubble) => !next.messages.some(
      (message) => message.author === "guest" && message.body === bubble.body,
    ),
  );
  return { ...next, messages: sortMessages([...next.messages, ...pending]) };
}

export type SupportFrame = {
  cursor: number;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
};

/**
 * Applique une trame. Rend le MÊME objet quand rien ne change : l'appelant
 * peut donc s'en servir comme état React sans provoquer un rendu inutile.
 */
export function applySupportFrame(
  snapshot: SupportSnapshotDto,
  frame: SupportFrame,
): SupportSnapshotDto {
  if (frame.type === "support.message") {
    const message = readMessage(frame);
    if (!message) return snapshot;
    // Le serveur a confirmé un message du visiteur : la bulle optimiste du
    // même texte n'a plus de raison d'être.
    const withoutPending = message.author === "guest"
      ? {
          ...snapshot,
          messages: snapshot.messages.filter(
            (existing) => !(isPendingMessage(existing) && existing.body === message.body),
          ),
        }
      : snapshot;
    return appendSupportMessage(withoutPending, message);
  }
  if (frame.type === "support.status") {
    const status = frame.payload.status;
    if (status !== "open" && status !== "closed") return snapshot;
    if (snapshot.status === status) return snapshot;
    return { ...snapshot, status };
  }
  return snapshot;
}

function readMessage(frame: SupportFrame): SupportMessageDto | null {
  const messageId = frame.payload.messageId;
  const author = frame.payload.author;
  const body = frame.payload.body;
  if (typeof messageId !== "string" || typeof body !== "string") return null;
  if (author !== "guest" && author !== "staff") return null;
  const staffName = frame.payload.staffName;
  return {
    id: messageId,
    author,
    staffName: author === "staff" && typeof staffName === "string" ? staffName : null,
    body,
    // Une trame ne transporte pas l'identité des captures, seulement leur
    // NOMBRE (`attachmentCount`) : un flux SSE n'est pas un canal d'images.
    // L'écran qui voit ce compte relit le fil, et c'est cette relecture qui
    // fait apparaître l'image. Inventer des identifiants ici donnerait des
    // images cassées.
    attachments: [],
    createdAt: frame.occurredAt,
  };
}

/** Combien de captures accompagnent la trame : l'écran sait qu'il doit relire. */
export function frameAttachmentCount(frame: SupportFrame): number {
  const count = frame.payload.attachmentCount;
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
}
