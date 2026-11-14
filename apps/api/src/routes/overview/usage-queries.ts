import { isoInstant } from "@openedbot/contracts-primitives";
import type { BotUsageDto, ModelUsageDto } from "@openedbot/contracts-api";
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

/**
 * Same time predicate as `usageByModel`, but starting from `bots` so as to
 * keep those that still have no run. `lastModel` is really the
 * last model executed, and not an arbitrary `max(model)`.
 */
export async function usageByBot(
  tx: Bun.TransactionSQL,
  organizationId: string,
  windowDays: number,
): Promise<BotUsageDto> {
  const rows = await tx<Array<{
    botId: string;
    name: string;
    slug: string;
    model: string | null;
    lastModel: string | null;
    runs: string | number;
    inputTokens: string | number;
    outputTokens: string | number;
    tokens: string | number;
    lastAt: Date | string | null;
  }>>`
    select b.id as "botId", b.name, b.slug, nullif(b.model, '') as model,
           (array_agg(nullif(r.model, '') order by coalesce(r.ended_at, r.created_at) desc)
              filter (where nullif(r.model, '') is not null))[1] as "lastModel",
           count(r.id) as runs,
           coalesce(sum((r.usage->>'inputTokens')::bigint), 0) as "inputTokens",
           coalesce(sum((r.usage->>'outputTokens')::bigint), 0) as "outputTokens",
           coalesce(sum((r.usage->>'totalTokens')::bigint), 0) as tokens,
           max(coalesce(r.ended_at, r.created_at)) as "lastAt"
      from bots b
      left join runs r on r.organization_id = b.organization_id and r.bot_id = b.id
           and r.status in ('completed', 'failed')
           and coalesce(r.ended_at, r.created_at) >= now() - (${windowDays} * interval '1 day')
     where b.organization_id = ${organizationId} and b.archived_at is null
     group by b.id, b.name, b.slug, b.model
     order by tokens desc, runs desc, b.name asc
  `;
  return {
    windowDays,
    bots: rows.map((row) => ({
      botId: row.botId,
      name: row.name,
      slug: row.slug,
      model: row.model,
      lastModel: row.lastModel,
      runs: Number(row.runs ?? 0),
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      tokens: Number(row.tokens ?? 0),
      lastAt: row.lastAt ? isoInstant(row.lastAt) : null,
    })),
  };
}
