import { asRecord } from "@openedbot/contracts-primitives";
import type {
  ProductRunStatus,
  RunDto,
  SendMessageAccepted,
  ThreadMessageDto,
  ThreadSnapshot,
  WorkflowDto,
} from "@openedbot/contracts-api";
import { messagePreviewText } from "./send-accepted";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { BotDto, GroupDto, RosterDto } from "@openedbot/contracts-api";
import type { MessageContent, Usage } from "@openedbot/contracts-api";
import { isReceiptOnlyEvent, isTerminalProductEvent, statusFromEvent } from "./terminal-event";

export { isTerminalProductEvent, statusFromEvent };

/**
 * Le vocabulaire d'Hermes, mot pour mot : `POST /v1/runs/:id/approval` refuse
 * tout ce qui n'est pas l'un de ces quatre choix (« Invalid approval choice;
 * expected one of: once, session, always, deny »). Un booléen ne suffit pas :
 * c'est le choix lui-même que le runtime attend.
 */
export const APPROVAL_CHOICES = ["once", "session", "always", "deny"] as const;
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

/**
 * La version du bloc `payload.completion`. Elle n'est pas décorative : un
 * client à jour parlant à une API plus ancienne (ou l'inverse) doit pouvoir
 * REFUSER un bloc qu'il ne sait pas lire, et retomber sur le rechargement
 * complet : jamais appliquer à moitié un patch dont il ignore la forme.
 */
export const TERMINAL_COMPLETION_VERSION = 1;

/**
 * Ce que l'événement terminal ramène du run, sans son `input` : le client a
 * déjà la ligne du run dans son snapshot, et réémettre l'invite de
 * l'utilisateur à chaque fin de génération doublerait le poids de la trame
 * pour une valeur qui ne change jamais.
 */
export type TerminalRunPatch = Pick<
  RunDto,
  "id" | "status" | "output" | "usage" | "error" | "endedAt" | "lastEventAt"
> & {
  completionKind: string | null;
  recoveryState: "needs_review" | null;
  /**
   * Le modèle du run. Optionnel : une API plus ancienne ne l'envoie pas, et
   * son absence laisse le modèle déjà connu du run en cache (posé à `null` à
   * l'envoi optimiste) intact.
   */
  model?: string | null;
};

/**
 * Le contenu persisté qu'un événement terminal transporte, pour que le client
 * n'ait plus à retélécharger le fil entier quand une génération se termine.
 *
 * `messages` est un TABLEAU et non un message : un courrier de hand-off annulé
 * écrit sa réponse et clôt son run dans la même transaction, et un tour de
 * salon qui « passe » n'en écrit aucun. Zéro, un ou deux : la forme reste la
 * même.
 */
export type TerminalCompletion = {
  version: number;
  messages: ThreadMessageDto[];
  run: TerminalRunPatch;
  workflow: WorkflowDto | null;
};

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Un message persisté, validé au strict minimum dont le rendu dépend. */
function readCompletionMessage(value: unknown): ThreadMessageDto | null {
  const row = asRecord(value);
  if (!row) return null;
  if (typeof row.id !== "string" || row.id === "") return null;
  if (row.role !== "user" && row.role !== "assistant") return null;
  if (!Array.isArray(row.content)) return null;
  if (typeof row.createdAt !== "string" || row.createdAt === "") return null;
  if (!nullableString(row.runId)) return null;
  return {
    ...(row as unknown as ThreadMessageDto),
    role: row.role,
    content: row.content as MessageContent,
    createdAt: row.createdAt,
    runId: row.runId,
  };
}

function readRunPatch(value: unknown, runId: string): TerminalRunPatch | null {
  const row = asRecord(value);
  if (!row) return null;
  // Un patch qui désigne un AUTRE run que celui de l'événement est une
  // incohérence serveur, pas une donnée à appliquer de travers.
  if (row.id !== runId) return null;
  if (typeof row.status !== "string") return null;
  if (!nullableString(row.output) || !nullableString(row.error)) return null;
  if (!nullableString(row.endedAt) || !nullableString(row.lastEventAt)) return null;
  return {
    id: runId,
    status: row.status as ProductRunStatus,
    output: row.output,
    usage: (row.usage ?? null) as Usage | null,
    error: row.error,
    endedAt: row.endedAt,
    lastEventAt: row.lastEventAt,
    completionKind: typeof row.completionKind === "string" ? row.completionKind : null,
    recoveryState: row.recoveryState === "needs_review" ? "needs_review" : null,
    // Seule une valeur lisible est portée : `null` ou l'absence ne doivent pas
    // effacer un modèle déjà connu au moment du `{ ...run, ...patch }`.
    ...(typeof row.model === "string" && row.model.trim() ? { model: row.model } : {}),
  };
}

function readWorkflowPatch(value: unknown): WorkflowDto | null {
  const row = asRecord(value);
  if (!row) return null;
  if (typeof row.id !== "string" || typeof row.status !== "string") return null;
  if (typeof row.updatedAt !== "string") return null;
  return row as unknown as WorkflowDto;
}

/**
 * Le bloc `completion` d'un événement terminal, ou `null` quand il n'y en a
 * pas d'exploitable.
 *
 * `null` n'est jamais un silence : c'est le signal qui fait retomber les deux
 * clients sur l'invalidation complète du fil (API antérieure à ce lot, champ
 * manquant, forme inattendue). Mieux vaut un GET de trop qu'une bulle finale
 * qui n'arrive jamais.
 */
export function readTerminalCompletion(
  event: Pick<StoredProductEvent, "type" | "payload" | "runId">,
): TerminalCompletion | null {
  if (!isTerminalProductEvent(event)) return null;
  const block = asRecord(event.payload?.completion);
  if (!block) return null;
  if (block.version !== TERMINAL_COMPLETION_VERSION) return null;
  if (!Array.isArray(block.messages)) return null;
  const messages: ThreadMessageDto[] = [];
  for (const candidate of block.messages) {
    const message = readCompletionMessage(candidate);
    // Un seul message illisible invalide TOUT le bloc : appliquer les autres
    // laisserait le fil dans un état que rien ne vient corriger.
    if (!message) return null;
    messages.push(message);
  }
  const run = readRunPatch(block.run, event.runId);
  if (!run) return null;
  const workflow = block.workflow === null || block.workflow === undefined
    ? null
    : readWorkflowPatch(block.workflow);
  if (block.workflow !== null && block.workflow !== undefined && !workflow) return null;
  return { version: TERMINAL_COMPLETION_VERSION, messages, run, workflow };
}

/**
 * Insère un message persisté à sa place, et JAMAIS deux fois.
 *
 * Deux dédoublonnages, parce qu'il y a deux façons de recevoir deux fois le
 * même message : la reconnexion SSE rejoue l'événement (l'identité
 * `runId`+`sequence` la couvre déjà en amont), et un rechargement du snapshot
 * peut avoir ramené le message alors que l'événement terminal, lui, est sorti
 * de la fenêtre `?events=compact`. Seul l'identifiant du message tranche les
 * deux cas.
 *
 * La position se décide sur `createdAt` : le snapshot est trié par `sequence`
 * en base, que le client n'a pas, et un message écrit pendant qu'un run
 * tournait ne doit pas se retrouver après lui.
 */
export function mergePersistedMessages(
  messages: readonly ThreadMessageDto[],
  incoming: readonly ThreadMessageDto[],
): ThreadMessageDto[] {
  let next: ThreadMessageDto[] | null = null;
  for (const message of incoming) {
    const current: readonly ThreadMessageDto[] = next ?? messages;
    if (current.some((known) => known.id === message.id)) continue;
    let index = current.length;
    while (index > 0) {
      const previous = current[index - 1]!;
      if (previous.createdAt < message.createdAt) break;
      if (previous.createdAt === message.createdAt && previous.id <= message.id) break;
      index -= 1;
    }
    next = [...current.slice(0, index), message, ...current.slice(index)];
  }
  return next ?? [...messages];
}

/**
 * Ce qu'un événement oblige encore à RELIRE, une fois le snapshot muté.
 *
 * La règle vit ici, et non dans chacun des deux `use-thread-stream.ts` : web
 * et le client natif la partageaient déjà mot pour mot, et une divergence se paierait
 * en « le bot a répondu mais l'écran ne le montre pas » sur un seul des deux :
 * exactement le genre de défaut qu'un typecheck ne voit jamais.
 *
 * `thread` retombe à `true` dès que le patch ne peut pas couvrir l'événement :
 * pas de snapshot en cache, run inconnu, bloc `completion` absent ou illisible.
 * `roster` ne se relit plus par événement : `applyProductEventToRoster` patche
 * la ligne du fil en cache. Seul un run que le snapshot ne connaît pas, donc
 * potentiellement un fil ou un bot que le roster ne connaît pas non plus,
 * force encore sa relecture.
 *
 * Un événement que le snapshot a DÉJÀ (curseur inférieur ou égal au sien)
 * n'oblige à rien : le rejeu SSE à la reconnexion en livrait des dizaines, et
 * chacun déclenchait un `GET /api/bots` pour ne rien apprendre.
 */
export function snapshotRefreshAfterEvent(input: {
  event: StoredProductEvent;
  /** Un snapshot existe-t-il déjà en cache pour ce fil ? */
  hasSnapshot: boolean;
  /** Le run de l'événement est-il absent du snapshot ? */
  unknownRun: boolean;
  /** Curseur du snapshot en cache AVANT application de l'événement. */
  snapshotCursor?: number;
}): { thread: boolean; roster: boolean } {
  const { event, hasSnapshot, unknownRun, snapshotCursor } = input;
  if (snapshotCursor !== undefined && event.cursor <= snapshotCursor) {
    return { thread: false, roster: false };
  }
  // Un run déjà dans le snapshot se patche en place (texte, outil, raisonnement).
  // Relire `/history` à chacun de ces événements rallongeait le tour (DEV-212).
  if (
    hasSnapshot
    && !unknownRun
    && (
      event.type === "agent.message"
      || event.type === "agent.reasoning"
      || event.type === "tool.call"
      || event.type === "tool.result"
    )
  ) {
    return { thread: false, roster: false };
  }
  const gate = event.type === "approval.requested" || event.type === "approval.responded";
  // L'ACK Hermes conclut aussi le run FIFO créé comme repli du steer. Cet
  // autre run n'est pas celui de l'événement et ne peut donc pas être patché
  // localement : sans relecture, il reste `queued` dans le cache et le fil
  // affiche « En attente… » jusqu'au prochain GET (ou indéfiniment tant que
  // le SSE reste connecté).
  const acceptedSteer = event.type === "raw" &&
    event.payload.event === "run.steered" && event.payload.accepted === true;
  const signalOnly = gate || event.type === "bot.message" || acceptedSteer || isReceiptOnlyEvent(event);
  const terminal = isTerminalProductEvent(event);
  const patched = terminal && hasSnapshot && !unknownRun && readTerminalCompletion(event) !== null;
  return {
    thread: unknownRun || signalOnly || (terminal && !patched),
    roster: unknownRun,
  };
}

/**
 * Une ligne du roster, bot ou salon, réduite aux champs que le flux sait
 * faire bouger. `BotDto` et `GroupDto` la satisfont tous les deux.
 */
type RosterRow = {
  threadId: string;
  pinned?: boolean;
  position: number;
  lastActivityAt: string;
  preview: string | null;
  awaitingApproval: boolean;
  running?: boolean;
  unread?: boolean;
};

/**
 * L'enveloppe telle qu'elle arrive du flux d'organisation : `threadId` peut
 * être nul (événement hors fil) et `occurredAt` est une chaîne sur le fil,
 * une `Date` dans le worker. Le roster ne fait pas la différence.
 */
export type RosterEvent = Pick<StoredProductEvent, "type" | "payload" | "runId" | "cursor" | "sequence"> & {
  threadId: string | null;
  occurredAt: string | Date;
};

/** Même troncature que le SQL du roster (`left(..., 160)` sur le premier bloc texte). */
const ROSTER_PREVIEW_LENGTH = 160;

function isoOccurredAt(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function firstTextBlock(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const first = asRecord(content[0]);
  return first && typeof first.text === "string" ? first.text : null;
}

/**
 * L'aperçu que le serveur calculerait après cet événement, ou `null` quand
 * l'événement ne transporte pas de texte affichable : le dernier message
 * persisté du bloc `completion`, ou le texte d'un `bot.message`.
 */
function rosterPreviewFromEvent(event: RosterEvent): string | null {
  if (event.type === "bot.message") {
    const text = event.payload?.text;
    return typeof text === "string" ? text.slice(0, ROSTER_PREVIEW_LENGTH) : null;
  }
  const completion = readTerminalCompletion(event);
  if (!completion) return null;
  for (let index = completion.messages.length - 1; index >= 0; index -= 1) {
    const text = firstTextBlock(completion.messages[index]!.content);
    if (text !== null) return text.slice(0, ROSTER_PREVIEW_LENGTH);
  }
  return null;
}

/** L'ordre de `GET /api/bots` : épinglés d'abord, puis activité décroissante, puis position. */
function compareRosterRows(left: RosterRow, right: RosterRow): number {
  const pinned = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
  if (pinned !== 0) return pinned;
  const activity = Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt);
  if (activity !== 0 && !Number.isNaN(activity)) return activity;
  return left.position - right.position;
}

function isSortedBy<T>(rows: readonly T[], compare: (left: T, right: T) => number): boolean {
  for (let index = 1; index < rows.length; index += 1) {
    if (compare(rows[index - 1]!, rows[index]!) > 0) return false;
  }
  return true;
}

/**
 * Un événement que la ligne reflète DÉJÀ.
 *
 * `lastActivityAt` est calculé par le serveur comme le max des `occurred_at`
 * des événements du fil (et des messages) : un événement daté à ou avant ce
 * max était visible quand la ligne a été lue. Le rejeu SSE à la reconnexion
 * en renvoie des dizaines ; les appliquer marquait non-lu un fil déjà lu et
 * rallumait la pastille d'un run terminé. Deux horloges SERVEUR se comparent
 * ici, jamais celle du client, qui peut être en avance et ferait passer un
 * événement live pour ancien.
 */
export function isEventReflectedInRosterRow(
  row: Pick<RosterRow, "lastActivityAt">,
  event: Pick<RosterEvent, "occurredAt">,
): boolean {
  const occurredAt = isoOccurredAt(event.occurredAt);
  if (occurredAt === null) return false;
  const known = Date.parse(row.lastActivityAt);
  return !Number.isNaN(known) && Date.parse(occurredAt) <= known;
}

/**
 * Un événement que le roster reflète déjà, par CURSEUR : `roster.cursor` est
 * le `max(cursor)` lu en premier dans la transaction qui l'a construit, et
 * l'ordre des curseurs est l'ordre des commits. Pas d'horloge : `occurredAt`
 * est l'heure de capture côté worker, et un `run.completed` capturé avant un
 * delta d'un autre bot peut être commité APRÈS lui. Comparer des dates
 * l'aurait classé « déjà connu » et laissé son fil « en cours ». Sans
 * `cursor` (API antérieure), on ne sait pas : rien n'est réputé périmé ici,
 * seule la garde par ligne (`isEventReflectedInRosterRow`) s'applique.
 */
export function isStaleRosterEvent(
  event: { cursor?: number },
  roster: Pick<RosterDto, "cursor"> | undefined,
): boolean {
  const cursor = roster?.cursor;
  return typeof cursor === "number" && Number.isFinite(cursor)
    && typeof event.cursor === "number" && event.cursor <= cursor;
}

/** Le curseur du roster après application d'un événement : jamais en arrière. */
function advancedRosterCursor(roster: Pick<RosterDto, "cursor">, event: Pick<RosterEvent, "cursor">): number | undefined {
  if (typeof roster.cursor !== "number") return roster.cursor;
  if (!Number.isSafeInteger(event.cursor)) return roster.cursor;
  return Math.max(roster.cursor, event.cursor);
}

const ACTIVE_WORKFLOW_STATUSES = new Set(["queued", "running", "awaiting_approval", "reconciling"]);

const RUN_ACTIVITY_EVENT_TYPES = new Set<RosterEvent["type"]>([
  "agent.message",
  "agent.reasoning",
  "tool.call",
  "tool.result",
  "approval.requested",
  "run.provider_fallback",
]);

/** Le workflow commité avec ce run terminal a-t-il encore une étape en file ? */
function workflowContinues(event: RosterEvent): boolean {
  const status = readTerminalCompletion(event)?.workflow?.status;
  return typeof status === "string" && ACTIVE_WORKFLOW_STATUSES.has(status);
}

function patchRosterRow<T extends RosterRow>(
  row: T,
  event: RosterEvent,
  openThreadId: string | undefined,
): T {
  if (isEventReflectedInRosterRow(row, event)) return row;
  const terminal = isTerminalProductEvent({ type: event.type, payload: event.payload });
  const botMessage = event.type === "bot.message";
  const next: T = { ...row };
  let changed = false;

  const occurredAt = isoOccurredAt(event.occurredAt);
  if (occurredAt !== null) {
    next.lastActivityAt = occurredAt;
    changed = true;
  }

  const preview = rosterPreviewFromEvent(event);
  if (preview !== null && preview !== row.preview) {
    next.preview = preview;
    changed = true;
  }

  // Jamais remis à `false` ici : seul l'accusé de lecture de l'utilisateur
  // (`thread_reads`) le fait, et c'est le serveur qui le sait.
  if ((terminal || botMessage) && event.threadId !== openThreadId && row.unread !== true) {
    next.unread = true;
    changed = true;
  }

  if (event.type === "approval.requested") {
    // A gate under automatic review (PERM2-7) waits for nobody yet.
    if (event.payload.reviewing !== true && row.awaitingApproval !== true) { next.awaitingApproval = true; changed = true; }
    if (row.running !== true) { next.running = true; changed = true; }
  } else if (event.type === "approval.responded") {
    if (row.awaitingApproval !== false) { next.awaitingApproval = false; changed = true; }
  } else if (terminal) {
    if (row.awaitingApproval !== false) { next.awaitingApproval = false; changed = true; }
    // Un tour de salon qui passe la main laisse son workflow actif : le
    // membre suivant est déjà en file. Le salon reste « en cours » au lieu de
    // clignoter jusqu'au premier événement du tour suivant.
    const continues = workflowContinues(event);
    if (row.running !== continues) { next.running = continues; changed = true; }
  } else if (RUN_ACTIVITY_EVENT_TYPES.has(event.type) && row.running !== true) {
    // Une notice (pass, fin de salon) suit la fin du run : elle ne le rallume pas.
    // Un run qui émet est un run actif, y compris quand la ligne n'en savait
    // rien parce que le roster datait d'avant son démarrage.
    next.running = true;
    changed = true;
  }

  return changed ? next : row;
}

function patchRosterRows<T extends RosterRow>(
  rows: readonly T[],
  event: RosterEvent,
  openThreadId: string | undefined,
): { rows: T[]; changed: boolean } {
  const index = rows.findIndex((row) => row.threadId === event.threadId);
  if (index < 0) return { rows: rows as T[], changed: false };
  const patched = patchRosterRow(rows[index]!, event, openThreadId);
  if (patched === rows[index]) return { rows: rows as T[], changed: false };
  const next = rows.map((row, position) => (position === index ? patched : row));
  // Le serveur trie par activité ; une ligne qui vient de bouger remonte,
  // comme elle le ferait au prochain `GET`. Un roster qui n'était pas dans
  // cet ordre (tri local, ancien serveur) est laissé tel quel.
  if (patched.lastActivityAt !== rows[index]!.lastActivityAt && isSortedBy(rows, compareRosterRows)) {
    next.sort(compareRosterRows);
  }
  return { rows: next, changed: true };
}

/**
 * Applique un événement d'organisation à la ligne du roster qu'il concerne.
 *
 * Le roster projette TOUS les fils : dernier message, horodatage, non-lu,
 * pastille d'exécution. C'est ce que le flux SSE annonce déjà, fil par
 * fil. Le patcher ici évite un `GET /api/bots` par événement ; la relecture
 * périodique (deux minutes) et celle des mutations restent le filet.
 *
 * Retourne le MÊME objet quand rien ne change : React Query n'a alors rien à
 * notifier, et les observateurs ne re-rendent pas.
 */
export function applyProductEventToRoster(
  roster: RosterDto,
  event: RosterEvent,
  options: { openThreadId?: string } = {},
): RosterDto {
  if (event.threadId === null || isStaleRosterEvent(event, roster)) return roster;
  if (isReceiptOnlyEvent(event)) {
    const cursor = advancedRosterCursor(roster, event);
    return cursor === roster.cursor ? roster : { ...roster, cursor };
  }
  const bots = patchRosterRows(roster.bots, event, options.openThreadId);
  if (bots.changed) return { ...roster, bots: bots.rows, cursor: advancedRosterCursor(roster, event) };
  if (!roster.groups) return roster;
  const groups = patchRosterRows(roster.groups, event, options.openThreadId);
  if (groups.changed) return { ...roster, groups: groups.rows, cursor: advancedRosterCursor(roster, event) };
  return roster;
}

/** La ligne (bot ou salon) dont le fil est `threadId`, si le roster la porte. */
export function findRosterThread(roster: RosterDto, threadId: string): BotDto | GroupDto | undefined {
  return roster.bots.find((row) => row.threadId === threadId)
    ?? roster.groups?.find((row) => row.threadId === threadId);
}

/**
 * L'accusé de lecture, appliqué localement : la ligne du fil passe `unread:
 * false`. C'est ce que le serveur répondrait après `markThreadRead`, le
 * relire coûtait un `GET /api/bots` par ouverture de fil pour l'apprendre.
 * Même objet si la ligne est absente ou déjà lue.
 */
export function markRosterThreadRead(roster: RosterDto, threadId: string): RosterDto {
  const botIndex = roster.bots.findIndex((row) => row.threadId === threadId);
  if (botIndex >= 0) {
    if (roster.bots[botIndex]!.unread !== true) return roster;
    return {
      ...roster,
      bots: roster.bots.map((row, index) => (index === botIndex ? { ...row, unread: false } : row)),
    };
  }
  const groupIndex = roster.groups?.findIndex((row) => row.threadId === threadId) ?? -1;
  if (groupIndex < 0 || !roster.groups) return roster;
  if (roster.groups[groupIndex]!.unread !== true) return roster;
  return {
    ...roster,
    groups: roster.groups.map((row, index) => (index === groupIndex ? { ...row, unread: false } : row)),
  };
}

// Les clés `(runId, sequence)` du dernier tableau d'événements patché. Le
// patch suivant part presque toujours de ce tableau : la recherche de doublon
// ne reparcourt plus tout le fil chargé. Un autre tableau (autre fil, snapshot
// relu) reconstruit l'index depuis ses propres lignes.
let eventKeyIndex: { events: readonly StoredProductEvent[]; keys: Set<string> } | null = null;

function eventKey(event: Pick<StoredProductEvent, "runId" | "sequence">): string {
  return `${event.runId}:${event.sequence}`;
}

function knownEventKeys(events: readonly StoredProductEvent[]): Set<string> {
  if (eventKeyIndex?.events === events) return eventKeyIndex.keys;
  const keys = new Set(events.map(eventKey));
  eventKeyIndex = { events, keys };
  return keys;
}

export function applyProductEventToSnapshot(
  snapshot: ThreadSnapshot,
  event: StoredProductEvent,
): ThreadSnapshot {
  const keys = knownEventKeys(snapshot.events);
  const key = eventKey(event);
  if (keys.has(key)) return snapshot;

  const nextStatus = statusFromEvent(event);
  const now = new Date().toISOString();
  const next: ThreadSnapshot = {
    ...snapshot,
    cursor: Number.isSafeInteger(event.cursor) ? Math.max(snapshot.cursor, event.cursor) : snapshot.cursor,
    // Nouveau tableau, mêmes objets devant : le modèle incrémental reconnaît
    // l'ajout par identité d'élément. Pousser dans le tableau déjà en cache
    // le réutiliserait (`events === source`) et l'événement ne serait pas vu.
    events: appendIndexedEvent(snapshot.events, keys, key, event),
    runs: snapshot.runs.map((run) => {
      if (run.id !== event.runId) return run;

      const withEventAt = { ...run, lastEventAt: now };

      if (nextStatus === "awaiting_approval") {
        return { ...withEventAt, status: "awaiting_approval" };
      }
      if (nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled") {
        return {
          ...withEventAt,
          status: nextStatus,
          endedAt: now,
          error:
            event.type === "run.error"
              ? String(event.payload.message ?? "Erreur Hermes.")
              : run.error,
          // Le code stable voyage avec l'événement : sans lui, l'alerte
          // « modèle indisponible » attendrait un rechargement du fil.
          ...(event.type === "run.error" && typeof event.payload.errorCode === "string"
            ? { errorCode: event.payload.errorCode }
            : {}),
        };
      }
      if (isReceiptOnlyEvent(event)) return withEventAt;
      // `queued` compte : le 202 pose le run `queued` en cache, et sans cette
      // promotion il le restait jusqu'à sa fin, outils exécutés compris. Une
      // notice ne prouve pas l'exécution : elle ne promeut pas un run en file.
      if (
        run.status === "pending" || run.status === "starting" ||
        (run.status === "queued" && event.type !== "system.notice")
      ) {
        return {
          ...withEventAt,
          status: "running",
          startedAt: run.startedAt ?? now,
        };
      }
      return withEventAt;
    }),
  };

  const completion = readTerminalCompletion(event);
  if (!completion) return next;
  return {
    ...next,
    messages: mergePersistedMessages(next.messages, completion.messages),
    // Les valeurs de la BASE remplacent celles que `statusFromEvent` avait
    // devinées à `now` : c'est le même run, mais daté par le serveur.
    runs: next.runs.map((run) => (run.id === completion.run.id ? { ...run, ...completion.run } : run)),
    workflows: mergeCompletionWorkflow(next.workflows, completion.workflow),
  };
}

/** Le nouveau tableau hérite de l'index : l'ancien n'en a plus, et le reconstruira s'il est repatché. */
function appendIndexedEvent(
  events: readonly StoredProductEvent[],
  keys: Set<string>,
  key: string,
  event: StoredProductEvent,
): StoredProductEvent[] {
  // `slice` + `push` : une copie mémoire du tableau, sans passer par l'itérateur
  // que le spread parcourt élément par élément.
  const next = events.slice();
  next.push(event);
  keys.add(key);
  eventKeyIndex = { events: next, keys };
  appendedFrom.set(next, new WeakRef(events));
  return next;
}

// `suite -> tableau d'origine` pour un tableau obtenu en ajoutant UN événement
// à la fin d'un autre. Les tableaux du fil sont traités comme immuables : le
// lien reste vrai tant que le tableau vit. La valeur est une `WeakRef` : une
// référence forte chaînerait chaque tableau à tous ses ancêtres, soit une
// copie du préfixe par événement retenue pendant tout le streaming.
const appendedFrom = new WeakMap<readonly StoredProductEvent[], WeakRef<readonly StoredProductEvent[]>>();

/**
 * Le tableau dont `events` est l'extension d'un seul événement en queue, ou
 * `undefined` si `events` ne sort pas d'un patch SSE. Permet à un consommateur
 * incrémental de prouver « mêmes objets devant » sans comparer les N éléments.
 */
export function eventsAppendedFrom(
  events: readonly StoredProductEvent[],
): readonly StoredProductEvent[] | undefined {
  return appendedFrom.get(events)?.deref();
}

/**
 * Le workflow du run, remplacé en place, sauf s'il est PLUS VIEUX que ce que
 * le fil connaît déjà.
 *
 * La garde n'est pas théorique : un rechargement du snapshot parti après ce
 * run peut revenir avec l'étape SUIVANTE déjà démarrée, et rejouer alors le
 * bloc d'un événement sorti de la fenêtre `?events=compact` ferait reculer le
 * workflow de `running` à ce qu'il était une étape plus tôt.
 */
function mergeCompletionWorkflow(
  workflows: WorkflowDto[] | undefined,
  workflow: WorkflowDto | null,
): WorkflowDto[] | undefined {
  if (!workflow) return workflows;
  if (!workflows) return [workflow];
  const known = workflows.find((candidate) => candidate.id === workflow.id);
  if (!known) return [...workflows, workflow];
  if (known.updatedAt > workflow.updatedAt) return workflows;
  return workflows.map((candidate) => (candidate.id === workflow.id ? workflow : candidate));
}

function isTerminalRunStatus(status: ProductRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function hasTerminalRunState(
  snapshot: Pick<ThreadSnapshot, "runs" | "events">,
  runId: string,
): boolean {
  return snapshot.runs.some((run) => run.id === runId && isTerminalRunStatus(run.status))
    || snapshot.events.some((event) => event.runId === runId && isTerminalProductEvent(event));
}

function newestTimestamp(current: string, candidate: string): string {
  const candidateTime = Date.parse(candidate);
  if (Number.isNaN(candidateTime)) return current;
  const currentTime = Date.parse(current);
  if (Number.isNaN(currentTime) || candidateTime > currentTime) return candidate;
  return current;
}

/**
 * Applique le 202 d'un envoi au snapshot en cache : le message persisté, le
 * run `queued` (s'il est nouveau), le workflow, les notices de hand-off.
 *
 * Sans `message`, le 202 est trop mince pour un patch (API antérieure) : le
 * même objet est rendu pour que l'appelant relise le fil.
 */
export function applySendAcceptedToSnapshot(
  snapshot: ThreadSnapshot,
  accepted: SendMessageAccepted,
): ThreadSnapshot {
  if (!accepted.message) return snapshot;
  let next = snapshot;
  if (!next.messages.some((message) => message.id === accepted.message!.id)) {
    next = { ...next, messages: mergePersistedMessages(next.messages, [accepted.message]) };
  }
  if (accepted.events?.length) {
    const extra = accepted.events.filter((event) =>
      !next.events.some((known) => known.runId === event.runId && known.sequence === event.sequence));
    if (extra.length) next = { ...next, events: [...next.events, ...extra] };
  }
  if (accepted.run && !next.runs.some((run) => run.id === accepted.run!.id)
    && !hasTerminalRunState(next, accepted.run.id)) {
    next = { ...next, runs: [...next.runs, accepted.run] };
  }
  if (accepted.workflow) {
    const workflows = next.workflows ?? [];
    if (!workflows.some((workflow) => workflow.id === accepted.workflow!.id)
      && !hasTerminalRunState(next, accepted.workflow.rootRunId)) {
      next = { ...next, workflows: [...workflows, accepted.workflow] };
    }
  }
  if (accepted.supersededRunId) {
    const runs = next.runs.map((run) =>
      run.id === accepted.supersededRunId && !hasTerminalRunState(next, run.id)
        ? { ...run, status: "cancelled" as const }
        : run);
    if (runs.some((run, index) => run !== next.runs[index])) next = { ...next, runs };
  }
  const updatedAt = newestTimestamp(next.updatedAt, accepted.message.createdAt);
  if (next === snapshot && updatedAt === snapshot.updatedAt) return snapshot;
  return updatedAt === next.updatedAt ? next : { ...next, updatedAt };
}

export function applySendAcceptedToRoster(
  roster: RosterDto,
  input: { threadId: string; accepted: SendMessageAccepted; openThreadId?: string },
): RosterDto {
  const createdAt = input.accepted.message?.createdAt;
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) return roster;
  const preview = input.accepted.message
    ? messagePreviewText(input.accepted.message.content)
    : null;
  const botIndex = roster.bots.findIndex((row) => row.threadId === input.threadId);
  if (botIndex >= 0) {
    const rows = patchRosterAfterSend(roster.bots, botIndex, createdAt, preview, input.openThreadId);
    return rows === roster.bots ? roster : { ...roster, bots: rows };
  }
  const groupIndex = roster.groups?.findIndex((row) => row.threadId === input.threadId) ?? -1;
  if (groupIndex < 0 || !roster.groups) return roster;
  const rows = patchRosterAfterSend(roster.groups, groupIndex, createdAt, preview, input.openThreadId);
  return rows === roster.groups ? roster : { ...roster, groups: rows };
}

function patchRosterAfterSend<T extends RosterRow>(
  rows: readonly T[],
  index: number,
  lastActivityAt: string,
  preview: string | null,
  openThreadId: string | undefined,
): T[] {
  const row = rows[index]!;
  if (isEventReflectedInRosterRow(row, { occurredAt: lastActivityAt })) return rows as T[];
  const next: T = { ...row };
  let changed = false;
  if (row.lastActivityAt !== lastActivityAt) {
    next.lastActivityAt = lastActivityAt;
    changed = true;
  }
  if (preview !== null && preview !== row.preview) {
    next.preview = preview;
    changed = true;
  }
  if (row.running !== true) {
    next.running = true;
    changed = true;
  }
  if (row.threadId !== openThreadId && row.unread !== true) {
    next.unread = true;
    changed = true;
  }
  if (!changed) return rows as T[];
  const patched = rows.map((candidate, position) => (position === index ? next : candidate));
  if (isSortedBy(rows, compareRosterRows)) patched.sort(compareRosterRows);
  return patched;
}
