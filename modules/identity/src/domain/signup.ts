import type { AuthFailureCode } from "@openedbot/contracts-api";
import { HttpError } from "@openedbot/contracts-errors/http-error";

/**
 * Ce qu'il faut décider AVANT de toucher la base quand un compte Google
 * inconnu se présente : sous quel nom son espace naît, sous quel `slug`, et
 * si rien de tout cela n'aboutit, sous quel nom l'échec revient à l'écran.
 *
 * Tout est pur : le SQL vit dans `auth.ts`, ces règles se testent sans Postgres.
 */

const SLUG_MAX = 40;
/** Les codes qu'un client d'authentification sait déjà nommer à l'écran. */
const NAMED_FAILURES = new Set<AuthFailureCode>([
  "AUTH_ATTEMPT_UNKNOWN",
  "AUTH_STATE_INVALID",
  "AUTH_DENIED",
  "AUTH_EXCHANGE_FAILED",
  "AUTH_TOKEN_INVALID",
  "AUTH_EMAIL_NOT_VERIFIED",
  "AUTH_EMAIL_NOT_ALLOWED",
  "AUTH_NOT_A_MEMBER",
  "AUTH_SIGNUP_FAILED",
  "AUTH_GOOGLE_UNLINKED",
  "GOOGLE_EMAIL_MISMATCH",
  "GOOGLE_ALREADY_LINKED",
]);

/** `Camille Lefèvre` → `camille-lefevre` ; à défaut, la partie locale de l'e-mail. */
export function organizationSlugBase(email: string, displayName: string | null): string {
  return kebab(displayName ?? "") || kebab(localPart(email)) || "espace";
}

const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Le `slug` est unique en base : la deuxième tentative porte un suffixe. Il est
 * aussi le segment d'URL de l'espace (`/o/<slug>/`), donc jamais en forme d'UUID
 * (contrainte `organizations_slug_url_segment`, 0085).
 */
export function organizationSlugCandidate(base: string, suffix: string | null): string {
  const kebabbed = kebab(base);
  const safe = kebabbed && !ORGANIZATION_ID.test(kebabbed) ? kebabbed : "espace";
  if (!suffix) return safe.slice(0, SLUG_MAX);
  const tail = kebab(suffix);
  return `${safe.slice(0, SLUG_MAX - tail.length - 1)}-${tail}`;
}

/** Le nom affiché de l'espace, que l'opérateur renommera à l'onboarding. */
export function defaultOrganizationName(email: string, displayName: string | null): string {
  const named = displayName?.trim();
  return named && named.length > 0 ? named.slice(0, 80) : localPart(email).slice(0, 80);
}

/**
 * Un refus doit revenir DANS l'application avec son nom. Les erreurs métier
 * déjà nommées passent telles quelles ; tout le reste, panne SQL ou bug, sort
 * sous `AUTH_SIGNUP_FAILED` plutôt que sous une page JSON à l'origine de l'API.
 */
export function authFailureCode(error: unknown): AuthFailureCode {
  if (error instanceof HttpError && NAMED_FAILURES.has(error.code as AuthFailureCode)) {
    return error.code as AuthFailureCode;
  }
  return "AUTH_SIGNUP_FAILED";
}

function localPart(email: string): string {
  return email.split("@")[0] ?? "";
}

function kebab(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
}
