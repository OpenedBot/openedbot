import type { CreatedOrganizationDto } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db, TransactionDb } from "@openedbot/platform-db";
import { isUniqueViolation, withAuthenticatingUser, withTenant } from "@openedbot/platform-db";
import { logger } from "@openedbot/platform-observability";
import { announceOrganizationCreated } from "../application/organization-created";
import { randomCredential } from "@openedbot/platform-db/credential";
import { runOrganizationCreating } from "../application/organization-creating";
import { organizationSlugCandidate } from "../domain/signup";
import { lockUserSessions } from "./sessions";
import { verifyPassword } from "../application/password-hash";

/** Les environnements de l'API, tels que `ApiConfig["environment"]` les nomme. */
export type ApiEnvironment = "development" | "test" | "production";

type UserRow = { id: string; email: string; passwordHash: string | null };
export type MembershipRow = { organizationId: string; role: "owner" | "admin" | "member" };

/**
 * En DEUX temps, et jamais par une jointure : la policy de `organizations`
 * n'ouvre la table que sur `app.organization_id`, réglage qu'un contexte
 * « utilisateur qui s'authentifie » n'a pas encore. Une jointure
 * `memberships × organizations` sous `withAuthenticatingUser` ne renvoie donc
 * RIEN, même à un membre parfaitement légitime : c'est ce silence qui refusait
 * l'entrée à tout compte Google. Même marche que `verifyCredentials`.
 *
 * Exporté parce qu'un outil d'exploitation peut poser la MÊME question avant d'ouvrir une
 * porte : une adresse dont le compte n'a plus aucun espace vivant ne peut pas
 * entrer, et doit être traitée comme une adresse sans compte
 * (hors du cœur ouvert).
 */
export async function firstLivingOrganization(db: Db, userId: string): Promise<string | null> {
  const memberships = await withAuthenticatingUser(db, userId, (tx) => tx<Array<{ organizationId: string }>>`
    select organization_id as "organizationId" from memberships
     where user_id = ${userId} and revoked_at is null  order by created_at asc
  `);
  for (const membership of memberships) {
    const alive = await withTenant(db, membership.organizationId, async (tx) => {
      const rows = await tx<Array<{ id: string }>>`
        select id from organizations where id = ${membership.organizationId} and deleted_at is null
      `;
      return rows[0] ?? null;
    });
    if (alive) return membership.organizationId;
  }
  return null;
}

/** Same membership/tenant lookup when the caller already owns a transaction. */
export async function firstLivingOrganizationInTransaction(tx: TransactionDb, userId: string): Promise<string | null> {
  await tx`select set_config('app.authenticating_user_id', ${userId}, true)`;
  const memberships = await tx<Array<{ organizationId: string }>>`
    select organization_id as "organizationId" from memberships
     where user_id = ${userId} and revoked_at is null order by created_at asc
  `;
  for (const membership of memberships) {
    await tx`select set_config('app.organization_id', ${membership.organizationId}, true)`;
    const rows = await tx<Array<{ id: string }>>`select id from organizations where id = ${membership.organizationId} and deleted_at is null`;
    if (rows[0]) return membership.organizationId;
  }
  return null;
}

/**
 * One account, one workspace: creating one's own space and accepting an
 * invitation are the only two ways in, and both take this lock (per account,
 * held until the transaction ends) before checking `livingWorkspacesExcept`.
 * Two concurrent requests of the same account are thus ordered, and the
 * second sees the membership the first committed.
 *
 * Lock order: this lock BEFORE any lock on the account's `users` row (and
 * before the inserts whose foreign key takes one), on every path.
 */
export async function lockAccountWorkspace(tx: TransactionDb, userId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${userId}), hashtext('openedbot-account-workspace'))`;
}

/**
 * The account's live memberships in living organizations other than
 * `currentOrganizationId`, read inside the caller's transaction. The tenant is
 * switched for each read (the `organizations` policy forbids the join), then
 * restored to `currentOrganizationId`, and the authenticating-user setting to
 * what it was.
 */
export async function livingWorkspacesExcept(
  tx: TransactionDb,
  userId: string,
  currentOrganizationId: string,
): Promise<MembershipRow[]> {
  const [previous] = await tx<Array<{ value: string | null }>>`select current_setting('app.authenticating_user_id', true) as value`;
  await tx`select set_config('app.authenticating_user_id', ${userId}, true)`;
  const memberships = await tx<MembershipRow[]>`
    select organization_id as "organizationId", role from memberships
     where user_id = ${userId} and revoked_at is null and organization_id <> ${currentOrganizationId}
     order by created_at asc
  `;
  const living: MembershipRow[] = [];
  for (const membership of memberships) {
    await tx`select set_config('app.organization_id', ${membership.organizationId}, true)`;
    const rows = await tx<Array<{ id: string }>>`select id from organizations where id = ${membership.organizationId} and deleted_at is null`;
    if (rows[0]) living.push(membership);
  }
  await tx`select set_config('app.organization_id', ${currentOrganizationId}, true)`;
  await tx`select set_config('app.authenticating_user_id', ${previous?.value ?? ""}, true)`;
  return living;
}

export function memberAlreadyInWorkspace(): HttpError {
  return new HttpError(
    409,
    "MEMBER_ALREADY_IN_WORKSPACE",
    "Ce compte appartient déjà à un autre espace sur cette instance : quittez-le ou fermez votre propre espace d’abord, ou utilisez une autre adresse e-mail.",
  );
}

/**
 * L'organisation qu'un compte définit lui-même, à l'onboarding (0086) : un slug
 * libre, un propriétaire, et l'abonnement d'une organisation neuve.
 *
 * Plus aucune entrée (Google, backoffice, mot de passe) ne crée d'organisation
 * d'office : c'est la page « Définir votre organisation » qui appelle ceci.
 *
 * Une seule par compte, tenue par `personal_owner_user_id` unique : deux POST
 * concurrents donnent une organisation et un 409. Un compte déjà membre d'un
 * autre espace (entré par invitation) n'en crée pas : 409
 * `MEMBER_ALREADY_IN_WORKSPACE`. La colonne `kind` n'est pas nommée : sa
 * valeur par défaut (`personal`) suffit.
 */
export async function createOrganization(
  db: Db,
  input: { name: string },
  userId: string,
  environment: ApiEnvironment,
  billingEnforced: boolean,
): Promise<CreatedOrganizationDto> {
  if (await ownsPersonalOrganization(db, userId)) throw personalOrganizationExists();
  const organizationId = crypto.randomUUID();
  const name = input.name.trim().slice(0, 80);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = organizationSlugCandidate(name, attempt === 0 ? null : randomCredential(4));
    try {
      await withTenant(db, organizationId, async (tx) => {
        // A member of another workspace (joined by invitation) has no space of
        // their own to create: one account, one workspace.
        await lockAccountWorkspace(tx, userId);
        const others = await livingWorkspacesExcept(tx, userId, organizationId);
        if (others.some((other) => other.role === "owner")) throw personalOrganizationExists();
        if (others.length > 0) throw memberAlreadyInWorkspace();
        await tx`
          insert into organizations (id, slug, name, personal_owner_user_id)
          values (${organizationId}, ${slug}, ${name}, ${userId})
        `;
        await tx`
          insert into memberships (organization_id, user_id, role)
          values (${organizationId}, ${userId}, 'owner')
        `;
        // Ce que billing attache à l'organisation (l'abonnement de bienvenue)
        // s'écrit dans cette transaction : `onOrganizationCreating`, plug-in
        // billing seulement. En solo, rien.
        await runOrganizationCreating(tx, { organizationId, billingEnforced, environment });
      });
      await announceOrganizationCreated(organizationId);
      return { organizationId, slug, kind: "personal" };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // La violation peut venir du slug (on retente) ou d'une organisation
      // personnelle créée entre-temps par une requête concurrente.
      if (await ownsPersonalOrganization(db, userId)) throw personalOrganizationExists();
    }
  }
  throw new HttpError(409, "ORGANIZATION_SLUG_UNAVAILABLE", "Aucun identifiant d’espace libre n’a pu être trouvé.");
}

function personalOrganizationExists(): HttpError {
  return new HttpError(409, "PERSONAL_ORGANIZATION_EXISTS", "Ce compte a déjà une organisation personnelle.");
}

/** Même marche en deux temps que `firstLivingOrganization` : la policy d'`organizations` interdit la jointure. */
async function ownsPersonalOrganization(db: Db, userId: string): Promise<boolean> {
  const memberships = await withAuthenticatingUser(db, userId, (tx) => tx<Array<{ organizationId: string }>>`
    select organization_id as "organizationId" from memberships
     where user_id = ${userId} and role = 'owner' and revoked_at is null
  `);
  for (const membership of memberships) {
    const owned = await withTenant(db, membership.organizationId, (tx) => tx<Array<{ id: string }>>`
      select id from organizations where id = ${membership.organizationId} and personal_owner_user_id = ${userId}
    `);
    if (owned[0]) return true;
  }
  return false;
}

/**
 * `organizationId: null` : le mot de passe est bon mais le compte n'a encore
 * aucune organisation vivante. La session s'ouvre quand même, et l'application
 * l'envoie sur « Définir votre organisation ». Un slug demandé et introuvable
 * reste un refus.
 */
export async function verifyCredentials(
  db: Db,
  email: string,
  password: string,
  organizationSlug: string | null,
): Promise<{ userId: string; organizationId: string | null }> {
  const users = await db<UserRow[]>`
    select id, email, password_hash as "passwordHash" from users where lower(email) = ${email} limit 1
  `;
  const user = users[0];
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    throw new HttpError(401, "CREDENTIALS_INVALID", "Email ou mot de passe invalide.");
  }
  const memberships = await withAuthenticatingUser(db, user.id, (tx) =>
    tx<MembershipRow[]>`
      select organization_id as "organizationId", role
        from memberships where user_id = ${user.id} and revoked_at is null
       order by created_at asc
    `,
  );
  for (const membership of memberships) {
    const organization = await withTenant(db, membership.organizationId, async (tx) => {
      const rows = await tx<Array<{ slug: string }>>`
        select slug from organizations where id = ${membership.organizationId} and deleted_at is null
      `;
      return rows[0] ?? null;
    });
    if (organization && (!organizationSlug || organization.slug === organizationSlug)) {
      return { userId: user.id, organizationId: membership.organizationId };
    }
  }
  if (!organizationSlug) return { userId: user.id, organizationId: null };
  throw new HttpError(403, "MEMBERSHIP_REQUIRED", "Ce compte n’appartient à aucune organisation active.");
}

/**
 * Horodate la DERNIÈRE CONNEXION du compte (`users.last_login_at`, 0075).
 *
 * Appelée à chaque authentification qui OUVRE une session, et uniquement là.
 * Trois choses qu'elle n'écrit délibérément pas :
 *
 *   * l'activité d'une session déjà ouverte : c'est `sessions.last_seen_at`,
 *     rafraîchi par `authMiddleware` à chaque requête. Confondre les deux
 *     ferait dire « connecté à l'instant » d'un onglet laissé ouvert depuis un
 *     mois ;
 *   * la rotation d'un refresh token natif (`grant_type=refresh_token`) : elle
 *     ne présente aucun identifiant et ne prouve donc aucune entrée nouvelle.
 *     L'entrée native est datée à l'échange du code d'autorisation, une fois,
 *     quel que soit le nombre de rotations qui suivent ;
 *   * une session d'assistance (ouverte pour la personne) : celle
 *     qui s'authentifie n'est pas le titulaire. La
 *     compter ferait apparaître un compte dormant comme revenu, précisément à
 *     cause de l'assistance venue comprendre pourquoi il dormait.
 *
 * L'écriture vit HORS de la transaction de session et son échec est avalé
 * après un log : une connexion par ailleurs valide ne se refuse pas parce
 * qu'une date d'observation n'a pas pu s'écrire. Le prix d'un échec est une
 * trace perdue (la colonne garde la valeur précédente, ou reste `null`), jamais
 * une porte fermée. `updated_at` n'est pas touché : entrer dans son compte ne
 * modifie pas le compte.
 */
export async function recordUserLogin(db: Db, userId: string): Promise<void> {
  try {
    await db`update users set last_login_at = now() where id = ${userId}`;
  } catch (error) {
    logger.warn(
      { event: "auth.last_login.write_failed", userId, error: String(error) },
      "last login not recorded",
    );
  }
}

/** L'identité que `/api/auth/me` rend : `must_change_password` voyage avec elle, jamais dans une lecture à part. */
export type AccountIdentityRow = {
  id: string;
  email: string;
  displayName: string | null;
  mustChangePassword: boolean;
};

export type OrganizationSummaryRow = { id: string; slug: string; name: string };

export async function readAccountIdentity(tx: TransactionDb, userId: string): Promise<AccountIdentityRow | null> {
  const users = await tx<AccountIdentityRow[]>`
    select id, email, display_name as "displayName",
           must_change_password as "mustChangePassword"
      from users where id = ${userId}
  `;
  return users[0] ?? null;
}

export async function readLivingOrganizationSummary(
  tx: TransactionDb,
  organizationId: string,
): Promise<OrganizationSummaryRow | null> {
  const organizations = await tx<OrganizationSummaryRow[]>`
    select id, slug, name from organizations where id = ${organizationId} and deleted_at is null
  `;
  return organizations[0] ?? null;
}

/**
 * `users` n'est pas sous RLS et `openedbot_api` y porte un grant de table entière
 * depuis 0001 : l'adresse se lit sous la porte déjà ouverte.
 */
export async function readUserEmail(tx: TransactionDb, userId: string): Promise<string | null> {
  const users = await tx<Array<{ email: string }>>`
    select email from users where id = ${userId} limit 1
  `;
  return users[0]?.email ?? null;
}

/** La méthode de connexion d'un compte, pour l'écran « Sécurité du compte ». */
export type AccountSecurityRow = {
  email: string;
  hasPassword: boolean;
  hasGoogle: boolean;
  mustChangePassword: boolean;
};

export async function readAccountSecurity(db: Db, userId: string): Promise<AccountSecurityRow | null> {
  const users = await db<AccountSecurityRow[]>`
    select email, (password_hash is not null) as "hasPassword", (google_subject is not null) as "hasGoogle",
           must_change_password as "mustChangePassword"
      from users where id = ${userId}
  `;
  return users[0] ?? null;
}

/** Ce que la liaison et la déliaison Google lisent d'un compte. */
export type GoogleLinkRow = {
  email: string;
  googleSubject: string | null;
  passwordHash: string | null;
};

export async function readGoogleLink(db: Db, userId: string): Promise<GoogleLinkRow | null> {
  const users = await db<GoogleLinkRow[]>`
    select email, google_subject as "googleSubject", password_hash as "passwordHash"
      from users where id = ${userId}
  `;
  return users[0] ?? null;
}

/** L'utilisateur qui porte déjà ce `sub` Google, s'il y en a un. */
export async function findUserIdByGoogleSubject(db: Db, subject: string): Promise<string | null> {
  const users = await db<Array<{ id: string }>>`
    select id from users where google_subject = ${subject} limit 1
  `;
  return users[0]?.id ?? null;
}

/**
 * Pose le lien et efface la déliaison passée : seule une liaison explicite
 * rouvre l'entrée Google par adresse. Rend `false` si un autre compte a pris
 * ce `sub` entre la lecture et l'écriture (contrainte `unique`).
 */
export async function writeGoogleSubject(db: Db, userId: string, subject: string): Promise<boolean> {
  try {
    await db`
      update users set google_subject = ${subject}, google_unlinked_at = null, updated_at = now()
       where id = ${userId}
    `;
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/**
 * Une seule transaction, comme le changement de mot de passe : le lien tombe,
 * la déliaison est datée (l'auto-liaison par adresse se ferme) et les autres
 * sessions sont révoquées. Rend leur nombre.
 */
export async function clearGoogleSubjectRevokingOtherSessions(
  db: Db,
  userId: string,
  currentSessionId: string,
): Promise<number> {
  const revoked = await withAuthenticatingUser(db, userId, async (tx) => {
    await lockUserSessions(tx, userId);
    await tx`
      update users set google_subject = null, google_unlinked_at = now(), updated_at = now()
       where id = ${userId}
    `;
    return tx<Array<{ id: string }>>`
      update sessions set revoked_at = now(), revoked_reason = 'google_unlink'
       where user_id = ${userId} and id <> ${currentSessionId} and revoked_at is null
      returning id
    `;
  });
  return revoked.length;
}

export async function readPasswordHash(db: Db, userId: string): Promise<string | null> {
  const users = await db<Array<{ passwordHash: string | null }>>`
    select password_hash as "passwordHash" from users where id = ${userId}
  `;
  return users[0]?.passwordHash ?? null;
}

/**
 * Une seule transaction : le changement de mot de passe et la révocation
 * des autres sessions sont un seul geste, jamais l'un sans l'autre. Le drapeau
 * du mot de passe temporaire tombe AVEC le nouveau hachage, jamais séparément :
 * c'est ce même geste qui rend l'application à une personne dont le compte a
 * été créé par l'équipe. Rend le nombre de sessions révoquées.
 */
export async function replacePasswordRevokingOtherSessions(
  db: Db,
  userId: string,
  passwordHash: string,
  currentSessionId: string,
): Promise<number> {
  const revoked = await withAuthenticatingUser(db, userId, async (tx) => {
    await lockUserSessions(tx, userId);
    await tx`
      update users set password_hash = ${passwordHash}, must_change_password = false, updated_at = now()
       where id = ${userId}
    `;
    return tx<Array<{ id: string }>>`
      update sessions set revoked_at = now(), revoked_reason = 'password_change'
       where user_id = ${userId} and id <> ${currentSessionId} and revoked_at is null
      returning id
    `;
  });
  return revoked.length;
}
