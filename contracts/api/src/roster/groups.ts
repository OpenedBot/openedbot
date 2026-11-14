import type { BotFaceSpec } from "../shared/bot-face";

/** One row of a section's order: bots and rooms interleaved. */
type SectionOrderItem = { kind: "bot" | "group"; id: string };

export type SectionOrderInput = { order: SectionOrderItem[] };

/** The order of editable sections, top to bottom; « Non assigné » is not in it, it stays in place. */
export type SectionsOrderInput = { order: string[] };

export type SectionDto = {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
  /** Shared team brief, owned by the operator. Absent on older servers. */
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
  /** Shared room instructions, added to each member's turns. */
  instructions: string;
  /** Explicit mentions always take precedence over this default rule. */
  defaultResponder: GroupDefaultResponder;
  /**
   * `each`: each member answers for themselves. `team`: a member then writes
   * the team's final answer. Optional for APIs older than 0106.
   */
  answerMode?: GroupAnswerMode;
  threadId: string;
  members: GroupMemberDto[];
  sectionId: string;
  position: number;
  /** Optional, to stay compatible with cloud APIs older than 0036. */
  pinned?: boolean;
  /** Rank in the pinned grid (see `BotDto.pinPosition`). Absent before 0159. */
  pinPosition?: number | null;
  needsYou: boolean;
  awaitingApproval: boolean;
  /** Bot/runtime activity later than the current user's last read receipt. */
  unread?: boolean;
  /** Personal preference: the room is removed from the current roster, without being deleted. */
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
