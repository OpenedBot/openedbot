import type { SQL } from "bun";
import type { HermesRunImage } from "@openedbot/hermes";
import { getArtifactBlob } from "../artifact-store";
import { attachmentChips, type LoadedAttachment } from "@openedbot/conversation/domain/attachments";
import {
  HISTORY_CHAR_BUDGET,
  assemblePackedHistory,
  buildConversationPackInstructions,
  historyCharCount,
  planConversationPack,
  type HistoryMessage,
} from "@openedbot/conversation/domain/thread-compaction";
import {
  loadCompactInput,
  readThreadCompaction,
  runThreadCompaction,
  type CompactHermes,
} from "@openedbot/conversation/application/compact-thread";
import type { WorkerConfig } from "../worker-config";
import type { RunContext } from "./types";
import { messageText } from "./util";

type PackedHistory = {
  history: Array<{ role: string; content: string }>;
  packInstructions: string | null;
};

export async function conversationHistory(
  db: SQL,
  context: Pick<RunContext, "organizationId" | "threadId" | "id"> & Partial<Pick<RunContext, "model" | "provider" | "reasoningEffort">>,
  compact?: { client: CompactHermes; signal: AbortSignal },
): Promise<PackedHistory> {
  // 201 et non 200 : la ligne excédentaire ne part jamais au modèle, elle
  // PROUVE qu'il en existe de plus anciennes. Sans elle, la coupe par `limit`
  // serait indistinguable d'un fil qui commence là : et l'aveu d'entête,
  // muet. Un `count(*)` séparé coûterait un aller-retour de plus par run.
  const rows = await db<Array<{
    role: string;
    content: unknown;
    sequence: number;
    interruptedStatus: InterruptedRunStatus | null;
    interruptedTools: string[] | null;
  }>>`
    select role, content, sequence, interrupted_status as "interruptedStatus",
      interrupted_tools as "interruptedTools" from (
      select m.role, m.content, m.sequence,
        case when m.role = 'user' and source_run.status in ('failed', 'cancelled')
          then source_run.status end as interrupted_status,
        -- Ce que le tour interrompu avait déjà fait : sans cela le bot
        -- nie un travail que l'utilisateur a vu dans le fil.
        case when m.role = 'user' and source_run.status in ('failed', 'cancelled') then (
          select array_agg(distinct event.payload->>'tool' order by event.payload->>'tool')
            from run_events event
           where event.organization_id = source_run.organization_id and event.run_id = source_run.id
             and event.type = 'tool.call' and event.payload->>'tool' is not null
        ) end as interrupted_tools
        from messages m
       left join runs source_run
         on source_run.organization_id = m.organization_id and source_run.id = m.run_id
       where m.organization_id = ${context.organizationId} and m.thread_id = ${context.threadId}
         and (m.run_id is null or m.run_id <> ${context.id})
         -- Un tour annulé/échoué reste visible dans le fil, mais son message
         -- utilisateur ne doit jamais redevenir une instruction implicite au
         -- tour suivant. C'est notamment ce qui rejouait la commande sleep 30 après
         -- que l'utilisateur l'avait explicitement arrêté. Les messages sans
         -- run (ingress/import historique) restent du contexte ; pour un run,
         -- seule une issue réussie prouve que la paire est conversationnelle.
         -- Le taire tout à fait rendait pourtant le bot amnésique : « tu es
         -- toujours en recherche ? » recevait « aucune recherche en cours ».
         -- Il revient donc, marqué non abouti (interruptedRequestNote). Un
         -- message absorbé par un autre run est déjà dans l'entrée de celui-ci.
         and (
           m.run_id is null
           or source_run.status = 'completed'
           or (
             m.role = 'user'
             and source_run.status in ('failed', 'cancelled')
             and coalesce(source_run.completion_kind, '') not in ('steered_into_active', 'folded_into_followup', 'superseded_by_followup')
           )
           or (
             m.role = 'assistant'
             and source_run.status = 'cancelled'
             and source_run.completion_kind not in ('steered_into_active', 'folded_into_followup', 'superseded_by_followup')
             and coalesce(source_run.output, '') <> ''
           )
         )
       order by m.sequence desc limit 201
    ) recent order by sequence asc
  `;
  // A message-version task contains a copied prefix, not the abandoned tail
  // of its parent. If that prefix itself exceeded the bounded replay window,
  // provenance records it durably so Hermes receives the same honest
  // history-loss notice as for a long ordinary thread.
  const branchRows = await db<Array<{ prefixTruncated: boolean }>>`
    select prefix_truncated as "prefixTruncated" from message_versions
     where organization_id = ${context.organizationId} and run_id = ${context.id}
     limit 1
  `;
  const olderExist = rows.length > HISTORY_MESSAGE_CAP || branchRows[0]?.prefixTruncated === true;
  const messages: HistoryMessage[] = rows
    .slice(-HISTORY_MESSAGE_CAP)
    .map((row) => {
      const content = messageText(row.content);
      return {
        role: row.role,
        content: row.interruptedStatus && content.length > 0
          ? `${interruptedRequestNote(row.interruptedStatus, row.interruptedTools ?? [])}\n${content}`
          : content,
        sequence: Number(row.sequence),
      };
    })
    .filter((row) => row.content.length > 0);

  const fallback = (): PackedHistory => ({
    history: trimHistoryToCharBudget(
      messages.map((row) => ({ role: row.role, content: row.content })),
      MAX_HISTORY_CHARS,
      olderExist,
    ),
    packInstructions: null,
  });

  if (historyCharCount(messages) <= HISTORY_CHAR_BUDGET && !olderExist) {
    return {
      history: messages.map((row) => ({ role: row.role, content: row.content })),
      packInstructions: null,
    };
  }

  let compaction = await readThreadCompaction(db, context.organizationId, context.threadId);
  let plan = planConversationPack({
    messages,
    compaction,
    olderExist,
    budget: HISTORY_CHAR_BUDGET,
  });

  if (plan.needsCompact) {
    if (!compact) return fallback();
    const keepFirst = plan.keep[0]?.sequence ?? null;
    const old = await loadCompactInput(
      db,
      context,
      compaction?.compactedThroughSequence ?? -1,
      keepFirst,
    );
    const written = await runThreadCompaction(
      db,
      compact.client,
      {
        organizationId: context.organizationId,
        threadId: context.threadId,
        id: context.id,
        model: context.model ?? null,
        provider: context.provider ?? null,
        reasoningEffort: context.reasoningEffort ?? null,
      },
      { previousSummary: compaction?.summary ?? "", messages: old.length > 0 ? old : plan.old },
      compact.signal,
    );
    if (!written) return fallback();
    compaction = written;
    plan = planConversationPack({
      messages,
      compaction,
      olderExist,
      budget: HISTORY_CHAR_BUDGET,
    });
  }

  if (!plan.summary) return fallback();

  return {
    history: assemblePackedHistory(plan),
    packInstructions: buildConversationPackInstructions(),
  };
}

type InterruptedRunStatus = "failed" | "cancelled";

/**
 * L'en-tête d'une demande dont le tour n'a pas abouti. Le modèle doit savoir
 * qu'elle a existé (sinon il nie un travail que l'utilisateur a vu), sans la
 * reprendre de lui-même (sinon un ordre arrêté se rejoue).
 */
export function interruptedRequestNote(status: InterruptedRunStatus, tools: readonly string[] = []): string {
  const outcome = status === "cancelled" ? "it was stopped before you answered" : "it failed before you answered";
  const work = tools.length > 0
    ? ` Before it stopped you had already used: ${tools.slice(0, 12).join(", ")}; their results are not in this history.`
    : "";
  return `[Earlier request, not completed: ${outcome}.${work} Context only. If the user asks about it, say it was interrupted and offer to start it again; do not redo it on your own unless the user asks for it again.]`;
}

/** Une image relue, sous la forme d'une part `image_url` : un data-URI. */
export function runImage(file: LoadedAttachment): HermesRunImage {
  return { name: file.name, dataUrl: `data:${file.contentType};base64,${Buffer.from(file.data).toString("base64")}` };
}

/**
 * Les images du message opérateur qui a créé ce run (DM, mention, version).
 *
 * L'API n'écrit plus le data-URI dans `runs.input` : le message lié au run
 * (`messages.run_id`) garde les puces, et les octets se relisent ici. Une
 * relance n'a pas de message à elle : `runs.source_message_id` désigne celui
 * du tour d'origine, sans dupliquer la conversation.
 */
export async function loadRunImages(
  db: SQL,
  context: Pick<RunContext, "id" | "organizationId">,
  blob: WorkerConfig["blob"] | undefined,
): Promise<{ images: HermesRunImage[]; missing: string[] }> {
  const messages = await db<Array<{ content: unknown }>>`
    select message.content from runs run
      join messages message on message.organization_id = run.organization_id and message.role = 'user'
       and (message.run_id = run.id or message.id = run.source_message_id)
     where run.organization_id = ${context.organizationId} and run.id = ${context.id}
     order by (message.run_id is not distinct from run.id) desc, message.sequence asc nulls last limit 1
  `;
  const chips = attachmentChips(messages[0]?.content).filter((chip) => chip.kind === "image");
  if (chips.length === 0) return { images: [], missing: [] };
  if (!blob) return { images: [], missing: chips.map((chip) => chip.name) };
  const ids = chips.map((chip) => chip.id);
  const rows = await db<Array<{ id: string; objectKey: string; name: string; contentType: string }>>`
    select id, object_key as "objectKey", name, content_type as "contentType"
      from attachments
     where organization_id = ${context.organizationId} and id in ${db(ids)} and deleted_at is null
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const images: HermesRunImage[] = [];
  const missing: string[] = [];
  for (const chip of chips) {
    const row = byId.get(chip.id);
    const data = row ? await getArtifactBlob(blob, row.objectKey) : null;
    if (row && data) images.push(runImage({ name: row.name, contentType: row.contentType, kind: "image", data }));
    else missing.push(chip.name);
  }
  return { images, missing };
}

/**
 * L'historique de conversation vu par CE membre : ses messages en `assistant`
 * bruts, tout le reste (opérateur et autres membres) en `user` attribué.
 */
/** Budget de contexte (caractères ≈ proxy de tokens). Au-delà de 200 messages,
 * un fil aux messages longs dépassait la fenêtre du modèle → run en échec
 * répété → fil mort en permanence. On borne aussi la TAILLE, pas que le nombre. */
export const MAX_HISTORY_CHARS = 48_000;

/** Messages relus au plus, avant même le budget de caractères. */
export const HISTORY_MESSAGE_CAP = 200;

/**
 * Garde les messages les plus récents tenant dans le budget ; jamais vide s'il
 * y a du contenu.
 *
 * Quand des messages tombent, une ligne le DIT au modèle. Avant, la coupe était
 * muette des deux côtés : l'opérateur voyait tout le fil à l'écran, le bot n'en
 * recevait que la queue, et il répondait sur ce qu'il avait sans jamais pouvoir
 * signaler qu'il lui manquait le début. C'est la panne la plus coûteuse d'une
 * mémoire par rejeu : elle produit une réponse confiante et fausse, sans aucun
 * symptôme visible. Une ligne d'entête ne rend pas le contexte perdu, elle rend
 * la perte DISABLE : le bot peut demander qu'on lui rappelle le début.
 */
export function trimHistoryToCharBudget(
  messages: Array<{ role: string; content: string }>,
  maxChars = MAX_HISTORY_CHARS,
  /**
   * Des messages ont DÉJÀ été écartés en amont (le `limit` SQL, le `cap` de
   * salon) : cette fonction ne peut alors plus compter ce qui manque, et le
   * dire quand même produirait un chiffre faux : pire qu'aucun chiffre.
   */
  olderExist = false,
): Array<{ role: string; content: string }> {
  const kept: Array<{ role: string; content: string }> = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    total += message.content.length;
    if (total > maxChars && kept.length > 0) break;
    kept.push(message);
  }
  kept.reverse();
  const dropped = messages.length - kept.length;
  if (dropped <= 0 && !olderExist) return kept;
  // En tête et en `user` : c'est la place d'un fait de contexte, et le rôle
  // `assistant` ferait passer l'aveu pour une phrase que le bot aurait dite.
  const notice = droppedHistoryNotice(olderExist ? null : dropped);
  return [{ role: "user", content: notice }, ...kept];
}

/**
 * L'aveu envoyé au modèle. `null` quand le nombre exact n'est pas connaissable
 * : un compte faux se lirait comme un compte, et le modèle raisonnerait dessus.
 *
 * En anglais comme tout le protocole bot-mode (`buildBotModeInstructions`) :
 * ces lignes sont du cadrage, pas de l'interface, et mélanger les langues dans
 * un même prompt n'aide personne.
 */
export function droppedHistoryNotice(dropped: number | null): string {
  const missing = dropped === null
    ? "The oldest messages of this thread are"
    : `The ${dropped} oldest message${dropped === 1 ? "" : "s"} of this thread ${dropped === 1 ? "is" : "are"}`;
  return `[Platform notice: this conversation is longer than what fits in one run. ${missing} NOT included below. Do not assume you remember them : if the answer depends on that earlier context, say so and ask the user to restate it.]`;
}
