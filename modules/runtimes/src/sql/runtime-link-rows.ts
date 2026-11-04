import type { Db } from "@openedbot/platform-db";
import { pgTextArray } from "@openedbot/platform-db/text-array";

/**
 * Writes of the connector link columns of `runtimes`, called by runtime-link
 * (gateway, liveness store, token rotation) with its own transaction. The
 * `where` clauses keep the token-hash gate (current hash, or the previous one
 * during the rotation grace) exactly as the link wrote them.
 */

/** Le runtime dont le lien s'écrit : identifiant, organisation et hash du jeton présenté. */
export type LinkRuntimeScope = { runtimeId: string; organizationId: string; tokenHash: string };

/**
 * L'agent et la version Hermes de `hello` (0055, 0162) ne sont retenus
 * qu'après admission ; la génération doit encore être celle du lien.
 */
export async function writeLinkAgent(
  tx: Db,
  scope: LinkRuntimeScope,
  input: { agent: string; hermesVersion: string | null; generation: string | null },
): Promise<void> {
  await tx`
    update runtimes set link_agent = ${input.agent}, link_hermes_version = ${input.hermesVersion}, link_agent_seen_at = now()
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId}
       and revoked_at is null and link_connected_at is not null
       and link_generation = ${input.generation}::bigint
       and (link_token_hash = ${scope.tokenHash}
         or (link_token_previous_hash = ${scope.tokenHash} and link_token_previous_expires_at > now()))
  `;
}

/**
 * Origine signée à la preuve de possession (`https://link.example`, ou la
 * loopback de dev). Écrasée à chaque session acceptée. `false` si le jeton
 * a tourné ou le runtime a été révoqué entre la preuve et l'écriture.
 */
export async function writeLinkOrigin(tx: Db, scope: LinkRuntimeScope, origin: string): Promise<boolean> {
  const rows = await tx`
    update runtimes set link_origin = ${origin}
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId}
       and revoked_at is null
       and (link_token_hash = ${scope.tokenHash}
         or (link_token_previous_hash = ${scope.tokenHash} and link_token_previous_expires_at > now()))
     returning id
  `;
  return rows.length > 0;
}

/** Enregistre la clé device du lien ; `false` si le jeton a tourné ou le runtime a été révoqué. */
export async function registerLinkDevicePublicKey(
  tx: Db,
  scope: LinkRuntimeScope,
  devicePublicKey: string,
): Promise<boolean> {
  const rows = await tx`
    update runtimes set link_device_pubkey = ${devicePublicKey}, updated_at = now()
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId}
       and link_token_hash = ${scope.tokenHash} and revoked_at is null
     returning id
  `;
  return rows.length > 0;
}

/** Le runtime `connector` créé par l'enrôlement, sonde déjà passée, lien déjà monté. */
export async function insertConnectorRuntime(
  tx: Db,
  input: {
    runtimeId: string;
    organizationId: string;
    name: string;
    tokenHash: string;
    instanceId: string;
    features: readonly string[];
    capacity: number;
    active: boolean;
    devicePublicKey: string | null;
  },
): Promise<void> {
  await tx`
    insert into runtimes (
      id, organization_id, name, reachability, link_token_hash, link_instance_id,
      link_connected_at, link_last_seen_at, link_features, capacity, last_health_status, last_health_error,
      last_probed_at, is_active, link_device_pubkey
    ) values (
      ${input.runtimeId}, ${input.organizationId}, ${input.name}, 'connector', ${input.tokenHash}, ${input.instanceId},
      now(), now(), ${pgTextArray(input.features)}::text[], ${input.capacity}, 'healthy', null, now(), ${input.active},
      ${input.devicePublicKey}
    )
  `;
}

/** Hello accepté : l'instance tient le lien. `false` si le bail est perdu. */
export async function markLinkConnected(
  tx: Db,
  scope: LinkRuntimeScope,
  input: { instanceId: string; generation: string; features: readonly string[] },
): Promise<boolean> {
  const { instanceId, generation, features } = input;
  const rows = await tx<Array<{ id: string }>>`
    update runtimes
       set link_instance_id = ${instanceId},
           link_connected_at = case when link_generation < ${generation}::bigint then now() else link_connected_at end,
           link_last_seen_at = now(), link_generation = ${generation}::bigint,
           link_features = ${pgTextArray(features)}::text[],
           last_health_status = 'healthy', last_health_error = null, updated_at = now()
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId} and revoked_at is null
       and (link_generation < ${generation}::bigint
         or (link_generation = ${generation}::bigint and link_instance_id = ${instanceId} and link_connected_at is not null))
       and (link_token_hash = ${scope.tokenHash}
         or (link_token_previous_hash = ${scope.tokenHash} and link_token_previous_expires_at > now()))
    returning id
  `;
  return rows.length > 0;
}

/** Les capacités annoncées ont changé. `false` si le bail est perdu. */
export async function setLinkFeatures(
  tx: Db,
  scope: LinkRuntimeScope,
  input: { instanceId: string; generation: string; features: readonly string[] },
): Promise<boolean> {
  const { instanceId, generation, features } = input;
  const rows = await tx<Array<{ id: string }>>`
    update runtimes set link_features = ${pgTextArray(features)}::text[]
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId} and revoked_at is null
       and link_generation = ${generation}::bigint and link_instance_id = ${instanceId} and link_connected_at is not null
       and (link_token_hash = ${scope.tokenHash}
         or (link_token_previous_hash = ${scope.tokenHash} and link_token_previous_expires_at > now()))
    returning id
  `;
  return rows.length > 0;
}

/** Signe de vie du lien. `false` si le bail est perdu. */
export async function markLinkSeen(
  tx: Db,
  scope: LinkRuntimeScope,
  input: { instanceId: string; generation: string },
): Promise<boolean> {
  const { instanceId, generation } = input;
  const rows = await tx<Array<{ id: string }>>`
    update runtimes set link_last_seen_at = now(),
           last_health_status = case when last_health_status = 'disconnected' then 'healthy' else last_health_status end,
           last_health_error = case when last_health_status = 'disconnected' then null else last_health_error end
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId} and revoked_at is null
       and link_generation = ${generation}::bigint and link_instance_id = ${instanceId} and link_connected_at is not null
       and (link_token_hash = ${scope.tokenHash}
         or (link_token_previous_hash = ${scope.tokenHash} and link_token_previous_expires_at > now()))
    returning id
  `;
  return rows.length > 0;
}

/** Le lien s'est fermé proprement. `false` si le bail est perdu. */
export async function markLinkDisconnected(
  tx: Db,
  scope: LinkRuntimeScope,
  input: { instanceId: string; generation: string; reason: string },
): Promise<boolean> {
  const { instanceId, generation, reason } = input;
  const rows = await tx<Array<{ id: string }>>`
    update runtimes set link_instance_id = null, link_connected_at = null,
           last_health_status = 'disconnected', last_health_error = ${reason}, updated_at = now()
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId} and revoked_at is null
       and link_generation = ${generation}::bigint and link_instance_id = ${instanceId} and link_connected_at is not null
       and (link_token_hash = ${scope.tokenHash}
         or (link_token_previous_hash = ${scope.tokenHash} and link_token_previous_expires_at > now()))
    returning id
  `;
  return rows.length > 0;
}

/** Une écriture de toolsets a eu lieu sur l'hôte : le cache du worker doit se périmer. */
export async function bumpToolsetEpoch(tx: Db, scope: LinkRuntimeScope): Promise<void> {
  await tx`
    update runtimes set toolset_epoch = toolset_epoch + 1
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId} and revoked_at is null
       and (link_token_hash = ${scope.tokenHash}
         or (link_token_previous_hash = ${scope.tokenHash} and link_token_previous_expires_at > now()))
  `;
}

/**
 * 0163 : une écriture relayée a changé les capacités de la racine (`profile`
 * nul) ou d'un profil. Le profil est un segment déjà validé par la route
 * relayée ; la carte ne grandit que d'une clé par profil.
 */
export async function markCapabilitiesChanged(tx: Db, scope: LinkRuntimeScope, profile: string | null): Promise<void> {
  if (profile === null) {
    await tx`
      update runtimes set capabilities_changed_at = now()
       where id = ${scope.runtimeId} and organization_id = ${scope.organizationId} and revoked_at is null
         and (link_token_hash = ${scope.tokenHash}
           or (link_token_previous_hash = ${scope.tokenHash} and link_token_previous_expires_at > now()))
    `;
    return;
  }
  await tx`
    update runtimes
       set profile_capabilities_changed_at = jsonb_set(profile_capabilities_changed_at, array[${profile}::text], to_jsonb(now()))
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId} and revoked_at is null
       and (link_token_hash = ${scope.tokenHash}
         or (link_token_previous_hash = ${scope.tokenHash} and link_token_previous_expires_at > now()))
  `;
}

/**
 * L'hôte a signalé que son inventaire a bougé (`inventory.changed`). Rendu :
 * `true` quand la ligne du runtime de ce jeton a été marquée.
 */
export async function markInventoryChanged(tx: Db, scope: LinkRuntimeScope): Promise<boolean> {
  const rows = await tx`
    update runtimes set inventory_changed_at = now()
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId} and revoked_at is null
       and (link_token_hash = ${scope.tokenHash}
         or (link_token_previous_hash = ${scope.tokenHash} and link_token_previous_expires_at > now()))
    returning id
  `;
  return rows.length > 0;
}

/**
 * Rotation d'urgence : le nouveau jeton n'est jamais rendu, son hash seul
 * existe. Plus personne ne peut monter avec l'ancien, ni avec l'ancien-précédent.
 */
export async function replaceLinkTokenEmergency(
  tx: Db,
  input: { organizationId: string; runtimeId: string; tokenHash: string },
): Promise<void> {
  await tx`
    update runtimes
       set link_token_previous_hash = null, link_token_previous_expires_at = null,
           link_token_rotation_unconfirmed_at = null,
           link_token_rotated_at = now(), link_token_expires_at = null,
           link_token_hash = ${input.tokenHash}, updated_at = now()
     where organization_id = ${input.organizationId} and id = ${input.runtimeId}
       and reachability = 'connector' and revoked_at is null
  `;
}

/**
 * Fin de grâce d'une rotation de jeton (0027) : l'ancien hash est effacé dès
 * que `link_token_previous_expires_at` est passé. Jusque-là un hôte qui n'a
 * pas encore reçu `link.rotate` se reconnecte avec l'ancien jeton ; après,
 * seul le nouveau ouvre le lien.
 */
export async function expireRotatedLinkTokens(db: Db): Promise<number> {
  const rows = await db<Array<{ count: string | number }>>`
    with expired as (
      update runtimes
         set link_token_previous_hash = null, link_token_previous_expires_at = null,
             link_token_rotation_unconfirmed_at = null, updated_at = now()
       where link_token_previous_hash is not null
         and (link_token_previous_expires_at is null or link_token_previous_expires_at <= now())
       returning id
    )
    select count(*) as count from expired
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Rotation automatique : l'ancien hash glisse en `link_token_previous_hash`
 * pour `graceMinutes`, le nouveau prend sa place. Rend l'ancien hash, ou
 * `null` si le runtime a déjà une rotation en cours.
 */
export async function rotateLinkToken(
  db: Db,
  input: { runtimeId: string; organizationId: string; tokenHash: string; expiresAt: Date; graceMinutes: number },
): Promise<string | null> {
  const previous = await db<Array<{ previousHash: string }>>`
    update runtimes
       set link_token_previous_hash = link_token_hash,
           link_token_previous_expires_at = now() + (${input.graceMinutes} * interval '1 minute'),
           link_token_rotation_unconfirmed_at = null,
           link_token_rotated_at = now(),
           link_token_expires_at = ${input.expiresAt},
           link_token_hash = ${input.tokenHash},
           updated_at = now()
     where id = ${input.runtimeId} and organization_id = ${input.organizationId}
       and reachability = 'connector' and revoked_at is null and link_token_previous_hash is null
    returning link_token_previous_hash as "previousHash"
  `;
  return previous[0]?.previousHash ?? null;
}

/** Personne n'a reçu le nouveau jeton : on rend l'ancien, sans grâce ni trace. */
export async function undoLinkTokenRotation(
  db: Db,
  input: { runtimeId: string; organizationId: string; previousHash: string; tokenHash: string },
): Promise<void> {
  await db`
    update runtimes
       set link_token_hash = ${input.previousHash}, link_token_previous_hash = null, link_token_previous_expires_at = null,
           link_token_rotation_unconfirmed_at = null, link_token_expires_at = null, updated_at = now()
     where id = ${input.runtimeId} and organization_id = ${input.organizationId} and link_token_hash = ${input.tokenHash}
  `;
}

/**
 * Livraison de `link.rotate` incertaine (0174) : l'hôte a peut-être le
 * nouveau jeton, peut-être pas. Les deux hashes restent valables jusqu'à sa
 * prochaine admission (`settleLinkTokenRotation`), au plus `holdHours`.
 * `false` si la rotation n'est plus celle-ci (révoquée, retournée entre-temps).
 */
export async function holdUnconfirmedLinkTokenRotation(
  db: Db,
  input: { runtimeId: string; organizationId: string; tokenHash: string; holdHours: number },
): Promise<boolean> {
  const rows = await db<Array<{ id: string }>>`
    update runtimes
       set link_token_previous_expires_at = now() + (${input.holdHours} * interval '1 hour'),
           link_token_rotation_unconfirmed_at = now(), updated_at = now()
     where id = ${input.runtimeId} and organization_id = ${input.organizationId}
       and revoked_at is null and link_token_hash = ${input.tokenHash}
       and link_token_previous_hash is not null
    returning id
  `;
  return rows.length > 0;
}

/**
 * L'hôte vient d'être admis avec `scope.tokenHash` : il dit quel jeton il
 * détient. Le jeton courant confirme toute rotation en cours (l'ancien hash ne
 * sert plus personne). L'ancien jeton, pendant une rotation non confirmée,
 * prouve que l'hôte n'a pas enregistré le nouveau : la rotation est défaite
 * et la passe suivante la rejoue. Une rotation confirmée par la livraison
 * garde sa grâce ordinaire. Rend ce qui a été tranché, `null` sinon.
 */
export async function settleLinkTokenRotation(tx: Db, scope: LinkRuntimeScope): Promise<"confirmed" | "reverted" | null> {
  const confirmed = await tx<Array<{ id: string }>>`
    update runtimes
       set link_token_previous_hash = null, link_token_previous_expires_at = null,
           link_token_rotation_unconfirmed_at = null, updated_at = now()
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId} and revoked_at is null
       and link_token_hash = ${scope.tokenHash} and link_token_previous_hash is not null
    returning id
  `;
  if (confirmed.length > 0) return "confirmed";
  const reverted = await tx<Array<{ id: string }>>`
    update runtimes
       set link_token_hash = ${scope.tokenHash}, link_token_previous_hash = null, link_token_previous_expires_at = null,
           link_token_rotation_unconfirmed_at = null, link_token_expires_at = null, updated_at = now()
     where id = ${scope.runtimeId} and organization_id = ${scope.organizationId} and revoked_at is null
       and link_token_rotation_unconfirmed_at is not null
       and link_token_previous_hash = ${scope.tokenHash} and link_token_previous_expires_at > now()
    returning id
  `;
  return reverted.length > 0 ? "reverted" : null;
}
