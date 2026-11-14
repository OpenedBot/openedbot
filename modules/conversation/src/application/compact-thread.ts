import type { SQL } from "bun";
import type { HermesClient } from "@openedbot/hermes";
import {
  COMPACT_INPUT_MAX_CHARS,
  buildCompactionInput,
  buildCompactionInstructions,
  buildRoomCompactionInstructions,
  compactionSessionKey,
  HISTORY_CHAR_BUDGET,
  normalizeCompactionSummary,
  splitKeepOld,
  takeOldestWithinBudget,
  type HistoryMessage,
  type ThreadCompaction,
} from "../domain/thread-compaction";
import { withTenant, type TransactionDb } from "@openedbot/platform-db";

const COMPACT_POLL_MS = 400;
const COMPACT_DEADLINE_MS = 60_000;

export type CompactHermes = Pick<HermesClient, "ensureSession" | "createRun" | "getRunStatus">;

export async function readThreadCompaction(
  db: SQL,
  organizationId: string,
  threadId: string,
): Promise<ThreadCompaction | null> {
  const rows = await withTenant(db, organizationId, (tx) => tx<Array<{
    summary: string;
    compactedThroughSequence: number;
    sourceMessageCount: number;
  }>>`
    select summary,
           compacted_through_sequence as "compactedThroughSequence",
           source_message_count as "sourceMessageCount"
      from thread_compactions
     where organization_id = ${organizationId} and thread_id = ${threadId}
     limit 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    summary: row.summary,
    compactedThroughSequence: Number(row.compactedThroughSequence),
    sourceMessageCount: Number(row.sourceMessageCount),
  };
}

/**
 * The watermark only moves forward: a summarizer that finishes late (a run's
 * own compaction racing the on-demand one) never replaces a summary that
 * already covers more of the thread.
 */
export async function persistThreadCompaction(
  db: SQL,
  organizationId: string,
  threadId: string,
  compaction: ThreadCompaction,
): Promise<void> {
  await withTenant(db, organizationId, (tx) => persistThreadCompactionTx(tx, organizationId, threadId, compaction));
}

/** The same write inside the caller's transaction (under its tenant), e.g. behind a lease fence. */
export async function persistThreadCompactionTx(
  tx: TransactionDb,
  organizationId: string,
  threadId: string,
  compaction: ThreadCompaction,
): Promise<void> {
  await tx`
    insert into thread_compactions (
      organization_id, thread_id, summary, compacted_through_sequence, source_message_count
    ) values (
      ${organizationId}, ${threadId}, ${compaction.summary},
      ${compaction.compactedThroughSequence}, ${compaction.sourceMessageCount}
    )
    on conflict (organization_id, thread_id) do update set
      summary = excluded.summary,
      compacted_through_sequence = excluded.compacted_through_sequence,
      source_message_count = excluded.source_message_count,
      updated_at = now()
    where thread_compactions.compacted_through_sequence <= excluded.compacted_through_sequence
  `;
}

/**
 * Writes a summary for the caller; false when it refused (its fence was lost)
 * and nothing was written. Defaults to `persistThreadCompaction`.
 */
export type PersistCompaction = (compaction: ThreadCompaction) => Promise<boolean>;

/**
 * Messages OLD à plier : après le watermark, avant KEEP. Le plus vieux
 * préfixe qui tient dans `COMPACT_INPUT_MAX_CHARS`, le tour suivant
 * avancera le watermark s'il en reste.
 */
export async function loadCompactInput(
  db: SQL,
  context: { organizationId: string; threadId: string; id: string },
  watermark: number,
  keepFirstSequence: number | null,
): Promise<HistoryMessage[]> {
  const rows = await db<Array<{ role: string; content: unknown; sequence: number }>>`
    select m.role, m.content, m.sequence
      from messages m
      left join runs source_run
        on source_run.organization_id = m.organization_id and source_run.id = m.run_id
     where m.organization_id = ${context.organizationId} and m.thread_id = ${context.threadId}
       and (m.run_id is null or m.run_id <> ${context.id})
       and (m.run_id is null or source_run.status = 'completed')
       and m.sequence > ${watermark}
       and (${keepFirstSequence}::int is null or m.sequence < ${keepFirstSequence})
     order by m.sequence asc
     limit 500
  `;
  const messages = rows
    .map((row) => ({
      role: row.role,
      content: messageText(row.content),
      sequence: Number(row.sequence),
    }))
    .filter((row) => row.content.length > 0);
  return takeOldestWithinBudget(messages, COMPACT_INPUT_MAX_CHARS);
}

export async function runThreadCompaction(
  db: SQL,
  client: CompactHermes,
  context: {
    organizationId: string;
    threadId: string;
    id: string;
    model: string | null;
    provider: string | null;
    reasoningEffort: string | null;
  },
  input: {
    previousSummary: string;
    messages: readonly HistoryMessage[];
    /** Consignes du résumeur ; DM par défaut, `buildRoomCompactionInstructions` pour un salon. */
    instructions?: string;
    persist?: PersistCompaction;
    /** Told the Hermes run of the summary once created (a command stops it on cancellation). */
    onRun?: (hermesRunId: string) => void | Promise<void>;
  },
  signal: AbortSignal,
): Promise<ThreadCompaction | null> {
  if (input.messages.length === 0) return null;
  const last = input.messages[input.messages.length - 1]!;
  const sessionId = compactionSessionKey(context.organizationId, context.threadId);
  try {
    await client.ensureSession(sessionId, `compact ${context.threadId}`, signal);
    const hermesRunId = await client.createRun({
      input: buildCompactionInput({
        date: new Date().toISOString().slice(0, 10),
        previousSummary: input.previousSummary,
        messages: input.messages,
      }),
      instructions: input.instructions ?? buildCompactionInstructions(),
      sessionId,
      model: context.model,
      provider: context.provider,
      reasoningEffort: context.reasoningEffort,
      // A one-off summary in its own session: nobody reads this prefix again.
      promptCacheTtl: "5m",
      idempotencyKey: `compact:${context.id}:${last.sequence}`,
      signal,
    });
    await input.onRun?.(hermesRunId);
    const output = await waitForCompactOutput(client, hermesRunId, signal);
    const summary = output ? normalizeCompactionSummary(output) : null;
    if (!summary) return null;
    const compaction: ThreadCompaction = {
      summary,
      compactedThroughSequence: last.sequence,
      sourceMessageCount: input.messages.length,
    };
    if (input.persist) {
      if (!(await input.persist(compaction))) return null;
    } else {
      await persistThreadCompaction(db, context.organizationId, context.threadId, compaction);
    }
    return compaction;
  } catch {
    return null;
  }
}

// ── Salon ────────────────────────────────────────────────────────────────────
//
// Une ligne `thread_compactions` par fil, commune à tous les membres : le
// watermark est une séquence de message, pas une position de lecture. Seule
// la matière change : le résumeur doit savoir QUI parle, ce que le rejeu d'un
// membre (ses propres tours en `assistant`) ne dit pas.

/** Libellé d'un locuteur de salon pour le résumeur, identique pour tous les membres. */
export function roomSpeakerLabel(
  line: { role: string; authorName: string | null; authorSlug: string | null },
  operatorName: string | null,
): string {
  if (line.role === "user") return operatorName ? `operator ${operatorName}` : "operator";
  if (!line.authorName && !line.authorSlug) return "member";
  return line.authorSlug
    ? `member ${line.authorName ?? line.authorSlug} (@${line.authorSlug})`
    : `member ${line.authorName}`;
}

type RoomCompactContext = {
  organizationId: string;
  threadId: string;
  runId: string | null;
  /**
   * Keys the summarizer run on Hermes (`compact:<id>:<last sequence>`) when
   * there is no run: a durable command passes its own id, so its retry after
   * a crash reuses the Hermes run it already created for the same messages.
   */
  idempotencyId?: string;
};

/**
 * Messages attribués du salon, du plus ancien au plus récent, strictement
 * après `afterSequence` et avant `beforeSequence`. `newest` > 0 prend les N
 * derniers de cette plage au lieu des 500 premiers.
 *
 * Même périmètre que le rejeu de salon (`prepareGroupTurn`) : aucun filtre
 * sur le statut du run, un salon montre ce que chaque membre a publié. Seule
 * la sortie du run courant est exclue (elle n'existe pas encore pour les
 * autres membres) ; le message opérateur qui l'ouvre, lui, reste.
 */
export async function loadRoomMessages(
  db: SQL,
  context: RoomCompactContext,
  operatorName: string | null,
  range: { afterSequence: number; beforeSequence: number | null; newest?: number },
): Promise<HistoryMessage[]> {
  const newest = range.newest ?? 0;
  // Sous `withTenant` : `messages` et `bots` sont sous RLS pour `openedbot_api`, qui ne
  // lit RIEN sans `app.organization_id` (ni erreur, ni ligne). Le worker, lui,
  // passe par ses policies `using (true)` et n'est pas gêné par ce réglage.
  const rows = await withTenant(db, context.organizationId, (tx) => tx<Array<{
    role: string;
    content: unknown;
    sequence: number;
    authorName: string | null;
    authorSlug: string | null;
  }>>`
    select * from (
      select m.role, m.content, m.sequence,
             coalesce(m.original_author_name, ab.name) as "authorName", ab.slug as "authorSlug"
        from messages m
        left join bots ab on ab.organization_id = m.organization_id and ab.id = m.author_bot_id
       where m.organization_id = ${context.organizationId} and m.thread_id = ${context.threadId}
         and (${context.runId}::uuid is null or m.run_id is null or m.run_id <> ${context.runId}::uuid or m.role = 'user')
         and m.sequence > ${range.afterSequence}
         and (${range.beforeSequence}::int is null or m.sequence < ${range.beforeSequence})
       -- Plus ancien d'abord, ou les N derniers : le signe de la clé choisit.
       order by case when ${newest}::int > 0 then -m.sequence else m.sequence end
       limit case when ${newest}::int > 0 then ${newest}::int else 500 end
    ) page order by sequence asc
  `);
  return rows
    .map((row) => ({
      role: row.role,
      content: messageText(row.content),
      sequence: Number(row.sequence),
      speaker: roomSpeakerLabel(row, operatorName),
    }))
    .filter((row) => row.content.length > 0);
}

/**
 * Plie le préfixe du salon après `watermark` et avant `keepFirstSequence` dans
 * le résumé commun (prolongé : le précédent est fourni au résumeur). `null` si
 * rien à plier ou si le résumeur échoue : l'appelant retombe sur sa troncature.
 */
export async function compactRoomThread(
  db: SQL,
  client: CompactHermes,
  context: RoomCompactContext & {
    model: string | null;
    provider: string | null;
    reasoningEffort: string | null;
    operatorName: string | null;
  },
  input: {
    previousSummary: string;
    watermark: number;
    keepFirstSequence: number | null;
    persist?: PersistCompaction;
    onRun?: (hermesRunId: string) => void | Promise<void>;
  },
  signal: AbortSignal,
): Promise<ThreadCompaction | null> {
  const loaded = await loadRoomMessages(db, context, context.operatorName, {
    afterSequence: input.watermark,
    beforeSequence: input.keepFirstSequence,
  });
  const messages = takeOldestWithinBudget(loaded, COMPACT_INPUT_MAX_CHARS);
  return runThreadCompaction(
    db,
    client,
    {
      organizationId: context.organizationId,
      threadId: context.threadId,
      id: context.runId ?? context.idempotencyId ?? crypto.randomUUID(),
      model: context.model,
      provider: context.provider,
      reasoningEffort: context.reasoningEffort,
    },
    {
      previousSummary: input.previousSummary,
      messages,
      instructions: buildRoomCompactionInstructions(),
      ...(input.persist ? { persist: input.persist } : {}),
      ...(input.onRun ? { onRun: input.onRun } : {}),
    },
    signal,
  );
}

/** Passes de résumé au plus par appel à la demande : chacune plie au plus 80 000 caractères. */
const COMPACT_NOW_MAX_PASSES = 4;

export type CompactNowResult = {
  compacted: boolean;
  /** Messages pliés dans le résumé PAR CET APPEL (0 si rien n'a changé). */
  summarizedCount: number;
  /** Watermark après l'appel ; `null` si le fil n'a jamais été compacté. */
  compactedThroughSequence: number | null;
};

/**
 * Compacte un salon à la demande (DEV-332, `POST /api/threads/:threadId/compact`,
 * exécuté par le worker comme commande durable depuis S3),
 * sans attendre le dépassement de budget : tout sauf la queue récente (KEEP,
 * même ratio que l'automatique) rejoint le résumé commun, prolongé s'il existe.
 *
 * Le modèle est celui que l'appelant passe (le membre dont la jauge est pleine,
 * ou le défaut de l'opérateur). Ne lève pas sur un échec du résumeur : un
 * résumeur en échec, un fil hors salon ou un fil déjà à jour rendent
 * `compacted: false`. Le refus 409 « run en cours » est la garde de la route,
 * pas d'ici.
 */
export async function compactThreadNow(
  db: SQL,
  client: CompactHermes,
  input: {
    organizationId: string;
    threadId: string;
    model: string | null;
    provider: string | null;
    reasoningEffort: string | null;
    operatorName?: string | null;
    /** See `RoomCompactContext.idempotencyId`. */
    idempotencyId?: string;
    /** Writes each pass's summary (a durable command fences it with its lease). */
    persist?: PersistCompaction;
    /** See `runThreadCompaction`. */
    onRun?: (hermesRunId: string) => void | Promise<void>;
  },
  signal: AbortSignal,
): Promise<CompactNowResult> {
  const compaction = await readThreadCompaction(db, input.organizationId, input.threadId);
  const unchanged: CompactNowResult = {
    compacted: false,
    summarizedCount: 0,
    compactedThroughSequence: compaction?.compactedThroughSequence ?? null,
  };
  const groups = await withTenant(db, input.organizationId, (tx) => tx<Array<{ groupId: string | null }>>`
    select group_id as "groupId" from threads
     where organization_id = ${input.organizationId} and id = ${input.threadId}
  `);
  if (!groups[0]?.groupId) return unchanged;
  const context: RoomCompactContext = {
    organizationId: input.organizationId,
    threadId: input.threadId,
    runId: null,
    ...(input.idempotencyId ? { idempotencyId: input.idempotencyId } : {}),
  };
  const operatorName = input.operatorName ?? null;
  let watermark = compaction?.compactedThroughSequence ?? -1;
  let summary = compaction?.summary ?? "";
  const recent = await loadRoomMessages(db, context, operatorName, {
    afterSequence: watermark,
    beforeSequence: null,
    newest: 500,
  });
  const { keep, old } = splitKeepOld(recent, HISTORY_CHAR_BUDGET);
  const keepFirst = keep[0]?.sequence ?? null;
  const target = old[old.length - 1]?.sequence ?? null;
  if (target === null) return unchanged;
  let summarized = 0;
  for (let pass = 0; pass < COMPACT_NOW_MAX_PASSES && watermark < target; pass += 1) {
    const written = await compactRoomThread(
      db,
      client,
      { ...context, model: input.model, provider: input.provider, reasoningEffort: input.reasoningEffort, operatorName },
      {
        previousSummary: summary,
        watermark,
        keepFirstSequence: keepFirst,
        ...(input.persist ? { persist: input.persist } : {}),
        ...(input.onRun ? { onRun: input.onRun } : {}),
      },
      signal,
    );
    if (!written) break;
    summarized += written.sourceMessageCount;
    watermark = written.compactedThroughSequence;
    summary = written.summary;
  }
  return {
    compacted: summarized > 0,
    summarizedCount: summarized,
    compactedThroughSequence: summarized > 0 ? watermark : unchanged.compactedThroughSequence,
  };
}

async function waitForCompactOutput(
  client: CompactHermes,
  hermesRunId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const deadline = Date.now() + COMPACT_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) return null;
    const details = await client.getRunStatus(hermesRunId, signal);
    if (details.status === "completed") return details.output;
    if (details.status === "failed" || details.status === "cancelled") return null;
    if (details.status === "waiting_for_approval") return null;
    await sleep(COMPACT_POLL_MS, signal);
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function messageText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n");
}

/**
 * Combien de messages `compactThreadNow` plierait aujourd'hui : la même coupe
 * KEEP / OLD, sans appeler le résumeur. La route s'en sert pour refuser sous le
 * seuil (rien à plier) avant d'ouvrir une session sur le runtime du client.
 */
export async function countFoldableRoomMessages(
  db: SQL,
  input: { organizationId: string; threadId: string },
): Promise<number> {
  const compaction = await readThreadCompaction(db, input.organizationId, input.threadId);
  const recent = await loadRoomMessages(
    db,
    { organizationId: input.organizationId, threadId: input.threadId, runId: null },
    null,
    { afterSequence: compaction?.compactedThroughSequence ?? -1, beforeSequence: null, newest: 500 },
  );
  return splitKeepOld(recent, HISTORY_CHAR_BUDGET).old.length;
}
