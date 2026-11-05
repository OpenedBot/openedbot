import type { SQL } from "bun";

/**
 * Garde la latence d'un run (`runLatencyRecord`) sur sa ligne, pour
 * l'analyse (0151). Le worker n'attend pas cette écriture : le run est déjà
 * terminé, et un échec ne coûte qu'une ligne de journal. Le relevé ne porte
 * que des noms et des durées (`RunTrace` écarte le reste) ; l'identifiant du
 * run et de l'organisation n'y sont pas répétés, la ligne les porte déjà.
 * L'écriture est bornée à la génération du bail : un worker qui a perdu le run
 * n'écrase pas, en retard, la mesure de celui qui l'a repris.
 */
export function saveRunTimings(
  db: SQL,
  run: { id: string; organizationId: string; leaseGeneration: number },
  record: Record<string, unknown>,
): Promise<void> {
  const { runId: _runId, organizationId: _organizationId, ...timings } = record;
  return db`
    update runs set timings = ${timings}::jsonb
     where organization_id = ${run.organizationId} and id = ${run.id}
       and lease_generation = ${run.leaseGeneration}
  `.then(
    () => undefined,
    () => {
      console.error(JSON.stringify({ event: "run.timings_write_failed", runId: run.id }));
    },
  );
}
