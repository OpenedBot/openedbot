import type { RuntimeHealthStatus } from "@openedbot/contracts-api";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { logger } from "@openedbot/platform-observability";
import { pgTextArray } from "@openedbot/platform-db/text-array";
import type { HttpError } from "@openedbot/contracts-errors/http-error";

/**
 * Verdict de santé d'un runtime : ce que `runtimes.last_health_status` doit
 * dire après une observation : sonde « Tester la connexion », lecture du
 * catalogue de modèles, ou toute autre route qui vient de parler au runtime.
 *
 * Une seule règle : on n'écrit que ce qu'on a observé. Une erreur qui n'est
 * pas née à la frontière Hermes (bug de code, erreur SQL) ne dit rien du
 * runtime et ne produit aucun verdict.
 */

/** Fenêtre au-delà de laquelle `link_last_seen_at` est vieux : même 45 s que le worker. */
export const RUNTIME_LINK_STALE_MS = 45_000;

/** De quoi identifier la ligne à écrire et dater son lien. */
export type RuntimeHealthTarget = {
  id: string;
  linkLastSeenAt: Date | string | null;
  /** Le bail de socket lu AVANT l'observation (`link_generation`, 0051). */
  linkGeneration?: string | null;
};

/**
 * L'état de santé à écrire quand une observation échoue.
 *
 * Tout échec s'écrivait `unreachable`, y compris quand le runtime avait répondu :
 * un token refusé et un contrat d'outils violé s'affichaient « runtime
 * injoignable », ce qui envoie l'opérateur vérifier son réseau alors que la
 * cause est son token ou son `config.yaml`. Le badge doit nommer la panne qu'il
 * a réellement observée, sinon il vaut mieux ne rien afficher.
 *
 * Un contrat violé est rangé sous `missing_feature` (« runtime incompatible ») :
 * la machine répond, elle n'est simplement pas compatible avec le protocole
 * durable d'openedbot. `unreachable` reste le repli des vraies pannes de
 * transport.
 */
export function runtimeHealthStatusForError(error: HttpError): RuntimeHealthStatus {
  // Un lien connecteur fermé n'est ni un réseau en panne ni un token faux :
  // l'hôte ne s'est pas présenté, et c'est ce que l'opérateur doit lire.
  if (error.code === "RUNTIME_LINK_UNAVAILABLE") return "disconnected";
  if (error.status === 401 || error.status === 403) return "unauthorized";
  if (
    error.code === "HERMES_FORBIDDEN_TOOLSETS_ACTIVE" ||
    error.code === "HERMES_TOOLSET_INVENTORY_REQUIRED"
  ) return "missing_feature";
  return "unreachable";
}

/**
 * `POST /test` et l'activation ne concluent `disconnected` que si
 * `link_last_seen_at` est vieux ou l'instance propriétaire est morte,
 * jamais parce que le lien est monté sur une autre instance vivante.
 */
export function shouldMarkLinkDisconnected(
  detail: string | undefined,
  lastSeenAt: Date | string | null,
  nowMs: number = Date.now(),
): boolean {
  if (detail === "instance_dead") return true;
  if (!lastSeenAt) return true;
  const seen = lastSeenAt instanceof Date ? lastSeenAt.getTime() : new Date(lastSeenAt).getTime();
  return !Number.isFinite(seen) || nowMs - seen >= RUNTIME_LINK_STALE_MS;
}

/**
 * Écrit le verdict d'une sonde. `hostFeatures` n'est fourni que par une sonde
 * réussie d'un runtime `direct` : le tableau relu (vide si l'hôte a répondu
 * « je ne l'ai pas ») ; `null` laisse `link_features` intact.
 */
export async function updateRuntimeHealth(
  db: Db,
  organizationId: string,
  runtimeId: string,
  status: RuntimeHealthStatus,
  error: string | null,
  hostFeatures: string[] | null = null,
): Promise<void> {
  await withTenant(db, organizationId, async (tx) => {
    if (hostFeatures === null) {
      await tx`
        update runtimes set last_health_status = ${status}, last_health_error = ${error},
          last_probed_at = now(), updated_at = now()
        where organization_id = ${organizationId} and id = ${runtimeId}
      `;
      return;
    }
    await tx`
      update runtimes set last_health_status = ${status}, last_health_error = ${error},
        last_probed_at = now(), updated_at = now(), link_features = ${pgTextArray(hostFeatures)}::text[]
      where organization_id = ${organizationId} and id = ${runtimeId}
    `;
  });
}

/**
 * Écrit le verdict d'un échec déjà classé en `HttpError` : `disconnected`
 * seulement si le lien est réellement absent (voir `shouldMarkLinkDisconnected`),
 * sinon le statut que l'erreur nomme.
 */
export async function updateRuntimeHealthForFailure(
  db: Db,
  organizationId: string,
  runtime: RuntimeHealthTarget,
  error: HttpError,
): Promise<void> {
  if (error.code === "RUNTIME_LINK_UNAVAILABLE") {
    if (!shouldMarkLinkDisconnected(error.detail, runtime.linkLastSeenAt)) return;
    await updateRuntimeHealth(db, organizationId, runtime.id, "disconnected", error.message);
    return;
  }
  await updateRuntimeHealth(db, organizationId, runtime.id, runtimeHealthStatusForError(error), error.message);
}

/**
 * Écrit une observation, fencée par ce qui la rend encore vraie.
 *
 * Une lecture s'observe sur UN lien, à UN moment ; entre-temps le broker ou le
 * worker ont pu écrire. Deux gardes, dans le même `update` :
 *
 * - `link_generation` : la génération lue avant l'observation. Si l'hôte s'est
 *   reconnecté depuis, `hello` a écrit `healthy` sur un nouveau bail, et l'échec
 *   de l'ancien lien n'a plus rien à dire.
 * - `last_health_status <> 'disconnected'` : `disconnected` n'est écrit que par
 *   la couche lien (broker, worker), qui SAIT que la socket est partie. Une
 *   réponse arrivée juste avant la fermeture ne remet pas `healthy` par-dessus,
 *   et un échec ne remplace pas sa raison de fermeture par la nôtre.
 *
 * Un runtime `direct` (génération `0`, jamais `disconnected`) satisferait les
 * deux gardes ; aujourd'hui `readRuntimeSecret` ne construit de client que
 * pour un runtime `connector`, donc ce chemin ne voit que des liens.
 */
async function updateObservedRuntimeHealth(
  db: Db,
  organizationId: string,
  runtime: RuntimeHealthTarget,
  linkGeneration: string,
  status: RuntimeHealthStatus,
  error: string | null,
): Promise<void> {
  await withTenant(db, organizationId, async (tx) => {
    await tx`
      update runtimes set last_health_status = ${status}, last_health_error = ${error},
        last_probed_at = now(), updated_at = now()
      where organization_id = ${organizationId} and id = ${runtime.id}
        and link_generation = ${linkGeneration}::bigint
        and last_health_status <> 'disconnected'
    `;
  });
}

/**
 * Verdict posé en passant par une route de LECTURE (catalogue de modèles…) :
 * `null` quand le runtime a répondu, l'`HttpError` classée sinon. L'écriture
 * ne remplace jamais la réponse de la route : si elle échoue, elle se
 * journalise et la lecture garde son résultat ou son erreur d'origine.
 *
 * Sans génération de lien en main, rien ne s'écrit : une écriture non fencée
 * pourrait écraser un verdict plus récent de la couche lien.
 */
export async function recordRuntimeHealthObservation(
  db: Db,
  organizationId: string,
  runtime: RuntimeHealthTarget,
  failure: HttpError | null,
): Promise<void> {
  const linkGeneration = runtime.linkGeneration ?? null;
  if (linkGeneration === null || !/^[0-9]+$/.test(linkGeneration)) {
    logger.warn(
      { event: "api.runtime_health_observation_unfenced", runtimeId: runtime.id },
      "runtime health observation skipped: no link generation to fence on",
    );
    return;
  }
  try {
    if (failure === null) {
      await updateObservedRuntimeHealth(db, organizationId, runtime, linkGeneration, "healthy", null);
      return;
    }
    // Un lien absent est le verdict de la couche lien, pas d'une observation :
    // on ne le pose pas ici (la route l'a d'ailleurs refusé avant d'observer).
    if (failure.code === "RUNTIME_LINK_UNAVAILABLE") return;
    await updateObservedRuntimeHealth(
      db, organizationId, runtime, linkGeneration, runtimeHealthStatusForError(failure), failure.message,
    );
  } catch (error) {
    logger.warn(
      {
        event: "api.runtime_health_write_failed",
        runtimeId: runtime.id,
        verdict: failure === null ? "healthy" : runtimeHealthStatusForError(failure),
        error: error instanceof Error ? error.message : String(error),
      },
      "runtime health write failed",
    );
  }
}
