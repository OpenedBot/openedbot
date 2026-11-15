import { isoInstant } from "@openedbot/contracts-primitives";
import type { ModelUsageDto } from "@openedbot/contracts-api";
import { HttpError } from "../../interfaces/http/http-error";

/**
 * The usage reads by model and by bot of `/usage/models` and
 * `/usage/bots` (`misc-routes.ts`), moved out of that file so that it holds
 * its size. Same timestamp and same index as the usage series:
 * `coalesce(ended_at, created_at)`.
 */

export const USAGE_MODELS_WINDOW_DAYS = 90;

/** A usage window in days, from 1 to 90; anything else is a 400, never a silent default. */
export function usageWindowDays(raw: string): number {
  const days = /^[0-9]{1,2}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
    throw new HttpError(400, "USAGE_DAYS_INVALID", "La fenêtre d’usage doit être un nombre de jours entre 1 et 90.");
  }
  return days;
}

/**
 * Breakdown of finished runs by persisted model, same timestamp and
 * same index as `usageSeries` (`coalesce(ended_at, created_at)`).
 * `model` null = runs from before persistence, or Hermes without a selection.
 */
export async function usageByModel(
  tx: Bun.TransactionSQL,
  organizationId: string,
  windowDays = USAGE_MODELS_WINDOW_DAYS,
): Promise<ModelUsageDto> {
  const rows = await tx<Array<{
    model: string | null;
    runs: string | number;
    inputTokens: string | number;
    outputTokens: string | number;
    tokens: string | number;
    lastAt: Date | string;
  }>>`
    select nullif(coalesce(model, ''), '') as model,
           count(*) as runs,
           coalesce(sum((usage->>'inputTokens')::bigint), 0) as "inputTokens",
           coalesce(sum((usage->>'outputTokens')::bigint), 0) as "outputTokens",
           coalesce(sum((usage->>'totalTokens')::bigint), 0) as tokens,
           max(coalesce(ended_at, created_at)) as "lastAt"
      from runs
     where organization_id = ${organizationId}
       and coalesce(ended_at, created_at) >= now() - (${windowDays} * interval '1 day')
       and status in ('completed', 'failed')
     group by 1
     order by tokens desc, runs desc
  `;
  return {
    windowDays,
    models: rows.map((row) => ({
      model: row.model && row.model.trim() ? row.model : null,
      runs: Number(row.runs ?? 0),
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      tokens: Number(row.tokens ?? 0),
      lastAt: isoInstant(row.lastAt),
    })),
  };
}
