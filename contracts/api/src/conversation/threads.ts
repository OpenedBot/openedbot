import type { OrganizationEvent, StoredProductEvent } from "@openedbot/contracts-events";
import type { RunDto, WorkflowDto } from "../execution/runs";
import type { BotFaceSpec } from "../shared/bot-face";
import type { MessageContent } from "../shared/domain";

/**
 * L'auteur d'un message quand ce n'est pas l'opérateur mais un AUTRE bot
 * (bot mode, hand-off). `name`/`slug`/`face` sont relus au moment de la
 * lecture ; nuls si le bot a été supprimé depuis : l'attribution, elle,
 * survit (l'`id` reste).
 */
export type MessageAuthorBot = {
  id: string;
  name: string | null;
  slug: string | null;
  face: BotFaceSpec | null;
};

export type MessageReactionDto = {
  emoji: string;
  count: number;
  reactedByMe: boolean;
};

export type MessageReplyPreview = {
  id: string;
  role: "user" | "assistant";
  content: MessageContent;
  authorBot?: MessageAuthorBot | null;
};

export type ThreadMessageDto = {
  id: string;
  /** Stable per-thread ordering across pages; string preserves PostgreSQL bigint. */
  sequence?: string;
  /** Correlates this operator's optimistic send with its persisted message. */
  clientSubmissionId?: string | null;
  role: "user" | "assistant";
  content: MessageContent;
  runId: string | null;
  createdAt: string;
  /**
   * Posé quand le message a été écrit par un autre bot. Un `user` avec
   * `authorBot` se rend comme une bulle du bot auteur, jamais comme celle de
   * l'opérateur. Optionnel : les fixtures antérieures restent valides.
   */
  authorBot?: MessageAuthorBot | null;
  /** Réponse plate : aperçu de la cible, sans créer de sous-fil imbriqué. */
  replyTo?: MessageReplyPreview | null;
  /** Agrégat par emoji; `reactedByMe` rend l'ajout/retrait idempotent côté client. */
  reactions?: MessageReactionDto[];
};

/**
 * Tout ce que la vue conversation a besoin de savoir, en une lecture.
 *
 * `cursor` est le curseur d'événement le plus haut déjà appliqué : c'est lui qui
 * permet au SSE de reprendre sans rejouer, et à `applyProductEventToSnapshot`
 * d'ignorer un événement déjà vu.
 */
/** Le salon d'un groupe, vu du fil : de quoi nommer et dessiner ses membres. */
export type ThreadGroupInfo = {
  id: string;
  name: string;
  members: Array<{ id: string; name: string; slug: string; face: BotFaceSpec | null; voiceId: string | null }>;
};

export type ThreadSnapshot = {
  id: string;
  /** `null` pour le salon d'un groupe : voir `group`. */
  botId: string | null;
  title: string;
  botName: string | null;
  /** Posé sur le salon d'un groupe ; absent/`null` sur un fil DM. */
  group?: ThreadGroupInfo | null;
  /** Résumé du salon : `null` s'il n'a jamais été compacté. Absent sur une API antérieure. */
  compaction?: ThreadCompactionDto | null;
  instructions: string;
  model: string;
  /** Modèle résolu au moment de la lecture (réglage du bot, sinon défaut runtime). */
  effectiveModel: string;
  createdAt: string;
  updatedAt: string;
  messages: ThreadMessageDto[];
  runs: RunDto[];
  /**
   * La même enveloppe que le flux SSE (`organizationEventEnvelope`) ;
   * l'identité est absente sur une API antérieure.
   */
  events: Array<StoredProductEvent & Partial<Pick<OrganizationEvent,
    "version" | "organizationId" | "threadId" | "botId" | "turnId" | "sessionKey" | "leaseGeneration">>>;
  /** Optionnel pour préserver la compatibilité des anciens clients. */
  workflows?: WorkflowDto[];
  cursor: number;
  /**
   * `max(cursor)` de l'ORGANISATION, lu dans la même transaction que ce
   * snapshot. C'est le point d'attache du flux SSE : en partir, il n'y a rien
   * à rejouer par construction. `cursor` ci-dessus est celui du fil : un fil
   * inactif depuis dix jours ferait rejouer tout ce que l'organisation a
   * produit depuis. Absent sur une API antérieure : repli sur `cursor`.
   */
  organizationCursor?: number;
  /**
   * Le fil dépasse ce qu'une lecture sort de la base
   * (`THREAD_SNAPSHOT_LIMITS`, côté API) : les runs et messages les plus
   * ANCIENS ne sont pas ici. Jamais silencieux : l'interface le dit, sinon
   * un fil tronqué se lit comme un fil complet.
   */
  truncated: boolean;
  /**
   * Older transcript pages use their own cursor, independent of live SSE.
   * Initial page can also include an old active workflow: merge row IDs across pages.
   */
  history?: {
    nextBefore: string | null;
    hasMore: boolean;
    turnKeys: string[];
  };
};

/**
 * `POST /api/threads/:id/messages` 202. A previous server only returned
 * `runId` / `workflowId` / `status`. `message` (and `run` when a new run was
 * created) let the client patch the snapshot instead of rereading the thread.
 * `workflowId` is null for a plain DM turn (no room, handoff or autonomy):
 * such a turn has no workflow, and `workflow` is then absent.
 */
export type SendMessageAccepted = {
  runId: string;
  workflowId: string | null;
  status: string;
  notificationEligible?: boolean;
  workflowUpdatedAt?: string;
  steerTargetRunId?: string;
  supersededRunId?: string;
  foldedIntoRunId?: string;
  message?: ThreadMessageDto;
  run?: RunDto;
  workflow?: WorkflowDto;
  events?: StoredProductEvent[];
};

/**
 * Jusqu'où l'historique d'un salon est résumé (DEV-331/332). Une seule ligne par
 * fil, commune à tous les membres : `ThreadSnapshot.compaction` est `null` tant
 * que le salon n'a jamais été compacté.
 */
export type ThreadCompactionDto = {
  /** Séquence du dernier message plié dans le résumé. */
  compactedThroughSequence: number;
  /** Instant de la dernière compaction (ISO 8601 UTC). */
  compactedAt: string;
};

/** Réponse de `POST /api/threads/:threadId/compact` : le salon a bien été résumé. */
export type ThreadCompactResult = {
  /** Toujours `true` : un résumé qui n'a rien changé répond par une erreur lisible. */
  compacted: true;
  /** Messages pliés dans le résumé par CET appel. */
  summarizedCount: number;
  compactedThroughSequence: number;
  compactedAt: string;
};

/**
 * Seuil minimal de « Compacter l'historique du salon », en caractères de texte
 * non encore résumé : la queue récente (KEEP) que la compaction ne plie jamais,
 * soit 35 % de `HISTORY_CHAR_BUDGET` (48 000). En dessous, tout tient dans la
 * queue et il n'y a rien à plier. Le serveur reste l'autorité (422) ; la console
 * ne s'en sert que pour désactiver le bouton avec la raison. Un test de
 * `modules/conversation` garde cette valeur égale à celle du domaine.
 */
export const ROOM_COMPACT_MIN_CHARS = 16_800;
