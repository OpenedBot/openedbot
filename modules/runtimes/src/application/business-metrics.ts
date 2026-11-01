/** Indicateurs métier d'un espace (ex-module `@openedbot/analytics`, fusionné ici : son seul consommateur métier est la flotte). */
import type { MetricsPeriod, WorkspaceBusinessMetrics, UsagePoint } from "@openedbot/contracts-api";
import type { TransactionDb } from "@openedbot/platform-db";

export function metricsPeriod(days = 30, now = new Date()): MetricsPeriod {
  if (!Number.isSafeInteger(days) || days < 1 || days > 90 || !Number.isFinite(now.getTime())) {
    throw new RangeError("Invalid metrics period");
  }
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { days, from: new Date(until.getTime() - days * 86_400_000).toISOString(), until: until.toISOString(), timezone: "UTC" };
}

export async function readBusinessMetrics(
  tx: TransactionDb, organizationId: string, period: MetricsPeriod | null = null, now = new Date(),
): Promise<WorkspaceBusinessMetrics> {
  const rows = await tx<Array<{ metrics: WorkspaceBusinessMetrics }>>`select workspace_business_metrics(
    ${organizationId}::uuid, ${period?.from ?? null}::timestamptz, ${period?.until ?? null}::timestamptz, ${now.toISOString()}::timestamptz) as metrics`;
  if (!rows[0]?.metrics) throw new Error("Business metrics unavailable");
  return rows[0].metrics;
}

export async function readUsageSeries(
  tx: TransactionDb, organizationId: string, unit: "day" | "week" | "month" | "year", buckets: number,
): Promise<UsagePoint[]> {
  const rows = await tx<Array<{ date: string; inputTokens: number | string; outputTokens: number | string; totalTokens: number | string }>>`
    with bounds as (
      select date_trunc(${unit}, now() at time zone 'UTC') as last,
        date_trunc(${unit}, now() at time zone 'UTC') - ('1 ' || ${unit})::interval * ${buckets - 1} as first
    ), series as (select generate_series(first, last, ('1 ' || ${unit})::interval) as bucket from bounds),
    sums as (
      select date_trunc(${unit}, r.observed_at at time zone 'UTC') as bucket,
        coalesce(sum(r.input_tokens), 0) as "inputTokens", coalesce(sum(r.output_tokens), 0) as "outputTokens",
        coalesce(sum(r.total_tokens), 0) as "totalTokens"
      from bounds b cross join lateral workspace_run_activity(${organizationId}::uuid,
        b.first at time zone 'UTC', (b.last + ('1 ' || ${unit})::interval) at time zone 'UTC') r group by 1
    )
    select to_char(s.bucket, 'YYYY-MM-DD') as date, coalesce(u."inputTokens", 0) as "inputTokens",
      coalesce(u."outputTokens", 0) as "outputTokens", coalesce(u."totalTokens", 0) as "totalTokens"
    from series s left join sums u using (bucket) order by s.bucket`;
  return rows.map((row) => ({ date: row.date, inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens), totalTokens: Number(row.totalTokens) }));
}

export async function readOverviewActivity(tx: TransactionDb, organizationId: string) {
  const rows = await tx<Array<{ date: string; completed: number | string; failed: number | string; tokens: number | string }>>`
    with bounds as (select date_trunc('day', now() at time zone 'UTC') as last),
    activity as (
      select r.* from bounds b cross join lateral workspace_run_activity(${organizationId}::uuid,
        (b.last - interval '89 days') at time zone 'UTC', (b.last + interval '1 day') at time zone 'UTC') r
    ), series as (select generate_series(last - interval '89 days', last, interval '1 day') as day from bounds)
    select to_char(d.day, 'YYYY-MM-DD') as date, count(r.id) filter (where r.status = 'completed') as completed,
      count(r.id) filter (where r.status = 'failed') as failed, coalesce(sum(r.total_tokens), 0) as tokens
    from series d left join activity r on r.status in ('completed','failed')
      and date_trunc('day', r.observed_at at time zone 'UTC') = d.day group by d.day order by d.day`;
  return rows.map((point) => ({ date: point.date, completed: Number(point.completed), failed: Number(point.failed), tokens: Number(point.tokens) }));
}
