/**
 * Les échecs d'outils, écrits dans `tool_errors` (0037) à côté du
 * `tool.result` qui les prouve, sous le même verrou et dans la même
 * transaction : une ligne d'erreur sans son événement, ou l'inverse, serait
 * une histoire à deux versions.
 */
import type { SQL } from "bun";
import type { RunEvent } from "../domain/hermes-events";
import { sanitizeToolErrorMessage } from "../domain/tool-text";
import { toolErrorCode } from "@openedbot/conversation/domain/tool-error";
import type { ToolErrorDto } from "@openedbot/contracts-api";

export type ToolErrorRow = {
  tool: string;
  toolCallId: string;
  errorCode: NonNullable<ToolErrorDto["errorCode"]>;
  errorMessage: string | null;
  durationMs: number | null;
  occurredAt: Date;
};

/**
 * La ligne à écrire pour un `tool.result`, ou `null` quand l'appel a réussi
 * (ou que l'événement n'est pas un résultat d'outil). Le message est déjà
 * borné et rédigé par le normaliseur ; la borne est refaite ici parce que la
 * contrainte SQL la refait aussi, et qu'un événement rejoué d'un ancien
 * format ne doit pas faire échouer toute la transaction.
 */
export function toolErrorRow(event: Pick<RunEvent, "type" | "payload" | "occurredAt">): ToolErrorRow | null {
  if (event.type !== "tool.result" || event.payload.error !== true) return null;
  const { tool, toolCallId, errorMessage, durationMs } = event.payload;
  const message = sanitizeToolErrorMessage(errorMessage);
  return {
    tool: typeof tool === "string" && tool !== "" ? tool : "tool",
    toolCallId: typeof toolCallId === "string" && toolCallId !== "" ? toolCallId : "tc_unknown",
    errorCode: toolErrorCode(errorMessage),
    errorMessage: message,
    durationMs: typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
      ? Math.round(durationMs)
      : null,
    occurredAt: event.occurredAt,
  };
}

export type ToolErrorContext = {
  id: string;
  organizationId: string;
  threadId: string;
  botId: string;
};

/**
 * Insère la ligne d'erreur dans la transaction courante. L'auteur humain du
 * run est relu dans `message_ingress` (la seule table qui relie un run à
 * l'opérateur qui l'a déclenché) ; une routine, un webhook ou un hand-off n'y
 * ont pas de ligne, `user_id` reste NULL.
 */
export async function insertToolErrorTx(
  tx: SQL,
  context: ToolErrorContext,
  row: ToolErrorRow,
): Promise<void> {
  await tx`
    insert into tool_errors (
      organization_id, bot_id, thread_id, run_id, user_id,
      tool, tool_call_id, error_code, error_message, duration_ms, occurred_at
    ) values (
      ${context.organizationId}, ${context.botId}, ${context.threadId}, ${context.id},
      (select ingress.user_id from message_ingress ingress
        where ingress.organization_id = ${context.organizationId} and ingress.run_id = ${context.id}
        limit 1),
      ${row.tool}, ${row.toolCallId}, ${row.errorCode}, ${row.errorMessage}, ${row.durationMs}, ${row.occurredAt}
    )
  `;
}

/** Complète une ligne sans motif quand le transcript final apporte ce détail. */
export async function backfillToolErrorMessageTx(
  tx: SQL,
  context: Pick<ToolErrorContext, "id" | "organizationId">,
  toolCallId: string,
  errorMessage: string,
): Promise<void> {
  const message = sanitizeToolErrorMessage(errorMessage);
  if (!message) return;
  await tx`
    update tool_errors set error_message = ${message}, error_code = ${toolErrorCode(errorMessage)}
     where organization_id = ${context.organizationId} and run_id = ${context.id}
       and tool_call_id = ${toolCallId} and error_message is null
  `;
}

/** Purge des erreurs plus anciennes que la rétention (jours) ; renvoie le nombre de lignes retirées. */
export async function purgeOldToolErrors(
  db: SQL,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  // Une borne concrète évite l'inférence ambiguë Date/interval de Bun SQL qui
  // faisait évaluer `timestamptz < interval` à PostgreSQL.
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  const rows = await db<Array<{ count: string | number }>>`
    with deleted as (
      delete from tool_errors where occurred_at < ${cutoff} returning id
    )
    select count(*) as count from deleted
  `;
  return Number(rows[0]?.count ?? 0);
}
