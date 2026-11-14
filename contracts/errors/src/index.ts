/**
 * Public error codes: the values written in `error_code` (runs,
 * workflows, routine executions) or in a `run.error`, and reread by the
 * clients. No domain error type exists yet: only the
 * constants live here, their messages stay with their emitters.
 */

/** Run replaced by a burst of messages (`followup.ts`). */
export const FOLLOWUP_SUPERSEDE_CODE = "SUPERSEDED_BY_FOLLOWUP";

/** No authenticated inference provider on the runtime (`hermes-events.ts`). */
export const NO_USABLE_PROVIDER_CODE = "HERMES_NO_USABLE_PROVIDER";

/**
 * The provider refuses the model during a turn (« Model is unavailable »,
 * « does not exist or you do not have access »). Stable code for the console:
 * the upstream text changes with the provider and the Hermes version
 * (`provider-failure.ts`, set by `hermes-events.ts` and `runner/failure.ts`).
 */
export const MODEL_UNAVAILABLE_CODE = "MODEL_UNAVAILABLE";

/**
 * The provider chosen for the bot refused its authentication during a run
 * (expired or revoked login). The run is never re-routed to another
 * provider for this: the `run.error` payload names `provider`, the one to
 * reconnect in Settings > Models (`provider-recovery.ts`).
 */
export const PROVIDER_AUTH_REQUIRED_CODE = "PROVIDER_AUTH_REQUIRED";

/** The Hermes runtime interrupted the run (`hermes-events.ts`). */
export const HERMES_RUN_FAILURE_CODE = "HERMES_RUN_FAILED";

/** The Hermes gateway interrupted a run, usually during a gateway restart. */
export const HERMES_RUN_INTERRUPTED_CODE = "HERMES_RUN_INTERRUPTED";

/**
 * openedbot stopped the run itself: Hermes had not answered since
 * `WORKER_RUN_INACTIVITY_MS` (and was not saying it was alive), or the run
 * exceeded `WORKER_RUN_TIMEOUT_MS`. Without these names, the stop read as
 * « Run Hermes annulé », as if someone had cancelled it (`runner.ts`).
 */
export const RUN_INACTIVITY_STOP_CODE = "RUN_INACTIVITY_TIMEOUT";
export const RUN_TIMEOUT_STOP_CODE = "RUN_TIMEOUT";

/** Named codes visible in the history (and, for abandonment, as run.error). */
export const ROUTINE_ERROR_BUSY_RETRIES_EXHAUSTED = "ROUTINE_BUSY_RETRIES_EXHAUSTED";
export const ROUTINE_ERROR_GROUP_EMPTY = "GROUP_EMPTY";
/** The worker threw while firing an occurrence: deferred, then abandoned after repeated failures. */
export const ROUTINE_ERROR_FIRE_FAILED = "ROUTINE_FIRE_FAILED";

/** Orphaned approval: lease expired, then attempt ceiling reached (worker, `queue.ts`). */
export const APPROVAL_LEASE_EXPIRED_CODE = "APPROVAL_LEASE_EXPIRED";
export const APPROVAL_MAX_ATTEMPTS_CODE = "APPROVAL_ORPHANED_MAX_ATTEMPTS";
