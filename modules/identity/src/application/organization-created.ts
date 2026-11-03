/**
 * The one place the core announces a new organization, after the transaction
 * that created it has committed. Every creation path of `identity` ends here
 * (`createOrganization`, the agency client consent); a contract test fails if
 * a new insert of an organization row appears without it.
 *
 * - Idempotent: an organization is announced at most once per process, so a
 *   retried path or a double call does not run the listener twice. Listeners
 *   must still tolerate a repeat (another instance, a restart).
 * - Never breaks the creation: the organization is already committed; a
 *   listener that throws, rejects or hangs past `timeoutMs` is logged and
 *   ignored, and the caller gets its result as if nothing was listening.
 */
import { logger } from "@openedbot/platform-observability";

export type OrganizationCreatedListener = (organizationId: string) => Promise<void> | void;

const ANNOUNCED_LIMIT = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;

let listener: OrganizationCreatedListener | null = null;
let timeoutMs = DEFAULT_TIMEOUT_MS;
const announced = new Set<string>();

/** Installed once by the API composition root; `null` uninstalls (tests). */
export function installOrganizationCreatedListener(next: OrganizationCreatedListener | null, options: { timeoutMs?: number } = {}): void {
  listener = next;
  timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  announced.clear();
}

export async function announceOrganizationCreated(organizationId: string): Promise<void> {
  const current = listener;
  if (!current || announced.has(organizationId)) return;
  announced.add(organizationId);
  if (announced.size > ANNOUNCED_LIMIT) announced.delete(announced.values().next().value as string);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => current(organizationId)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
  } catch (error) {
    logger.warn(
      { event: "identity.organization_created_listener_failed", organizationId, error: error instanceof Error ? error.message : String(error) },
      "organization created listener failed",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
