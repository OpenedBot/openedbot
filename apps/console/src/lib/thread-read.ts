/**
 * Projection minimale d'un snapshot de fil vers son watermark de lecture.
 *
 * Le contrat est volontairement structurel : la PWA l'utilise sans importer
 * ses types de vue. Seules les dates effectivement présentes à l'écran
 * participent au watermark ; `Date.now()` n'est jamais utilisé, car il
 * pourrait masquer une réponse arrivée pendant l'accusé.
 */
export type ThreadReadActivity = {
  updatedAt?: string | Date | null;
  messages?: readonly { createdAt?: string | Date | null }[];
  runs?: readonly {
    status?: string | null;
    createdAt?: string | Date | null;
    lastEventAt?: string | Date | null;
  }[];
  events?: readonly { occurredAt?: string | Date | null }[];
  workflows?: readonly { updatedAt?: string | Date | null }[];
  approvals?: readonly { requestedAt?: string | Date | null }[];
};

export function latestThreadReadThrough(activity: ThreadReadActivity | null | undefined): string | null {
  if (!activity) return null;
  let latest = validTime(activity.updatedAt);
  const include = (value: string | Date | null | undefined) => {
    const candidate = validTime(value);
    if (candidate !== null && (latest === null || candidate > latest)) latest = candidate;
  };

  for (const message of activity.messages ?? []) include(message.createdAt);
  for (const run of activity.runs ?? []) {
    include(run.createdAt);
    include(run.lastEventAt);
  }
  for (const event of activity.events ?? []) include(event.occurredAt);
  for (const workflow of activity.workflows ?? []) include(workflow.updatedAt);
  for (const approval of activity.approvals ?? []) include(approval.requestedAt);
  return latest === null ? null : new Date(latest).toISOString();
}

const STREAMING_RUN_STATUSES: ReadonlySet<string> = new Set(["queued", "pending", "starting", "running"]);

/**
 * Vrai tant qu'un run du snapshot produit des événements (le watermark avance
 * alors à chaque événement). `awaiting_approval` n'en fait pas partie : le run
 * attend l'opérateur, plus rien ne défile.
 */
export function threadHasStreamingRun(activity: ThreadReadActivity | null | undefined): boolean {
  return (activity?.runs ?? []).some((run) => STREAMING_RUN_STATUSES.has(run.status ?? ""));
}

function validTime(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
