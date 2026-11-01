import type { TransactionDb } from "@openedbot/platform-db";

/**
 * `max(cursor)` de l'organisation : le point d'attache du flux SSE que les
 * snapshots (fil, roster) publient au client.
 *
 * À lire EN PREMIER dans la transaction qui construit le snapshot, et seul
 * (pas dans un `Promise.all`). READ COMMITTED : chaque SELECT voit ce qui est
 * commité à SON instant. Le worker prend `pg_advisory_xact_lock` par
 * organisation avant son premier insert et le tient jusqu'au commit
 * (`modules/execution/src/application/runner/events.ts`, `lockRunEventCursorTx`) : l'ordre
 * des curseurs est l'ordre des commits, donc tout curseur ≤ un max lu à T1
 * est visible par un SELECT à T2 > T1. Lu d'abord, ce max est une borne
 * BASSE sûre : tout ce que les SELECT suivants ne voient pas a un curseur
 * strictement supérieur, le serveur le rejouera et le client le dédupliquera.
 * Lu en dernier, il pouvait dépasser un événement absent du snapshot, jamais
 * rejoué (`replay()` est strictement `>`), perdu sans filet.
 */
export async function readOrganizationCursor(tx: TransactionDb, organizationId: string): Promise<number> {
  const rows = await tx<Array<{ max: string | number | null }>>`
    select max(cursor) as max from run_events where organization_id = ${organizationId}
  `;
  return Number(rows[0]?.max ?? 0);
}
