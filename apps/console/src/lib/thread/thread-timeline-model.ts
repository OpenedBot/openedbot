import type { RailPosition } from "@openedbot/browser-ui-kit";
import type {
  ApprovalRequestDto,
  MessageAuthorBot,
  MessageContent,
  MessageReactionDto,
  MessageReplyPreview,
  ProductRunStatus,
  ThreadMessageDto,
} from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import { isAbsorbedRun } from "@openedbot/conversation/domain/followup";
import { eventText, rendersNothing } from "./thread-event-text";
import { eventsAppendedFrom } from "@openedbot/conversation/domain/thread-snapshot-mutations";
import {
  readAttachment,
  readToolOutcome,
  runToolTerminalStates,
  toolCallKey,
  type ToolAttachment,
  type ToolCall,
  type ToolOutcome,
} from "@openedbot/conversation/domain/thread-tools";
import { isAgentPlan, type AgentPlan } from "@openedbot/execution/domain/agent-plan";
import { isTodoTool } from "@openedbot/execution/domain/agent-tool-call";
import { withoutMediaLines } from "@openedbot/execution/domain/output-media-text";
import { isWebSearchTrail, type WebSearchQuery, type WebSearchTrail } from "@openedbot/execution/domain/agent-web-search";
import { pairWebSearchCalls } from "../run/tool-web-search";
import { splitAskUser } from "@openedbot/roster/domain/ask-user";
import {
  handoffDirectiveNotices,
  splitHandoff,
  type HandoffDirectiveNotice,
} from "@openedbot/roster/domain/bot-mode";
import type { MentionableBot } from "@openedbot/roster/domain/mentions";

/**
 * Le modèle du fil : la liste ordonnée des entrées à rendre, et ce que le
 * rendu lit autour (libellés d'auteur, troncs de trace, tours agrégés…).
 *
 * Deux constructions, une seule sortie :
 *
 * - `buildTimelineModel` reconstruit tout depuis le snapshot ;
 * - `createTimelineModelBuilder` garde un sous-modèle par BLOC (un run avec
 *   ses messages, un message sans run, un run sans message). Un événement SSE
 *   n'ajoute qu'au seau de son run : les autres blocs gardent leurs entrées,
 *   à l'identité près, et seul le bloc touché se recalcule.
 *
 * Les deux appliquent les mêmes fonctions (blocs, fusion, plans et
 * recherches, décorations) ; le test `thread-timeline-model.test.ts` vérifie
 * que la seconde rend exactement la première après chaque événement.
 */

export type MessageAttachmentChip = Extract<MessageContent[number], { type: "attachment" }>;

/** Un élément du fil, dans l'ordre où il doit être rendu. */
export type Entry =
  | {
      kind: "user";
      key: string;
      text: string;
      /** Le tour que ce message a ouvert, `null` pour un message sans run. */
      runId: string | null;
      attachments?: readonly MessageAttachmentChip[];
      authorBot?: MessageAuthorBot | null;
      replyTo?: MessageReplyPreview | null;
      reactions?: MessageReactionDto[];
      steeredIntoActive: boolean;
      /** Absorbé par un run qui a rendu depuis : l'étiquette passe au passé. */
      steeredIntoSettled: boolean;
      targetId: string;
      /** ISO : l'heure d'envoi, sous la bulle. */
      createdAt?: string;
    }
  | {
      kind: "assistant";
      key: string;
      text: string;
      runId: string;
      author?: MessageAuthorBot | null;
      messageId?: string | null;
      replyTo?: MessageReplyPreview | null;
      reactions?: MessageReactionDto[];
      /** Fichiers produits par le tour, rangés sur le message persisté. */
      attachments?: readonly MessageAttachmentChip[];
      targetId: string;
    }
  | { kind: "event"; key: string; event: StoredProductEvent; targetId: string }
  /**
   * Les `tool.call` ADJACENTS d'un même passage, réunis en une seule ligne
   * dépliable : même règle de lecture que le mobile (`collapseToolRuns`) :
   * onze appels empilés n'apprennent rien de plus qu'une ligne « 11 outils »,
   * et poussent la réponse hors de l'écran. La clé est celle du PREMIER appel,
   * pour que l'identité de la ligne survive à l'arrivée du douzième.
   */
  | {
      kind: "tools";
      key: string;
      runId: string;
      calls: ToolCall[];
      approvals: ApprovalRequestDto[];
      targetId: string;
      /** The web search each call ran, aligned on `calls` (`pairWebSearchCalls`). */
      searches?: (WebSearchQuery | null)[];
    }
  | { kind: "plan"; key: string; runId: string; plan: AgentPlan; targetId: string }
  | { kind: "search"; key: string; runId: string; trail: WebSearchTrail; targetId: string }
  | { kind: "gate"; key: string; approval: ApprovalRequestDto };

export type TimelineUserInput = {
  id: string;
  text: string;
  /** US-CHAT-08 : les puces du message, sans leur charge. */
  attachments?: readonly MessageAttachmentChip[];
  runId: string | null;
  authorBot?: MessageAuthorBot | null;
  /** ISO. Sert à entrelacer par le temps avec les runs sans message (salons). */
  createdAt?: string;
};

export type TimelineRun = {
  id: string;
  status: ProductRunStatus;
  completionKind?: string | null;
  workflowId?: string | null;
  stepKind?: string | null;
  /** Salon en mode équipe : le tour qui écrit la réponse finale. */
  groupPhase?: string | null;
  /** `MODEL_UNAVAILABLE` : la bulle d'erreur devient un message lisible. */
  errorCode?: string | null;
  /** Le modèle demandé (le refusé, pour `MODEL_UNAVAILABLE`). */
  model?: string | null;
  usage?: { totalTokens?: number; outputTokens?: number } | null;
  /** ISO : bornes du run, pour la durée réelle affichée sous la réponse. */
  createdAt?: string;
  endedAt?: string | null;
};

export type TimelineModelInput = {
  /** Déjà privés des runs de service. */
  events: readonly StoredProductEvent[];
  userInputs: readonly TimelineUserInput[];
  messages: readonly ThreadMessageDto[];
  approvals: readonly ApprovalRequestDto[];
  runs: readonly TimelineRun[];
  running: boolean;
  runAuthors?: ReadonlyMap<string, MessageAuthorBot>;
  defaultAuthor: MessageAuthorBot | null;
  mentionables: readonly MentionableBot[];
  operatorUsername: string | null;
  activeAskUserRunId: string | null;
  /** `t("eventParts.toolFallback")` : une chaîne plutôt que `t`, comparable d'un passage à l'autre. */
  toolFallbackLabel: string;
};

export type AssistantTurn = { firstKey: string; lastKey: string; text: string };

export type TimelineModel = {
  shown: Entry[];
  assistantTurns: Map<string, AssistantTurn>;
  authorLabelEntryKeys: Set<string>;
  answeredQuestionByUserKey: Map<string, string>;
  attachedQuestionEntryKeys: Set<string>;
  streamingRunId: string | null;
  latestAssistantKey: string | null;
  handoffNoticeByRun: ReadonlyMap<string, HandoffDirectiveNotice>;
  runsById: Map<string, TimelineRun>;
  eventsByRun?: ReadonlyMap<string, readonly StoredProductEvent[]>;
  trailPositions: Map<string, RailPosition>;
  /** L'heure d'un tour : son premier événement. */
  turnTimeByRun: Map<string, string>;
};

// Le texte d’un événement, lu aussi par la timeline et par le flux (`live-run-text.ts`).
export { eventText } from "./thread-event-text";

type AskUserSplit = ReturnType<typeof splitAskUser>;

const askSplits = new WeakMap<object, { text: string; username: string | null; value: AskUserSplit }>();

/**
 * `splitAskUser` d'une entrée, mémoïsé par entrée : le fil le relit à chaque
 * passage (tours agrégés, activité, lecture vocale) et il compile une regex
 * par appel. Une entrée n'est jamais modifiée une fois le modèle rendu.
 */
export function entryAskSplit(entry: { text: string }, operatorUsername: string | null): AskUserSplit {
  const hit = askSplits.get(entry);
  if (hit && hit.text === entry.text && hit.username === operatorUsername) return hit.value;
  const value = splitAskUser(entry.text, operatorUsername ? { username: operatorUsername } : null);
  askSplits.set(entry, { text: entry.text, username: operatorUsername, value });
  return value;
}

export type AssistantTextParts = {
  split: AskUserSplit;
  /** Le texte sans la question ask_user terminale. */
  shown: string;
  body: string;
  handoff: ReturnType<typeof splitHandoff>["handoff"];
};

const textParts = new WeakMap<object, {
  text: string;
  username: string | null;
  notice: HandoffDirectiveNotice | null;
  mentionables: readonly MentionableBot[];
  value: AssistantTextParts;
}>();

/** La prose publique d'une bulle : question ask_user et directive de hand-off retirées. */
export function assistantTextParts(
  entry: { text: string },
  operatorUsername: string | null,
  handoffNotice: HandoffDirectiveNotice | null,
  mentionables: readonly MentionableBot[],
): AssistantTextParts {
  const hit = textParts.get(entry);
  if (
    hit && hit.text === entry.text && hit.username === operatorUsername
    && hit.notice === handoffNotice && hit.mentionables === mentionables
  ) return hit.value;
  const split = entryAskSplit(entry, operatorUsername);
  const shown = split.prompt ? split.body : entry.text;
  const { body, handoff } = handoffNotice
    ? splitHandoff(
        shown,
        handoffNotice.target ? [...mentionables, handoffNotice.target] : mentionables,
      )
    : { body: shown, handoff: null };
  const value = { split, shown, body, handoff };
  textParts.set(entry, { text: entry.text, username: operatorUsername, notice: handoffNotice, mentionables, value });
  return value;
}

type Steering = { steeredIntoActive: boolean; steeredIntoSettled: boolean };

type TimelineBlock =
  | { kind: "message"; id: string; time: number; order: number; message: TimelineUserInput }
  | { kind: "run"; id: string; time: number; order: number; runId: string }
  | { kind: "events"; id: string; time: number; order: number; runId: string };

type BlockPlan = {
  blocks: TimelineBlock[];
  messagesByRun: Map<string, TimelineUserInput[]>;
  steeredMessagesByTarget: Map<string, TimelineUserInput[]>;
  persistedById: Map<string, ThreadMessageDto>;
  runsById: Map<string, TimelineRun>;
  assistantMessageByRun: Map<string, ThreadMessageDto>;
  /** Run absorbé (steering) vers le run qui l'a absorbé. */
  steeredIntoRun: Map<string, string>;
  steeringOf: (runId: string | null) => Steering;
};

type EventsByRun = ReadonlyMap<string, readonly StoredProductEvent[]>;

function isMetadataReceipt(event: StoredProductEvent): boolean {
  return event.type === "message.admitted" || event.type === "run.steering";
}

function withoutReceipts(events: readonly StoredProductEvent[]): StoredProductEvent[] {
  return events.filter((event) => !isMetadataReceipt(event));
}

function bucketEventsByRun(events: readonly StoredProductEvent[]): Map<string, StoredProductEvent[]> {
  const eventsByRun = new Map<string, StoredProductEvent[]>();
  for (const event of events) {
    const bucket = eventsByRun.get(event.runId) ?? [];
    bucket.push(event);
    eventsByRun.set(event.runId, bucket);
  }
  return eventsByRun;
}

/**
 * Les BLOCS du fil, triés par temps. Un bloc = un run avec ses messages et
 * ses événements (ancré sur son premier message), OU un message sans run (le
 * message de l'opérateur dans un salon de groupe), OU un run sans message (un
 * tour de salon, une reprise, une notice système).
 */
function planTimelineBlocks(input: TimelineModelInput, eventsByRun: EventsByRun): BlockPlan {
  const { userInputs, messages, runs } = input;
  // Le message d'un tour précède les événements de ce tour. Les entrelacer par
  // `runId` évite qu'une deuxième question apparaisse au-dessus de la réponse
  // à la première.
  //
  // Un tour de « courrier » (hand-off bot mode) porte DEUX messages sur le
  // même `runId` : la question humaine « @neo … » et la réponse entrante du
  // bot. Rattacher les événements du run à chacun des deux les dupliquerait :
  // ils ne s'attachent donc qu'une fois par run, à son premier message. Et
  // parmi les messages d'un run, seule une RÉPONSE LIVRÉE (celle qu'un
  // `bot.message` du run désigne par `messageId`) passe APRÈS les événements
  // : la notice « Transmis à … » l'annonce. Un message entrant qui est le
  // PROMPT du run (dans le fil du bot cible : « Message de Amis ») précède
  // les événements comme le ferait une question humaine, sinon la réponse du
  // bot s'afficherait avant la question. Structurel, pas horodaté : les
  // horloges du runtime et du cloud API ne sont pas les mêmes.
  const messagesByRun = new Map<string, TimelineUserInput[]>();
  for (const message of userInputs) {
    if (message.runId === null) continue;
    const bucket = messagesByRun.get(message.runId) ?? [];
    bucket.push(message);
    messagesByRun.set(message.runId, bucket);
  }
  const persistedById = new Map(messages.map((message) => [message.id, message]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const assistantMessageByRun = new Map<string, ThreadMessageDto>();
  for (const message of messages) {
    if (message.role === "assistant" && message.runId) assistantMessageByRun.set(message.runId, message);
  }
  // Un message écrit PENDANT une réponse est absorbé par le run en cours
  // (steering) : son propre run est annulé avec `steered_into_active`. Il
  // appartient donc au tour actif et se lit SOUS le message qui a ouvert ce
  // tour, au-dessus de la machinerie et de la réponse qui lui répondent aussi.
  // En bloc séparé, il tombait après tout le tour actif : l'indicateur de
  // travail se glissait entre les deux questions, et la réponse apparaissait
  // au-dessus du dernier message envoyé.
  //
  // L'API ne transporte pas la cible de l'absorption. Un fil n'exécute qu'un
  // run à la fois (la file est sérialisée par conversation) et `runs` arrive
  // trié par date de création : la cible est donc le dernier run non steeré
  // qui précède.
  const steeredIntoRun = new Map<string, string>();
  let absorbingRunId: string | null = null;
  for (const run of runs) {
    if (isAbsorbedRun(run)) {
      if (absorbingRunId) steeredIntoRun.set(run.id, absorbingRunId);
      continue;
    }
    absorbingRunId = run.id;
  }
  const steeringOf = steeringResolver(runsById, steeredIntoRun);
  // Des BLOCS, puis un tri par temps. Sans ce tri, les tours d'un salon : des
  // runs sans message humain : tombaient tous APRÈS tous les messages de
  // l'opérateur, dans l'ordre inverse du réel. Le temps vient de `createdAt`
  // (messages) et `occurredAt` (événements), que le cloud API écrit à la
  // milliseconde ; un message sans horodatage (anciens appelants) garde sa
  // place d'insertion.
  const steeredMessagesByTarget = new Map<string, TimelineUserInput[]>();
  const absorbedRuns = new Set<string>();
  const blocks: TimelineBlock[] = [];
  const timeOf = (value: string | Date | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const attachedRuns = new Set<string>();
  let lastTime = 0;
  userInputs.forEach((message, index) => {
    const runId = message.runId;
    const time = timeOf(message.createdAt, lastTime);
    lastTime = Math.max(lastTime, time);
    if (runId === null) {
      blocks.push({ kind: "message", id: `m:${message.id}`, time, order: index, message });
      return;
    }
    const absorbedBy = steeredIntoRun.get(runId);
    if (absorbedBy !== undefined && messagesByRun.has(absorbedBy)) {
      if (absorbedRuns.has(runId)) return;
      absorbedRuns.add(runId);
      const bucket = steeredMessagesByTarget.get(absorbedBy) ?? [];
      bucket.push(...(messagesByRun.get(runId) ?? []));
      steeredMessagesByTarget.set(absorbedBy, bucket);
      return;
    }
    if (attachedRuns.has(runId)) return;
    attachedRuns.add(runId);
    blocks.push({ kind: "run", id: `r:${runId}`, time, order: index, runId });
  });
  // Les événements d'un run sans message utilisateur (tour de salon, reprise,
  // notice système) ne doivent pas disparaître pour autant : un bloc par run,
  // daté de son premier événement.
  for (const [runId, runEvents] of eventsByRun) {
    if (attachedRuns.has(runId)) continue;
    const first = runEvents[0];
    if (!first) continue;
    blocks.push({
      kind: "events",
      id: `e:${runId}`,
      time: timeOf(first.occurredAt, Number.MAX_SAFE_INTEGER),
      order: userInputs.length + blocks.length,
      runId,
    });
  }
  blocks.sort((left, right) => left.time - right.time || left.order - right.order);
  return { blocks, messagesByRun, steeredMessagesByTarget, persistedById, runsById, assistantMessageByRun, steeredIntoRun, steeringOf };
}

// L'étiquette suit le run ABSORBANT, pas le run annulé : « dans la réponse
// en cours » tant qu'il écrit, « dans la réponse » une fois qu'il a rendu.
// Sans cela chaque message absorbé gardait « en cours » à vie, alors que
// plus rien ne tournait. Cible introuvable : on reste au présent, comme
// avant, plutôt que d'affirmer une réponse qu'on ne voit pas.
function steeringResolver(
  runsById: ReadonlyMap<string, TimelineRun>,
  steeredIntoRun: ReadonlyMap<string, string>,
): (runId: string | null) => Steering {
  return (runId) => {
    const run = runId === null ? undefined : runsById.get(runId);
    if (run === undefined || !isAbsorbedRun(run)) {
      return { steeredIntoActive: false, steeredIntoSettled: false };
    }
    const absorbingId = steeredIntoRun.get(run.id);
    const absorbing = absorbingId === undefined ? undefined : runsById.get(absorbingId);
    const settled = absorbing !== undefined
      && (absorbing.status === "completed" || absorbing.status === "failed" || absorbing.status === "cancelled");
    return { steeredIntoActive: !settled, steeredIntoSettled: settled };
  };
}

/** Les entrées brutes d'un bloc, avant fusion. */
function blockEntries(block: TimelineBlock, plan: BlockPlan, eventsByRun: EventsByRun): Entry[] {
  const out: Entry[] = [];
  const pushMessage = (message: TimelineUserInput) => {
    const persisted = plan.persistedById.get(message.id);
    out.push({
      kind: "user",
      key: message.id,
      text: message.text,
      runId: message.runId,
      attachments: message.attachments,
      authorBot: message.authorBot ?? null,
      replyTo: persisted?.replyTo ?? null,
      reactions: persisted?.reactions ?? [],
      ...plan.steeringOf(message.runId),
      targetId: `message:${message.id}`,
      createdAt: message.createdAt,
    });
  };
  const pushEvents = (runEvents: readonly StoredProductEvent[]) => {
    for (const event of runEvents) {
      out.push({
        kind: "event",
        // Par séquence, pas par curseur : un delta diffusé avant son commit
        // n'a pas de curseur, et sa jumelle durable est écartée comme doublon
        // (même `runId:sequence`). Une clé au curseur valait `…:undefined`
        // pour tous les deltas provisoires d'un run : clés React dupliquées,
        // bulles fantômes après la relecture du fil.
        key: `e${event.runId}:${event.sequence}`,
        event,
        targetId: `event:${event.runId}:${event.cursor}`,
      });
    }
  };
  if (block.kind === "message") {
    pushMessage(block.message);
    return out;
  }
  const runEvents = eventsByRun.get(block.runId) ?? [];
  if (block.kind === "events") {
    pushEvents(runEvents);
    return out;
  }
  const delivered = new Set(
    runEvents
      .filter((event) => event.type === "bot.message")
      .map((event) => String(event.payload.messageId ?? "")),
  );
  const runMessages = plan.messagesByRun.get(block.runId) ?? [];
  for (const item of runMessages) if (!delivered.has(item.id)) pushMessage(item);
  // Les messages que CE run a absorbés en cours de route : sous la question
  // qui a ouvert le tour, avant la machinerie. Les placer après les événements
  // déjà émis serait chronologiquement exact mais les ferait dépasser par
  // chaque nouvel outil, puis par la réponse.
  for (const item of plan.steeredMessagesByTarget.get(block.runId) ?? []) pushMessage(item);
  pushEvents(runEvents);
  for (const item of runMessages) if (delivered.has(item.id)) pushMessage(item);
  return out;
}

type ToolIndex = {
  outcomes: Map<string, ToolOutcome>;
  terminal: ReturnType<typeof runToolTerminalStates>;
  attached: Map<string, ToolAttachment>;
};

// `toolCallId` seul se répète d'un run à l'autre : `HermesEventNormalizer`
// est neuf par run et son compteur (`tc_0`, `tc_1`, …) reprend toujours à
// zéro (revue vador, F2). La clé (`toolCallKey`) porte donc TOUJOURS
// `runId` : sans quoi le résultat d'un tour s'affiche aussi sous la ligne
// d'un tour précédent. Le `tool.result` porte AUSSI l'issue (`error`) et la
// durée (`durationMs`) : longtemps émis sans jamais être lus.
function indexToolEvents(events: readonly StoredProductEvent[]): ToolIndex {
  const outcomes = new Map<string, ToolOutcome>(
    events
      .filter((event) => event.type === "tool.result")
      .map((event) => [toolCallKey(event), readToolOutcome(event.payload)]),
  );
  // US-CHAT-07 : le contenu réel, rattaché après coup par le cloud API dans un
  // événement distinct : `tool.result` (ci-dessus) ne fait que marquer un
  // appel comme terminé, jamais le pourquoi voir `tool-results.ts`.
  const attached = new Map<string, ToolAttachment>();
  for (const event of events) {
    if (event.type !== "tool.result.attached") continue;
    const attachment = readAttachment(event.payload);
    if (attachment) attached.set(toolCallKey(event), attachment);
  }
  return { outcomes, terminal: runToolTerminalStates(events), attached };
}

// Groupes : un tour qui a PASSÉ (notice `group.pass`) n'a rien dit : le
// texte « pass » streamé par le runtime ne se rend pas, seule la notice reste.
function passedRunIds(events: readonly StoredProductEvent[]): Set<string> {
  return new Set(
    events
      .filter((event) => event.type === "system.notice" && event.payload.kind === "group.pass")
      .map((event) => event.runId),
  );
}

type MergeContext = {
  tools: ToolIndex;
  passedRuns: ReadonlySet<string>;
  approval: (id: string) => ApprovalRequestDto | undefined;
  /** Les demandes déjà posées : un replay ne doit jamais offrir deux boutons pour la même décision. */
  placed: Set<string>;
  runAuthors?: ReadonlyMap<string, MessageAuthorBot>;
  assistantMessageByRun: ReadonlyMap<string, ThreadMessageDto>;
  toolFallbackLabel: string;
};

/**
 * Le runtime émet un `agent.message` par fenêtre de flush (toutes les
 * DELTA_FLUSH_MS pendant le streaming), donc un même tour arrive en plusieurs
 * fragments coupés au milieu d'un mot. On fusionne les fragments ADJACENTS en
 * une seule bulle : un `tool.call` ou une gate entre deux textes rompt la
 * fusion et préserve l'entrelacement. Concaténation nue : les fragments
 * recomposent exactement le texte d'origine (`buffer += delta`).
 *
 * Toute fusion exige le même `runId` : deux blocs (un par run) ne fusionnent
 * donc jamais entre eux, ce qui permet de fusionner bloc par bloc.
 */
function mergeTimelineEntries(entries: readonly Entry[], ctx: MergeContext): Entry[] {
  const merged: Entry[] = [];
  for (const entry of entries) {
    if (entry.kind === "event" && entry.event.type === "approval.requested") {
      // Le worker remplace l'identifiant Hermes local par l'UUID réellement
      // persisté dans `approval_requests`. `approvalId` reste accepté pour les
      // anciens événements déjà stockés. Sans cette jointure, la carte était
      // rejetée tout en bas du fil, loin de la commande à décider.
      const rawId = entry.event.payload.approvalRequestId ?? entry.event.payload.approvalId;
      const approvalId = typeof rawId === "string" ? rawId : null;
      const approval = approvalId ? ctx.approval(approvalId) : undefined;
      // Une demande déjà répondue/expirée n'est plus dans `approvals` : elle
      // reste muette et ne coupe pas deux fragments de texte (comportement
      // historique verrouillé par test).
      if (!approval) continue;
      // Un replay SSE ou un snapshot mal fusionné ne doit jamais offrir deux
      // boutons capables de répondre à la même décision.
      if (ctx.placed.has(approval.id)) continue;
      ctx.placed.add(approval.id);
      const previous = merged[merged.length - 1];
      if (previous?.kind === "tools" && previous.runId === entry.event.runId) {
        previous.approvals.push(approval);
      } else {
        merged.push({ kind: "gate", key: `approval:${approval.id}`, approval });
      }
      continue;
    }
    // Un événement sans rendu ne devient pas une entrée : intercalé entre deux
    // fragments (un `tool.result`, un `raw`… au milieu du flush), il rompait
    // l'adjacence et coupait la bulle en deux sans rien afficher. Le mobile
    // filtre de même avant fusion (`thread-rows.ts`). Un `tool.call`, lui,
    // se rend : il continue de couper la bulle.
    if (entry.kind === "event" && rendersNothing(entry.event)) continue;
    // Les `tool.call` adjacents se réunissent en une seule ligne « N outils »
    // (même repli que le mobile, `collapseToolRuns`). L'adjacence est réelle :
    // les événements sans rendu sont déjà filtrés au-dessus, un texte ou une
    // notice intercalés cassent bien la série : la chronologie reste vraie.
    if (entry.kind === "event" && entry.event.type === "tool.call") {
      const key = toolCallKey(entry.event);
      const outcome = ctx.tools.outcomes.get(key);
      const terminal = ctx.tools.terminal.get(entry.event.runId);
      const attachment = ctx.tools.attached.get(key);
      const preview = entry.event.payload.preview;
      const errorMessage = outcome?.errorMessage ?? (attachment && "errorMessage" in attachment ? attachment.errorMessage : null);
      const call: ToolCall = {
        tool: String(entry.event.payload.tool ?? ctx.toolFallbackLabel),
        done: outcome !== undefined || terminal !== undefined,
        ...(outcome?.failed || (outcome === undefined && terminal === "interrupted")
          ? { failed: true as const }
          : {}),
        ...(outcome && outcome.durationMs !== null ? { durationMs: outcome.durationMs } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(typeof preview === "string" && preview !== "" ? { preview } : {}),
        ...(outcome?.resultExcerpt ? { resultExcerpt: outcome.resultExcerpt } : {}),
        ...(attachment ? { attachment } : {}),
      };
      const last = merged[merged.length - 1];
      // Une gate ferme visuellement le groupe : un appel qui n'arrive qu'après
      // la décision appartient à une nouvelle étape, même si aucun texte ne
      // s'est intercalé.
      if (
        last?.kind === "tools" &&
        last.runId === entry.event.runId &&
        last.approvals.length === 0
      ) last.calls.push(call);
      else merged.push({
        kind: "tools",
        key: entry.key,
        runId: entry.event.runId,
        calls: [call],
        approvals: [],
        targetId: entry.targetId,
      });
      continue;
    }
    if (entry.kind === "event" && entry.event.type === "agent.message") {
      if (ctx.passedRuns.has(entry.event.runId)) continue;
      const last = merged[merged.length - 1];
      const author = ctx.runAuthors?.get(entry.event.runId) ?? null;
      // Deux tours de deux membres différents ne fusionnent jamais, même adjacents.
      if (last?.kind === "assistant" && last.runId === entry.event.runId && (last.author?.id ?? null) === (author?.id ?? null)) {
        last.text += eventText(entry.event);
      } else {
        const persisted = ctx.assistantMessageByRun.get(entry.event.runId);
        merged.push({
          kind: "assistant",
          key: entry.key,
          text: eventText(entry.event),
          runId: entry.event.runId,
          author,
          messageId: persisted?.id ?? null,
          replyTo: persisted?.replyTo ?? null,
          reactions: persisted?.reactions ?? [],
          targetId: entry.targetId,
        });
      }
      continue;
    }
    merged.push(entry);
  }
  const lastAssistant = new Map<string, Extract<Entry, { kind: "assistant" }>>();
  for (const entry of merged) if (entry.kind === "assistant") { // puces sur la DERNIÈRE bulle, `MEDIA:` joints hors du texte
    const persisted = ctx.assistantMessageByRun.get(entry.runId), names = persisted?.content.flatMap((part) => part.type === "attachment" ? [part.name] : []);
    entry.text = withoutMediaLines(entry.text, names ? new Set(names) : null);
    lastAssistant.set(entry.runId, entry);
  }
  for (const [runId, entry] of lastAssistant) {
    const attachments = (ctx.assistantMessageByRun.get(runId)?.content ?? [])
      .filter((part): part is MessageAttachmentChip => part.type === "attachment");
    if (attachments.length > 0) entry.attachments = attachments;
  }
  // Un membre de salon qui passe streame « (pass) » avant que la notice
  // `group.pass` n'arrive avec la fin du run : sans ce filtre, une bulle
  // « (pass) » s'affichait puis disparaissait. Un run qui a persisté un
  // message a parlé : on ne masque que le texte encore sans message.
  return merged.filter((entry) =>
    entry.kind !== "assistant" ||
    ctx.assistantMessageByRun.has(entry.runId) ||
    !isPassLikeText(entry.text));
}

/** `(pass)`, `pass` ou un de leurs débuts, tel que le stream le livre. */
function isPassLikeText(text: string): boolean {
  const compact = text.trim().toLowerCase().replace(/[\s*_`"'.!]/g, "");
  return compact.length > 0 && ("(pass)".startsWith(compact) || "pass".startsWith(compact));
}

type RunTrail<T> = { value: T; first: StoredProductEvent };

/**
 * Hermes ne met pas les arguments des outils dans le flux SSE. Le worker
 * relit donc le transcript après chaque écriture `todo` et à la clôture du
 * run. Le dernier `agentPlan` observé remplace le précédent : aucune étape ne
 * progresse sur un timer ou sur un simple `tool.call`. Même mécanique pour les
 * recherches web. `first` garde le premier événement porteur : c'est lui qui
 * ordonne les plans et recherches posés en fin de fil.
 */
function collectRunTrails(events: readonly StoredProductEvent[]) {
  const plans = new Map<string, RunTrail<AgentPlan>>();
  const searches = new Map<string, RunTrail<WebSearchTrail>>();
  for (const event of events) {
    const plan = event.payload.agentPlan;
    if (!isAgentPlan(plan) || plan.steps.length === 0) continue;
    plans.set(event.runId, { value: plan, first: plans.get(event.runId)?.first ?? event });
  }
  for (const event of events) {
    const trail = event.payload.webSearch;
    if (!isWebSearchTrail(trail) || trail.queries.length === 0) continue;
    searches.set(event.runId, { value: trail, first: searches.get(event.runId)?.first ?? event });
  }
  return { plans, searches };
}

type OrphanTrail = { entry: Entry; first: StoredProductEvent };

/**
 * Hands each run's web searches to its `web_search` calls, so the Tool Result
 * carries the query and its sources. Returns the trails still owed a row of
 * their own: the queries no call claimed (a run whose calls were never
 * streamed, a transcript ahead of the stream).
 */
function attachRunSearches(
  merged: Entry[],
  searches: ReadonlyMap<string, RunTrail<WebSearchTrail>>,
): Map<string, RunTrail<WebSearchTrail>> {
  const toolEntries = new Map<string, Array<{ index: number; entry: Extract<Entry, { kind: "tools" }> }>>();
  merged.forEach((entry, index) => {
    if (entry.kind !== "tools") return;
    toolEntries.set(entry.runId, [...(toolEntries.get(entry.runId) ?? []), { index, entry }]);
  });
  const remaining = new Map(searches);
  for (const [runId, entries] of toolEntries) {
    const trail = searches.get(runId);
    const { searches: paired, unpaired } = pairWebSearchCalls(entries.map(({ entry }) => entry.calls), trail?.value ?? null);
    entries.forEach(({ index, entry }, at) => {
      const aligned = paired[at]!;
      if (aligned.some((query) => query !== null)) merged[index] = { ...entry, searches: aligned };
    });
    if (!trail) continue;
    if (unpaired.length === 0) remaining.delete(runId);
    else remaining.set(runId, { ...trail, value: { queries: unpaired } });
  }
  return remaining;
}

/**
 * Pose le plan puis la trace de recherche de chaque run juste avant son
 * journal d'outils (à défaut, avant sa première bulle). Un run sans outil ni
 * bulle n'a pas d'ancre : son plan et sa recherche sont rendus pour être
 * ajoutés en fin de fil, plans d'abord.
 */
function insertRunTrails(
  merged: Entry[],
  trails: ReturnType<typeof collectRunTrails>,
): { orphanPlans: OrphanTrail[]; orphanSearches: OrphanTrail[] } {
  const orphanPlans: OrphanTrail[] = [];
  const orphanSearches: OrphanTrail[] = [];
  const searchTrails = attachRunSearches(merged, trails.searches);
  for (const [runId, { value: plan, first }] of trails.plans) {
    const firstTools = merged.findIndex((entry) => entry.kind === "tools" && entry.runId === runId);
    const firstRunEntry = merged.findIndex((entry) =>
      (entry.kind === "assistant" || entry.kind === "tools") && entry.runId === runId,
    );
    const insertionIndex = firstTools === -1 ? firstRunEntry : firstTools;
    const targetId = firstTools === -1
      ? `plan:${runId}`
      : merged[firstTools]!.kind === "tools" ? merged[firstTools]!.targetId : `plan:${runId}`;
    const planEntry: Entry = { kind: "plan", key: `plan:${runId}`, runId, plan, targetId };
    if (insertionIndex === -1) orphanPlans.push({ entry: planEntry, first });
    else merged.splice(insertionIndex, 0, planEntry);
  }
  // La trace se pose juste après le plan du run, avant le détail des outils.
  for (const [runId, { value: trail, first }] of searchTrails) {
    const firstTools = merged.findIndex((entry) => entry.kind === "tools" && entry.runId === runId);
    const firstRunEntry = merged.findIndex((entry) =>
      (entry.kind === "assistant" || entry.kind === "tools") && entry.runId === runId,
    );
    const insertionIndex = firstTools === -1 ? firstRunEntry : firstTools;
    const targetId = firstTools !== -1 && merged[firstTools]!.kind === "tools"
      ? merged[firstTools]!.targetId
      : `search:${runId}`;
    const searchEntry: Entry = { kind: "search", key: `search:${runId}`, runId, trail, targetId };
    if (insertionIndex === -1) orphanSearches.push({ entry: searchEntry, first });
    else merged.splice(insertionIndex, 0, searchEntry);
  }
  return { orphanPlans, orphanSearches };
}

function runTurnTime(runEvents: readonly StoredProductEvent[]): string | undefined {
  let earliest: string | undefined;
  for (const event of runEvents) {
    const at = new Date(event.occurredAt);
    if (!Number.isFinite(at.getTime())) continue;
    const iso = at.toISOString();
    if (!earliest || iso < earliest) earliest = iso;
  }
  return earliest;
}

/**
 * Le run dont le texte arrive ENCORE : ses bulles lissent leur croissance
 * (`useSmoothText`), les autres rendent leur texte tel quel. Un run déjà
 * conclu ne streame plus.
 */
function streamingRunOf(
  running: boolean,
  events: readonly StoredProductEvent[],
  eventsByRun: EventsByRun,
  runsById: ReadonlyMap<string, TimelineRun>,
): string | null {
  if (!running) return null;
  // A run the snapshot lists as ended (cancelled, failed) is concluded even
  // when its closing event never came.
  const concluded = (runId: string) => {
    const status = runsById.get(runId)?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") return true;
    return (eventsByRun.get(runId) ?? []).some((event) => event.type === "run.completed" || event.type === "run.error");
  };
  const last = events.findLast((event) => !isMetadataReceipt(event));
  if (!last) return null;
  // One run at a time (a 1:1 thread): the last event's run, unless it ended.
  if (!concluded(last.runId)) return last.runId;
  // A salon runs several members: the last event can close one member's run
  // while another is still working. The live run is then the latest one that
  // has not concluded AND that the snapshot still lists as active; an old run
  // that never wrote its closing event must not come back to life.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const { runId } = events[index]!;
    if (isMetadataReceipt(events[index]!) || runId === last.runId || concluded(runId)) continue;
    const status = runsById.get(runId)?.status;
    if (status !== undefined && status !== "completed" && status !== "failed" && status !== "cancelled") return runId;
  }
  return null;
}

/** Ce que le rendu lit autour des entrées : un passage linéaire, sans reparse (splits mémoïsés par entrée). */
function finishTimelineModel(
  shown: Entry[],
  input: TimelineModelInput,
  derived: Pick<TimelineModel, "handoffNoticeByRun" | "runsById" | "streamingRunId" | "turnTimeByRun" | "eventsByRun">,
  derivedEntries: readonly Entry[] = shown,
): TimelineModel {
  const { runAuthors, defaultAuthor, operatorUsername, activeAskUserRunId, mentionables } = input;
  const latestAssistantKey = derivedEntries.findLast((entry) => entry.kind === "assistant")?.key ?? null;

  // Le libellé du bot appartient au début visuel du tour, donc à sa PREMIÈRE
  // entrée : trace de recherche, plan, appel d'outil ou texte, dans l'ordre où
  // le fil les pose. Les deux premières s'insèrent avant le journal d'outils et
  // ne portaient pas le libellé, si bien que le tour s'ouvrait sur un bloc
  // orphelin et que le nom du bot apparaissait dessous.
  const authorLabelEntryKeys = new Set<string>();
  const labeledRunIds = new Set<string>();
  for (const entry of derivedEntries) {
    if (entry.kind !== "assistant" && entry.kind !== "tools" && entry.kind !== "search" && entry.kind !== "plan") {
      continue;
    }
    const author = entry.kind === "assistant"
      ? entry.author ?? defaultAuthor
      : runAuthors?.get(entry.runId) ?? defaultAuthor;
    if (!author || labeledRunIds.has(entry.runId)) continue;
    // Un journal d'outils vide (uniquement des `todo`, projetés ailleurs) ne
    // s'affiche pas : il n'ouvre donc pas le tour et ne prend pas le libellé.
    if (entry.kind === "tools") {
      const calls = entry.calls.filter((call) => !isTodoTool(call.tool));
      if (calls.length === 0 && entry.approvals.length === 0) continue;
    }
    authorLabelEntryKeys.add(entry.key);
    labeledRunIds.add(entry.runId);
  }

  // La trace du tour : plan, recherches, outils et demandes d'autorisation
  // CONSÉCUTIFS d'un même run se relient par un seul tronc (`TrailItem`), comme
  // les blocs `task-list` et `web-search` de BoardUI partagent leur guide. Toute
  // autre entrée (texte, message, repère) coupe le tronc : une coupure de trop
  // laisse deux traces propres, un raccord à tort laisserait un trait pendant.
  const trailPositions = new Map<string, RailPosition>();
  let trailGroup: Array<{ key: string; runId: string }> = [];
  const closeTrail = () => {
    if (trailGroup.length > 1) {
      trailGroup.forEach((item, index) => trailPositions.set(
        item.key,
        index === 0 ? "first" : index === trailGroup.length - 1 ? "last" : "middle",
      ));
    }
    trailGroup = [];
  };
  for (const entry of derivedEntries) {
    const trailRunId = entry.kind === "plan" || entry.kind === "search"
      ? entry.runId
      : entry.kind === "tools" && (entry.calls.some((call) => !isTodoTool(call.tool)) || entry.approvals.length > 0)
        ? entry.runId
        : entry.kind === "gate"
          ? entry.approval.runId ?? null
          : null;
    if (trailRunId === null || (trailGroup.length > 0 && trailGroup[0]!.runId !== trailRunId)) closeTrail();
    if (trailRunId !== null) trailGroup.push({ key: entry.key, runId: trailRunId });
  }
  closeTrail();

  // Une question ask_user terminée est le contexte de la réponse opérateur
  // qui la suit. La laisser sur l'axe assistant crée deux conversations
  // visuelles (question tout à gauche, réponse tout à droite). On rattache
  // donc la question au prochain vrai message opérateur ; les entrées de
  // machinerie intermédiaires (plan/outils) ne brisent pas cette relation.
  const answeredQuestionByUserKey = new Map<string, string>();
  const attachedQuestionEntryKeys = new Set<string>();
  let pendingAnsweredQuestion: { entryKey: string; question: string } | null = null;
  for (const entry of derivedEntries) {
    if (entry.kind === "assistant") {
      const split = entryAskSplit(entry, operatorUsername);
      pendingAnsweredQuestion = split.prompt && entry.runId !== activeAskUserRunId
        ? { entryKey: entry.key, question: split.prompt.question }
        : null;
      continue;
    }
    if (entry.kind !== "user") continue;
    if (!entry.authorBot && pendingAnsweredQuestion) {
      answeredQuestionByUserKey.set(entry.key, pendingAnsweredQuestion.question);
      attachedQuestionEntryKeys.add(pendingAnsweredQuestion.entryKey);
    }
    pendingAnsweredQuestion = null;
  }

  // Un tour est un seul bloc. Les outils coupent le texte d'un run en
  // plusieurs fragments du même message : seul le dernier fragment rendu porte
  // la barre d'actions et les réactions, et cette barre copie et lit le tour
  // entier. Une barre par fragment répétait les mêmes gestes au milieu du tour.
  const assistantTurns = new Map<string, AssistantTurn>();
  for (const entry of derivedEntries) {
    if (entry.kind !== "assistant") continue;
    const { split, shown: visible, body, handoff } = assistantTextParts(
      entry,
      operatorUsername,
      derived.handoffNoticeByRun.get(entry.runId) ?? null,
      mentionables,
    );
    // Même garde que le rendu : un fragment réduit à sa question ne s'affiche pas.
    if (!body.trim() && (split.prompt || handoff)) continue;
    const text = (handoff ? body : visible).trim();
    const turn = assistantTurns.get(entry.runId);
    if (!turn) {
      assistantTurns.set(entry.runId, { firstKey: entry.key, lastKey: entry.key, text });
      continue;
    }
    turn.lastKey = entry.key;
    if (text) turn.text = turn.text ? `${turn.text}\n\n${text}` : text;
  }

  return {
    shown,
    assistantTurns,
    authorLabelEntryKeys,
    answeredQuestionByUserKey,
    attachedQuestionEntryKeys,
    latestAssistantKey,
    trailPositions,
    ...derived,
  };
}

/** Le modèle complet, reconstruit depuis le snapshot entier. */
export function buildTimelineModel(input: TimelineModelInput): TimelineModel {
  const { approvals } = input;
  // Ces événements transportent un état d'admission ou de steering pour le
  // cache. Le fil visible reste construit depuis les messages et runs persistés.
  const events = withoutReceipts(input.events);
  const eventsByRun = bucketEventsByRun(events);
  const plan = planTimelineBlocks(input, eventsByRun);
  const entries: Entry[] = [];
  for (const block of plan.blocks) {
    for (const entry of blockEntries(block, plan, eventsByRun)) entries.push(entry);
  }
  const approvalsById = new Map(approvals.map((approval) => [approval.id, approval]));
  const placed = new Set<string>();
  const shown = mergeTimelineEntries(entries, {
    tools: indexToolEvents(events),
    passedRuns: passedRunIds(events),
    approval: (id) => approvalsById.get(id),
    placed,
    runAuthors: input.runAuthors,
    assistantMessageByRun: plan.assistantMessageByRun,
    toolFallbackLabel: input.toolFallbackLabel,
  });
  const { orphanPlans, orphanSearches } = insertRunTrails(shown, collectRunTrails(events));
  for (const { entry } of orphanPlans) shown.push(entry);
  for (const { entry } of orphanSearches) shown.push(entry);
  // Compatibilité avec les snapshots tronqués et les anciens événements sans
  // identifiant corrélable : une demande ACTIVE ne doit jamais disparaître.
  // Elle retombe alors en carte autonome, après la partie observable du fil.
  for (const approval of approvals) {
    if (!placed.has(approval.id)) shown.push({ kind: "gate", key: `approval:${approval.id}`, approval });
  }
  const turnTimeByRun = new Map<string, string>();
  for (const [runId, runEvents] of eventsByRun) {
    const time = runTurnTime(runEvents);
    if (time !== undefined) turnTimeByRun.set(runId, time);
  }
  return finishTimelineModel(shown, input, {
    handoffNoticeByRun: handoffDirectiveNotices(events),
    runsById: plan.runsById,
    streamingRunId: streamingRunOf(input.running, events, eventsByRun, plan.runsById),
    turnTimeByRun,
    eventsByRun,
  });
}

/** Rebuilds render-only summaries for the mounted slice (`shown` from `visibleStart`) and its preceding turn. */
export function deriveTimelineWindow(
  model: TimelineModel,
  input: TimelineModelInput,
  visible: readonly Entry[],
  visibleStart = model.shown.length - visible.length,
): TimelineModel {
  let prefixStart = visibleStart;
  while (prefixStart > 0 && model.shown[prefixStart - 1]?.kind !== "user") prefixStart -= 1;
  if (prefixStart > 0) prefixStart -= 1;
  const precedingTurn = model.shown.slice(prefixStart, visibleStart);
  const derivedEntries = precedingTurn.length ? [...precedingTurn, ...visible] : visible;
  return finishTimelineModel(model.shown, input, {
    handoffNoticeByRun: model.handoffNoticeByRun,
    runsById: model.runsById,
    streamingRunId: model.streamingRunId,
    turnTimeByRun: model.turnTimeByRun,
    eventsByRun: model.eventsByRun,
  }, derivedEntries);
}

type CachedBlock = {
  deps: unknown[];
  /** Les demandes d'autorisation lues par la fusion : le bloc reste valide tant qu'elles sont les mêmes objets. */
  approvalRefs: Array<readonly [string, ApprovalRequestDto | undefined]>;
  entries: Entry[];
  placed: string[];
  orphanPlan: OrphanTrail | null;
  orphanSearch: OrphanTrail | null;
  turnTime: string | undefined;
};

function pushMessageDeps(deps: unknown[], message: TimelineUserInput, plan: BlockPlan): void {
  const persisted = plan.persistedById.get(message.id);
  const steering = plan.steeringOf(message.runId);
  deps.push(
    message.id,
    message.text,
    message.runId,
    message.createdAt,
    message.authorBot ?? null,
    persisted?.replyTo ?? null,
    persisted?.reactions ?? null,
    steering.steeredIntoActive,
    steering.steeredIntoSettled,
  );
  // Les puces par élément : `conversation.tsx` refiltre `content` à chaque
  // changement de `messages`, le tableau est neuf mais ses parts sont les mêmes.
  if (message.attachments === undefined) deps.push(-1);
  else deps.push(message.attachments.length, ...message.attachments);
}

/**
 * Tout ce que la construction d'un bloc lit, comparé par identité. Le seau
 * d'événements d'un run ne fait que croître (voir `syncEvents`) : sa
 * référence et sa longueur suffisent.
 */
function blockDeps(block: TimelineBlock, plan: BlockPlan, eventsByRun: EventsByRun, input: TimelineModelInput): unknown[] {
  const deps: unknown[] = [block.kind];
  if (block.kind === "message") {
    pushMessageDeps(deps, block.message, plan);
    return deps;
  }
  const bucket = eventsByRun.get(block.runId);
  deps.push(
    block.runId,
    bucket,
    bucket?.length ?? 0,
    input.toolFallbackLabel,
    input.runAuthors?.get(block.runId) ?? null,
    plan.assistantMessageByRun.get(block.runId) ?? null,
  );
  if (block.kind === "run") {
    const runMessages = plan.messagesByRun.get(block.runId) ?? [];
    deps.push(runMessages.length);
    for (const message of runMessages) pushMessageDeps(deps, message, plan);
    const steered = plan.steeredMessagesByTarget.get(block.runId) ?? [];
    deps.push(steered.length);
    for (const message of steered) pushMessageDeps(deps, message, plan);
  }
  return deps;
}

/** `previous` est-il `events` à partir de `offset`, objet par objet ? */
function sameEventIdentity(
  events: readonly StoredProductEvent[],
  previous: readonly StoredProductEvent[],
  offset: number,
): boolean {
  for (let index = 0; index < previous.length; index += 1) {
    if (events[offset + index] !== previous[index]) return false;
  }
  return true;
}

function sameDeps(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

function buildBlock(
  block: TimelineBlock,
  deps: unknown[],
  plan: BlockPlan,
  eventsByRun: EventsByRun,
  input: TimelineModelInput,
  approvalsById: ReadonlyMap<string, ApprovalRequestDto>,
): CachedBlock {
  const runEvents = block.kind === "message" ? [] : eventsByRun.get(block.runId) ?? [];
  const approvalRefs: CachedBlock["approvalRefs"] = [];
  const placed = new Set<string>();
  const entries = mergeTimelineEntries(blockEntries(block, plan, eventsByRun), {
    tools: indexToolEvents(runEvents),
    passedRuns: passedRunIds(runEvents),
    approval: (id) => {
      const approval = approvalsById.get(id);
      approvalRefs.push([id, approval]);
      return approval;
    },
    placed,
    runAuthors: input.runAuthors,
    assistantMessageByRun: plan.assistantMessageByRun,
    toolFallbackLabel: input.toolFallbackLabel,
  });
  const { orphanPlans, orphanSearches } = insertRunTrails(entries, collectRunTrails(runEvents));
  return {
    deps,
    approvalRefs,
    entries,
    placed: [...placed],
    orphanPlan: orphanPlans[0] ?? null,
    orphanSearch: orphanSearches[0] ?? null,
    turnTime: runTurnTime(runEvents),
  };
}

/** Plusieurs runs sans ancre : même ordre que le fil complet, celui de leur premier événement porteur. */
function sortByEventOrder(orphans: OrphanTrail[], events: readonly StoredProductEvent[]): void {
  if (orphans.length < 2) return;
  const position = new Map(events.map((event, index) => [event, index]));
  orphans.sort((left, right) => position.get(left.first)! - position.get(right.first)!);
}

export type TimelineModelBuilder = (
  input: TimelineModelInput,
  options?: { deferDerived?: boolean },
) => TimelineModel;

/**
 * Le modèle incrémental : même sortie que `buildTimelineModel`, mais seuls
 * les blocs dont une dépendance a changé se reconstruisent. Les entrées d'un
 * bloc inchangé sont les MÊMES objets d'un passage à l'autre : les
 * signatures (`entrySignature`) et les splits mémoïsés par entrée tiennent.
 */
export function createTimelineModelBuilder(): TimelineModelBuilder {
  let source: readonly StoredProductEvent[] | null = null;
  // Seaux par run. Deux croissances les gardent :
  // - queue (préfixe identique, élément par élément) : `push` ;
  // - page antérieure (l'ancien tableau est un suffixe par identité) :
  //   `unshift` sur les runs de la page, les autres seaux restent les mêmes
  //   objets. Un remplacement, une troncature ou un tableau recopié élément
  //   par élément repart de zéro, ce qui invalide les blocs.
  let buckets = new Map<string, StoredProductEvent[]>();
  let handoffNoticeByRun: ReadonlyMap<string, HandoffDirectiveNotice> = new Map();
  const blocks = new Map<string, CachedBlock>();
  // Le plan des blocs du passage précédent, réutilisé tant que la structure du
  // fil ne bouge pas : un delta ne reparse plus les dates ni ne retrie les
  // blocs de tout le fil chargé.
  let previousInput: TimelineModelInput | null = null;
  let previousPlan: BlockPlan | null = null;
  // Un seau neuf, une page collée devant ou une reconstruction changent les
  // blocs eux-mêmes : le plan est alors recalculé.
  let bucketsReshaped = true;
  // Les runs dont le seau a grandi ou la ligne a changé depuis le passage
  // précédent. Seuls leurs blocs recalculent leurs dépendances.
  const touchedRuns = new Set<string>();

  const pushBucket = (event: StoredProductEvent, where: "push" | "unshift") => {
    // Même filtre que `buildTimelineModel`. Un `message.admitted` commité
    // après le premier delta provisionnel (publié avant son commit) tombait
    // entre deux fragments du même run : il rompait leur fusion, et la
    // réponse s'affichait en plusieurs bulles.
    if (isMetadataReceipt(event)) return;
    const bucket = buckets.get(event.runId);
    if (!bucket) {
      buckets.set(event.runId, [event]);
      bucketsReshaped = true;
    } else if (where === "push") bucket.push(event);
    else {
      bucket.unshift(event);
      bucketsReshaped = true;
    }
    touchedRuns.add(event.runId);
  };

  const absorbTail = (events: readonly StoredProductEvent[], from: number) => {
    let notices = from === 0;
    for (let index = from; index < events.length; index += 1) {
      const event = events[index]!;
      pushBucket(event, "push");
      if (event.type === "system.notice") notices = true;
    }
    // Les notices de hand-off débordent sur le run précédent : leur repli
    // reste global, mais seule une nouvelle notice peut en changer le résultat.
    if (notices) handoffNoticeByRun = handoffDirectiveNotices(withoutReceipts(events));
  };

  const syncEvents = (events: readonly StoredProductEvent[]) => {
    if (events === source) return;
    const previous = source;
    // Un patch SSE ajoute un événement en queue : le lien posé par le patch
    // prouve « mêmes objets devant » sans parcourir les N éléments du fil.
    if (
      previous
      && events.length >= previous.length
      && (eventsAppendedFrom(events) === previous || sameEventIdentity(events, previous, 0))
    ) {
      if (previous.length === 0) {
        buckets = new Map();
        bucketsReshaped = true;
      }
      absorbTail(events, previous.length);
      source = events;
      return;
    }
    // Page plus ancienne collée devant. L'ancien tableau est le suffixe :
    // on n'écrase pas les seaux déjà construits. Une notice dans la page
    // (ou devant une notice déjà vue) peut rattacher le hand-off à un autre
    // run : on recalcule la carte, pas les blocs.
    if (
      previous
      && previous.length > 0
      && events.length > previous.length
      && sameEventIdentity(events, previous, events.length - previous.length)
    ) {
      for (let index = events.length - previous.length - 1; index >= 0; index -= 1) {
        pushBucket(events[index]!, "unshift");
      }
      handoffNoticeByRun = handoffDirectiveNotices(withoutReceipts(events));
      source = events;
      return;
    }
    buckets = new Map();
    bucketsReshaped = true;
    absorbTail(events, 0);
    source = events;
  };

  const build = (input: TimelineModelInput, options?: { deferDerived?: boolean }): TimelineModel => {
    syncEvents(input.events);
    const eventsByRun: EventsByRun = buckets;
    const reused = previousInput && previousPlan && !bucketsReshaped
      ? reusablePlan(previousInput, previousPlan, input, touchedRuns)
      : null;
    const plan = reused ?? planTimelineBlocks(input, eventsByRun);
    previousPlan = plan;
    const approvalsById = new Map(input.approvals.map((approval) => [approval.id, approval]));
    const seen = new Set<string>();
    const shown: Entry[] = [];
    const placed = new Set<string>();
    let duplicateApproval = false;
    const orphanPlans: OrphanTrail[] = [];
    const orphanSearches: OrphanTrail[] = [];
    const turnTimeByRun = new Map<string, string>();
    for (const block of plan.blocks) {
      let cached = blocks.get(block.id);
      // Plan réutilisé, run intact, mêmes demandes : ses dépendances sont
      // celles du passage précédent, inutile de les reconstruire.
      const clean = reused !== null
        && cached !== undefined
        && !seen.has(block.id)
        && (block.kind === "message" || !touchedRuns.has(block.runId))
        && !cached.approvalRefs.some(([id, approval]) => approvalsById.get(id) !== approval);
      if (!clean) {
        const deps = blockDeps(block, plan, eventsByRun, input);
        if (
          !cached
          || seen.has(block.id)
          || !sameDeps(cached.deps, deps)
          || cached.approvalRefs.some(([id, approval]) => approvalsById.get(id) !== approval)
        ) {
          cached = buildBlock(block, deps, plan, eventsByRun, input, approvalsById);
          blocks.set(block.id, cached);
        }
      }
      if (!cached) throw new Error("timeline block missing");
      seen.add(block.id);
      for (const entry of cached.entries) shown.push(entry);
      for (const id of cached.placed) {
        if (placed.has(id)) duplicateApproval = true;
        placed.add(id);
      }
      if (cached.orphanPlan) orphanPlans.push(cached.orphanPlan);
      if (cached.orphanSearch) orphanSearches.push(cached.orphanSearch);
      if (block.kind !== "message" && cached.turnTime !== undefined) turnTimeByRun.set(block.runId, cached.turnTime);
    }
    for (const id of blocks.keys()) if (!seen.has(id)) blocks.delete(id);
    // Une même demande ancrée dans deux runs (replay corrompu) : seule la
    // première compte, ce qui dépend de l'ordre global. Cas pathologique,
    // traité par la reconstruction complète.
    if (duplicateApproval) return buildTimelineModel(input);
    sortByEventOrder(orphanPlans, input.events);
    sortByEventOrder(orphanSearches, input.events);
    for (const { entry } of orphanPlans) shown.push(entry);
    for (const { entry } of orphanSearches) shown.push(entry);
    for (const approval of input.approvals) {
      if (!placed.has(approval.id)) shown.push({ kind: "gate", key: `approval:${approval.id}`, approval });
    }
    return finishTimelineModel(shown, input, {
      handoffNoticeByRun,
      runsById: plan.runsById,
      streamingRunId: streamingRunOf(input.running, input.events, eventsByRun, plan.runsById),
      turnTimeByRun,
      eventsByRun,
    }, options?.deferDerived ? [] : undefined);
  };

  return (input, options) => {
    try {
      return build(input, options);
    } catch (error) {
      previousPlan = null;
      throw error;
    } finally {
      previousInput = input;
      bucketsReshaped = false;
      touchedRuns.clear();
    }
  };
}

/**
 * Le plan précédent vaut encore si seuls des runs déjà connus ont changé de
 * ligne (statut, horodatage) sans toucher au steering : mêmes messages, même
 * ordre de runs, aucun run absorbé ni absorbant modifié. Sinon `null`, et le
 * plan est recalculé.
 */
function reusablePlan(
  previous: TimelineModelInput,
  plan: BlockPlan,
  input: TimelineModelInput,
  touchedRuns: Set<string>,
): BlockPlan | null {
  if (
    previous.userInputs !== input.userInputs
    || previous.messages !== input.messages
    || previous.runAuthors !== input.runAuthors
    || previous.toolFallbackLabel !== input.toolFallbackLabel
  ) return null;
  if (previous.runs === input.runs) return plan;
  if (previous.runs.length !== input.runs.length) return null;
  const absorbing = new Set(plan.steeredIntoRun.values());
  for (let index = 0; index < input.runs.length; index += 1) {
    const before = previous.runs[index]!;
    const after = input.runs[index]!;
    if (before === after) continue;
    if (before.id !== after.id || isAbsorbedRun(before) || isAbsorbedRun(after) || absorbing.has(after.id)) return null;
    touchedRuns.add(after.id);
  }
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  return { ...plan, runsById, steeringOf: steeringResolver(runsById, plan.steeredIntoRun) };
}
