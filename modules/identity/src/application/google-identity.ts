import { HttpError } from "@openedbot/contracts-errors/http-error";
import type { Db } from "@openedbot/platform-db";
import { resolveVerifiedIdentity } from "./verified-identity";
import type { GoogleIdentity } from "./google-auth";

/**
 * Une identité Google vérifiée devient un opérateur, par l'un de deux chemins
 * et jamais par une impasse :
 * 1. il est déjà membre : on le laisse entrer là où il travaille ;
 * 2. personne ne l'attend : son compte naît ici SANS organisation
 *    (`organizationId: null`), et l'application l'emmène sur « Définir votre
 *    organisation » (Personnel ou Agence). Ce second chemin est le seul qui
 *    ouvre un compte neuf. Tant que `product_features.waitlist` est allumée,
 *    sans validation de l'équipe il sort en `AUTH_EMAIL_NOT_ALLOWED` avant
 *    toute écriture. Éteinte, il naît en `classic`.
 */
export async function resolveGoogleIdentity(
  db: Db,
  identity: GoogleIdentity,
  options: { waitlistRequired?: boolean } = {},
): Promise<{
  userId: string;
  organizationId: string | null;
  user: { email: string; displayName: string | null };
}> {
  const users = await db<Array<{
    id: string;
    email: string;
    displayName: string | null;
    linkedBySubject: boolean;
    googleUnlinked: boolean;
  }>>`
    select id, email, display_name as "displayName",
           coalesce(google_subject = ${identity.subject}, false) as "linkedBySubject",
           (google_unlinked_at is not null) as "googleUnlinked"
      from users
     where google_subject = ${identity.subject} or lower(email) = ${identity.email}
     order by google_subject is not null desc limit 1
  `;
  const user = users[0] ?? null;
  // Google délié depuis « Mon compte » : l'adresse seule ne rouvre plus la
  // porte, sinon ce SSO déferait la déliaison en silence. Seule une liaison
  // explicite (`google-link.ts`) efface `google_unlinked_at`.
  if (user && !user.linkedBySubject && user.googleUnlinked) {
    throw new HttpError(
      403,
      "AUTH_GOOGLE_UNLINKED",
      "Google a été délié de ce compte : connectez-vous par mot de passe, puis reliez-le depuis « Mon compte ».",
    );
  }
  if (user) {
    await db`update users set google_subject = ${identity.subject}, display_name = coalesce(${identity.displayName}, display_name), updated_at = now() where id = ${user.id}`;
  }
  return resolveVerifiedIdentity(db, identity, user ? { ...user, displayName: identity.displayName ?? user.displayName } : null, options.waitlistRequired !== false);
}
