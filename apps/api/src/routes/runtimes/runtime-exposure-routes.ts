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
import { HermesClient, type HermesClientConfig } from "@openedbot/hermes";
import {
  publicExposure,
  readExposureById,
  readPendingExposures,
  type RuntimeExposureRow,
} from "@openedbot/runtimes/sql/runtime-exposures";
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
  /** Sonde Hermes du hostname publié ; un faux dans les tests. */
  clientFactory?: (clientConfig: HermesClientConfig) => RuntimeProbeClient;
  /** Client de l'API Cloudflare pour un token donné ; un faux dans les tests. */
  cloudflareFactory?: CloudflareClientFactory;
  /** Client de l'API Tailscale pour un client OAuth donné ; un faux dans les tests. */
  tailscaleFactory?: TailscaleClientFactory;
  now?: () => Date;
};

const SLUG = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/;
/** Tirages successifs avant d'abandonner un sous-domaine géré libre. */
const MANAGED_SLUG_ATTEMPTS = 5;
/** Deux lectures d'un même hostname espacées de moins que ceci rendent l'état en cache. */
export const EXPOSURE_CHECK_CACHE_MS = 10_000;

/**
 * Le cycle de vie d'une publication de gateway direct.
 *
 * Créer provisionne le hostname chez le fournisseur (tunnel géré sur le compte
 * Cloudflare d'openedbot, ou Funnel sur le tailnet du client) et rend la commande à
 * jouer sur l'hôte ; lire sonde le hostname et dit s'il répond ; déclarer crée
 * la ligne `runtimes` avec le bearer ; révoquer retire ce qui peut l'être. openedbot
 * ne touche jamais l'hôte : la seule commande est copiée par l'opérateur,
 * comme à l'appairage.
 *
 * Les deux voies qui exigeaient un domaine Cloudflare chez le client ont été
 * retirées ; leurs publications restent lisibles et révocables.
 */
export function runtimeExposureRoutes(db: Db, config: ApiConfig, deps: RuntimeExposureRouteDeps = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const createClient = deps.clientFactory ?? ((clientConfig: HermesClientConfig) => new HermesClient(clientConfig));
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
    // Les ressources existent déjà chez le fournisseur : si la ligne qui les
    // retrouve n'est pas écrite, elles sont retirées, mais seulement quand le
    // rollback est certain (échec avant le COMMIT). Au-delà, la ligne existe
    // peut-être : on ne détruit rien et l'événement nomme les ressources.
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
   * Les publications encore sans runtime, pour que le registre puisse les
   * reprendre ou les révoquer. Aucune sonde ici : une liste ne doit pas
   * déclencher un appel réseau par ligne. Aucun secret non plus, `publicExposure`
   * ne rend ni jeton d'installation ni service token.
   */
  routes.get("/", async (context) => {
    const auth = context.get("auth");
    requireRole(auth, ["owner", "admin"]);
    const rows = await withTenant(db, auth.organizationId, (tx) => readPendingExposures(tx, auth.organizationId));
    const response: RuntimeExposureListDto = { exposures: rows.map(publicExposure) };
    return context.json(response);
  });

  /**
   * Lit l'exposition et, hors cache, sonde son hostname : `/health` répond
   * (200, ou 401 du gateway qui réclame son bearer) veut dire « joignable » ;
   * un 530/1033 Cloudflare veut dire « tunnel non connecté » ; un DNS muet
   * veut dire « pas encore publié ». Aucun token Cloudflare n'est nécessaire,
   * ce qui vaut pour les trois voies.
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
   * La même sonde que `POST /api/runtime/test-draft`, avec le service token
   * de la publication que le navigateur ne détient pas. 200 même en échec.
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
   * Le bearer arrive en dernier : la ligne `runtimes` naît ici avec l'URL et le
   * service token de la publication, active si rien ne sert encore
   * l'organisation, sinon inactive comme remplaçant unique en attente
   * (`assertNoPendingReplacement`). Même sonde et même insertion
   * que `POST /api/runtime` ; la publication passe `declared` et oublie ses
   * secrets, désormais portés par le runtime.
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
      // Sans runtime qui sert, celui-ci sert tout de suite ; sinon il attend
      // le remplacement (`POST /:runtimeId/replace`).
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
    // La révocation est commitée seule, puis le fournisseur est nettoyé hors
    // transaction : un retrait distant à moitié fait ne ressuscite plus une
    // publication en base. Un nettoyage `pending` se reprend par ce même DELETE.
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
  /** LA commande à coller sur l'hôte ; elle porte le secret et n'est rendue qu'une fois. */
  installCommand: string;
  edgeAuth: { clientId: string; clientSecret: string } | null;
};

function readKind(value: unknown): RuntimeExposureKind {
  if (value === "managed_cloudflare" || value === "tailscale_funnel") return value;
  throw new HttpError(400, "VALIDATION_ERROR", "Le type de publication est invalide.");
}

/** Le premier label du hostname : sous-domaine géré, ou nom de machine Tailscale. */
function readSlug(value: unknown, name: string): string {
  const slug = assertString(value, name, { min: 3, max: 32 }).toLowerCase();
  if (!SLUG.test(slug)) throw new HttpError(400, "VALIDATION_ERROR", `${name} n’accepte que des minuscules, chiffres et tirets (3 à 32 caractères).`);
  return slug;
}

/** Le client OAuth du tailnet : lu, utilisé le temps de la requête, jamais écrit. */
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
 * Publication Funnel assistée : openedbot pose l'attribut `funnel` sur son tag dans
 * le fichier de politique du tailnet, crée la clé d'appairage et prédit le nom
 * MagicDNS. Funnel n'a pas d'équivalent d'Access : aucune paire de service
 * token n'est produite, le bearer du gateway reste sa seule protection.
 *
 * Fermée par défaut : le parcours existe de bout en bout mais n'est ouvert que
 * si le déploiement pose `OPENEDBOT_TAILSCALE_FUNNEL_ENABLED`.
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
 * Un sous-domaine que personne n'a choisi : `openedbot-<hex>` sur la zone gérée.
 *
 * Rien à saisir côté client, donc rien à valider ni à disputer. Le tirage est
 * relu contre le DNS de la zone avant d'être retenu : la collision est
 * improbable (2^32) mais un hostname déjà publié appartient à quelqu'un.
 */
async function pickManagedSlug(client: ReturnType<CloudflareClientFactory>, managed: ManagedTunnelConfig): Promise<string> {
  for (let attempt = 0; attempt < MANAGED_SLUG_ATTEMPTS; attempt++) {
    const slug = `openedbot-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    if (!(await client.findDnsRecord(managed.zoneId, `${slug}.${managed.hostSuffix}`))) return slug;
  }
  throw new HttpError(503, "EXPOSURE_HOSTNAME_TAKEN", "Aucun sous-domaine libre n’a été tiré ; réessayez.");
}

/**
 * Le tunnel géré : tout se passe sur le compte Cloudflare d'openedbot.
 *
 * Sans `slug`, openedbot tire le sous-domaine lui-même et le client n'a rien à
 * saisir avant de publier. Un `slug` explicite reste accepté pour un appel
 * d'API qui veut un nom lisible ; l'assistant, lui, n'en envoie pas.
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
 * Une publication provisionnée chez le fournisseur dont la ligne n'a pas été
 * écrite. Rollback certain : ses ressources sont retirées (suppressions
 * idempotentes). Issue du COMMIT inconnue : rien n'est détruit, la ligne peut
 * exister et servir. Dans les deux cas d'échec, l'événement nomme les
 * identifiants (aucun secret) pour un retrait à la main.
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

/** Ce que la première preuve dit du hostname, sans bearer : joignable, tunnel à terre, DNS muet, ou rien de lisible. */
export function reachabilityVerdict(edgeOk: boolean | null, code: RuntimeProbeDiagnosticCode | undefined): { reachable: boolean; tunnelStatus: string; code: string | null } {
  if (edgeOk === true || code === "RUNTIME_BEARER_REJECTED" || code === "RUNTIME_CAPABILITIES_MISSING") return { reachable: true, tunnelStatus: "healthy", code: null };
  if (code === "RUNTIME_TUNNEL_DOWN") return { reachable: false, tunnelStatus: "down", code };
  if (code === "RUNTIME_DNS_UNRESOLVED") return { reachable: false, tunnelStatus: "dns_pending", code };
  if (code === "RUNTIME_EDGE_AUTH_REJECTED" || code === "RUNTIME_EDGE_AUTH_REQUIRED") return { reachable: false, tunnelStatus: "access_rejected", code };
  return { reachable: false, tunnelStatus: "unreachable", code: code ?? "RUNTIME_PROBE_INDETERMINATE" };
}

/** Traduit l'échec d'un fournisseur en erreur HTTP, sans jamais laisser fuir son corps de réponse. */
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
