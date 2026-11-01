import type { ApprovalRequestDto, RunDto } from "@openedbot/contracts-api";

const CONCLUDED: ReadonlySet<RunDto["status"]> = new Set(["completed", "failed", "cancelled"]);

/**
 * Les gates qui attendent ENCORE une décision humaine.
 *
 * Le snapshot garde une demande `pending` en base jusqu'à son expiration
 * (10 minutes) même quand son run s'est terminé ou a été annulé : sans ce
 * filtre la carte restait affichée sous la réponse et `pendingGate` gardait le
 * composer caché. Une gate n'est vivante que si elle est `pending` ET que son
 * run n'est pas conclu. Un run absent du snapshot ne conclut rien : le
 * serveur reste la source.
 *
 * Renvoie le tableau d'entrée tel quel quand rien n'est retiré : la timeline
 * met ses éléments en cache sur l'identité de `approvals`.
 */
export function liveApprovals(
  approvals: ApprovalRequestDto[],
  runs: readonly Pick<RunDto, "id" | "status">[],
): ApprovalRequestDto[] {
  const live = approvals.filter((approval) => {
    if (approval.status !== "pending") return false;
    const run = runs.find((candidate) => candidate.id === approval.runId);
    return !(run && CONCLUDED.has(run.status));
  });
  return live.length === approvals.length ? approvals : live;
}
