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

export type ThreadTimelineProps = {
  events: StoredProductEvent[];
  /** Messages persistés : identité des bulles assistant + réponses/réactions. */
  messages?: readonly ThreadMessageDto[];
  userInputs: Array<{
    id: string;
    text: string;
    /** US-CHAT-08 : les puces du message, sans leur charge. */
    attachments?: readonly MessageAttachmentChip[];
    runId: string | null;
    authorBot?: MessageAuthorBot | null;
    /** ISO. Sert à entrelacer par le temps avec les runs sans message (salons). */
    createdAt?: string;
  }>;
  /**
   * Send in flight, rendered after the memoized entries so `isPending` does
   * not rebuild the transcript. Hidden once the snapshot already has it.
   */
  outgoing?: OutgoingUserInput | null;
  onRetryOutgoing?: () => void;
  approvals: ApprovalRequestDto[];
  /** Propositions du bot sur sa persona et ses réglages, rendues dans le tour de leur run. */
  settingProposals?: readonly BotSettingProposalDto[];
  running: boolean;
  mentionables?: MentionableBot[];
  runs?: ReadonlyArray<{
    id: string;
    status: ProductRunStatus;
    completionKind?: string | null;
    workflowId?: string | null;
    stepKind?: string | null;
    errorCode?: string | null;
    model?: string | null;
    usage?: { totalTokens?: number; outputTokens?: number } | null;
    /** ISO : bornes du run, pour la durée réelle affichée sous la réponse. */
    createdAt?: string;
    endedAt?: string | null;
  }>;
  /**
   * Groupes : le membre dont c'est le tour, par `runId`. Les bulles assistant
   * de ces runs portent son visage et son nom, et deux tours de membres
   * différents ne fusionnent jamais.
   */
  runAuthors?: ReadonlyMap<string, MessageAuthorBot>;
  /**
   * DM : le bot du fil. Ses bulles portent son visage et son nom, exactement
   * comme les messages relayés portent ceux de leur auteur.
   */
  defaultAuthor?: MessageAuthorBot | null;
  truncated?: boolean;
  hasOlderHistory?: boolean;
  loadingOlder?: boolean;
  olderError?: boolean;
  onLoadOlder?: (beforeMerge?: () => void) => Promise<boolean>;
  /** Ouvre la rubrique des échecs du bot dans ses réglages. */
  onOpenBotErrors?: () => void;
  /** Le handle de l'opérateur : `@elodie` se lit alors comme `@user` dans les blocs ask_user. */
  operatorUsername?: string | null;
  /**
   * Le run dont la question ask_user est ACTUELLEMENT servie par le panneau
   * (côté écran) : sa bulle ne montre que la prose : la question vit dans le
   * panneau, jamais deux fois à l'écran.
   */
  activeAskUserRunId?: string | null;
  /**
   * La réponse choisie sur la carte ask_user du fil (`AskUserCard`), envoyée
   * comme message de l'opérateur. Identité stable exigée : elle entre dans le
   * contexte global du cache des tours.
   */
  onAskUserPick?: (text: string) => void;
  /** Cible stable produite par `thread-find`, mise en évidence après navigation. */
  activeFindTargetId?: string | null;
  onReply?: (messageId: string, quote?: string) => void;
  messageVersionFamilies?: ReadonlyMap<string, MessageVersionFamilyDto>;
  onEditMessage?: (messageId: string) => void;
  onRegenerateMessage?: (messageId: string) => void;
  /**
   * Disponibilité de `onEditMessage`/`onRegenerateMessage`, en DONNÉE plutôt
   * que dans l'identité du callback : l'écran garde `beginEdit`/`regenerate`
   * stables et fait varier ce booléen (écriture bloquée, run en cours, gate
   * en attente, version déjà en écriture). Lu par tour dans le cache de rendu
   * (`turnNodeCache`), jamais dans le contexte global qui viderait tout le
   * fil à chaque démarrage/fin de run.
   */
  canEditMessages?: boolean;
  /**
   * Tours dont la prose est une carte de plan (dock), pas une bulle.
   * Identifiants de run séparés par une virgule. Chaîne, pour que le `memo`
   * compare une valeur et pas un tableau neuf à chaque rendu.
   */
  hiddenAssistantRunIds?: string;
  onSelectMessageVersion?: (version: MessageVersionLinkDto) => void;
  onReaction?: (
    messageId: string,
    emoji: MessageReactionEmoji,
    active: boolean,
  ) => void | Promise<void>;
  /** Adaptateur injectable : en production, seule la vraie Web Speech API est utilisée. */
  speechAdapter?: SpeechSynthesisAdapter;
  /** Identité de conversation : tout changement annule immédiatement la lecture. */
  speechScope?: string;
  /** Un appel half-duplex possède exclusivement le moteur vocal du fil. */
  speechDisabled?: boolean;
  /** Voix persistée par bot ; absente ou inconnue => repli client/langue. */
  speechVoiceByBotId?: ReadonlyMap<string, string | null>;
  /** A route switch opens the new conversation at its latest turn. */
  scrollToBottomOnThreadKey?: string | null;
  /**
   * Recale le fil en bas quand cette valeur change : le montage du panneau
   * ask_user rétrécit la zone de lecture APRÈS le dernier scroll : sans ce
   * signal, la bulle finale reste coupée derrière le panneau (mesuré).
   */
  resnap?: unknown;
};
