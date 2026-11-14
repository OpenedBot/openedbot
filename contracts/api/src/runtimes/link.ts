import type { RuntimeConnectorDto, RuntimeHermesUpdateDto } from "./connector";

export type RuntimeLinkDto = {
  /** Identity of the declared connector; null before the first agent declaration. */
  connector?: RuntimeConnectorDto | null;
  /** The host's Hermes against the latest edge-setup release; absent from older servers. */
  hermesUpdate?: RuntimeHermesUpdateDto | null;
  /** A link WebSocket is open right now (as recorded; see `live`). */
  connected: boolean;
  /**
   * Rework-flux-api step 5d: the link is effectively alive. Open, a sign of
   * life within 45 s, and held by an API instance that beat within 60 s and
   * was not replaced at its address. Only `GET /api/runtime` sets it;
   * absent, read `connected`.
   */
  live?: boolean;
  /**
   * Until when `live` holds without any news, ISO; `null` when not live.
   * Past it, a silent death would have been pushed (`runtime.changed`) by the
   * worker's sweep: a client that heard nothing rereads, and until it has
   * read, the state is unknown, not good.
   */
  validUntil?: string | null;
  /** Lease of the current connection (decimal integer); changes on every reconnect. `null` with no link. */
  generation?: string | null;
  /** Opening of the current connection, ISO; `null` with no link. */
  connectedAt?: string | null;
  /** Last sign of life of the link, ISO; `null` until it has ever presented itself. */
  lastSeenAt: string | null;
  /** Last replacement of the connection by a newer one (link journal), ISO. */
  lastReplacedAt: string | null;
  /**
   * Last suspect replacement: from another address, or three
   * replacements in ten minutes. The screen shows it in a banner and offers to
   * rotate the token.
   */
  hijackSuspectedAt: string | null;
  /** Last rotation of the link token, ISO; `null` if never rotated. */
  rotatedAt: string | null;
  /**
   * HTTPS origin (loopback HTTP in dev) signed at the last proof.
   * `null` until a proof has been recorded (0110).
   */
  origin: string | null;
  /** This origin is no longer among those this deployment accepts. */
  originRetired: boolean;
  /**
   * `edge-setup link --openedbot <origine actuelle> --yes`, only when
   * `originRetired`: without a ticket, the command alone is not enough.
   */
  relinkCommand: string | null;
};

/**
 * `POST /api/runtime/:id/link/verify`: native WebSocket ping of the link, then a probe
 * of the gateway if the link answers.
 *
 * - `alive`: pong received (`rttMs`), or a frame received without a pong (`rttMs: null`);
 *   `gateway` says whether Hermes answers behind it.
 * - `reconnect_requested`: nothing received, openedbot hung up (4005); the host redials.
 *   Wait for a `link.generation` different from `generation`, then verify again.
 * - `generation_changed`: the host has already reconnected; verify again.
 * - `indeterminate`: ping not sent (saturated link).
 * - `no_link` / `owner_unavailable`: openedbot cannot reach the host.
 */
type RuntimeLinkVerifyOutcome =
  | "alive"
  | "reconnect_requested"
  | "generation_changed"
  | "indeterminate"
  | "no_link"
  | "owner_unavailable";

export type RuntimeLinkVerifyDto = {
  runtimeId: string;
  outcome: RuntimeLinkVerifyOutcome;
  /** The lease probed; `null` with no link. */
  generation: string | null;
  rttMs: number | null;
  /** Gateway probe, only when the link answers. */
  gateway: { ok: true } | { ok: false; code: string; message: string } | null;
  /** Last known sign of life and last error written, to say since when. */
  lastSeenAt: string | null;
  lastHealthError: string | null;
};

type RuntimeLinkEventKind ="connected" | "replaced" | "disconnected" | "revoked" | "rotated" | "device_key_registered" | "hijack_suspected" | "agent_outdated";

type RuntimeLinkEventMetadata = {
  minimum?: string;
  instanceId?: string | null;
  generation?: string | null;
  closeCode?: number;
  closeReason?: string;
  ownershipCurrent?: boolean | null;
};

type RuntimeLinkEventDto = {
  id: string;
  kind: RuntimeLinkEventKind;
  ip: string | null;
  agent: string | null;
  previousIp: string | null;
  occurredAt: string | null;
  meta?: RuntimeLinkEventMetadata;
};

export type RuntimeLinkEventsDto = { events: RuntimeLinkEventDto[] };

/**
 * `maintenance`: a ten-minute grace for the old token, new token pushed
 * on the open link. `emergency`: no grace, no push (the open
 * connection may be a hijacker's), link closed 4401: the token is set
 * by hand on the host.
 */
export type RuntimeLinkRotationMode = "maintenance" | "emergency";

/** Response of `POST /api/runtime/:runtimeId/link/rotate`: the token is returned only here, once. */
export type RuntimeLinkRotationDto = {
  linkToken: string;
  runtimeId: string;
  mode: RuntimeLinkRotationMode;
  /** The new token went out as `link.rotate` on the open link (never in `emergency`). */
  pushed: boolean;
  /** End of the old token's grace, ISO; `null` in `emergency`. */
  expiresPreviousAt: string | null;
};
