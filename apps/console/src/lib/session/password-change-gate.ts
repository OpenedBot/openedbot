/**
 * Le mot de passe temporaire d'un compte monté par l'équipe, et la seule chose
 * qui le rend vraiment temporaire.
 *
 * Un compte ouvert depuis le backoffice (`POST /api/pro/staff/users`, ou une
 * ouverture d'accès en liste d'attente) naît avec `users.must_change_password`.
 * Tant que ce drapeau est levé, l'application n'ouvre qu'une adresse, celle où
 * l'on choisit son mot de passe : sans ce garde, « temporaire » ne serait qu'un
 * mot dans un e-mail.
 *
 * Cette adresse est un écran À PART (`/change-password`), pas la rubrique
 * « Sécurité » des réglages. Une toute première connexion n'a pas à traverser
 * un écran d'administration, avec ses sessions et sa barre latérale, pour
 * trouver le seul champ qui la laisse entrer. `/settings/security` garde son
 * formulaire pour tous les autres jours.
 *
 * `GET /api/auth/me` porte le fait (`AuthStatus.mustChangePassword`), lu à
 * chaque navigation par le garde de route. Une session absente ou un cloud API
 * qui ne répond pas n'enferment personne : ce qui n'a pas été affirmé ne
 * redirige pas.
 */
import { isAppAuthenticated, type AuthStatus } from "./auth-status";

export const PASSWORD_CHANGE_PATH = "/change-password";

export function needsPasswordChange(status: AuthStatus, pathname: string): boolean {
  if (!isAppAuthenticated(status)) return false;
  if (!status.mustChangePassword) return false;
  // La destination ne se redirige pas vers elle-même : le garde tournerait en
  // boucle sur l'écran qui baisse justement le drapeau. La déconnexion y vit
  // aussi : personne n'y reste prisonnier.
  return pathname !== PASSWORD_CHANGE_PATH;
}
