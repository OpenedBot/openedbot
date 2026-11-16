import type { SQL } from "bun";
import {
  HISTORY_CHAR_BUDGET,
  assemblePackedHistory,
  clampReplayedMessages,
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
import { clearCompactionFailure, compactionAllowed, compactionFailureKey, noteCompactionFailure } from "./history";
import type { RunContext } from "./types";

/**
 * Le rejeu brut de ce que le membre a déjà lu, avec la séquence de chaque
 * ligne (le watermark de compaction est une séquence) : la matière de
 * `packRoomHistory`. `olderExist` : des lignes sont tombées sous le plafond.
 */
export type RoomPack = { rows: HistoryMessage[]; olderExist: boolean };

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
  // Same rule as DMs: [shared summary] + every line after its cut, each one bounded.
  const replayed = clampReplayedMessages(pack.rows);
  let compaction = await readThreadCompaction(db, context.organizationId, context.threadId);
  let plan = planConversationPack({
    messages: replayed,
    compaction,
    olderExist: pack.olderExist,
    budget: HISTORY_CHAR_BUDGET,
  });
  if (plan.needsCompact) {
    const failureKey = compactionFailureKey(context.organizationId, context.threadId);
    if (!compact || !compactionAllowed(failureKey, plan.remainderChars)) return fallback;
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
    if (!written) {
      // A cancelled run says nothing about the summarizer: no backoff for it.
      if (!compact.signal.aborted) noteCompactionFailure(failureKey, plan.remainderChars);
      return fallback;
    }
    clearCompactionFailure(failureKey);
    compaction = written;
    plan = planConversationPack({
      messages: replayed,
      compaction,
      olderExist: pack.olderExist,
      budget: HISTORY_CHAR_BUDGET,
    });
  }
  return {
    history: assemblePackedHistory(plan),
    packInstructions: plan.summary ? buildRoomPackInstructions() : null,
  };
}
