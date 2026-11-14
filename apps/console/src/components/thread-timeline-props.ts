import type {
  ApprovalRequestDto,
  BotSettingProposalDto,
  MessageAuthorBot,
  MessageVersionFamilyDto,
  MessageVersionLinkDto,
  ProductRunStatus,
  ThreadMessageDto,
} from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { MessageReactionEmoji } from "@openedbot/conversation/domain/message-reply";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";
import type { OutgoingUserInput } from "../lib/thread/thread-anchor";
import type { SpeechSynthesisAdapter } from "../lib/voice/web-speech-synthesis";
import type { MessageAttachmentChip } from "./attachment-canvas";
import type { ThreadLiveText } from "../lib/stream/live-run-text";

export type ThreadTimelineProps = {
  events: StoredProductEvent[];
  /** Persisted messages: identity of the assistant bubbles + replies/reactions. */
  messages?: readonly ThreadMessageDto[];
  userInputs: Array<{
    id: string;
    text: string;
    /** US-CHAT-08: the message's chips, without their payload. */
    attachments?: readonly MessageAttachmentChip[];
    runId: string | null;
    authorBot?: MessageAuthorBot | null;
    /** ISO. Used to interleave by time with the runs that have no message (salons). */
    createdAt?: string;
  }>;
  /**
   * Send in flight, rendered after the memoized entries so `isPending` does
   * not rebuild the transcript. Hidden once the snapshot already has it.
   */
  outgoing?: OutgoingUserInput | null;
  onRetryOutgoing?: () => void;
  approvals: ApprovalRequestDto[];
  /** The bot's proposals on its persona and its settings, rendered in their run's turn. */
  settingProposals?: readonly BotSettingProposalDto[];
  running: boolean;
  mentionables?: MentionableBot[];
  runs?: ReadonlyArray<{
    id: string;
    status: ProductRunStatus;
    completionKind?: string | null;
    routineId?: string | null;
  workflowId?: string | null;
    stepKind?: string | null;
    errorCode?: string | null;
    model?: string | null;
    usage?: { totalTokens?: number; outputTokens?: number } | null;
    /** ISO: the run's bounds, for the real duration shown under the reply. */
    createdAt?: string;
    endedAt?: string | null;
  }>;
  /**
   * Groups: the member whose turn it is, by `runId`. The assistant bubbles
   * of those runs carry its face and its name, and two turns of different
   * members never merge.
   */
  runAuthors?: ReadonlyMap<string, MessageAuthorBot>;
  /**
   * DM: the thread's bot. Its bubbles carry its face and its name, exactly
   * as relayed messages carry their author's.
   */
  defaultAuthor?: MessageAuthorBot | null;
  truncated?: boolean;
  hasOlderHistory?: boolean;
  loadingOlder?: boolean;
  olderError?: boolean;
  onLoadOlder?: (beforeMerge?: () => void) => Promise<boolean>;
  /** Opens the bot's failures section in its settings. */
  onOpenBotErrors?: () => void;
  /** The operator's handle: `@elodie` then reads as `@user` in the ask_user blocks. */
  operatorUsername?: string | null;
  /**
   * The run whose ask_user question is CURRENTLY served by the panel
   * (screen side): its bubble shows only the prose: the question lives in the
   * panel, never twice on screen.
   */
  activeAskUserRunId?: string | null;
  /**
   * The answer chosen on the thread's ask_user card (`AskUserCard`), sent
   * as the operator's message. A stable identity is required: it enters the
   * turns cache's global context.
   */
  onAskUserPick?: (text: string) => void;
  /** Stable target produced by `thread-find`, highlighted after navigation. */
  activeFindTargetId?: string | null;
  onReply?: (messageId: string, quote?: string) => void;
  messageVersionFamilies?: ReadonlyMap<string, MessageVersionFamilyDto>;
  onEditMessage?: (messageId: string) => void;
  onRegenerateMessage?: (messageId: string) => void;
  /**
   * Availability of `onEditMessage`/`onRegenerateMessage`, as DATA rather
   * than in the callback's identity: the screen keeps `beginEdit`/`regenerate`
   * stable and varies this boolean (writing blocked, run in progress, gate
   * waiting, version already being written). Read per turn in the render cache
   * (`turnNodeCache`), never in the global context that would empty the whole
   * thread on every run start/end.
   */
  canEditMessages?: boolean;
  /**
   * Turns whose prose is a plan card (dock), not a bubble.
   * Run identifiers separated by a comma. A string, so the `memo`
   * compares a value and not a fresh array on every render.
   */
  hiddenAssistantRunIds?: string;
  onSelectMessageVersion?: (version: MessageVersionLinkDto) => void;
  onReaction?: (
    messageId: string,
    emoji: MessageReactionEmoji,
    active: boolean,
  ) => void | Promise<void>;
  /** Injectable adapter: in production, only the real Web Speech API is used. */
  speechAdapter?: SpeechSynthesisAdapter;
  /** Conversation identity: any change cancels playback immediately. */
  speechScope?: string;
  /** A half-duplex call exclusively owns the thread's voice engine. */
  speechDisabled?: boolean;
  /** Voice persisted per bot; absent or unknown => client/language fallback. */
  speechVoiceByBotId?: ReadonlyMap<string, string | null>;
  /** A route switch opens the new conversation at its latest turn. */
  scrollToBottomOnThreadKey?: string | null;
  /**
   * Pins the thread to the bottom when this value changes: mounting the
   * ask_user panel shrinks the reading area AFTER the last scroll: without this
   * signal, the final bubble stays cut off behind the panel (measured).
   */
  resnap?: unknown;
  /**
   * The text of the replies in progress, outside the snapshot (`useThreadStream().liveText`):
   * only the live run's bubble subscribes to it. Absent, the timeline reads only its props.
   */
  liveText?: ThreadLiveText | null;
};
