/**
 * A runtime's pairing ticket, opened from the application.
 *
 * It carries no bearer: the script is what reads the gateway's on
 * the host, then pushes it. `scriptSha256` is the fingerprint of the script actually
 * served by this API, so the operator can compare it before
 * running it.
 */
export type RuntimeEnrollmentTicketDto = {
  enrollmentId: string;
  reachability: "connector";
  /** Always `null`: no gateway URL exists on the cloud side. */
  endpoint: null;
  runtimeName: string;
  /** Organization namespace used to resume a dedicated local link. */
  workspaceId?: string;
  /** `<enrollmentId>.<secret>`, single use and expired with `expiresAt`. */
  ticket: string;
  /** The ticket is entered at the masked prompt, never placed in argv. */
  command: string;
  expiresAt: string;
};

/** The state of an enrollment opened here; it is what the screen polls while waiting for the host. */
export type RuntimeEnrollmentStatusDto = {
  enrollmentId: string;
  reachability: "connector";
  state: "pending" | "claimed" | "completed" | "expired";
  runtimeId: string | null;
  /** Machine ticket: the local engines (`local:*`) already paired with it. */
  engines: string[];
  expiresAt: string;
};
