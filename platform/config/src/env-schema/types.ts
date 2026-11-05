import type { RuntimeMode } from "@openedbot/contracts-api";
import type { RuntimeEnvironment } from "../runtime-mode";

/**
 * The workspace a variable belongs to, which is how the templates are
 * sectioned. It is the workspace the variable *configures*, not always the
 * process that reads it: `WEB_APP_URL` and `ADMIN_PUBLIC_URL` describe the two
 * clients but are read by the API, and each `doc` says so. In a monorepo, a
 * developer looks for "the web variables", not for "what apps/api/src reads".
 */
export type EnvScope = "shared" | "api" | "worker" | "web" | "admin" | "scripts";

/**
 * Where a variable belongs.
 *
 *   - `local`: listed in `.env.example`; a developer copies it as is.
 *   - `production`: deployment-owned, printed by `make env-prod-list` and
 *     stored in a secret manager, never in this repository. `env-audit` keeps
 *     it in `.env.local` only when non-empty.
 *   - `default_only`: has a code default and belongs in no template. Same
 *     `env-audit` rule as `production`: kept only when non-empty.
 *
 * Un nom qui n'est plus lu du tout ne prend PAS de palier : il quitte le
 * schéma et rejoint `DEPRECATED_ENV_NAMES`, qui le fait retirer d'un
 * `.env.local` ancien sans lui garder une entrée complète ici.
 */
export type EnvTier = "local" | "production" | "default_only";

export type EnvRequiredWhen = {
  environment?: RuntimeEnvironment[];
  runtimeMode?: RuntimeMode[];
};

export type EnvVar = {
  name: string;
  scope: EnvScope;
  tier: EnvTier;
  /**
   * When `env-check` demands a non-empty value. Both dimensions must match
   * when listed; an absent dimension matches everything. A `runtimeMode`
   * constraint also tells `env-audit` that the variable is unused : and
   * removable whatever its value : in the other mode.
   */
  requiredWhen?: EnvRequiredWhen;
  /**
   * Runtime modes in which the variable is read at all, for a variable that
   * is mode-specific without being required (defaults to
   * `requiredWhen.runtimeMode`). `env-audit` removes it, whatever its value,
   * in any other mode.
   */
  runtimeModes?: RuntimeMode[];
  /** One line, written as the comment above the variable in the templates. */
  doc: string;
  /** Value written in the template of the variable's tier (empty when absent). */
  example?: string;
  /**
   * Value printed in the production template for a variable whose tier is not
   * `production` (it is listed there only when this is defined).
   */
  productionExample?: string;
  secret?: boolean;
};

/** Development database URLs, the examples of API_DATABASE_URL and WORKER_DATABASE_URL. */
export const DEVELOPMENT_DATABASE_URL_API = "postgres://openedbot_api:openedbot_api_dev@127.0.0.1:5432/openedbot";
export const DEVELOPMENT_DATABASE_URL_WORKER = "postgres://openedbot_worker:openedbot_worker_dev@127.0.0.1:5432/openedbot";
