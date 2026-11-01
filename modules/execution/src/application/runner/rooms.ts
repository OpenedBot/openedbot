import type { SQL } from "bun";
import type { HermesRunImage } from "@openedbot/hermes";
import { insertAssistantMessage } from "@openedbot/conversation/sql/messages";
import { getArtifactBlob } from "../artifact-store";
import {
  ATTACHMENT_LIMITS,
  attachmentChips,
  modelTextFromContent,
  type AttachmentGap,
  type LoadedAttachment,
} from "@openedbot/conversation/domain/attachments";
import {
  GROUP_ADDRESSED_NUDGE,
  ROOM_LIMITS,
  ROOM_NOTICE_KIND,
  attributedInput,
  buildGroupInstructions,
  isPass,
  operatorAttributedInput,
  withBotModeInstructions,
  type OperatorIdentity,
} from "@openedbot/roster/domain/bot-mode";
import {
  advanceGroupSend,
  buildGroupRouteInstructions,
  coerceGroupDefaultResponder,
  isGroupNudgeTurn,
  isGroupSendState,
  type GroupSendState,
} from "../../domain/group-send";
import {
  HISTORY_CHAR_BUDGET,
  assemblePackedHistory,
  buildRoomPackInstructions,
  historyCharCount,
  planConversationPack,
  type HistoryMessage,
} from "@openedbot/conversation/domain/thread-compaction";
import {
  compactRoomThread,
  readThreadCompaction,
  type CompactHermes,
} from "@openedbot/conversation/application/compact-thread";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import type { WorkerConfig } from "../worker-config";
import { appendNoticeTx } from "./events";
import { HISTORY_MESSAGE_CAP, MAX_HISTORY_CHARS, runImage, trimHistoryToCharBudget } from "./history";
import { assistantContent } from "./transcript";
import type { GroupRunContext, LegacyGroupRunContext, RunContext } from "./types";

type GroupWorkflowLimits = {
  maxSteps: number;
  usedSteps: number;
  tokenBudget: string | number;
  usedTokens: string | number;
  deadlineAt: Date | string;
};

type GroupLimitCode = "WORKFLOW_DEADLINE_EXCEEDED" | "WORKFLOW_TOKEN_BUDGET_EXHAUSTED" | "WORKFLOW_STEP_LIMIT";
/**
 * Atteindre une limite QU'ON A CONFIGURÉE n'est pas un échec : le tour demandé
 * a répondu, la série s'arrête simplement là. Seul un dépassement réel : la
 * deadline franchie, le budget consommé au-delà de sa valeur : reste un échec.
 */
type GroupWorkflowLimitOutcome =
  | { kind: "overrun"; status: "expired" | "failed"; errorCode: GroupLimitCode; message: string }
  | { kind: "settled"; errorCode: GroupLimitCode; message: string };

/**
 * Borne DURE du salon, à contraster avec le DM où le budget de jetons n'agit
 * que via `canDelegate` (borne molle : la chaîne engagée finit sa synthèse).
 * Un tour de salon est une réponse complète sans remontée à protéger, donc on
 * peut couper entre deux tours sans jeter de travail partiel. Asymétrie
 * assumée, documentée dans docs/cloud/MULTI_BOT.md § Budgets d'autonomie.
 */
export function groupWorkflowLimitOutcome(
  workflow: GroupWorkflowLimits,
  hasNextTurn: boolean,
  now = Date.now(),
): GroupWorkflowLimitOutcome | null {
  if (new Date(workflow.deadlineAt).getTime() <= now) {
    return {
      kind: "overrun",
      status: "expired",
      errorCode: "WORKFLOW_DEADLINE_EXCEEDED",
      message: "La durée maximale du workflow de salon est atteinte.",
    };
  }
  const usedTokens = Number(workflow.usedTokens);
  const tokenBudget = Number(workflow.tokenBudget);
  // Franchir le budget reste un échec : on a dépensé plus que ce qui était
  // autorisé. L'atteindre exactement, en revanche, est le comportement voulu
  // d'un plafond : le tour a répondu, il n'y a simplement plus de place pour
  // le suivant.
  if (usedTokens > tokenBudget) {
    return {
      kind: "overrun",
      status: "failed",
      errorCode: "WORKFLOW_TOKEN_BUDGET_EXHAUSTED",
      message: "Le budget de jetons du workflow de salon est dépassé.",
    };
  }
  if (hasNextTurn && usedTokens >= tokenBudget) {
    return {
      kind: "settled",
      errorCode: "WORKFLOW_TOKEN_BUDGET_EXHAUSTED",
      message: "Le salon s’arrête : le budget de jetons configuré est atteint.",
    };
  }
  if (hasNextTurn && workflow.usedSteps >= workflow.maxSteps) {
    return {
      kind: "settled",
      errorCode: "WORKFLOW_STEP_LIMIT",
      message: "Le salon s’arrête : le nombre d’étapes configuré est atteint.",
    };
  }
  return null;
}

// ── Salon (Hermes « Groups and group chats ») ────────────────────────────────
//
// Un message de l'opérateur ouvre un ENVOI (l'API pose `runs.group_state` via
// initGroupSend) ; le worker exécute chaque tour et fait avancer l'état via
// advanceGroupSend. Un tour = un run ordinaire dont l'entrée est ce que le
// membre n'a PAS encore lu, attribué ligne à ligne.

/** L'état de salon porté par le run, ou null si ce n'est pas un tour de salon. */
export function groupSendState(context: RunContext): GroupSendState | null {
  return context.groupId && isGroupSendState(context.groupState) ? context.groupState : null;
}

/** L'entrée d'une synthèse d'équipe quand rien de neuf n'est arrivé depuis sa contribution. */
const GROUP_SYNTHESIS_CUE = "Write the team's final answer now.";

/** Une ligne du fil telle que lue en base, avec l'auteur résolu. */
type RoomLine = {
  role: string;
  content: unknown;
  runId?: string | null;
  authorBotId: string | null;
  authorName: string | null;
  authorSlug: string | null;
  sequence?: number;
};

/** Fenêtre de repli quand le membre n'a jamais parlé : les 30 derniers messages. */
const ROOM_UNREAD_FALLBACK = 30;

/**
 * Coupe le fil au dernier message du membre : `unread` = tout ce qui suit
 * (son entrée), `before` = tout ce qui précède, son propre dernier message
 * inclus (son historique). Jamais parlé → les 30 derniers messages sont non lus.
 */
function splitRoomUnread(
  lines: readonly RoomLine[],
  selfBotId: string,
  fallbackWindow = ROOM_UNREAD_FALLBACK,
): { before: RoomLine[]; unread: RoomLine[] } {
  let lastOwn = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.authorBotId === selfBotId) { lastOwn = index; break; }
  }
  const cut = lastOwn >= 0 ? lastOwn + 1 : Math.max(0, lines.length - fallbackWindow);
  return { before: lines.slice(0, cut), unread: lines.slice(cut) };
}

/**
 * Un curseur scalaire ne peut pas représenter un trou : A peut écrire sa
 * réponse après que le follow-up B a été inséré, donc « lu jusqu'à la réponse
 * A » dépasserait aussi la séquence de B. Le run racine B doit toujours relire
 * sa propre entrée opérateur, même si le curseur du membre l'a franchie.
 */
function forceCurrentRootInputUnread(
  partition: { before: RoomLine[]; unread: RoomLine[] },
  currentRunId: string,
): { before: RoomLine[]; unread: RoomLine[] } {
  const forced = partition.before.filter((line) => line.role === "user" && line.runId === currentRunId);
  if (!forced.length) return partition;
  const forcedSet = new Set(forced);
  return {
    before: partition.before.filter((line) => !forcedSet.has(line)),
    unread: [...forced, ...partition.unread].sort((left, right) => (left.sequence ?? -1) - (right.sequence ?? -1)),
  };
}

/**
 * Une ligne attribuée : opérateur ou membre.
 *
 * Le texte ET les pièces. `messageText` seul jetait les puces `attachment` :
 * la photo était dans le fil, et chaque membre répondait qu'il ne la voyait
 * pas. Même canal que le message direct (`composeRunInput`).
 */
function attributedLine(
  line: RoomLine,
  operator: OperatorIdentity,
  files: ReadonlyMap<string, LoadedAttachment | AttachmentGap>,
): string {
  const text = modelTextFromContent(line.content, files).trim();
  if (!text) return "";
  if (line.role === "user") return operatorAttributedInput(operator, text);
  return attributedInput({ name: line.authorName ?? "bot", slug: line.authorSlug ?? "bot" }, text);
}

/**
 * L'entrée d'un tour : le journal non lu du membre, attribué, ses propres
 * messages exclus. Vide → le tour est un silence implicite.
 */
export function roomDigest(
  unread: readonly RoomLine[],
  selfBotId: string,
  operator: OperatorIdentity,
  files: ReadonlyMap<string, LoadedAttachment | AttachmentGap> = new Map(),
): string {
  return unread
    .filter((line) => line.authorBotId !== selfBotId)
    .map((line) => attributedLine(line, operator, files))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * Les images que ce membre doit voir : celles des lignes non lues, dans
 * l'ordre, ses propres messages exclus comme dans `roomDigest`.
 */
export function roomImages(
  unread: readonly RoomLine[],
  selfBotId: string,
  files: ReadonlyMap<string, LoadedAttachment | AttachmentGap>,
): HermesRunImage[] {
  const images: HermesRunImage[] = [];
  for (const line of unread) {
    if (line.authorBotId === selfBotId) continue;
    for (const chip of attachmentChips(line.content)) {
      const file = files.get(chip.id);
      if (chip.kind === "image" && file && typeof file === "object") images.push(runImage(file));
    }
  }
  return images;
}

/**
 * Le rejeu brut de ce que le membre a déjà lu, avec la séquence de chaque
 * ligne (le watermark de compaction est une séquence) : la matière de
 * `packRoomHistory`. `olderExist` : des lignes sont tombées sous le plafond.
 */
type RoomPack = { rows: HistoryMessage[]; olderExist: boolean };

function roomHistory(
  before: readonly RoomLine[],
  selfBotId: string,
  operator: OperatorIdentity,
  cap = HISTORY_MESSAGE_CAP,
  files: ReadonlyMap<string, LoadedAttachment | AttachmentGap> = new Map(),
): { history: Array<{ role: string; content: string }>; pack: RoomPack } {
  const rows: HistoryMessage[] = [];
  for (const line of before) {
    const sequence = line.sequence ?? -1;
    if (line.authorBotId === selfBotId) {
      const text = modelTextFromContent(line.content, files).trim();
      if (text) rows.push({ role: "assistant", content: text, sequence });
      continue;
    }
    const attributed = attributedLine(line, operator, files);
    if (attributed) rows.push({ role: "user", content: attributed, sequence });
  }
  const capped = rows.slice(-cap);
  const olderExist = rows.length > cap;
  return {
    // Repli : la troncature d'avant la compaction, inchangée.
    history: trimHistoryToCharBudget(
      capped.map((row) => ({ role: row.role, content: row.content })),
      MAX_HISTORY_CHARS,
      olderExist,
    ),
    pack: { rows: capped, olderExist },
  };
}

/**
 * Compaction de l'historique d'un salon, même mécanisme et même budget que les
 * DM (`conversationHistory`) : au-dessus du budget, les anciens messages
 * deviennent le résumé COMMUN du fil (une ligne `thread_compactions`, lue par
 * tous les membres, prolongée au lieu d'être recalculée) et les récents restent
 * tels quels ; en dessous, rien ne change.
 *
 * Appelée APRÈS le choix du modèle : le résumé tourne sur celui du membre dont
 * c'est le tour. Tout échec (pas de client, résumeur en erreur, résumé vide)
 * rend la troncature de `prepareGroupTurn`, comme les DM.
 */
export async function packRoomHistory(
  db: SQL,
  context: Pick<RunContext, "organizationId" | "threadId" | "id" | "operator"> & Partial<Pick<RunContext, "model" | "provider" | "reasoningEffort">>,
  turn: { history: Array<{ role: string; content: string }>; pack?: RoomPack },
  compact?: { client: CompactHermes; signal: AbortSignal },
): Promise<{ history: Array<{ role: string; content: string }>; packInstructions: string | null }> {
  const fallback = { history: turn.history, packInstructions: null };
  const pack = turn.pack;
  if (!pack || (historyCharCount(pack.rows) <= HISTORY_CHAR_BUDGET && !pack.olderExist)) return fallback;
  let compaction = await readThreadCompaction(db, context.organizationId, context.threadId);
  let plan = planConversationPack({
    messages: pack.rows,
    compaction,
    olderExist: pack.olderExist,
    budget: HISTORY_CHAR_BUDGET,
  });
  if (plan.needsCompact) {
    if (!compact) return fallback;
    const written = await compactRoomThread(
      db,
      compact.client,
      {
        organizationId: context.organizationId,
        threadId: context.threadId,
        runId: context.id,
        model: context.model ?? null,
        provider: context.provider ?? null,
        reasoningEffort: context.reasoningEffort ?? null,
        operatorName: context.operator?.username ?? null,
      },
      {
        previousSummary: compaction?.summary ?? "",
        watermark: compaction?.compactedThroughSequence ?? -1,
        keepFirstSequence: plan.keep[0]?.sequence ?? null,
      },
      compact.signal,
    );
    if (!written) return fallback;
    compaction = written;
    plan = planConversationPack({
      messages: pack.rows,
      compaction,
      olderExist: pack.olderExist,
      budget: HISTORY_CHAR_BUDGET,
    });
  }
  if (!plan.summary) return fallback;
  return { history: assemblePackedHistory(plan), packInstructions: buildRoomPackInstructions() };
}

/**
 * Le message du fil qu'une complétion doit écrire : la sortie telle quelle :
 * sauf vide, ou `pass` sur un tour de salon, qui ne laissent rien.
 */
export function assistantMessageForCompletion(output: string, state: GroupSendState | null): string | null {
  if (!output) return null;
  if (state && isPass(output)) return null;
  return output;
}

type GroupTurn =
  | {
    kind: "speak";
    input: string;
    /** Les images des lignes non lues, en parts `image_url` du run. */
    images: HermesRunImage[];
    instructions: string;
    history: Array<{ role: string; content: string }>;
    /** Le rejeu brut avec séquences, pour `packRoomHistory` ; absent au routage. */
    pack?: RoomPack;
  }
  | { kind: "silent" }
  /** Données de salon introuvables : on retombe sur le flux DM ordinaire. */
  | null;

/**
 * Prépare le tour d'un membre : roster actif, instructions de salon, entrée
 * attribuée et historique à sa perspective. Le fil est relu sur ses ~260
 * derniers messages (200 d'historique + la fenêtre non lue + marge) : au-delà,
 * le repli « jamais parlé » borne de toute façon l'entrée à 30 messages.
 */
/**
 * Relit les pièces nommées par les lignes du salon.
 *
 * Les lignes non lues (le message auquel on répond) passent en premier et
 * sont toujours chargées. L'historique derrière s'arrête au budget d'un
 * envoi : une note dit alors que le fichier n'est pas dans ce tour.
 */
async function loadRoomAttachments(
  db: SQL,
  organizationId: string,
  unread: readonly RoomLine[],
  before: readonly RoomLine[],
  blob: WorkerConfig["blob"] | undefined,
): Promise<Map<string, LoadedAttachment | AttachmentGap>> {
  const wanted: string[] = [];
  const seen = new Set<string>();
  // Une image n'est relue que pour les lignes non lues : elle part avec ce
  // tour en part `image_url`. Plus ancienne, elle reste une note.
  const take = (lines: readonly RoomLine[], withImages: boolean) => {
    for (const line of lines) {
      for (const chip of attachmentChips(line.content)) {
        if ((chip.kind === "image" && !withImages) || seen.has(chip.id)) continue;
        seen.add(chip.id);
        wanted.push(chip.id);
      }
    }
  };
  take(unread, true);
  const asked = new Set(wanted);
  take([...before].reverse(), false);
  const files = new Map<string, LoadedAttachment | AttachmentGap>();
  if (wanted.length === 0) return files;
  const rows = await db<Array<{
    id: string;
    objectKey: string;
    name: string;
    contentType: string;
    kind: string;
    bytes: number;
  }>>`
    select id, object_key as "objectKey", name, content_type as "contentType", kind, bytes
      from attachments
     where organization_id = ${organizationId}
       and id in ${db(wanted)}
       and deleted_at is null
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  let spent = 0;
  for (const id of wanted) {
    const row = byId.get(id);
    const current = asked.has(id);
    if (!row || !blob) {
      files.set(id, current ? "missing" : "skipped");
      continue;
    }
    if (!current && spent + Number(row.bytes) > ATTACHMENT_LIMITS.maxBytesTotal) {
      files.set(id, "skipped");
      continue;
    }
    const data = await getArtifactBlob(blob, row.objectKey);
    if (!data) {
      files.set(id, "missing");
      continue;
    }
    spent += data.byteLength;
    files.set(id, {
      name: row.name,
      contentType: row.contentType,
      kind: row.kind === "image" ? "image" : "document",
      data,
    });
  }
  return files;
}

export async function prepareGroupTurn(
  db: SQL,
  context: RunContext,
  blob?: WorkerConfig["blob"],
): Promise<GroupTurn> {
  // Règle `mentions` sans @cible : l'API crée un reçu de run déterministe,
  // mais aucun membre ne doit parler ni déclencher Hermes.
  if (shouldSkipGroupHermes(groupSendState(context))) return { kind: "silent" };
  const groups = await db<Array<{ name: string; instructions: string }>>`
    select name, instructions from bot_groups
     where organization_id = ${context.organizationId} and id = ${context.groupId}
  `;
  const group = groups[0];
  if (!group) return null;
  const members = await db<Array<{ id: string; name: string; slug: string; description: string | null; position: number }>>`
    select b.id, b.name, b.slug, b.description, gm.position
      from group_members gm
      join bots b on b.organization_id = gm.organization_id and b.id = gm.bot_id
     where gm.organization_id = ${context.organizationId} and gm.group_id = ${context.groupId}
       and b.archived_at is null
     order by gm.position asc
  `;
  const newestFirst = await db<RoomLine[]>`
    select m.role, m.content, m.sequence, m.run_id as "runId",
           coalesce(m.original_author_bot_id, m.author_bot_id) as "authorBotId",
           coalesce(m.original_author_name, ab.name) as "authorName", ab.slug as "authorSlug"
      from messages m
      left join bots ab on ab.organization_id = m.organization_id and ab.id = m.author_bot_id
      left join runs message_run
        on message_run.organization_id = m.organization_id and message_run.id = m.run_id
      left join workflows message_workflow
        on message_workflow.organization_id = message_run.organization_id
       and message_workflow.id = message_run.workflow_id
      left join workflows current_workflow
        on current_workflow.organization_id = m.organization_id
       and current_workflow.id = ${context.workflowId}
     where m.organization_id = ${context.organizationId} and m.thread_id = ${context.threadId}
       -- Le message opérateur qui ouvre l'envoi porte le run_id du premier tour :
       -- seul l'éventuel output assistant du run courant est exclu, jamais l'entrée.
       and (m.run_id is null or m.run_id <> ${context.id} or m.role = 'user')
       -- Un follow-up peut être créé pendant ce tour. Il appartient à un
       -- workflow racine ultérieur : ni ce tour ni les rounds suivants du
       -- workflow courant ne doivent le consommer avant sa propre exécution.
       and (
         current_workflow.id is null or message_workflow.id is null
         or message_workflow.id = current_workflow.id
         or (message_workflow.created_at, message_workflow.id)
              < (current_workflow.created_at, current_workflow.id)
       )
     order by m.sequence desc limit 260
  `;
  const lines = newestFirst.reverse();
  const positions = await db<Array<{ sequence: string | number }>>`
    select last_message_sequence as sequence from group_member_read_positions
     where organization_id = ${context.organizationId} and group_id = ${context.groupId} and bot_id = ${context.botId}
  `;
  const position = positions[0] ? Number(positions[0].sequence) : null;
  let partition = position === null
    ? splitRoomUnread(lines, context.botId)
    : {
        before: lines.filter((line) => (line.sequence ?? -1) <= position),
        unread: lines.filter((line) => (line.sequence ?? -1) > position),
      };
  if (context.stepIndex === 0) partition = forceCurrentRootInputUnread(partition, context.id);
  const { before, unread } = partition;
  // Le message auquel on répond est servi entier. L'historique derrière ne
  // l'est que tant que le budget d'un envoi (3 Mio) tient : au-delà, une note
  // dit que le fichier n'est pas dans ce tour. La règle : ne jamais répondre comme si la pièce n'existait pas.
  const files = await loadRoomAttachments(db, context.organizationId, unread, before, blob);
  const state = groupSendState(context);
  if (state?.phase === "route") {
    const digest = roomDigest(unread, context.botId, context.operator, files);
    return {
      kind: "speak",
      input: digest || "Choose the owner of the operator's latest message.",
      images: [],
      instructions: buildGroupRouteInstructions(members),
      history: [],
    };
  }
  // Relance d'un membre adressé qui a passé : sa position de lecture n'a pas
  // avancé, il relit la même entrée suivie de la consigne amont.
  const nudge = Boolean(state && isGroupNudgeTurn(state, context.botId));
  const synthesis = state?.phase === "synthesis";
  const contributing = state?.phase === "contribution";
  const digest = roomDigest(unread, context.botId, context.operator, files);
  const contributionPack = (state?.contributions ?? [])
    .map((item) => {
      const author = members.find((member) => member.id === item.botId);
      return `${author?.slug ?? item.botId}: ${item.text}`;
    })
    .filter((line) => line.trim())
    .join("\n");
  // La synthèse parle toujours : les contributions déjà lues sont dans son
  // historique, l'entrée ne fait que lui donner la parole. Celles qui n'ont
  // pas été publiées (mode équipe) arrivent dans le pack.
  const input = nudge
    ? [digest, GROUP_ADDRESSED_NUDGE].filter(Boolean).join("\n\n")
    : synthesis
      ? [digest, contributionPack && `Contributions:\n${contributionPack}`, digest ? "" : GROUP_SYNTHESIS_CUE].filter(Boolean).join("\n\n")
      : contributing
        ? [state?.brief, digest].filter(Boolean).join("\n\n")
        : digest;
  if (!input) return { kind: "silent" };
  const block = buildGroupInstructions({
    self: { name: context.botName, slug: context.botSlug, description: context.botDescription },
    group: { name: group.name, instructions: group.instructions },
    members,
    operator: context.operator,
    maxRounds: ROOM_LIMITS.maxRounds,
    addressed: state?.round === 1 && (state.responders ?? []).includes(context.botId),
    synthesis,
    contributing,
    webToolsEnabled: context.webToolsEnabled,
  });
  const replay = roomHistory(before, context.botId, context.operator, HISTORY_MESSAGE_CAP, files);
  return {
    kind: "speak",
    input,
    images: roomImages(unread, context.botId, files),
    instructions: withBotModeInstructions(context.instructions, block),
    history: replay.history,
    pack: replay.pack,
  };
}

/** Garde explicite et testable du mode `mentions` sans cible. */
export function shouldSkipGroupHermes(state: GroupSendState | null): boolean {
  return state?.responders?.length === 0;
}

/**
 * Fait avancer l'envoi après un tour terminé. `output` est la sortie retenue
 * (null pour un pass, un silence implicite ou un échec). Tour suivant → un run
 * `queued` portant le nouvel état (entrée recalculée à l'exécution) ; salon
 * calmé ou plafond → un `system.notice` sur le run qui vient de finir.
 * `explicitPass` : le membre a répondu `(pass)` ; adressé au premier tour, il
 * est relancé une fois, sans avancer sa position de lecture.
 */
export async function advanceGroupTx(
  tx: SQL,
  context: GroupRunContext,
  state: GroupSendState,
  output: string | null,
  explicitPass = false,
): Promise<OrganizationEvent | null> {
  const members = await tx<Array<{ id: string; slug: string; position: number }>>`
    select b.id, b.slug, gm.position
      from group_members gm
      join bots b on b.organization_id = gm.organization_id and b.id = gm.bot_id
     where gm.organization_id = ${context.organizationId} and gm.group_id = ${context.groupId}
       and b.archived_at is null
     order by gm.position asc
  `;
  // A deleted bot is represented by a null bot_id on historical runs. Its
  // failed turn still advances the queue because currentBotId is unused for a
  // null output; the empty sentinel cannot be emitted as a speaker.
  const groupRows = await tx<Array<{ answerMode: string; defaultResponder: unknown }>>`
    select answer_mode as "answerMode", default_responder as "defaultResponder" from bot_groups
     where organization_id = ${context.organizationId} and id = ${context.groupId}
  `;
  const team = groupRows[0]?.answerMode === "team"
    ? { defaultResponder: coerceGroupDefaultResponder(groupRows[0].defaultResponder, members.map((member) => member.id)) }
    : undefined;
  const advance = advanceGroupSend(state, { currentBotId: context.botId ?? "", output, members, explicitPass, team });
  const nudge = advance.kind === "next" && advance.nudge === true;
  // Le routeur et les contributions ne consomment pas le message de l'opérateur :
  // le propriétaire choisi doit encore le lire.
  const cursorHeld = nudge || state.phase === "route" || state.phase === "contribution";
  if (context.groupId && context.botId && !cursorHeld) {
    await tx`
      insert into group_member_read_positions (
        organization_id, group_id, bot_id, last_message_sequence, updated_at
      ) values (
        ${context.organizationId}, ${context.groupId}, ${context.botId},
        coalesce((
          select max(message.sequence)
            from messages message
            left join runs message_run
              on message_run.organization_id = message.organization_id and message_run.id = message.run_id
            left join workflows message_workflow
              on message_workflow.organization_id = message_run.organization_id
             and message_workflow.id = message_run.workflow_id
            left join workflows current_workflow
              on current_workflow.organization_id = message.organization_id
             and current_workflow.id = ${context.workflowId}
           where message.organization_id = ${context.organizationId}
             and message.thread_id = ${context.threadId}
             and (
               current_workflow.id is null or message_workflow.id is null
               or message_workflow.id = current_workflow.id
               or (message_workflow.created_at, message_workflow.id)
                    < (current_workflow.created_at, current_workflow.id)
             )
        ), -1),
        now()
      )
      on conflict (organization_id, group_id, bot_id) do update
        set last_message_sequence = greatest(
          group_member_read_positions.last_message_sequence,
          excluded.last_message_sequence
        ), updated_at = now()
    `;
  }
  if (context.workflowId) {
    const workflows = await tx<Array<{ status: string } & GroupWorkflowLimits>>`
      select status, max_steps as "maxSteps", used_steps as "usedSteps",
             token_budget as "tokenBudget", used_tokens as "usedTokens", deadline_at as "deadlineAt"
        from workflows where organization_id = ${context.organizationId} and id = ${context.workflowId}
    `;
    const workflow = workflows[0];
    if (!workflow || !["queued", "running", "awaiting_approval", "reconciling"].includes(workflow.status)) return null;
    const outcome = groupWorkflowLimitOutcome(workflow, advance.kind === "next");
    if (outcome) {
      // Un arrêt sur plafond configuré ne porte NI `error_code` NI
      // `error_message` : le fil l'explique déjà par sa notice, et un code
      // d'erreur ferait lire comme un échec un salon qui a répondu.
      const settled = outcome.kind === "settled";
      await tx`
        update workflows set status = ${settled ? "completed" : outcome.status},
          error_code = ${settled ? null : outcome.errorCode},
          error_message = ${settled ? null : outcome.message},
          ended_at = now(), updated_at = now()
         where organization_id = ${context.organizationId} and id = ${context.workflowId}
           and status in ('queued','running','awaiting_approval','reconciling')
      `;
      return appendNoticeTx(tx, context, {
        message: outcome.message,
        kind: ROOM_NOTICE_KIND.settled,
        errorCode: outcome.errorCode,
        workflowId: context.workflowId,
      });
    }
  }
  if (advance.kind === "question" || advance.kind === "verbatim") {
    const authorId = advance.kind === "verbatim" ? advance.botId : context.botId;
    const text = advance.text.trim();
    if (authorId && text) {
      await insertAssistantMessage(tx, {
        messageId: crypto.randomUUID(),
        organizationId: context.organizationId,
        threadId: context.threadId,
        runId: context.id,
        content: assistantContent(text, []),
        authorBotId: authorId,
      });
    }
  }
  if (advance.kind === "next") {
    const position = members.find((member) => member.id === advance.botId)?.position ?? null;
    await tx`
      insert into runs (
        id, organization_id, thread_id, bot_id, group_turn_position, group_state, input, status,
        workflow_id, step_index, step_kind, stack_depth, external_state, events_complete
      )
      values (${crypto.randomUUID()}, ${context.organizationId}, ${context.threadId}, ${advance.botId},
              ${position}, ${advance.state}, '', 'queued', ${context.workflowId ?? null},
              ${context.workflowId ? (context.stepIndex ?? 0) + 1 : null},
              ${context.workflowId ? "group" : null}, 0, 'not_started', true)
    `;
    if (context.workflowId) await tx`
      update workflows set status = 'running', used_steps = used_steps + 1, updated_at = now()
       where organization_id = ${context.organizationId} and id = ${context.workflowId}
    `;
    return null;
  }
  if (context.workflowId) await tx`
    update workflows set status = 'completed', ended_at = now(), updated_at = now()
     where organization_id = ${context.organizationId} and id = ${context.workflowId}
       and status in ('queued','running','awaiting_approval','reconciling')
  `;
  // Un salon qui se calme n'a rien à dire : la dernière bulle suffit. Seul
  // un plafond s'explique, parce qu'il coupe une conversation en cours.
  if (advance.kind === "settled" || advance.kind === "question" || advance.kind === "verbatim") return null;
  return appendNoticeTx(tx, context, {
    message: "Plafond de l'envoi atteint.",
    kind: ROOM_NOTICE_KIND.settled,
  });
}

/** Reprend le chaînage historique des tours créé avant `group_state`. */
export async function advanceLegacyGroupTx(tx: SQL, context: LegacyGroupRunContext): Promise<void> {
  const next = await tx<Array<{ botId: string; position: number }>>`
    select gm.bot_id as "botId", gm.position
      from group_members gm
     where gm.organization_id = ${context.organizationId} and gm.group_id = ${context.groupId}
       and gm.position > ${context.groupTurnPosition}
     order by gm.position asc limit 1
  `;
  if (!next[0]) return;
  await tx`
    insert into runs (id, organization_id, thread_id, bot_id, group_turn_position, input, status)
    values (${crypto.randomUUID()}, ${context.organizationId}, ${context.threadId}, ${next[0].botId},
            ${next[0].position}, ${context.input}, 'queued')
  `;
}
