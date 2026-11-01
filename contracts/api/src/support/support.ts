/* ------------------------------------------------------------------------- *
 * Guichet de support
 *
 * Deux clients, un seul modèle. `apps/console` parle aux routes publiques
 * `/api/support/*` avec le jeton du visiteur, `apps/admin` aux routes
 * `/api/pro/staff/support/*` avec sa session staff. Les deux lisent les MÊMES
 * formes : un fil de support n'a pas deux vérités selon qui le regarde.
 * ------------------------------------------------------------------------- */

/** Le côté qui parle. `agent` n'existe pas encore : le staff répond à la main. */
const SUPPORT_AUTHORS = ["guest", "staff"] as const;

export type SupportAuthor = (typeof SUPPORT_AUTHORS)[number];

const SUPPORT_STATUSES = ["open", "closed"] as const;

export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/**
 * Plafond d'un message, partagé par le composer et la route pour qu'ils
 * refusent la même chose : un texte accepté à l'écran puis rejeté en 413
 * perdrait ce que la personne vient d'écrire.
 */
export const SUPPORT_MESSAGE_MAX_CHARS = 4_000;

export type SupportMessageDto = {
  id: string;
  author: SupportAuthor;
  /** Le nom affiché du staff qui a répondu, jamais son adresse. */
  staffName: string | null;
  /**
   * Le texte, en MARKDOWN restreint.
   *
   * Les deux côtés le rendent (gras, listes, liens, code, tableaux), et aucun
   * des deux ne rend d'HTML brut : `react-markdown` l'ignore par défaut, et
   * c'est ce qui rend sûr d'afficher le texte d'un inconnu.
   */
  body: string;
  /**
   * Les captures du bug, s'il y en a. Jamais les octets : seulement leur
   * identité, servie à la demande par `GET /api/support/attachments/:id`. Un
   * fil relu six mois plus tard réaffiche donc ses images sans que la lecture
   * du fil transporte leur poids.
   */
  attachments: SupportAttachmentDto[];
  createdAt: string;
};

/** Une pièce jointe d'un message de support. Images seulement. */
export type SupportAttachmentDto = {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
};

/**
 * Ce que rend `POST /api/support/conversations`. Le jeton est rendu UNE FOIS,
 * ici et nulle part ailleurs : seul son condensat est en base.
 */
export type SupportOpenedDto = {
  conversationId: string;
  token: string;
  snapshot: SupportSnapshotDto;
};

/**
 * L'instantané d'un fil, et le point d'attache du flux.
 *
 * `cursor` est le dernier curseur déjà contenu dans `messages` : le client
 * ouvre le SSE à cette valeur, donc il n'y a rien à rejouer par construction.
 * C'est le même contrat que `ThreadSnapshot.organizationCursor`.
 */
export type SupportSnapshotDto = {
  conversationId: string;
  email: string;
  status: SupportStatus;
  messages: SupportMessageDto[];
  cursor: number;
  /**
   * Combien de réponses du staff sont arrivées APRÈS la dernière lecture du
   * visiteur. C'est le compteur de la bulle, et il vient du serveur : le
   * client ne peut pas le calculer, puisque la réponse arrive quand le
   * panneau est fermé.
   */
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * Une ligne de l'historique du visiteur.
 *
 * Pas d'adresse : le visiteur connaît la sienne, et le fil ouvert la porte
 * déjà. Pas de corps de message non plus, seulement son début : l'historique
 * dit de quoi il s'agit, le fil se lit à son tour.
 */
export type SupportThreadSummaryDto = {
  conversationId: string;
  status: SupportStatus;
  unreadCount: number;
  /**
   * Le dernier curseur déjà compté dans `unreadCount`.
   *
   * La bulle s'abonne au flux à cette valeur : sans elle, elle rejouerait
   * l'historique du fil et compterait une seconde fois des réponses que
   * `unreadCount` porte déjà.
   */
  cursor: number;
  messageCount: number;
  lastMessageAuthor: SupportAuthor | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Ce que rend `GET /api/support/conversations`.
 *
 * Un visiteur sans compte n'a qu'un fil, celui de son jeton. Un opérateur
 * connecté en a autant qu'il en a ouverts, et ils suivent son COMPTE, pas son
 * navigateur : c'est la seule façon de retrouver une réponse depuis une autre
 * machine.
 */
export type SupportHistoryDto = {
  conversations: SupportThreadSummaryDto[];
};

/**
 * Une trame du flux de support, telle qu'elle arrive dans `data:`.
 *
 * `cursor` vaut `0` pour les trames éphémères (la frappe), qui ne sont jamais
 * persistées et ne portent donc pas d'`id:` : elles ne doivent pas faire
 * avancer le `Last-Event-ID` d'un client qui se reconnecte.
 */
export type SupportEventDto = {
  cursor: number;
  conversationId: string;
  type: SupportEventType;
  payload: Record<string, unknown>;
  occurredAt: string;
};

const SUPPORT_EVENT_TYPES = [
  "support.opened",
  "support.message",
  "support.status",
  "support.assigned",
  "support.read",
  "support.typing",
] as const;

export type SupportEventType = (typeof SUPPORT_EVENT_TYPES)[number];
