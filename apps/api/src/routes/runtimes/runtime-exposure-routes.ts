import { Hono } from "hono";
import { CloudflareApiError } from "@openedbot/platform-integrations/cloudflare-api";
import { TailscaleApiError, type TailscaleCredentials } from "@openedbot/platform-integrations/tailscale-api";
import type {
  RuntimeExposureCreatedDto,
  RuntimeExposureKind,
  RuntimeExposureListDto,
  RuntimeExposureRevokedDto,
  RuntimeProbeDiagnosticCode,
} from "@openedbot/contracts-api";
import type { ManagedTunnelConfig } from "@openedbot/platform-integrations/managed-tunnel";
import type { ApiConfig } from "../../infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { withTenant } from "@openedbot/platform-db";
import { decryptSecretFromKeyring, encryptSecret } from "../../infrastructure/crypto";
import type { HermesClientConfig } from "@openedbot/hermes";
import { runtimeAdminClient } from "@openedbot/runtimes/application/runtime-admin-client";
import {
  publicExposure,
  readExposureById,
  readPendingExposures,
  type RuntimeExposureRow,
} from "@openedbot/runtimes/application/runtime-exposures";
import {
  defaultCloudflareClientFactory,
  defaultTailscaleClientFactory,
  cleanupRevokedExposure,
  markExposureRevoked,
  type CloudflareClientFactory,
  type TailscaleClientFactory,
} from "@openedbot/runtimes/application/direct-exposure-lifecycle";
import { deprovisionDirectExposure, provisionDirectExposure } from "@openedbot/runtimes/application/direct-exposure-provisioning";
import {
  deprovisionTailscaleExposure,
  provisionTailscaleExposure,
  tailscaleInstallCommand,
} from "@openedbot/runtimes/application/tailscale-exposure-provisioning";
import type { AppVariables } from "../identity/auth";
import { requireRole } from "../identity/auth";
import { assertString, HttpError, jsonBody } from "../../interfaces/http/http-error";
import { directConfig } from "@openedbot/runtimes/application/runtime-access";
import { assertSubscriptionAllowsRuntime } from "./runtime-subscription";
import { assertNoPendingReplacement } from "./runtime-replacement";
import {
  directProbeResult,
  insertRuntime,
  prepareDirectAccess,
  probeDirectCapacityWith,
  linkPublication,
  publicRuntimeWithBots,
  readAllRuntimeRows,
  type RuntimeProbeClient,
} from "./runtime-routes";

export type RuntimeExposureRouteDeps = {
  /** Hermes probe of the published hostname; a fake in tests. */
  clientFactory?: (clientConfig: HermesClientConfig) => RuntimeProbeClient;
  /** Cloudflare API client for a given token; a fake in tests. */
  cloudflareFactory?: CloudflareClientFactory;
  /** Tailscale API client for a given OAuth client; a fake in tests. */
  tailscaleFactory?: TailscaleClientFactory;
  now?: () => Date;
};

const SLUG = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/;
/** Successive draws before giving up on a free managed subdomain. */
const MANAGED_SLUG_ATTEMPTS = 5;
/** Two reads of the same hostname spaced by less than this return the cached state. */
export const EXPOSURE_CHECK_CACHE_MS = 10_000;

/**
 * Lifecycle of a direct-gateway publication.
 *
 * Create provisions the hostname at the provider (managed tunnel on openedbot's
 * Cloudflare account, or Funnel on the client's tailnet) and returns the command to
 * run on the host; read probes the hostname and says whether it answers; declare creates
 * the `runtimes` row with the bearer; revoke removes what can be removed. openedbot
 * never touches the host: the only command is copied by the operator,
 * as at pairing.
 *
 * The two paths that required a Cloudflare domain at the client have been
 * removed; their publications stay readable and revocable.
 */
export function runtimeExposureRoutes(db: Db, config: ApiConfig, deps: RuntimeExposureRouteDeps = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const createClient = deps.clientFactory ?? runtimeAdminClient;
  const cloudflare = deps.cloudflareFactory ?? defaultCloudflareClientFactory;
  const tailscale = deps.tailscaleFactory ?? defaultTailscaleClientFactory;
  const now = deps.now ?? (() => new Date());

  routes.post("/", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const body = await jsonBody(context.req.raw);
    const kind = readKind(body.kind);
    await assertSubscriptionAllowsRuntime(db, auth.organizationId, config.billingEnforced);

    const draft = kind === "tailscale_funnel"
      ? await funnelDraft(body, config, tailscale)
      : await managedDraft(body, config, cloudflare);

    const keyId = config.tokenEncryption.current.id;
    const install = draft.installToken ? encryptSecret(draft.installToken, config.tokenEncryption.current.value) : null;
    const edge = draft.edgeAuth ? encryptSecret(JSON.stringify(draft.edgeAuth), config.tokenEncryption.current.value) : null;
    const id = crypto.randomUUID();
    // The resources already exist at the provider: if the row that
    // finds them is not written, they are removed, but only when the
    // rollback is certain (failure before the COMMIT). Beyond that, the row may
    // exist: nothing is destroyed and the event names the resources.
    let commitSent = false;
    const row = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await tx<RuntimeExposureRow[]>`
        insert into runtime_direct_exposures (
          id, organization_id, created_by_user_id, kind, hostname, endpoint,
          cloudflare_account_id, zone_id, tunnel_id, dns_record_id, access_app_id, service_token_id, tailscale_auth_key_id,
          install_token_ciphertext, install_token_nonce, install_token_tag, install_token_key_id,
          edge_auth_ciphertext, edge_auth_nonce, edge_auth_tag, edge_auth_key_id, status
        ) values (
          ${id}, ${auth.organizationId}, ${auth.userId}, ${kind}, ${draft.hostname}, ${draft.endpoint},
          ${draft.accountId}, ${draft.zoneId}, ${draft.tunnelId}, ${draft.dnsRecordId}, ${draft.accessAppId}, ${draft.serviceTokenId}, ${draft.tailscaleAuthKeyId},
          ${install?.ciphertext ?? null}, ${install?.nonce ?? null}, ${install?.tag ?? null}, ${install ? keyId : null},
          ${edge?.ciphertext ?? null}, ${edge?.nonce ?? null}, ${edge?.tag ?? null}, ${edge ? keyId : null}, 'awaiting_install'
        )
        returning id, organization_id as "organizationId", runtime_id as "runtimeId", kind, hostname, endpoint,
                  cloudflare_account_id as "cloudflareAccountId", zone_id as "zoneId", tunnel_id as "tunnelId",
                  dns_record_id as "dnsRecordId", access_app_id as "accessAppId", service_token_id as "serviceTokenId", tailscale_auth_key_id as "tailscaleAuthKeyId",
                  install_token_ciphertext as "installTokenCiphertext", install_token_nonce as "installTokenNonce",
                  install_token_tag as "installTokenTag", install_token_key_id as "installTokenKeyId",
                  edge_auth_ciphertext as "edgeAuthCiphertext", edge_auth_nonce as "edgeAuthNonce",
                  edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId",
                  status, last_tunnel_status as "lastTunnelStatus", last_checked_at as "lastCheckedAt", error_code as "errorCode",
                  created_at as "createdAt", revoked_at as "revokedAt"`;
      const inserted = rows[0]!;
      commitSent = true;
      return inserted;
    }).catch(async (error: unknown) => {
      await releaseUnrecordedExposure(kind, draft, body, config, { cloudflare, tailscale }, commitSent, auth.organizationId);
      throw error;
    });
    const response: RuntimeExposureCreatedDto = {
      exposure: publicExposure(row),
      installCommand: draft.installCommand,
    };
    return context.json(response, 201);
  });

  /**
   * Publications still without a runtime, so the registry can
   * resume or revoke them. No probe here: a list must not
   * trigger a network call per row. No secret either: `publicExposure`
   * returns neither an install token nor a service token.
   */
  routes.get("/", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const rows = await withTenant(db, auth.organizationId, (tx) => readPendingExposures(tx, auth.organizationId));
    const response: RuntimeExposureListDto = { exposures: rows.map(publicExposure) };
    return context.json(response);
  });

  /**
   * Reads the exposure and, outside the cache, probes its hostname: `/health` answers
   * (200, or 401 from the gateway demanding its bearer) means « joignable »;
   * a Cloudflare 530/1033 means « tunnel non connecté »; a silent DNS
   * means « pas encore publié ». No Cloudflare token is required,
   * which holds for all three paths.
   */
  routes.get("/:id", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const id = assertString(context.req.param("id"), "L’identifiant de la publication", { max: 64 });
    const row = await withTenant(db, auth.organizationId, async (tx) => (await readExposureById(tx, auth.organizationId, id))[0] ?? null);
    if (!row) throw new HttpError(404, "EXPOSURE_NOT_FOUND", "Cette publication n’existe pas.");
    if (row.status === "declared" || row.status === "revoked") return context.json(publicExposure(row));
    const checkedAt = row.lastCheckedAt ? new Date(row.lastCheckedAt).getTime() : 0;
    if (now().getTime() - checkedAt < EXPOSURE_CHECK_CACHE_MS) return context.json(publicExposure(row));

    const edgeAuth = decryptEdgeAuth(row, config);
    const probe = await directProbeResult(() => createClient(directConfig(row.endpoint, "", edgeAuth, config)), edgeAuth !== null);
    const verdict = reachabilityVerdict(probe.steps[0]?.ok ?? null, probe.steps[0]?.code);
    const updated = await withTenant(db, auth.organizationId, async (tx) => {
      const rows = await tx<RuntimeExposureRow[]>`
        update runtime_direct_exposures
           set status = case when status = 'awaiting_install' and ${verdict.reachable} then 'reachable' else status end,
               last_tunnel_status = ${verdict.tunnelStatus}, error_code = ${verdict.code}, last_checked_at = now(), updated_at = now()
         where organization_id = ${auth.organizationId} and id = ${row.id} and status in ('awaiting_install', 'reachable')
        returning id, organization_id as "organizationId", runtime_id as "runtimeId", kind, hostname, endpoint,
                  cloudflare_account_id as "cloudflareAccountId", zone_id as "zoneId", tunnel_id as "tunnelId",
                  dns_record_id as "dnsRecordId", access_app_id as "accessAppId", service_token_id as "serviceTokenId", tailscale_auth_key_id as "tailscaleAuthKeyId",
                  install_token_ciphertext as "installTokenCiphertext", install_token_nonce as "installTokenNonce",
                  install_token_tag as "installTokenTag", install_token_key_id as "installTokenKeyId",
                  edge_auth_ciphertext as "edgeAuthCiphertext", edge_auth_nonce as "edgeAuthNonce",
                  edge_auth_tag as "edgeAuthTag", edge_auth_key_id as "edgeAuthKeyId",
                  status, last_tunnel_status as "lastTunnelStatus", last_checked_at as "lastCheckedAt", error_code as "errorCode",
                  created_at as "createdAt", revoked_at as "revokedAt"`;
      return rows[0] ?? row;
    });
    return context.json(publicExposure(updated));
  });

  /**
   * The same probe as `POST /api/runtime/test-draft`, with the service token
   * of the publication that the browser does not hold. 200 even on failure.
   */
  routes.post("/:id/test", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const id = assertString(context.req.param("id"), "L’identifiant de la publication", { max: 64 });
    const body = await jsonBody(context.req.raw);
    const row = await withTenant(db, auth.organizationId, async (tx) => (await readExposureById(tx, auth.organizationId, id))[0] ?? null);
    if (!row) throw new HttpError(404, "EXPOSURE_NOT_FOUND", "Cette publication n’existe pas.");
    if (row.status === "revoked") throw new HttpError(409, "EXPOSURE_REVOKED", "Cette publication est révoquée.");
    const edgeAuth = decryptEdgeAuth(row, config);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const result = await directProbeResult(() => createClient(directConfig(row.endpoint, token, edgeAuth, config)), edgeAuth !== null);
    return context.json(result);
  });

  /**
   * The bearer arrives last: the `runtimes` row is born here with the URL and the
   * publication's service token, active if nothing yet serves
   * the organization, otherwise inactive as the single waiting replacement
   * (`assertNoPendingReplacement`). Same probe and same insert
   * as `POST /api/runtime`; the publication becomes `declared` and forgets its
   * secrets, now carried by the runtime.
   */
  routes.post("/:id/declare", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const id = assertString(context.req.param("id"), "L’identifiant de la publication", { max: 64 });
    const body = await jsonBody(context.req.raw);
    const name = assertString(body.name, "Le nom du runtime", { max: 100 });
    const row = await withTenant(db, auth.organizationId, async (tx) => (await readExposureById(tx, auth.organizationId, id))[0] ?? null);
    if (!row) throw new HttpError(404, "EXPOSURE_NOT_FOUND", "Cette publication n’existe pas.");
    if (row.status === "declared" || row.runtimeId) throw new HttpError(409, "EXPOSURE_ALREADY_DECLARED", "Cette publication porte déjà un runtime.");
    if (row.status === "revoked") throw new HttpError(409, "EXPOSURE_REVOKED", "Cette publication est révoquée.");
    await assertSubscriptionAllowsRuntime(db, auth.organizationId, config.billingEnforced);

    const access = prepareDirectAccess({ url: row.endpoint, token: body.token, edgeAuth: decryptEdgeAuth(row, config) }, null, config);
    let capacity: number;
    try {
      capacity = await probeDirectCapacityWith(createClient(access.client));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "HERMES_UNREACHABLE", "Le gateway publié ne répond pas encore. Vérifiez la commande sur l’hôte et réessayez.");
    }
    const runtime = await withTenant(db, auth.organizationId, async (tx) => {
      const existing = await readAllRuntimeRows(tx, auth.organizationId);
      if (existing.some((candidate) => candidate.endpoint === access.endpoint)) {
        throw new HttpError(409, "RUNTIME_ALREADY_DECLARED", "Ce runtime est déjà déclaré.");
      }
      await assertNoPendingReplacement(tx, auth.organizationId);
      // With no runtime serving, this one serves at once; otherwise it waits
      // for replacement (`POST /:runtimeId/replace`).
      const inserted = (await insertRuntime(tx, {
        organizationId: auth.organizationId, name, endpoint: access.endpoint, encrypted: access.encrypted, edge: access.edge,
        keyId: config.tokenEncryption.current.id, capacity, hostFeatures: [], active: !existing.some((row) => row.isActive),
      }))[0]!;
      await tx`
        update runtime_direct_exposures
           set runtime_id = ${inserted.id}, status = 'declared', updated_at = now(),
               install_token_ciphertext = null, install_token_nonce = null, install_token_tag = null, install_token_key_id = null,
               edge_auth_ciphertext = null, edge_auth_nonce = null, edge_auth_tag = null, edge_auth_key_id = null
         where organization_id = ${auth.organizationId} and id = ${row.id}`;
      return inserted;
    });
    return context.json(await publicRuntimeWithBots(db, auth.organizationId, runtime, "disabled", [], config.connectorVersions, {
      id: row.id, kind: row.kind, hostname: row.hostname, lastTunnelStatus: row.lastTunnelStatus,
    }, linkPublication(config)), 201);
  });

  routes.delete("/:id", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const id = assertString(context.req.param("id"), "L’identifiant de la publication", { max: 64 });
    const credentials = await readOptionalTailscaleCredentials(context.req.raw);
    // The revocation is committed alone, then the provider is cleaned up outside
    // the transaction: a half-done remote removal no longer resurrects a
    // publication in the database. A `pending` cleanup is resumed by this same DELETE.
    const revoked = await withTenant(db, auth.organizationId, async (tx) => {
      const row = (await readExposureById(tx, auth.organizationId, id))[0];
      if (!row) throw new HttpError(404, "EXPOSURE_NOT_FOUND", "Cette publication n’existe pas.");
      if (row.status === "revoked") return { row, cleanup: row.cleanupStatus === "pending" ? "pending" as const : "none" as const };
      if (row.runtimeId) {
        const live = await tx<Array<{ id: string }>>`select id from runtimes where organization_id = ${auth.organizationId} and id = ${row.runtimeId} and revoked_at is null`;
        if (live.length) throw new HttpError(409, "EXPOSURE_RUNTIME_DECLARED", "Retirez d’abord le runtime qui utilise cette publication.");
      }
      return { row, cleanup: await markExposureRevoked(tx, config, row, credentials) };
    });
    if (revoked.cleanup !== "pending") {
      const result: RuntimeExposureRevokedDto = { ok: true, cloudflareCleanup: revoked.cleanup };
      return context.json(result);
    }
    let cloudflareCleanup: "done" | "manual";
    try {
      cloudflareCleanup = await cleanupRevokedExposure(db, config, revoked.row, credentials, { cloudflare, tailscale });
    } catch (error) {
      throw mapProviderError(error);
    }
    const result: RuntimeExposureRevokedDto = { ok: true, cloudflareCleanup };
    return context.json(result);
  });

  return routes;
}

type ExposureDraft = {
  hostname: string;
  endpoint: string;
  accountId: string | null;
  zoneId: string | null;
  tunnelId: string | null;
  dnsRecordId: string | null;
  accessAppId: string | null;
  serviceTokenId: string | null;
  tailscaleAuthKeyId: string | null;
  installToken: string | null;
  /** THE command to paste on the host; it carries the secret and is returned only once. */
  installCommand: string;
  edgeAuth: { clientId: string; clientSecret: string } | null;
};

function readKind(value: unknown): RuntimeExposureKind {
  if (value === "managed_cloudflare" || value === "tailscale_funnel") return value;
  throw new HttpError(400, "VALIDATION_ERROR", "Le type de publication est invalide.");
}

/** The hostname's first label: managed subdomain, or Tailscale machine name. */
function readSlug(value: unknown, name: string): string {
  const slug = assertString(value, name, { min: 3, max: 32 }).toLowerCase();
  if (!SLUG.test(slug)) throw new HttpError(400, "VALIDATION_ERROR", `${name} n’accepte que des minuscules, chiffres et tirets (3 à 32 caractères).`);
  return slug;
}

/** The tailnet's OAuth client: read, used for the duration of the request, never written. */
function readTailscaleCredentials(body: Record<string, unknown>): TailscaleCredentials {
  return {
    clientId: assertString(body.oauthClientId, "L’identifiant du client OAuth Tailscale", { min: 8, max: 256 }).trim(),
    clientSecret: assertString(body.oauthClientSecret, "Le secret du client OAuth Tailscale", { min: 20, max: 256 }).trim(),
  };
}

async function readOptionalTailscaleCredentials(request: Request): Promise<TailscaleCredentials | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json") || request.headers.get("content-length") === "0") return null;
  const body = await jsonBody(request);
  const tailscale = body.tailscale;
  if (!tailscale || typeof tailscale !== "object") return null;
  const record = tailscale as Record<string, unknown>;
  return readTailscaleCredentials({ oauthClientId: record.clientId, oauthClientSecret: record.clientSecret });
}

/**
 * Assisted Funnel publication: openedbot sets the `funnel` attribute on its tag in
 * the tailnet's policy file, creates the pairing key, and predicts the
 * MagicDNS name. Funnel has no Access equivalent: no service-token
 * pair is produced, the gateway bearer stays its only protection.
 *
 * Closed by default: the flow exists end to end but is opened only
 * if the deployment sets `OPENEDBOT_TAILSCALE_FUNNEL_ENABLED`.
 */
async function funnelDraft(body: Record<string, unknown>, config: ApiConfig, tailscale: TailscaleClientFactory): Promise<ExposureDraft> {
  if (!config.tailscaleFunnelEnabled) {
    throw new HttpError(404, "TAILSCALE_FUNNEL_UNAVAILABLE", "La publication Tailscale Funnel n’est pas encore ouverte.");
  }
  const slug = readSlug(body.slug, "Le nom de la machine Tailscale");
  const credentials = readTailscaleCredentials(body);
  try {
    const result = await provisionTailscaleExposure(tailscale(credentials), { slug });
    return {
      hostname: result.hostname, endpoint: `https://${result.hostname}`,
      accountId: null, zoneId: null, tunnelId: null, dnsRecordId: null, accessAppId: null, serviceTokenId: null,
      tailscaleAuthKeyId: result.authKeyId, installToken: result.authKey,
      installCommand: tailscaleInstallCommand(result.authKey, slug), edgeAuth: null,
    };
  } catch (error) {
    throw mapProviderError(error);
  }
}

/**
 * A subdomain nobody chose: `openedbot-<hex>` on the managed zone.
 *
 * Nothing to enter on the client side, so nothing to validate or dispute. The draw is
 * reread against the zone's DNS before it is kept: a collision is
 * improbable (2^32) but a hostname already published belongs to someone.
 */
async function pickManagedSlug(client: ReturnType<CloudflareClientFactory>, managed: ManagedTunnelConfig): Promise<string> {
  for (let attempt = 0; attempt < MANAGED_SLUG_ATTEMPTS; attempt++) {
    const slug = `openedbot-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    if (!(await client.findDnsRecord(managed.zoneId, `${slug}.${managed.hostSuffix}`))) return slug;
  }
  throw new HttpError(503, "EXPOSURE_HOSTNAME_TAKEN", "Aucun sous-domaine libre n’a été tiré ; réessayez.");
}

/**
 * The managed tunnel: everything happens on openedbot's Cloudflare account.
 *
 * Without a `slug`, openedbot draws the subdomain itself and the client has nothing to
 * enter before publishing. An explicit `slug` stays accepted for an API
 * call that wants a readable name; the assistant itself does not send one.
 */
async function managedDraft(body: Record<string, unknown>, config: ApiConfig, cloudflare: CloudflareClientFactory): Promise<ExposureDraft> {
  const managed = config.managedTunnel;
  if (!managed) throw new HttpError(404, "MANAGED_TUNNEL_UNAVAILABLE", "Ce déploiement ne publie pas de tunnel géré.");
  const chosen = body.slug === undefined || body.slug === null || body.slug === ""
    ? null
    : readSlug(body.slug, "Le nom du runtime géré");
  const client = cloudflare(managed.apiToken);
  try {
    const slug = chosen ?? await pickManagedSlug(client, managed);
    const hostname = `${slug}.${managed.hostSuffix}`;
    // A hostname already published on the managed zone belongs to someone: never overwrite it.
    if (chosen && await client.findDnsRecord(managed.zoneId, hostname)) {
      throw new HttpError(409, "EXPOSURE_HOSTNAME_TAKEN", "Ce nom est déjà pris ; choisissez-en un autre.");
    }
    const result = await provisionDirectExposure(client, {
      accountId: managed.accountId, zoneId: managed.zoneId, hostname,
      tunnelName: `openedbot-managed-${slug}`, accessName: `openedbot managed ${slug}`,
    });
    return {
      hostname, endpoint: `https://${hostname}`,
      accountId: managed.accountId, zoneId: managed.zoneId, tunnelId: result.tunnelId,
      dnsRecordId: result.dnsRecordId, accessAppId: result.accessAppId, serviceTokenId: result.serviceTokenId,
      tailscaleAuthKeyId: null, installToken: result.installToken,
      installCommand: `sudo cloudflared service install ${result.installToken}`, edgeAuth: result.edgeAuth,
    };
  } catch (error) {
    throw mapProviderError(error);
  }
}

/**
 * A publication provisioned at the provider whose row was not
 * written. Certain rollback: its resources are removed (idempotent
 * deletions). COMMIT outcome unknown: nothing is destroyed, the row may
 * exist and serve. In both failure cases, the event names the
 * identifiers (no secret) for a manual removal.
 */
async function releaseUnrecordedExposure(
  kind: RuntimeExposureKind,
  draft: ExposureDraft,
  body: Record<string, unknown>,
  config: ApiConfig,
  factories: { cloudflare: CloudflareClientFactory; tailscale: TailscaleClientFactory },
  commitSent: boolean,
  organizationId: string,
): Promise<void> {
  const resources = {
    organizationId, kind, hostname: draft.hostname, tunnelId: draft.tunnelId, dnsRecordId: draft.dnsRecordId,
    accessAppId: draft.accessAppId, serviceTokenId: draft.serviceTokenId, tailscaleAuthKeyId: draft.tailscaleAuthKeyId,
  };
  if (commitSent) {
    console.error(JSON.stringify({ event: "api.exposure_record_uncertain", ...resources }));
    return;
  }
  try {
    if (kind === "tailscale_funnel") {
      await deprovisionTailscaleExposure(factories.tailscale(readTailscaleCredentials(body)), {
        hostname: draft.hostname, authKeyId: draft.tailscaleAuthKeyId,
      });
    } else if (config.managedTunnel && draft.accountId && draft.zoneId) {
      await deprovisionDirectExposure(factories.cloudflare(config.managedTunnel.apiToken), {
        accountId: draft.accountId, zoneId: draft.zoneId, tunnelId: draft.tunnelId, dnsRecordId: draft.dnsRecordId,
        accessAppId: draft.accessAppId, serviceTokenId: draft.serviceTokenId,
      });
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "api.exposure_release_failed", ...resources, error: error instanceof Error ? error.name : "unknown",
    }));
  }
}

function decryptEdgeAuth(row: RuntimeExposureRow, config: ApiConfig): { clientId: string; clientSecret: string } | null {
  if (!row.edgeAuthCiphertext || !row.edgeAuthNonce || !row.edgeAuthTag || !row.edgeAuthKeyId) return null;
  try {
    const parsed = JSON.parse(decryptSecretFromKeyring({ ciphertext: row.edgeAuthCiphertext, nonce: row.edgeAuthNonce, tag: row.edgeAuthTag }, row.edgeAuthKeyId, config.tokenEncryption).value) as { clientId?: unknown; clientSecret?: unknown };
    if (typeof parsed.clientId !== "string" || typeof parsed.clientSecret !== "string") throw new Error();
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
  } catch {
    throw new HttpError(500, "RUNTIME_EDGE_AUTH_DECRYPTION_FAILED", "Le service token Access ne peut pas être déchiffré. Restaurez la clé précédente ou recréez la publication.");
  }
}

/** What the first proof says about the hostname, with no bearer: reachable, tunnel down, silent DNS, or nothing readable. */
export function reachabilityVerdict(edgeOk: boolean | null, code: RuntimeProbeDiagnosticCode | undefined): { reachable: boolean; tunnelStatus: string; code: string | null } {
  if (edgeOk === true || code === "RUNTIME_BEARER_REJECTED" || code === "RUNTIME_CAPABILITIES_MISSING") return { reachable: true, tunnelStatus: "healthy", code: null };
  if (code === "RUNTIME_TUNNEL_DOWN") return { reachable: false, tunnelStatus: "down", code };
  if (code === "RUNTIME_DNS_UNRESOLVED") return { reachable: false, tunnelStatus: "dns_pending", code };
  if (code === "RUNTIME_EDGE_AUTH_REJECTED" || code === "RUNTIME_EDGE_AUTH_REQUIRED") return { reachable: false, tunnelStatus: "access_rejected", code };
  return { reachable: false, tunnelStatus: "unreachable", code: code ?? "RUNTIME_PROBE_INDETERMINATE" };
}

/** Translates a provider failure into an HTTP error, never letting its response body leak. */
function mapProviderError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof CloudflareApiError) {
    const status = error.code === "CLOUDFLARE_TOKEN_REJECTED" ? 400 : error.code === "CLOUDFLARE_CONFLICT" ? 409 : error.code === "CLOUDFLARE_NOT_FOUND" ? 404 : 502;
    return new HttpError(status, error.code, error.message);
  }
  if (error instanceof TailscaleApiError) {
    const status = error.code === "TAILSCALE_CREDENTIALS_REJECTED" || error.code === "TAILSCALE_TAILNET_UNKNOWN" ? 400
      : error.code === "TAILSCALE_CONFLICT" ? 409
        : error.code === "TAILSCALE_NOT_FOUND" ? 404
          : error.code === "TAILSCALE_RATE_LIMITED" ? 429 : 502;
    return new HttpError(status, error.code, error.message);
  }
  return new HttpError(502, "CLOUDFLARE_UNAVAILABLE", "L’API du fournisseur n’a pas répondu.");
}
