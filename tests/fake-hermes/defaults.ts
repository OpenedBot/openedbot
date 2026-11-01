/**
 * The fake gateway's address and bearer, in one place.
 *
 * Four callers have to agree on them: the server itself, `scripts/setup.sh`
 * (which writes DEV_HERMES_URL / DEV_HERMES_TOKEN / HERMES_ALLOW_INSECURE_ORIGINS
 * for the `fake` profile), the Makefile (whose FAKE_HERMES_URL decides whether
 * an existing .env.local *is* the fake profile) and `make fake-hermes`.
 *
 * Shell and Make cannot import this module without paying a Bun start on every
 * invocation, so they keep their own literal and
 * `tests/scripts/fake-hermes-contract.sh` fails when the copies drift.
 */

export const FAKE_HERMES_HOST = "127.0.0.1";
export const FAKE_HERMES_PORT = 18642;
export const FAKE_HERMES_TOKEN = "fake-hermes-token";

/** `host:port`, the form HERMES_ALLOW_INSECURE_ORIGINS expects. */
export const FAKE_HERMES_ORIGIN = `${FAKE_HERMES_HOST}:${FAKE_HERMES_PORT}`;

/** The origin DEV_HERMES_URL points at under the `fake` profile. */
export const FAKE_HERMES_URL = `http://${FAKE_HERMES_ORIGIN}`;

/** Run pacing and concurrency of the stand-in; not part of the address contract. */
export const FAKE_HERMES_DELAY_MS = 40;
export const FAKE_HERMES_CAPACITY = 4;
