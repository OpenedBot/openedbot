import type { SupportHistoryDto, SupportOpenedDto, SupportSnapshotDto } from "@openedbot/contracts-api";
import type { MessageAttachmentInput } from "@openedbot/conversation/domain/attachments";
import { request, sharedRead, supportTokenHeader } from "./http";

export const supportApi = {
  /**
   * Le guichet de support. Hors tenant, sans session : le jeton du visiteur
   * voyage dans `X-OHB-Support-Token`, jamais dans un cookie.
   *
   * `tokenOverride: ""` n'est pas une coquetterie. Sans lui, un 401 sur ces
   * routes passerait par le nettoyage de session de `attempt()` et
   * DÉCONNECTERAIT un opérateur dont le seul tort est d'avoir un jeton de
   * support périmé. C'est le mécanisme déjà prévu pour les routes publiques du
   * SSO : un 401 y est la réponse à une question, pas une perte d'identité.
   */
  support: {
    /**
     * Ouvre un fil.
     *
     * `email` n'est envoyé QUE par un visiteur sans compte : quand la requête
     * porte une session, le serveur prend l'adresse du compte et ignore celle
     * du corps. `body` accompagne l'ouverture sur ce chemin-là, puisque rien
     * d'autre ne marque l'intention d'écrire.
     *
     * Pas de méthode « reprendre » : le fil déjà connu de ce navigateur se
     * relit par `snapshot`, qui est un GET. Un POST aurait consommé le plafond
     * de trois ouvertures par minute à chaque fois qu'on rouvre le panneau.
     */
    open: (input: {
      email?: string;
      locale: "fr" | "en";
      body?: string;
      fresh?: boolean;
      attachments?: readonly MessageAttachmentInput[];
    }) =>
      request<SupportOpenedDto>("/api/support/conversations", {
        method: "POST",
        body: JSON.stringify(input),
      }, { tokenOverride: "", skipOrganizationHeader: true }),

    /**
     * L'historique de ce visiteur : le fil de son jeton, et les fils de son
     * compte s'il est connecté. Un GET, donc hors du plafond de trois
     * ouvertures par minute.
     */
    // Shared while in flight: the unread watch reads it from an effect, which
    // StrictMode runs twice in development.
    history: (token: string | null) =>
      sharedRead(`support-history:${token ?? ""}`, () => request<SupportHistoryDto>("/api/support/conversations", {
        headers: supportTokenHeader(token),
      }, { tokenOverride: "", skipOrganizationHeader: true })),

    snapshot: (conversationId: string, token: string | null) =>
      request<SupportSnapshotDto>(`/api/support/conversations/${conversationId}`, {
        headers: supportTokenHeader(token),
      }, { tokenOverride: "", skipOrganizationHeader: true }),

    send: (
      conversationId: string,
      token: string | null,
      body: string,
      idempotencyKey: string,
      attachments: readonly MessageAttachmentInput[] = [],
    ) =>
      request<SupportSnapshotDto>(`/api/support/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { ...supportTokenHeader(token), "Idempotency-Key": idempotencyKey },
        // Les captures voyagent INLINE dans le corps, encodées en base64,
        // comme celles du fil des bots : une seule requête, donc un message et
        // ses images arrivent ensemble ou pas du tout.
        body: JSON.stringify(attachments.length > 0 ? { body, attachments } : { body }),
      }, { tokenOverride: "", skipOrganizationHeader: true }),

    markRead: (conversationId: string, token: string | null) =>
      request<void>(`/api/support/conversations/${conversationId}/read`, {
        method: "POST",
        headers: supportTokenHeader(token),
      }, { tokenOverride: "", skipOrganizationHeader: true }),

    typing: (conversationId: string, token: string | null) =>
      request<void>(`/api/support/conversations/${conversationId}/typing`, {
        method: "POST",
        headers: supportTokenHeader(token),
      }, { tokenOverride: "", skipOrganizationHeader: true }),
  },
};
