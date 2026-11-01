/**
 * Codes d'erreur publics : les valeurs écrites dans `error_code` (runs,
 * workflows, exécutions de routine) ou dans un `run.error`, et relues par les
 * clients. Aucun type d'erreur de domaine n'existe encore : seules les
 * constantes vivent ici, leurs messages restent chez leurs émetteurs.
 */

/** Run remplacé par une rafale de messages (`followup.ts`). */
export const FOLLOWUP_SUPERSEDE_CODE = "SUPERSEDED_BY_FOLLOWUP";

/** Aucun fournisseur d'inférence authentifié sur le runtime (`hermes-events.ts`). */
export const NO_USABLE_PROVIDER_CODE = "HERMES_NO_USABLE_PROVIDER";

/**
 * Le fournisseur refuse le modèle pendant un tour (« Model is unavailable »,
 * « does not exist or you do not have access »). Code stable pour la console :
 * le texte amont change selon le fournisseur et la version d'Hermes
 * (`provider-failure.ts`, posé par `hermes-events.ts` et `runner/failure.ts`).
 */
export const MODEL_UNAVAILABLE_CODE = "MODEL_UNAVAILABLE";

/**
 * The provider chosen for the bot refused its authentication during a run
 * (expired or revoked login). The run is never re-routed to another
 * provider for this: the `run.error` payload names `provider`, the one to
 * reconnect in Settings > Models (`provider-recovery.ts`).
 */
export const PROVIDER_AUTH_REQUIRED_CODE = "PROVIDER_AUTH_REQUIRED";

/** Le runtime Hermes a interrompu le run (`hermes-events.ts`). */
export const HERMES_RUN_FAILURE_CODE = "HERMES_RUN_FAILED";

/** The Hermes gateway interrupted a run, usually during a gateway restart. */
export const HERMES_RUN_INTERRUPTED_CODE = "HERMES_RUN_INTERRUPTED";

/** Codes nommés visibles dans l'historique (et, pour l'abandon, comme run.error). */
export const ROUTINE_ERROR_BUSY_RETRIES_EXHAUSTED = "ROUTINE_BUSY_RETRIES_EXHAUSTED";
export const ROUTINE_ERROR_GROUP_EMPTY = "GROUP_EMPTY";

/** Approbation orpheline : bail expiré, puis plafond de tentatives atteint (worker, `queue.ts`). */
export const APPROVAL_LEASE_EXPIRED_CODE = "APPROVAL_LEASE_EXPIRED";
export const APPROVAL_MAX_ATTEMPTS_CODE = "APPROVAL_ORPHANED_MAX_ATTEMPTS";
