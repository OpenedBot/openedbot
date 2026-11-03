import type { BotFaceSpec } from "../shared/bot-face";

/** Une ligne de l'ordre d'une section : bots et salons entrelacés. */
type SectionOrderItem = { kind: "bot" | "group"; id: string };

export type SectionOrderInput = { order: SectionOrderItem[] };

/** L'ordre des sections éditables, de haut en bas ; « Non assigné » n'y figure pas, il reste en place. */
export type SectionsOrderInput = { order: string[] };

export type SectionDto = {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
  /** Brief d'équipe partagé, appartenant à l'opérateur. Absent sur les anciens serveurs. */
  context?: string;
};

type GroupMemberDto = {
  id: string;
  name: string;
  slug: string;
  face: BotFaceSpec | null;
  voiceId: string | null;
  archivedAt: string | null;
};

export const GROUP_MEMBERS_MIN = 2;

export const GROUP_MEMBERS_MAX = 6;

export type GroupDefaultResponder =
  | { kind: "everyone" }
  | { kind: "mentions" }
  | { kind: "member"; botId: string };

export type GroupDto = {
  id: string;
  name: string;
  /** Instructions communes du salon, ajoutées aux tours de chaque membre. */
  instructions: string;
  /** Les mentions explicites priment toujours sur cette règle par défaut. */
  defaultResponder: GroupDefaultResponder;
  /**
   * `each` : chaque membre répond pour lui. `team` : un membre écrit ensuite
   * la réponse finale de l'équipe. Optionnel pour les API antérieures à 0106.
   */
  answerMode?: GroupAnswerMode;
  threadId: string;
  members: GroupMemberDto[];
  sectionId: string;
  position: number;
  /** Optionnel pour rester compatible avec les cloud API antérieures à 0036. */
  pinned?: boolean;
  /** Rang dans la grille des épinglés (voir `BotDto.pinPosition`). Absent avant 0159. */
  pinPosition?: number | null;
  needsYou: boolean;
  awaitingApproval: boolean;
  /** Activité bot/runtime postérieure au dernier accusé de lecture de l’utilisateur courant. */
  unread?: boolean;
  /** Préférence personnelle : le salon est retiré du roster courant, sans être supprimé. */
  hidden?: boolean;
  running: boolean;
  preview: string | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
};

export type GroupAnswerMode = "each" | "team";

export type CreateGroupInput = {
  name: string;
  memberIds: string[];
  sectionId?: string;
  instructions?: string;
  defaultResponder?: GroupDefaultResponder;
  answerMode?: GroupAnswerMode;
};

export type UpdateGroupInput = Partial<CreateGroupInput & { pinned: boolean }>;
