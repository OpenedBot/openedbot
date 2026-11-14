/**
 * How a direct gateway was published.
 *
 * - `managed_cloudflare`: tunnel, DNS and Access created on openedbot's
 *   Cloudflare account, hostname under the managed suffix (`<slug>.rt.openedbot.app`).
 * - `tailscale_funnel`: `funnel` attribute and pairing key set on the
 *   client's tailnet; the hostname is the machine's MagicDNS name.
 *
 * The two paths that required a Cloudflare domain at the client (assisted
 * flow on their account, and manual guide) have been removed: they
 * required a prerequisite the openedbot link does not have.
 */
export type RuntimeExposureKind = "managed_cloudflare" | "tailscale_funnel";

/**
 * What the database can carry, historical publications included.
 *
 * `customer_cloudflare` is no longer produced by the API but stays written on the
 * rows created before its removal: they stay readable, revocable, and
 * displayed under a « retiré » label.
 */
export type RuntimeExposureStoredKind = RuntimeExposureKind | "customer_cloudflare";

/**
 * `awaiting_install`: the command to paste has not yet been run on the host.
 * `reachable`: the tunnel is Healthy at Cloudflare, or the Funnel hostname answers.
 * `declared`: the `runtimes` row exists and carries the access.
 */
export type RuntimeExposureStatus = "awaiting_install" | "reachable" | "declared" | "failed" | "revoked";

export type RuntimeExposureCreateInput =
  /** Without `slug`, openedbot itself picks `openedbot-<hex>` on its managed zone. */
  | { kind: "managed_cloudflare"; slug?: string }
  /** The tailnet's OAuth client, for the duration of one request, never stored. */
  | { kind: "tailscale_funnel"; slug: string; oauthClientId: string; oauthClientSecret: string };

/** No secret: neither an install token, nor a service token, nor an API token. */
export type RuntimeExposureDto = {
  id: string;
  kind: RuntimeExposureStoredKind;
  status: RuntimeExposureStatus;
  hostname: string;
  /** The gateway's HTTPS URL as `runtimes.endpoint` will carry it. */
  endpoint: string;
  runtimeId: string | null;
  /** Access Service Auth set (Cloudflare); always false for Funnel. */
  edgeAuthProvisioned: boolean;
  /** `healthy | down | inactive` at Cloudflare; `reachable | unreachable` for Funnel; `null` before the first read. */
  lastTunnelStatus: string | null;
  lastCheckedAt: string | null;
  errorCode: string | null;
  createdAt: string;
};

/**
 * Creation response: the DTO plus THE command to run on the host, returned
 * once (it carries the install token for Cloudflare). The
 * steps around it (install the package, check the service) belong to
 * the screen, with no secret.
 */
export type RuntimeExposureCreatedDto = {
  exposure: RuntimeExposureDto;
  installCommand: string;
};

/**
 * The organization's publications that do not yet have a runtime: those
 * a dialog closed too early would leave invisible even though they hold
 * a tunnel, a DNS and an Access application at the provider.
 */
export type RuntimeExposureListDto = { exposures: RuntimeExposureDto[] };

/**
 * `cloudflareCleanup: "manual"`: the publication is revoked at openedbot but what
 * it created at the provider stays in place, for lack of credentials to
 * remove it. `"none"`: there was nothing to remove.
 */
export type RuntimeExposureRevokedDto = { ok: true; cloudflareCleanup: "done" | "manual" | "none" };

/** Body of `POST /api/runtime/exposures/:id/declare`: name and bearer; Access comes from the exposure. */
export type RuntimeExposureDeclareInput = { name: string; token: string };
