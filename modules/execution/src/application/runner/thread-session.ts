import type { SQL } from "bun";
import {
  latestCapabilityChange,
  threadSessionKey,
  threadSessionStale,
} from "@openedbot/conversation/domain/thread-session";
import {
  advanceThreadSessionGeneration,
  markThreadSessionOpened,
  readThreadSessionGeneration,
} from "@openedbot/conversation/sql/threads";
import type { ClaimedRun } from "../queue";
import { log } from "./util";

export type ThreadSessionRow = {
  organizationId: string;
  threadId: string;
  threadSessionId: string;
  threadSessionGeneration: number | string | null;
  threadSessionOpenedAt: Date | string | null;
  threadCreatedAt: Date | string;
  rootCapabilitiesChangedAt: Date | string | null;
  /** `runtimes.profile_capabilities_changed_at ->> <profil du bot>`, lu en texte. */
  profileCapabilitiesChangedAt: string | null;
};

/** Un instant lu en base ; une valeur illisible vaut « inconnu », jamais une erreur qui bloquerait le run. */
function instant(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * La session Hermes de ce run, sur le fil (0163).
 *
 * Une capacité du bot (toolset, skill, serveur MCP) changée après
 * l'ouverture de la session du fil fait passer le fil à la génération
 * suivante : Hermes construit alors un prompt et des outils neufs, au lieu
 * de resservir ceux qu'il a figés au premier tour. La bascule est atomique
 * (`generation = <lue>`) : deux runs qui partent ensemble sur un fil périmé
 * ne le font avancer qu'une fois et partagent la nouvelle session.
 *
 * La clé d'une génération > 0 est posée sur le run (`execution_session_key`,
 * sous le même bail) : les lectures qui résolvent la session d'un run par
 * `coalesce(execution_session_key, hermes_session_id)` la trouvent. Rendu :
 * la clé, ou `null` quand le bail a été perdu entre-temps.
 */
export async function pinThreadSession(
  db: SQL,
  claimed: ClaimedRun,
  workerId: string,
  row: ThreadSessionRow,
): Promise<string | null> {
  let generation = Number(row.threadSessionGeneration ?? 0);
  if (!Number.isInteger(generation) || generation < 0) generation = 0;
  const openedAt = instant(row.threadSessionOpenedAt);
  const changedAt = latestCapabilityChange(instant(row.rootCapabilitiesChangedAt), instant(row.profileCapabilitiesChangedAt));
  const stale = threadSessionStale(
    { generation, openedAt, threadCreatedAt: instant(row.threadCreatedAt) ?? new Date(0) },
    changedAt,
  );

  if (stale) {
    const advanced = await advanceThreadSessionGeneration(db, row.organizationId, row.threadId, generation);
    if (advanced !== null) {
      generation = advanced;
      log("worker.thread_session_rotated", {
        runId: claimed.id,
        threadId: row.threadId,
        generation,
        capabilitiesChangedAt: changedAt?.toISOString() ?? null,
      });
    } else {
      // Un autre run du fil l'a fait avancer : on prend sa génération.
      generation = (await readThreadSessionGeneration(db, row.organizationId, row.threadId)) ?? generation;
    }
  } else if (!openedAt) {
    // Premier run servi par cette génération (ou fil d'avant 0163) : l'instant
    // d'ouverture est celui qu'un changement futur devra dépasser.
    await markThreadSessionOpened(db, row.organizationId, row.threadId, generation);
  }

  const sessionId = threadSessionKey(row.threadSessionId, generation);
  if (generation === 0) return sessionId;
  const pinned = await db<{ id: string }[]>`
    update runs set execution_session_key = ${sessionId}, updated_at = now()
     where id = ${claimed.id} and organization_id = ${claimed.organizationId}
       and lease_owner = ${workerId} and lease_generation = ${claimed.leaseGeneration}
       and execution_session_key is null and hermes_run_id is null
    returning id
  `;
  return pinned[0] ? sessionId : null;
}
