/**
 * Types du domaine partagés par l'API cloud et les clients.
 *
 * Ils décrivent la forme des données, pas leur stockage. Les garder ici évite
 * d'embarquer le driver PostgreSQL dans les bundles UI.
 */

export type MessageContent = Array<
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: unknown;
    }
  /**
   * Une pièce jointe, telle que le FIL la montre (US-CHAT-08) : son identité
   * et l'`id` de la ligne qui garde ses octets, pas les octets eux-mêmes. Le
   * fichier RESTE dans le message (table `message_attachments`, servie par
   * `GET /api/attachments/:id`) ; l'inliner ici ferait porter à chaque lecture
   * de fil le poids de toutes ses images, y compris quand personne ne les
   * regarde.
   */
  | {
      type: "attachment";
      /**
       * La ligne `message_attachments` qui garde le fichier,
       * `GET /api/attachments/:id`.
       *
       * OPTIONNEL, et ça n'est pas une commodité : les messages écrits entre
       * l'arrivée des pièces jointes et leur rangement durable portent une part
       * sans identifiant, parce que leur fichier n'a jamais été rangé nulle
       * part. Le typer obligatoire ferait mentir la base, et une clé React
       * `undefined` est le premier symptôme qu'on récolte. Sans `id`, une
       * pièce se lit mais ne s'ouvre pas : il n'y a rien à ouvrir.
       */
      id?: string;
      name: string;
      contentType: string;
      kind: "image" | "document";
      /** Taille du fichier d'origine, pas de son encodage : voir `attachmentBytes`. */
      bytes: number;
    }
>;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type RuntimeHealthStatus =
  | "unknown"
  | "healthy"
  | "unreachable"
  | "unauthorized"
  | "missing_feature"
  /** Runtime `connector` dont le lien n'est pas ouvert : l'hôte ne s'est pas présenté. */
  | "disconnected"
  /**
   * Joignable, token accepté, et pourtant aucun bot ne répondra, faute de
   * fournisseur d'inférence authentifié. C'est l'état d'une installation
   * fraîche, et le confondre avec `healthy` était le mensonge du bouton
   * « Tester » : URL, token et fournisseur sont trois réglages, pas un seul.
   */
  | "no_provider";
