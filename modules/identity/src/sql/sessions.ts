import type { Db, TransactionDb } from "@openedbot/platform-db";
import { withAuthenticatingUser, withCredential, withTenant } from "@openedbot/platform-db";
import { hashCredential, randomCredential } from "@openedbot/platform-db/credential";

const ACCESS_TTL_MS = 15 * 60 * 1_000;
export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/** Ce qu'on retient d'une session à sa création, pour l'écran « Sécurité du compte ». */
export type SessionDevice = { userAgent: string | null; ip: string | null };

export async function createWebSession(
  db: Db,
  organizationId: string | null,
  userId: string,
  device: SessionDevice = { userAgent: null, ip: null },
): Promise<{ id: string; token: string; csrf: string }> {
  const id = crypto.randomUUID();
  const token = randomCredential();
  const csrf = randomCredential(24);
  // Un compte sans organisation (0086) ouvre quand même sa session web : il
  // doit pouvoir atteindre « Définir votre organisation ». La policy
  // `sessions_credential` accepte alors l'insertion par son propre jeton.
  const open = <T>(callback: (tx: TransactionDb) => Promise<T>) => organizationId
    ? withTenant(db, organizationId, callback)
    : withCredential(db, hashCredential(token), callback);
  await open(async (tx) => {
    await tx`
      insert into sessions (
        id, organization_id, user_id, kind, session_token_hash, csrf_hash, access_expires_at,
        user_agent, ip
      ) values (
        ${id}, ${organizationId}, ${userId}, 'web', ${hashCredential(token)},
        ${hashCredential(csrf)}, ${new Date(Date.now() + WEB_SESSION_TTL_MS)}, ${device.userAgent}, ${device.ip}
      )
    `;
  });
  // L'id est renvoyé pour que les appelants (ex. échange d'appairage) sachent
  // quelle ligne ils viennent de créer sans avoir à la retrouver par un
  // sous-select : sous `withTenant`, ce sous-select ne verrait rien.
  return { id, token, csrf };
}

/**
 * La connexion qu'une rotation prolonge : une session native qui tourne son
 * refresh token reste, pour l'écran « Sécurité », la même ouverture (même
 * famille, même date d'ouverture), pas une session neuve tous les quarts d'heure.
 */
export type NativeSessionLineage = { familyId: string; createdAt: Date };

export async function createNativeSession(
  db: Db,
  /** `null` : compte sans organisation, qui va la définir dans l'onboarding (0158). */
  organizationId: string | null,
  userId: string,
  device: SessionDevice = { userAgent: null, ip: null },
  lineage: NativeSessionLineage | null = null,
) {
  return db.begin((tx) => insertNativeSession(tx, organizationId, userId, device, lineage));
}

async function insertNativeSession(
  tx: TransactionDb,
  organizationId: string | null,
  userId: string,
  device: SessionDevice,
  lineage: NativeSessionLineage | null,
) {
  const accessToken = randomCredential();
  const refreshToken = randomCredential();
  const accessTokenExpiresAt = new Date(Date.now() + ACCESS_TTL_MS);
  // `family_id` regroupe les rotations d'une même connexion (app de bureau) :
  // une première ouverture en pose une, chaque rotation la reprend.
  const familyId = lineage?.familyId ?? crypto.randomUUID();
  const createdAt = lineage?.createdAt ?? new Date();
  // Même règle que `createWebSession` : sans organisation, la policy
  // `sessions_credential` accepte l'insertion par son propre jeton d'accès.
  if (organizationId) await tx`select set_config('app.organization_id', ${organizationId}, true)`;
  else await tx`select set_config('app.session_credential_hash', ${hashCredential(accessToken)}, true)`;
  await tx`
    insert into sessions (
      id, organization_id, user_id, kind, access_token_hash, refresh_token_hash,
      access_expires_at, refresh_expires_at, user_agent, ip, family_id, created_at
    ) values (
      ${crypto.randomUUID()}, ${organizationId}, ${userId}, 'native', ${hashCredential(accessToken)},
      ${hashCredential(refreshToken)}, ${accessTokenExpiresAt}, ${new Date(Date.now() + REFRESH_TTL_MS)},
      ${device.userAgent}, ${device.ip}, ${familyId}, ${createdAt}
    )
  `;
  return { accessToken, accessTokenExpiresAt: accessTokenExpiresAt.toISOString(), refreshToken, organizationId };
}

/**
 * Verrou transactionnel des sessions d'un compte. La rotation native et
 * chaque révocation le prennent AVANT de toucher une ligne : une révocation
 * voit donc soit l'ancienne session (pas encore tournée), soit sa remplaçante
 * déjà commitée, jamais l'entre-deux où aucune n'est vivante.
 */
export async function lockUserSessions(tx: TransactionDb, userId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${userId}), hashtext('openedbot-user-sessions'))`;
}

/** Une session vivante telle que la porte d'authentification la lit. */
export type LiveSessionRow = {
  id: string;
  /** `null` : session d'un compte qui n'a pas encore défini son organisation (web 0086, native 0158). */
  organizationId: string | null;
  userId: string;
  kind: "web" | "native";
  csrfHash: string | null;
  impersonatedByStaffUserId: string | null;
};

/**
 * La session que ce justificatif ouvre : jeton de session ou d'accès, non
 * révoquée, accès non expiré. À appeler sous `withCredential`.
 */
export async function findLiveSession(tx: TransactionDb, credentialHash: string): Promise<LiveSessionRow | null> {
  const rows = await tx<LiveSessionRow[]>`
    select s.id,
           s.organization_id as "organizationId",
           s.user_id as "userId",
           s.kind,
           s.csrf_hash as "csrfHash",
           s.impersonated_by_staff_user_id as "impersonatedByStaffUserId"
      from sessions s
     where s.revoked_at is null
       and (
         s.session_token_hash = ${credentialHash}
         or s.access_token_hash = ${credentialHash}
       )
       and s.access_expires_at > now()
     limit 1
  `;
  return rows[0] ?? null;
}

/** Rafraîchit `last_seen_at` au plus une fois par minute : l'écran « Sécurité » montre l'activité, pas chaque requête. */
export async function touchSession(tx: TransactionDb, sessionId: string): Promise<void> {
  await tx`
    update sessions set last_seen_at = now()
     where id = ${sessionId} and last_seen_at < now() - interval '60 seconds'
  `;
}

export async function revokeSessionOnLogout(db: Db, credentialHash: string, sessionId: string): Promise<void> {
  await withCredential(db, credentialHash, async (tx) => {
    await tx`update sessions set revoked_at = now(), revoked_reason = 'logout' where id = ${sessionId}`;
  });
}

/**
 * Rattache une session encore sans organisation, web ou native, à celle que
 * le compte vient de définir. Pour une session native, la ligne porte aussi le
 * refresh token : la rotation suivante reprend donc l'organisation.
 */
export async function attachSessionOrganization(
  db: Db,
  credentialHash: string,
  sessionId: string,
  organizationId: string,
): Promise<void> {
  await withCredential(db, credentialHash, (tx) => tx`
    update sessions set organization_id = ${organizationId}
     where id = ${sessionId} and organization_id is null
  `);
}

/** Ce qu'une rotation reprend de la session qu'elle remplace. */
export type RotatedNativeSession = {
  id: string;
  organizationId: string | null;
  userId: string;
  /** `null` pour une session antérieure à la famille (0019) : la suivante en ouvre une. */
  familyId: string | null;
  createdAt: Date;
  userAgent: string | null;
  ip: string | null;
};

/**
 * Consomme un refresh token natif et ouvre sa remplaçante, dans UNE
 * transaction sous le verrou du compte (`lockUserSessions`) : l'ancienne
 * session n'est jamais révoquée sans que la nouvelle existe, et une
 * révocation concurrente l'atteint forcément. La nouvelle ligne garde la
 * famille et la date d'ouverture de l'ancienne ; l'appareil et l'adresse
 * sont ceux de la requête, ou à défaut ceux qu'on connaissait.
 */
export async function rotateNativeSession(db: Db, refreshHash: string, device: SessionDevice) {
  return withCredential(db, refreshHash, async (tx) => {
    // Le compte d'abord, sans verrou de ligne : prendre le verrou du compte
    // en tenant déjà la ligne inverserait l'ordre des révocations (interblocage).
    const owners = await tx<Array<{ userId: string }>>`
      select user_id as "userId" from sessions
       where refresh_token_hash = ${refreshHash} and kind = 'native'
    `;
    const owner = owners[0];
    if (!owner) return null;
    await lockUserSessions(tx, owner.userId);
    // Relue sous le verrou : une révocation passée entre-temps la rend introuvable.
    const rows = await tx<RotatedNativeSession[]>`
      select id, organization_id as "organizationId", user_id as "userId",
             family_id as "familyId", created_at as "createdAt",
             user_agent as "userAgent", host(ip) as "ip"
        from sessions
       where refresh_token_hash = ${refreshHash}
         and kind = 'native' and revoked_at is null and refresh_expires_at > now()
       for update
    `;
    const found = rows[0];
    if (!found) return null;
    await tx`update sessions set revoked_at = now(), revoked_reason = 'refresh_rotation' where id = ${found.id}`;
    return insertNativeSession(
      tx,
      found.organizationId,
      found.userId,
      { userAgent: device.userAgent ?? found.userAgent, ip: device.ip ?? found.ip },
      found.familyId ? { familyId: found.familyId, createdAt: found.createdAt } : null,
    );
  });
}

/** Une ligne de l'écran « Sécurité du compte ». */
export type UserSessionRow = {
  id: string;
  kind: "web" | "native";
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  userAgent: string | null;
  ip: string | null;
};

/**
 * Les sessions du compte, web et natives : vivantes d'abord, puis révoquées
 * depuis moins de 30 jours. Une rotation de refresh token natif révoque la
 * ligne qu'elle remplace : ces lignes-là ne sont pas des appareils, juste les
 * étapes d'une même connexion, et noieraient la liste (une par quart d'heure).
 * Une session d'assistance staff (`impersonated_by_staff_user_id`) n'est pas
 * un appareil de la personne non plus : elle reste tracée côté staff
 * (`staff_impersonation_claims`), jamais dans la liste du titulaire.
 */
export async function listUserSessions(db: Db, userId: string): Promise<UserSessionRow[]> {
  return withAuthenticatingUser(db, userId, (tx) => tx<UserSessionRow[]>`
    select id, kind, created_at as "createdAt", last_seen_at as "lastSeenAt",
           access_expires_at as "expiresAt", revoked_at as "revokedAt",
           -- host() et non ip::text : la colonne est un inet, dont la
           -- représentation textuelle porte le masque (127.0.0.1/32). On
           -- montre une adresse à un utilisateur, pas un préfixe réseau.
           revoked_reason as "revokedReason", user_agent as "userAgent", host(ip) as "ip"
      from sessions
     where user_id = ${userId}
       and impersonated_by_staff_user_id is null
       and (kind = 'web' or (kind = 'native' and revoked_reason is distinct from 'refresh_rotation'))
       and (revoked_at is null or revoked_at > now() - interval '30 days')
     order by (revoked_at is null) desc, last_seen_at desc
     limit 50
  `);
}

/** Vrai quand la session existait, appartenait à ce compte et n'était pas déjà révoquée. */
export async function revokeUserSession(db: Db, userId: string, sessionId: string): Promise<boolean> {
  // Une session native désigne sa connexion entière : si elle a tourné depuis
  // l'affichage de la liste, c'est sa remplaçante (même famille) qui tombe.
  const revoked = await withAuthenticatingUser(db, userId, async (tx) => {
    await lockUserSessions(tx, userId);
    return tx<Array<{ id: string }>>`
      update sessions set revoked_at = now(), revoked_reason = 'user_revoked'
       where user_id = ${userId} and revoked_at is null
         and impersonated_by_staff_user_id is null
         and (
           id = ${sessionId}
           or family_id = (
             select family_id from sessions
              where id = ${sessionId} and user_id = ${userId} and kind = 'native'
           )
         )
      returning id
    `;
  });
  return revoked.length > 0;
}

/**
 * Révoque toutes les sessions du compte sauf la courante ; rend leur nombre.
 * Les sessions d'assistance staff n'en font pas partie : la liste ne les
 * montre pas, le compte rendu ne doit donc pas les compter.
 */
export async function revokeOtherUserSessions(db: Db, userId: string, currentSessionId: string): Promise<number> {
  const revoked = await withAuthenticatingUser(db, userId, async (tx) => {
    await lockUserSessions(tx, userId);
    return tx<Array<{ id: string }>>`
      update sessions set revoked_at = now(), revoked_reason = 'user_revoked'
       where user_id = ${userId} and id <> ${currentSessionId} and revoked_at is null
         and impersonated_by_staff_user_id is null
      returning id
    `;
  });
  return revoked.length;
}
