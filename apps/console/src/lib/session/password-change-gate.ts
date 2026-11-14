/**
 * The temporary password of an account set up by the team, and the only thing
 * that makes it truly temporary.
 *
 * An account opened for someone (by an operator tool outside the core) is
 * born with `users.must_change_password`.
 * As long as that flag is raised, the application opens only one address, the one where
 * the password is chosen: without this guard, « temporaire » would be only a
 * word in an email.
 *
 * That address is a screen OF ITS OWN (`/change-password`), not the
 * « Sécurité » section of settings. A very first sign-in does not have to cross
 * an administration screen, with its sessions and its sidebar, to
 * find the only field that lets it in. `/settings/security` keeps its
 * form for every other day.
 *
 * `GET /api/auth/me` carries the fact (`AuthStatus.mustChangePassword`), read on
 * every navigation by the route guard. An absent session or a cloud API
 * that does not answer locks nobody in: what has not been asserted does not
 * redirect.
 */
import { isAppAuthenticated, type AuthStatus } from "./auth-status";

export const PASSWORD_CHANGE_PATH = "/change-password";

export function needsPasswordChange(status: AuthStatus, pathname: string): boolean {
  if (!isAppAuthenticated(status)) return false;
  if (!status.mustChangePassword) return false;
  // The destination does not redirect to itself: the guard would loop
  // on the screen that is precisely what lowers the flag. Sign-out lives there
  // too: nobody stays trapped.
  return pathname !== PASSWORD_CHANGE_PATH;
}
