import type { SQL } from "bun";
import { internalBearer, type InternalSecretsWith } from "@openedbot/platform-config/internal-secrets";
import { createHash, randomBytes } from "node:crypto";
import { holdUnconfirmedLinkTokenRotation, rotateLinkToken, undoLinkTokenRotation } from "@openedbot/runtimes/application/runtime-link-rows";
import { pgTextArray } from "@openedbot/platform-db/text-array";
import { controlPushOf, LINK_CONTROL_FORWARD_TIMEOUT_MS, type ControlPush } from "./instances";
import { RELAY_FEATURE_SESSIONS_INVENTORY } from "@openedbot/contracts-connector/features";

/**
 * Entretien du lien connecteur côté worker.
 *
 * L'API écrit `disconnected` quand la socket se ferme proprement ; mais une
 * instance qui meurt n'écrit rien, et un hôte qui se tait sans fermer non
 * plus. Le balayage tranche à partir de `link_last_seen_at` : muet depuis
 * 45 s : la même fenêtre que le prédicat de vitalité de `queue.ts` et de
 * `runner.ts`. C'est déconnecté, et l'écran le dit.
 *
 * Un runtime dont l'instance propriétaire est vivante n'est jamais marqué
 * `disconnected` par le seul fait que le WebSocket est monté ailleurs :
 * seulement si `link_last_seen_at` est vieux, ou si cette instance est
 * morte (arrêt propre ou heartbeat de plus de 60 s).
 */
export const RUNTIME_LINK_STALE_INTERVAL = "45 seconds";
export const API_INSTANCE_DEAD_INTERVAL = "60 seconds";

export async function sweepDisconnectedRuntimeLinks(db: SQL): Promise<number> {
  const rows = await db<Array<{ count: string | number }>>`
    with swept as (
      update runtimes
         set last_health_status = 'disconnected', link_instance_id = null, link_connected_at = null,
             -- La raison que l'écran Runtime montre sous « lien connecteur fermé »,
             -- dans l'ordre des branches du where ci-dessous.
             last_health_error = case
               when link_last_seen_at is null then 'Le lien n’a jamais donné signe de vie.'
               when link_last_seen_at < now() - interval '45 seconds' then 'Aucun signe de vie du lien depuis 45 s.'
               else 'L’instance openedbot qui tenait le lien ne répond plus.'
             end,
             updated_at = now()
       where reachability = 'connector'
         and revoked_at is null
         and last_health_status <> 'disconnected'
         and (
           link_last_seen_at is null
           or link_last_seen_at < now() - interval '45 seconds'
           or (
             link_instance_id is not null
             and not exists (
               select 1 from api_instances inst
                where inst.instance_id = runtimes.link_instance_id
                  and inst.stopped_at is null
                  and inst.last_seen_at > now() - interval '60 seconds'
             )
           )
         )
         and not (
           link_last_seen_at is not null
           and link_last_seen_at > now() - interval '45 seconds'
           and exists (
             select 1 from api_instances inst
              where inst.instance_id = runtimes.link_instance_id
                and inst.stopped_at is null
                and inst.last_seen_at > now() - interval '60 seconds'
           )
         )
       returning id
    )
    select count(*) as count from swept
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Les événements de sécurité du lien (`hijack_suspected`, `revoked`, `rotated`) se gardent plus longtemps. */
export const LINK_SECURITY_EVENTS_RETENTION_DAYS = 90;

/**
 * Rétention du journal du lien (0027), sur le modèle de `purgeOldRunEvents` :
 * les allers-retours ordinaires (`connected`/`replaced`/`disconnected`)
 * partent après `retentionDays` ; les événements de sécurité après 90 jours.
 * Bornes concrètes en JS (pas `interval`) : même raison que `routines.ts`.
 */
export async function purgeOldRuntimeLinkEvents(
  db: SQL,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const routineCutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  const securityCutoff = new Date(now.getTime() - LINK_SECURITY_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  const rows = await db<Array<{ count: string | number }>>`
    with deleted as (
      delete from runtime_link_events
       where (kind in ('connected', 'replaced', 'disconnected') and occurred_at < ${routineCutoff})
          or (kind in ('hijack_suspected', 'revoked', 'rotated') and occurred_at < ${securityCutoff})
       returning id
    )
    select count(*) as count from deleted
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Fenêtre de grâce de l'ancien jeton après rotation, la même que `POST …/link/rotate` (0027). */
export const LINK_TOKEN_GRACE_MINUTES = 10;
/**
 * Livraison de `link.rotate` incertaine (0174) : les deux jetons restent
 * valables jusqu'à la prochaine admission de l'hôte, qui tranche. Au-delà de
 * trente jours sans reconnexion, l'ancien hash expire comme une grâce ordinaire.
 */
export const LINK_TOKEN_UNCONFIRMED_HOLD_HOURS = 30 * 24;
/** Cadence des passes de sécurité du lien (rotation automatique, réconciliation des sessions). */
export const LINK_SECURITY_TICK_MS = 60 * 60_000;
/** Sessions inconnues journalisées par passe et par runtime, au plus. */
export const UNATTRIBUTED_SESSIONS_PER_PASS = 50;
/**
 * Borne de l'appel du worker à la route de contrôle interne. Cet appel englobe
 * le saut de l'instance qui le reçoit vers celle qui tient le lien
 * (`LINK_CONTROL_FORWARD_TIMEOUT_MS`) : le worker attend ce saut, plus la même
 * marge pour l'instance elle-même. À l'échéance la trame a pu partir : la
 * rotation reste en attente de confirmation, comme sur une erreur réseau.
 */
export const LINK_CONTROL_CALL_TIMEOUT_MS = 2 * LINK_CONTROL_FORWARD_TIMEOUT_MS;
/**
 * Borne de la lecture de l'inventaire de sessions d'un hôte, à travers le lien.
 * Le relais borne déjà un hôte muet (60 s avant la première réponse) ; celle-ci
 * couvre ce qu'il ne voit pas : une instance qui ne répond plus. La passe lit
 * jusqu'à 100 runtimes l'un après l'autre : 100 x 30 s reste sous
 * `LINK_SECURITY_TICK_MS`, même quand tous les relais sont muets. Même ordre
 * que la sonde d'enrôlement à travers le tuyau (30 s). Un inventaire manquant
 * est journalisé et repris à la passe suivante.
 */
export const LINK_SESSIONS_INVENTORY_TIMEOUT_MS = 30_000;

/** Le sous-ensemble de `fetch` que ces passes utilisent : injectable dans les tests sans `preconnect`. */
export type LinkFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type LinkControlOptions = {
  apiInternalUrl: string;
  runtimeLinkInternalUrl?: string;
  /** The relay secret: these passes call the relay's control and proxy routes. */
  internalSecrets: InternalSecretsWith<"relay">;
  fetchImpl?: LinkFetch;
  now?: () => Date;
};

function linkOrigin(options: LinkControlOptions): string {
  return (options.runtimeLinkInternalUrl ?? options.apiInternalUrl).replace(/\/+$/, "");
}

/**
 * Rotation automatique du jeton de lien. Un runtime `connector`
 * connecté dont le jeton a plus de `maxAgeHours` reçoit un nouveau jeton en
 * mode maintenance : l'ancien hash glisse en `link_token_previous_hash` pour
 * dix minutes, le nouveau part par `link.rotate` sur le lien via la route de
 * contrôle interne. Si la trame n'a certainement pas été poussée (aucune
 * instance ne tient le lien), la rotation est DÉFAITE : un jeton que personne
 * n'a reçu tuerait le lien à la fin de la grâce. Si l'issue est inconnue
 * (réponse perdue, échéance), l'hôte a peut-être déjà enregistré le nouveau
 * jeton : les deux restent valables jusqu'à sa prochaine admission
 * (`settleLinkTokenRotation`). Le jeton n'est jamais journalisé.
 */
export async function rotateStaleLinkTokens(db: SQL, maxAgeHours: number, options: LinkControlOptions): Promise<number> {
  const fetchImpl: LinkFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - maxAgeHours * 3_600_000);
  const due = await db<Array<{ id: string; organizationId: string }>>`
    select id, organization_id as "organizationId"
      from runtimes
     where reachability = 'connector'
       and revoked_at is null
       and link_connected_at is not null
       and last_health_status <> 'disconnected'
       and link_last_seen_at > now() - interval '45 seconds'
       and link_token_previous_hash is null
       and coalesce(link_token_rotated_at, created_at) < ${cutoff}
     order by coalesce(link_token_rotated_at, created_at) asc
     limit 20
  `;
  let rotated = 0;
  for (const runtime of due) {
    const linkToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(linkToken).digest("hex");
    const expiresAt = new Date(now().getTime() + maxAgeHours * 3_600_000);
    const previousHash = await rotateLinkToken(db, {
      runtimeId: runtime.id,
      organizationId: runtime.organizationId,
      tokenHash,
      expiresAt,
      graceMinutes: LINK_TOKEN_GRACE_MINUTES,
    });
    if (!previousHash) continue;
    let pushed: ControlPush;
    try {
      const response = await fetchImpl(`${linkOrigin(options)}/internal/runtime-links/${encodeURIComponent(runtime.id)}/control`, {
        method: "POST",
        headers: { Authorization: internalBearer(options.internalSecrets, "relay"), "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "rotate", runtimeId: runtime.id, linkToken }),
        cache: "no-store",
        // Jamais une attente sans fin : l'échéance tombe dans le `catch`, issue inconnue.
        signal: AbortSignal.timeout(LINK_CONTROL_CALL_TIMEOUT_MS),
      });
      pushed = await controlPushOf(response);
    } catch {
      pushed = "unknown";
    }
    if (pushed === false) {
      // Personne n'a le nouveau jeton : on rend l'ancien, sans grâce ni trace.
      await undoLinkTokenRotation(db, {
        runtimeId: runtime.id,
        organizationId: runtime.organizationId,
        previousHash,
        tokenHash,
      });
      console.warn(JSON.stringify({ event: "worker.link_token_rotation_not_pushed", runtimeId: runtime.id }));
      continue;
    }
    if (pushed === "unknown") {
      const held = await holdUnconfirmedLinkTokenRotation(db, {
        runtimeId: runtime.id,
        organizationId: runtime.organizationId,
        tokenHash,
        holdHours: LINK_TOKEN_UNCONFIRMED_HOLD_HOURS,
      });
      if (held) {
        await db`
          insert into runtime_link_events (organization_id, runtime_id, kind, meta)
          values (${runtime.organizationId}, ${runtime.id}, 'rotated', ${{ automatic: true, reason: "max_age", confirmed: false }}::jsonb)
        `;
      }
      console.warn(JSON.stringify({ event: "worker.link_token_rotation_unconfirmed", runtimeId: runtime.id, held }));
      continue;
    }
    await db`
      insert into runtime_link_events (organization_id, runtime_id, kind, meta)
      values (${runtime.organizationId}, ${runtime.id}, 'rotated', ${{ automatic: true, reason: "max_age" }}::jsonb)
    `;
    rotated += 1;
  }
  return rotated;
}

type HostSessionsInventory = { sessions: Array<{ id: string; profile: string; createdAt: string }>; total: number; truncated: boolean };

/**
 * Un identifiant de session tel que le gateway l'accepte sur le lien (même
 * alphabet que `HERMES_SESSION_SEGMENT`, deux-points compris) : les sessions
 * d'openedbot s'appellent `openedbot:<org>:<thread>`.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._~:-]{1,256}$/;
/** Runtimes lus par passe : 100 x `LINK_SESSIONS_INVENTORY_TIMEOUT_MS` reste sous `LINK_SECURITY_TICK_MS`. */
export const SESSION_RECONCILIATION_BATCH = 100;

/**
 * Réconciliation des sessions, côté API. Pour chaque
 * runtime connecté qui annonce `sessions_inventory`, la liste bornée des
 * identifiants de session de l'hôte est comparée à ce qu'openedbot a lui-même
 * créé (`threads.hermes_session_id`, `runs.execution_session_key`). Une
 * session inconnue est une création hors du lien : journalisée
 * `unattributed_session` (une fois par identifiant) et remontée en erreur
 * structurée, jamais silencieuse. Le contenu d'une session ne transite pas.
 */
export async function reconcileRuntimeSessions(db: SQL, options: LinkControlOptions): Promise<{ runtimes: number; unattributed: number }> {
  const fetchImpl: LinkFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const runtimes = await db<Array<{ id: string; organizationId: string }>>`
    select id, organization_id as "organizationId"
      from runtimes
     where reachability = 'connector'
       and revoked_at is null
       and link_connected_at is not null
       and last_health_status <> 'disconnected'
       and ${RELAY_FEATURE_SESSIONS_INVENTORY} = any(link_features)
       -- Lien tenu par une API vivante (prédicat de queue.ts et du balayage
       -- du lien) : un hôte dont l'API vient de redémarrer n'est pas appelé
       -- avant de s'être reconnecté. Un propriétaire remplacé à la même
       -- adresse interne est mort même s'il a battu il y a moins de 60 s.
       and runtimes.link_last_seen_at > now() - interval '45 seconds'
       and exists (
         select 1 from api_instances inst
          where inst.instance_id = runtimes.link_instance_id
            and inst.stopped_at is null
            and inst.last_seen_at > now() - interval '60 seconds'
            and not exists (
              select 1 from api_instances newer
               where newer.internal_url = inst.internal_url
                 and newer.started_at > inst.started_at
                 -- Vivante seulement : une instance tombée au démarrage
                 -- (port déjà pris) ne disqualifie pas le propriétaire en place.
                 and newer.stopped_at is null
                 and newer.last_seen_at > now() - interval '60 seconds'
            )
       )
     order by link_sessions_reconciled_at asc nulls first, id
     limit ${SESSION_RECONCILIATION_BATCH}
  `;
  let unattributed = 0;
  for (const runtime of runtimes) {
    // Datée avant la lecture, réussie ou non : la passe suivante prend les
    // runtimes qui attendent depuis le plus longtemps, jamais les cent mêmes.
    await db`update runtimes set link_sessions_reconciled_at = now() where id = ${runtime.id} and organization_id = ${runtime.organizationId}`;
    let inventory: HostSessionsInventory;
    try {
      const response = await fetchImpl(`${linkOrigin(options)}/internal/runtime-links/${encodeURIComponent(runtime.id)}/proxy/hermes-setup/sessions-inventory`, {
        method: "GET",
        headers: { Authorization: internalBearer(options.internalSecrets, "relay") },
        cache: "no-store",
        // Jamais une attente sans fin : l'échéance tombe dans le `catch`, cet hôte est journalisé indisponible.
        signal: AbortSignal.timeout(LINK_SESSIONS_INVENTORY_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn(JSON.stringify({ event: "worker.sessions_inventory_unavailable", runtimeId: runtime.id, status: response.status }));
        continue;
      }
      inventory = await response.json() as HostSessionsInventory;
    } catch (error) {
      console.warn(JSON.stringify({ event: "worker.sessions_inventory_unavailable", runtimeId: runtime.id, error: String(error) }));
      continue;
    }
    if (!Array.isArray(inventory.sessions)) continue;
    const hostIds = [...new Set(inventory.sessions.map((session) => session?.id).filter((id): id is string => typeof id === "string" && SESSION_ID_PATTERN.test(id)))];
    if (hostIds.length === 0) continue;
    // Bun sends a bound JS array as "a,b": PostgreSQL refuses it as a
    // malformed array literal, so the reconciliation failed on every host
    // that announced a session.
    const hostIdArray = pgTextArray(hostIds);
    const known = await db<Array<{ id: string }>>`
      select hermes_session_id as id from threads
       where organization_id = ${runtime.organizationId} and hermes_session_id = any(${hostIdArray}::text[])
      union
      select execution_session_key as id from runs
       where organization_id = ${runtime.organizationId} and execution_session_key = any(${hostIdArray}::text[])
      union
      select meta->>'sessionId' as id from runtime_link_events
       where organization_id = ${runtime.organizationId} and runtime_id = ${runtime.id}
         and kind = 'unattributed_session' and meta->>'sessionId' = any(${hostIdArray}::text[])
    `;
    const knownIds = new Set(known.map((row) => row.id));
    const strangers = inventory.sessions
      .filter((session) => typeof session?.id === "string" && SESSION_ID_PATTERN.test(session.id) && !knownIds.has(session.id))
      .slice(0, UNATTRIBUTED_SESSIONS_PER_PASS);
    for (const session of strangers) {
      const meta = {
        sessionId: session.id,
        profile: typeof session.profile === "string" ? session.profile.slice(0, 64) : null,
        createdAt: typeof session.createdAt === "string" ? session.createdAt.slice(0, 40) : null,
      };
      await db`
        insert into runtime_link_events (organization_id, runtime_id, kind, meta)
        values (${runtime.organizationId}, ${runtime.id}, 'unattributed_session', ${meta}::jsonb)
      `;
      console.error(JSON.stringify({ event: "worker.unattributed_session", runtimeId: runtime.id, ...meta }));
      unattributed += 1;
    }
  }
  return { runtimes: runtimes.length, unattributed };
}
