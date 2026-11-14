/**
 * The API's listen port and its internal origin, in one place.
 *
 * The API, the worker and the connector-link relay all have to agree on where
 * this deployment's internal routes live. Writing `http://127.0.0.1:8790` in
 * each of them let `API_PORT=9000` move the API while the worker kept calling
 * the old port: a silent break, since nothing reads the two together. Here
 * the origin is *derived* from the port, so one value moves them all.
 *
 * The host stays loopback and is deliberately not derived from `API_HOST`:
 * `API_HOST` is a listen address and may be `0.0.0.0`, which is not dialable.
 */

const DEFAULT_API_PORT = 8790;

/** Loopback host of the internal routes; never the listen address. */
const INTERNAL_API_HOST = "127.0.0.1";

export function readApiPort(value: string | undefined, variableName = "API_PORT"): number {
  if (!value?.trim()) return DEFAULT_API_PORT;
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${variableName} is invalid.`);
  return port;
}

/** `API_INTERNAL_URL` when set, otherwise the loopback origin of `API_PORT`. */
export function readApiInternalUrl(
  internalUrl: string | undefined,
  apiPort: string | undefined,
): string {
  const explicit = internalUrl?.trim();
  if (explicit) return explicit.replace(/\/+$/u, "");
  return `http://${INTERNAL_API_HOST}:${readApiPort(apiPort)}`;
}
