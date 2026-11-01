import { randomBytes } from "node:crypto";
import { parseConnectorVersion, type ConnectorVersions } from "./connector-version";
import { readFileSync, statSync } from "node:fs";
import {
  normalizeHermesEndpoint,
  parseInsecureHermesOrigins,
  type EndpointPolicy,
} from "@openedbot/hermes/endpoint";
import type { HermesClientTimeouts } from "@openedbot/hermes";
import { readHermesMtlsIdentity, type HermesMtlsIdentity } from "@openedbot/hermes/mtls";
import { secretEncryptionKey, type SecretKeyring } from "@openedbot/hermes/secrets";
import { readApiInternalUrl, readApiPort } from "@openedbot/platform-config/api-address";
import { deployEnvironment, type DeployEnvironment } from "@openedbot/platform-config/deploy-environment";
import { readManagedTunnelConfig, type ManagedTunnelConfig } from "@openedbot/platform-integrations/managed-tunnel";
import { readHermesTimeouts } from "@openedbot/platform-config/hermes-timeouts";
import { readRuntimeMode } from "@openedbot/platform-config/runtime-mode";
import { readVapidConfig, type VapidConfig } from "@openedbot/platform-integrations/vapid";
import { readApnsConfig } from "@openedbot/platform-integrations/apns";
import { LEGAL_SLUGS, type LegalSlug, type RuntimeMode } from "@openedbot/contracts-api";
import { fileBlobRoot, resolveBlobDriver } from "./blob-driver";

/** Non-secret placeholder used outside production; rejected by assertProductionConfig. */
const DEV_WORKER_INTERNAL_TOKEN = "ohb-worker-dev-token";
const DEV_METRICS_INTERNAL_TOKEN = "ohb-metrics-dev-token";

/** L'origine de la PWA en développement, quand `WEB_APP_URL` n'est pas posé. */
export const DEV_WEB_ORIGIN = "http://localhost:1420";

/**
 * Le compte que `make db-seed` crée. `scripts/seed.ts` l'écrit, `/api/auth/providers`
 * le publie en développement pour que `/login` se pré-remplisse : une seule
 * source, sinon l'autofill propose des identifiants que la base ne connaît pas.
 *
 * Aucun mot de passe n'est versionné : `make setup` (ou le premier
 * `make db-seed`) en génère un aléatoire dans .env.local (E2E_PASSWORD,
 * DEV_STAFF_PASSWORD). Sans valeur, rien n'est publié à `/login`.
 */
export const DEV_SEED_EMAIL = "dev@ohb.local";
export const DEV_STAFF_EMAIL = "staff@ohb.dev";

export type ApiEnvironment = "development" | "test" | "production";

/** Ce que `OHB_RUNTIME_ADMIN_MODE` demande. `local` est le défaut de développement. */
type RuntimeAdminRequest = "disabled" | "local";

/** Les canaux réellement servables par ce déploiement. */
export type RuntimeAdminChannels = { local: boolean };

export const DEFAULT_LEGAL_MAX_BYTES = 256 * 1024;
export const MAX_LEGAL_MAX_BYTES = 1024 * 1024;

export type LegalConfig = {
  maxBytes: number;
  files: Record<LegalSlug, string | null>;
};

/**
 * Réglages du flux `/api/events`.
 *
 * Le hint HTTP post-commit du worker est le chemin nominal : il réveille le
 * poller de l'organisation sans attendre. Le sondage périodique n'est qu'un
 * filet : hint perdu, API redémarrée entre l'insert et le hint, réplique qui
 * n'a pas reçu la requête. Le rejeu de `cursor=0` est borné en temps ET en
 * nombre : un client qui n'a rien ne reçoit que le récent, jamais l'historique
 * retenu tout entier.
 */
export type EventsConfig = {
  /** Intervalle du sondage de secours, en ms (`API_EVENTS_FALLBACK_POLL_MS`, ≥ 250). */
  fallbackPollMs: number;
  /** Fenêtre temporelle rejouée quand le client part de zéro (`API_EVENTS_REPLAY_WINDOW_MS`). */
  replayWindowMs: number;
  /** Plafond d'événements rejoués quand le client part de zéro (`API_EVENTS_REPLAY_WINDOW_EVENTS`). */
  replayWindowEvents: number;
};

/**
 * Le flux du guichet de support.
 *
 * `pollMs` est bien plus court que le filet de `/api/events` (5 s) et il ne
 * joue pas le même rôle. Là-bas le chemin nominal est le hint HTTP que le
 * worker envoie après commit, et le sondage ne rattrape qu'un hint perdu. Ici
 * l'écrivain est l'API elle-même : dans le processus qui a commité, la pompe
 * est réveillée sans attendre, mais une AUTRE instance de l'API n'a aucun
 * moyen de l'apprendre. Ce tick est donc la latence réelle vue par un staff
 * servi par une autre instance que celle qui a reçu le message du visiteur.
 *
 * Une requête indexée par seconde et par flux ouvert : le prix est nul face à
 * un guichet qui répond avec cinq secondes de retard.
 */
export type SupportConfig = {
  /** Sondage du flux de support, en ms (`API_SUPPORT_POLL_MS`, ≥ 250). */
  pollMs: number;
};

export const DEFAULT_SUPPORT_POLL_MS = 1_000;
export const MIN_SUPPORT_POLL_MS = 250;

export const DEFAULT_EVENTS_FALLBACK_POLL_MS = 5_000;
export const MIN_EVENTS_FALLBACK_POLL_MS = 250;
export const DEFAULT_EVENTS_REPLAY_WINDOW_MS = 15 * 60_000;
export const DEFAULT_EVENTS_REPLAY_WINDOW_EVENTS = 200;

export type LinkSecurityConfig = { requirePop: boolean };

export type AuditVerdictSigningConfig = {
  /** Graine Ed25519 de 32 octets. */
  seed: Uint8Array;
  /** `true` quand la graine a été tirée au démarrage faute de variable. */
  ephemeral: boolean;
};

/**
 * L'ancrage WORM de l'audit de création (`AUDIT_WORM_*`). `r2` : un bucket
 * dédié sous verrou de rétention, une paire de credentials pour déposer et
 * une autre pour relire, distinctes du blob store. `disabled` : rien n'est
 * archivé hors base ; refusé en production.
 */
export type AuditWormConfig =
  | { mode: "disabled" }
  | {
      mode: "r2";
      bucket: string;
      endpoint: string;
      write: { accessKeyId: string; secretAccessKey: string };
      read: { accessKeyId: string; secretAccessKey: string };
      /** Rétention du verrou du bucket, en jours ; jamais moins de 365. */
      retentionDays: number;
    };

export const MIN_AUDIT_WORM_RETENTION_DAYS = 365;

export type ComputerProviderConfig =
  | { provider: "disabled" }
  | {
      provider: "box";
      /** Provider origin is deployment-owned. It is never accepted from an HTTP client. */
      apiUrl: string;
      token: string;
    };

export type ApiConfig = {
  environment: ApiEnvironment;
  /**
   * Palier de déploiement (`OHB_DEPLOY_ENV`, sinon dérivé de `OHB_ENV`) :
   * nommé dans chaque alerte et poussé aux connecteurs (`link.context`),
   * puisque plusieurs déploiements partagent un canal Discord.
   */
  deployEnvironment: DeployEnvironment;
  host: string;
  port: number;
  databaseUrl: string;
  /**
   * DSN privilégiée du vidage `POST /api/onboarding/reset {"scope":"full"}`,
   * en développement uniquement, `null` partout ailleurs et par défaut.
   * `ohb_api` ne peut PAS faire ce vidage : il n'a ni `delete` sur les tables
   * append-only (`decisions`, `team_imports`, `email_outbox`,
   * `tenant_blob_deletions`) ni le droit de `truncate` une table qu'il ne
   * possède pas : c'est le dessin des grants, pas un oubli. Sans cette DSN, la
   * portée `full` répond 503 et renvoie vers `make db-reset-keep-users`.
   */
  devResetDatabaseUrl: string | null;
  databaseMaxConnections: number;
  publicUrl: string;
  /**
   * `RUNTIME_LINK_PUBLIC_URL` : l'origine que composent les connecteurs, sur un
   * hôte à elle (`https://link.openedbot.app`) pour qu'un renommage du produit
   * ne déplace plus le lien. `publicUrl` par défaut. La PWA, l'API web et les
   * retours OAuth restent sur `publicUrl`.
   */
  linkPublicUrl: string;
  /**
   * `NATIVE_API_PUBLIC_URL` : l'origine de l'API que visent les clients natifs
   * (app iOS, bureau, notch), `https://api.openedbot.app` en production, gravée
   * dans leur build (`OPENEDBOT_API_ORIGIN`). Le lien du QR « Mobile Connect »
   * (`ohb://join?api=…`) la porte : l'app refuse une autre origine que la
   * sienne (`foreignDeployment`). `publicUrl` par défaut, l'origine de la PWA,
   * qui n'est pas celle de l'app dès que la console vit sur un autre nom.
   */
  nativeApiPublicUrl: string;
  /**
   * `RUNTIME_LINK_LEGACY_PUBLIC_URLS` : anciennes origines publiques sur
   * lesquelles des runtimes déjà appairés signent encore leur preuve de lien
   * (l'URL figée dans leur `link.json`). Acceptées en plus de `publicUrl`
   * pendant un changement de nom, pour ne pas exiger un nouveau ticket sur
   * chaque hôte client. HTTPS seulement en production ; vide par défaut.
   */
  linkLegacyPublicUrls: string[];
  /**
   * Origine interne de CETTE instance, telle que le worker et les autres
   * répliques la joignent (`API_INTERNAL_URL`). Enregistrée dans
   * `api_instances.internal_url` au démarrage ; `resolveInstanceUrl()`
   * renvoie celle du propriétaire du lien, plus toujours celle-ci.
   */
  apiInternalUrl: string;
  /**
   * `WEB_APP_URL` : l'origine canonique de la PWA. Les URLs de retour
   * navigateur (paiement) et d'enrôlement pointent ici, pas sur
   * l'API. Toujours incluse dans `webOrigins` et dans `browserOrigins`, donc
   * un lien de retour ne peut pas viser une origine que CORS refuserait.
   */
  webUrl: string;
  /**
   * Origines depuis lesquelles un `returnTo` est accepté : `WEB_APP_URL` plus
   * `CORS_ALLOWED_ORIGINS`. L'origine du backoffice n'y est pas : c'est une
   * autre application, un retour de la PWA n'a rien à y faire.
   */
  webOrigins: string[];
  /**
   * Origine du backoffice staff (`apps/admin`). Distincte de la PWA. Absente
   * en production tant que `ADMIN_PUBLIC_URL` n'est pas posé.
   */
  adminUrl: string | null;
  /**
   * Interface de relecture des courriers locaux. L'API ne l'appelle jamais et
   * ne la publie jamais en production.
   */
  transactionalEmailMailboxUrl: string | null;
  /**
   * Origines navigateur autorisées en CORS : `webOrigins` plus, automatiquement,
   * l'origine de `ADMIN_PUBLIC_URL`. Un seul var suffit pour le backoffice.
   */
  browserOrigins: string[];
  nativeRedirectUris: string[];
  runtimeMode: RuntimeMode;
  /**
   * Les canaux d'administration que CE déploiement peut réellement servir.
   *
   * Ce n'est pas un mode : le mode appartient à l'organisation et se change
   * depuis `/settings/runtime`. Le déploiement déclare seulement ce qu'il sait
   * faire : parler au Dashboard du Hermes intégré, sortir en SSH : et
   * `effectiveAdminMode` croise les deux. Sans cette séparation, basculer une
   * organisation sur un runtime externe fermait le canal jusqu'au prochain
   * redémarrage de l'API avec un autre `.env`.
   */
  runtimeAdminChannels: RuntimeAdminChannels;
  /** Optional persistent cloud desktop provider. Disabled is deliberately fail-closed. */
  computer: ComputerProviderConfig;
  /**
   * Le compte de développement, tel que `/login` doit le pré-remplir. `null`
   * partout ailleurs qu'en développement : hors de cet environnement, publier
   * un mot de passe serait une fuite, pas un confort.
   */
  devSignIn: { email: string; password: string } | null;
  /**
   * Le compte staff semé, pour l'autofill de `apps/admin` `/login`. Même
   * règle que `devSignIn` : développement seulement, jamais en test/prod.
   */
  staffDevSignIn: { email: string; password: string } | null;
  /**
   * Doit refléter `WORKER_RUN_EVENTS_RETENTION_DAYS` : au-delà, la purge du
   * worker a effacé les `run_events` et l'API ne peut plus distinguer « outil
   * jamais appelé » de « appelé puis purgé ». On la publie pour que l'écran
   * date ce qu'il montre au lieu de le laisser croire exhaustif.
   */
  runEventsRetentionDays: number;
  events: EventsConfig;
  support: SupportConfig;
  tokenEncryption: SecretKeyring;
  /**
   * Sécurité du lien connecteur. `requirePop` : une connexion n'est liée
   * qu'après une preuve de possession Ed25519 de sa clé device
   * (`RUNTIME_LINK_REQUIRE_POP`, obligatoire en production) ; hors
   * production, un runtime sans clé enregistrée est lié et journalise
   * `pop_missing`.
   */
  linkSecurity: LinkSecurityConfig;
  /** Seuils informatifs du connecteur ; aucune version ne refuse une session. */
  /**
   * Objet vivant : le flux des releases d'edge-setup (`connector-release-feed`)
   * y relève `latestVersion` en place, lu à chaque requête par les routes et
   * le gateway du lien.
   */
  connectorVersions: ConnectorVersions;
  /** `RUNTIME_CONNECTOR_RELEASES_URL` ; null : aucune lecture des releases. */
  connectorReleasesUrl: string | null;
  /**
   * Clé Ed25519 qui signe les verdicts d'audit de création
   * (`AUDIT_VERDICT_SIGNING_KEY`). Obligatoire en production ; ailleurs, une
   * clé éphémère est tirée au démarrage et chaque verdict le dit.
   */
  auditVerdictSigning: AuditVerdictSigningConfig;
  /** Copie write-once des ancres et des verdicts hors base (`AUDIT_WORM_MODE`), obligatoire en production. */
  auditWorm: AuditWormConfig;
  /** Process-wide outbound identity; certificate material is never persisted. */
  hermesMtls: HermesMtlsIdentity | null;
  /** Timeouts of the Hermes run and session calls; unset entries keep the client defaults. */
  hermesTimeouts: Partial<HermesClientTimeouts>;
  blob:
    /** `fallbackReason` : pourquoi le disque remplace R2 (annoncé au démarrage) ; null quand il est choisi. */
    | { driver: "file"; root: string; fallbackReason?: string | null }
    | {
        driver: "r2";
        bucket: string;
        endpoint: string;
        accessKeyId: string;
        secretAccessKey: string;
        cdnUrl: string;
        cdnSigningKey: string;
  };
  developmentHermesUrl: string;
  testHermesUrl: string | null;
  /**
   * Politique unique de validation d'endpoint. Construite une fois ici pour
   * qu'aucun appelant ne puisse en oublier une partie : omettre les origines
   * autorisées ferait silencieusement échouer un runtime local légitime, les
   * inventer rouvrirait le garde SSRF.
   */
  hermesEndpointPolicy: EndpointPolicy;
  workerInternalToken: string;
  metricsInternalToken: string;
  /** true seulement derrière un reverse-proxy de confiance (nginx en prod). */
  trustProxy: boolean;
  /**
   * Applique les vérifications d'abonnement (paywall, quotas de plan). Quand false
   * : la phase de test : tout compte est traité comme actif et le billing est neutralisé.
   * Défaut: true en production, false ailleurs. Override explicite par BILLING_ENFORCED.
   * Valeur BRUTE de la configuration : la décision est l'entitlement
   * `billing.enforced`, que seul le plug-in billing fournit (étape 8d) ; en
   * solo il n'est jamais tenu, quelle que soit cette valeur.
   */
  billingEnforced: boolean;
  /** OHB-75 : compte Cloudflare d'openedbot pour les tunnels gérés ; `null` cache cette voie. */
  managedTunnel: ManagedTunnelConfig | null;
  /**
   * OHB-75 : la publication Tailscale Funnel assistée. Fermée par défaut : le
   * parcours existe de bout en bout mais n'est pas ouvert aux organisations.
   */
  tailscaleFunnelEnabled: boolean;
  google: {
    clientId: string | null;
    clientSecret: string | null;
    allowedEmails: ReadonlySet<string>;
  };
  /**
   * Prix mensuel AFFICHÉ (EUR, `BILLING_PRICE_EUR`), prêté au plug-in billing.
   * Doit refléter le prix réel du fournisseur de paiement : personne ne l'y
   * relit. Les clés du fournisseur ne sont pas ici : le plug-in les déclare
   * et les lit lui-même (étape 11.5, `manifest.env`).
   */
  billingPriceEur: number;
  /** Limites appliquées à un abonnement actif. Configurable par déploiement (fin du « 2 » en dur). */
  plan: {
    runtimeLimit: number;
    memberLimit: number;
    concurrentRunLimit: number;
    attachmentQuotaBytes: number;
  };
  /** Délai de grâce (jours) entre la résiliation et la purge définitive du tenant. */
  billingGraceDays: number;
  legal: LegalConfig;
  /**
   * Clés VAPID du Web Push. `null` hors production quand les trois variables
   * sont absentes : l'écran le dit, l'API répond 404, le worker no-op.
   */
  vapid: VapidConfig | null;
  /**
   * iOS push (DEV-308): the bundle identifiers a device may register with.
   * `null` when the four `APNS_*` variables are absent: the registration
   * routes answer 404 `APNS_NOT_CONFIGURED` and `GET /api/push/apns/config`
   * answers `enabled: false`. The API validates the signing key at boot but
   * keeps no copy of it: only the worker signs.
   */
  apns: { bundleIds: readonly string[] } | null;
};

export function readApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const environment = readEnvironment(env.OHB_ENV ?? env.NODE_ENV);
  // R2 quand il est configuré, sinon le volume du serveur, même en production (`blob-driver.ts`).
  const blobChoice = resolveBlobDriver(env, environment === "production");
  const blobDriver = blobChoice.driver;

  const tokenEncryption = readTokenEncryption(
    env.RUNTIME_TOKEN_ENCRYPTION_KEY,
    env.RUNTIME_TOKEN_ENCRYPTION_PREVIOUS_KEYS,
    environment,
  );
  const runtimeMode = readRuntimeMode(env.OHB_RUNTIME_MODE, environment);
  // HTTP exceptions are always explicit, including the local fake gateway.
  const insecureHermesOrigins = parseInsecureHermesOrigins(env.HERMES_ALLOW_INSECURE_ORIGINS);
  const hermesEndpointPolicy: EndpointPolicy = {
    environment,
    testHttpUrl: environment === "test" ? optional(env.TEST_HERMES_URL) ?? undefined : undefined,
    insecureOrigins: insecureHermesOrigins,
  };
  // Seed-only. External has no implied lab URL : DEV_HERMES_URL must be explicit.
  const developmentHermesUrl = environment === "development" && env.DEV_HERMES_URL?.trim()
      ? normalizeHermesEndpoint(env.DEV_HERMES_URL.trim(), hermesEndpointPolicy)
      : "";
  const testHermesUrl = environment === "test" ? optional(env.TEST_HERMES_URL) : null;
  const legalDocumentsDirectory = optional(env.LEGAL_DOCUMENTS_DIR);
  // Trois choses distinctes, trois noms : où pointent les liens que l'API
  // fabrique (`webUrl`), depuis quelles origines un `returnTo` est digne de
  // confiance (`webOrigins`), et ce que CORS laisse passer (`browserOrigins`).
  // Les avoir fondues dans une liste dont la tête faisait loi rendait un simple
  // réordonnancement capable de déplacer les URLs de retour du paiement.
  const webUrl = (optional(env.WEB_APP_URL) ?? DEV_WEB_ORIGIN).replace(/\/+$/, "");
  const webOrigins = uniqueOrigins([webUrl, ...splitList(env.CORS_ALLOWED_ORIGINS ?? "")]);
  const adminUrl = readAdminUrl(env.ADMIN_PUBLIC_URL, environment);
  const transactionalEmailMailboxUrl = readTransactionalEmailMailboxUrl(
    env.TRANSACTIONAL_EMAIL_MAILBOX_URL,
    environment,
  );
  const adminOrigin = adminUrl ? originOf(adminUrl) : null;
  const browserOrigins = uniqueOrigins([
    ...webOrigins,
    ...(adminOrigin ? [adminOrigin] : []),
  ]);
  // `OHB_RUNTIME_ADMIN_MODE` déclare ce que l'hôte autorise, pas ce que
  // l'organisation a choisi : en développement les deux canaux existent, et
  // c'est le mode enregistré en base qui décide lequel sert la requête.
  const runtimeAdminRequest = readRuntimeAdminRequest(env.OHB_RUNTIME_ADMIN_MODE, environment);
  if (environment === "production" && runtimeAdminRequest === "local") throw new Error("Runtime administration channels are forbidden in production cloud mode.");
  const runtimeAdminChannels: RuntimeAdminChannels = { local: false };
  const base = {
    environment,
    deployEnvironment: deployEnvironment(env.OHB_DEPLOY_ENV, env.OHB_ENV),
    host: env.API_HOST?.trim() || "127.0.0.1",
    port: readApiPort(env.API_PORT),
    databaseUrl:
      env.API_DATABASE_URL?.trim() ||
      "postgres://ohb_api:ohb_api_dev@127.0.0.1:5432/ohb",
    devResetDatabaseUrl:
      environment === "development" ? env.DEV_RESET_DATABASE_URL?.trim() || null : null,
    databaseMaxConnections: positiveInteger(env.API_DB_MAX, 32, "API_DB_MAX"),
    publicUrl: env.API_PUBLIC_URL?.trim() || `http://localhost:${readApiPort(env.API_PORT)}`,
    linkPublicUrl: (env.RUNTIME_LINK_PUBLIC_URL?.trim() || env.API_PUBLIC_URL?.trim() || `http://localhost:${readApiPort(env.API_PORT)}`).replace(/\/+$/, ""),
    linkLegacyPublicUrls: splitList(env.RUNTIME_LINK_LEGACY_PUBLIC_URLS ?? ""),
    nativeApiPublicUrl: (env.NATIVE_API_PUBLIC_URL?.trim() || env.API_PUBLIC_URL?.trim() || `http://localhost:${readApiPort(env.API_PORT)}`).replace(/\/+$/, ""),
    apiInternalUrl: readApiInternalUrl(env.API_INTERNAL_URL, env.API_PORT),
    webUrl,
    webOrigins,
    adminUrl,
    transactionalEmailMailboxUrl,
    browserOrigins,
    // Fixed allowlist: the Expo client was removed and NATIVE_REDIRECT_URIS is
    // deprecated. An OAuth redirect_uri allowlist must not be widenable by the
    // environment.
    nativeRedirectUris: splitList("ohb://auth/callback,http://127.0.0.1:47813/callback"),
    runtimeMode,
    runtimeAdminChannels,
    computer: readComputerProvider(env, environment),
    devSignIn: environment === "development" && env.E2E_PASSWORD
      ? {
          email: env.E2E_EMAIL?.trim() || DEV_SEED_EMAIL,
          password: env.E2E_PASSWORD,
        }
      : null,
    staffDevSignIn: environment === "development" && env.DEV_STAFF_PASSWORD
      ? {
          email: env.DEV_STAFF_EMAIL?.trim() || DEV_STAFF_EMAIL,
          password: env.DEV_STAFF_PASSWORD,
        }
      : null,
    tokenEncryption,
    linkSecurity: { requirePop: readBooleanDefault(env.RUNTIME_LINK_REQUIRE_POP, environment === "production", "RUNTIME_LINK_REQUIRE_POP") },
    connectorVersions: {
      minimumVersion: readConnectorVersion(env.RUNTIME_CONNECTOR_MIN_VERSION, "RUNTIME_CONNECTOR_MIN_VERSION"),
      latestVersion: readConnectorVersion(env.RUNTIME_CONNECTOR_LATEST_VERSION, "RUNTIME_CONNECTOR_LATEST_VERSION"),
    },
    connectorReleasesUrl: readConnectorReleasesUrl(env.RUNTIME_CONNECTOR_RELEASES_URL, environment),
    auditVerdictSigning: readAuditVerdictSigning(env.AUDIT_VERDICT_SIGNING_KEY),
    auditWorm: readAuditWorm(env),
    hermesMtls: readHermesMtlsIdentity(env),
    hermesTimeouts: readHermesTimeouts(env),
    developmentHermesUrl,
    testHermesUrl,
    hermesEndpointPolicy,
    workerInternalToken:
      env.WORKER_INTERNAL_TOKEN?.trim() ||
      (environment === "production" ? required(undefined, "WORKER_INTERNAL_TOKEN") : DEV_WORKER_INTERNAL_TOKEN),
    metricsInternalToken:
      env.METRICS_INTERNAL_TOKEN?.trim() ||
      (environment === "production" ? required(undefined, "METRICS_INTERNAL_TOKEN") : DEV_METRICS_INTERNAL_TOKEN),
    trustProxy: /^(1|true)$/i.test(env.API_TRUST_PROXY?.trim() ?? ""),
    billingEnforced: readBooleanDefault(env.BILLING_ENFORCED, environment === "production"),
    managedTunnel: readManagedTunnelConfig(env),
    tailscaleFunnelEnabled: readBooleanDefault(env.OHB_TAILSCALE_FUNNEL_ENABLED, false),
    google: {
      clientId: optional(env.GOOGLE_CLIENT_ID),
      clientSecret: optional(env.GOOGLE_CLIENT_SECRET),
      allowedEmails: new Set(splitList(env.GOOGLE_ALLOWED_EMAILS ?? "")),
    },
    billingPriceEur: positiveInteger(env.BILLING_PRICE_EUR, 19, "BILLING_PRICE_EUR"),
    plan: {
      runtimeLimit: positiveInteger(env.PLAN_RUNTIME_LIMIT, 1, "PLAN_RUNTIME_LIMIT"),
      memberLimit: positiveInteger(env.PLAN_MEMBER_LIMIT, 2, "PLAN_MEMBER_LIMIT"),
      concurrentRunLimit: positiveInteger(env.PLAN_CONCURRENT_RUN_LIMIT, 4, "PLAN_CONCURRENT_RUN_LIMIT"),
      attachmentQuotaBytes: positiveInteger(env.PLAN_ATTACHMENT_QUOTA_BYTES, 1_073_741_824, "PLAN_ATTACHMENT_QUOTA_BYTES"),
    },
    billingGraceDays: positiveInteger(env.BILLING_GRACE_DAYS, 30, "BILLING_GRACE_DAYS"),
    runEventsRetentionDays: positiveInteger(
      env.WORKER_RUN_EVENTS_RETENTION_DAYS,
      30,
      "WORKER_RUN_EVENTS_RETENTION_DAYS",
    ),
    events: readEventsConfig(env),
    support: readSupportConfig(env),
    legal: {
      maxBytes: legalMaxBytes(env.LEGAL_MAX_BYTES),
      files: {
        mentions: legalFilePath(env, "mentions", legalDocumentsDirectory),
        privacy: legalFilePath(env, "privacy", legalDocumentsDirectory),
        terms: legalFilePath(env, "terms", legalDocumentsDirectory),
      },
    },
    vapid: readVapidConfig(env, false),
    apns: readApiApnsConfig(env, environment === "production"),
  } satisfies Omit<ApiConfig, "blob">;

  if (blobDriver === "file") {
    return {
      ...base,
      blob: { driver: "file", root: fileBlobRoot(env, environment === "production"), fallbackReason: blobChoice.fallbackReason },
    };
  }

  return {
    ...base,
    blob: {
      driver: "r2",
      bucket: required(env.R2_BUCKET, "R2_BUCKET"),
      endpoint: required(env.R2_ENDPOINT, "R2_ENDPOINT"),
      accessKeyId: required(env.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID"),
      secretAccessKey: required(env.R2_SECRET_ACCESS_KEY, "R2_SECRET_ACCESS_KEY"),
      cdnUrl: required(env.FILES_CDN_URL, "FILES_CDN_URL").replace(/\/+$/, ""),
      cdnSigningKey: required(env.FILES_CDN_SIGNING_KEY, "FILES_CDN_SIGNING_KEY"),
    },
  };
}

export function assertProductionConfig(config: ApiConfig): void {
  if (config.environment !== "production") throw new Error("OHB_ENV=production is required.");
  if (config.devSignIn) throw new Error("Development sign-in credentials must not be published in production.");
  if (config.staffDevSignIn) throw new Error("Development staff sign-in credentials must not be published in production.");
  if (!config.publicUrl.startsWith("https://")) throw new Error("API_PUBLIC_URL must use HTTPS in production.");
  if (!config.linkPublicUrl.startsWith("https://")) throw new Error("RUNTIME_LINK_PUBLIC_URL must use HTTPS in production.");
  if (!config.nativeApiPublicUrl.startsWith("https://")) throw new Error("NATIVE_API_PUBLIC_URL must use HTTPS in production.");
  if (config.linkLegacyPublicUrls.some((url) => !url.startsWith("https://"))) {
    throw new Error("RUNTIME_LINK_LEGACY_PUBLIC_URLS must use HTTPS in production.");
  }
  if (!config.webUrl.startsWith("https://")) throw new Error("WEB_APP_URL must use HTTPS in production.");
  if (config.adminUrl && !config.adminUrl.startsWith("https://")) {
    throw new Error("ADMIN_PUBLIC_URL must use HTTPS in production.");
  }
  // The payment provider's keys are no longer a core requirement (step
  // 11.5): the plug-in billing declares them (`manifest.env`,
  // `requiredInProduction`) and the API refuses to start without them only
  // while it is loaded (`assertProPluginProductionEnv`). Solo requires none.
  // Le canal SSH sortant n'existe plus du tout : il a
  // été retiré du code, pas seulement interdit ici.
  if (config.runtimeAdminChannels.local) {
    throw new Error("Runtime administration channels are forbidden in production cloud mode.");
  }
  if ((config.hermesEndpointPolicy.insecureOrigins?.size ?? 0) > 0) {
    throw new Error("HERMES_ALLOW_INSECURE_ORIGINS must be empty in production; Hermes requires HTTPS.");
  }
  if (config.workerInternalToken === DEV_WORKER_INTERNAL_TOKEN) {
    throw new Error("WORKER_INTERNAL_TOKEN must not be the development default in production.");
  }
  if (config.metricsInternalToken === DEV_METRICS_INTERNAL_TOKEN || config.metricsInternalToken === config.workerInternalToken) {
    throw new Error("METRICS_INTERNAL_TOKEN must be a distinct production secret.");
  }
  // En production l'API vit toujours derrière le proxy TLS (PRODUCTION.md) :
  // sans X-Forwarded-For, la limite de montée du lien connecteur (10/min)
  // compte l'IP du proxy, donc tous les hôtes clients ensemble : après un
  // redémarrage, les hôtes au-delà du dixième prennent 429.
  if (!config.trustProxy) {
    throw new Error("API_TRUST_PROXY=1 is required in production: the API runs behind the TLS proxy and rate limits key on the client IP.");
  }
  if (!config.vapid) {
    throw new Error("PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY and PUSH_VAPID_SUBJECT are required in production.");
  }
  // Un jeton de lien volé ne doit pas suffire : la preuve de possession de la
  // machine enrôlée est la règle en production, pas une option.
  if (!config.linkSecurity.requirePop) {
    throw new Error("RUNTIME_LINK_REQUIRE_POP=1 is required in production: a link token alone must not bind a connector.");
  }
  // Un verdict d'audit signé par une clé éphémère ne se revérifie pas après
  // un redémarrage : en production la clé est un secret de déploiement.
  if (config.auditVerdictSigning.ephemeral) {
    throw new Error("AUDIT_VERDICT_SIGNING_KEY is required in production; creation-audit verdicts must be re-verifiable.");
  }
  // Une ancre ou un verdict qui ne vit qu'en base tombe avec elle : en
  // production, chacun est aussi déposé une fois dans un bucket verrouillé.
  if (config.auditWorm.mode === "disabled") {
    throw new Error("AUDIT_WORM_MODE=r2 is required in production: audit anchors and verdicts must be archived write-once outside the database.");
  }
  assertLegalFiles(config.legal);
}

/**
 * `AUDIT_VERDICT_SIGNING_KEY` : 32 octets en base64, ou rien. Absente, une
 * graine aléatoire sert pour ce processus seulement, et `ephemeral` le dit
 * pour que le verdict le porte et que la production le refuse.
 */
function readAuditVerdictSigning(value: string | undefined): AuditVerdictSigningConfig {
  const raw = value?.trim();
  if (!raw) return { seed: new Uint8Array(randomBytes(32)), ephemeral: true };
  return { seed: decodeEncryptionKey(raw, "AUDIT_VERDICT_SIGNING_KEY"), ephemeral: false };
}

/**
 * `AUDIT_WORM_MODE` : `disabled` (défaut) ou `r2` avec son bucket, son
 * endpoint, ses deux paires de credentials et sa rétention. La rétention
 * est validée dès qu'elle est posée, quel que soit le mode : une valeur
 * sous 365 jours n'est jamais une configuration valide.
 */
function readAuditWorm(env: Record<string, string | undefined>): AuditWormConfig {
  const mode = env.AUDIT_WORM_MODE?.trim() || "disabled";
  if (mode !== "disabled" && mode !== "r2") throw new Error("AUDIT_WORM_MODE must be either disabled or r2.");
  const retentionDays = positiveInteger(env.AUDIT_WORM_RETENTION_DAYS, MIN_AUDIT_WORM_RETENTION_DAYS, "AUDIT_WORM_RETENTION_DAYS");
  if (retentionDays < MIN_AUDIT_WORM_RETENTION_DAYS) {
    throw new Error(`AUDIT_WORM_RETENTION_DAYS must be at least ${MIN_AUDIT_WORM_RETENTION_DAYS}: audit evidence is kept at least one year.`);
  }
  if (mode === "disabled") return { mode: "disabled" };
  const write = {
    accessKeyId: required(env.AUDIT_WORM_WRITE_ACCESS_KEY_ID, "AUDIT_WORM_WRITE_ACCESS_KEY_ID"),
    secretAccessKey: required(env.AUDIT_WORM_WRITE_SECRET_ACCESS_KEY, "AUDIT_WORM_WRITE_SECRET_ACCESS_KEY"),
  };
  const read = {
    accessKeyId: required(env.AUDIT_WORM_READ_ACCESS_KEY_ID, "AUDIT_WORM_READ_ACCESS_KEY_ID"),
    secretAccessKey: required(env.AUDIT_WORM_READ_SECRET_ACCESS_KEY, "AUDIT_WORM_READ_SECRET_ACCESS_KEY"),
  };
  // Deux paires, deux portées : la même paire des deux côtés annulerait la
  // séparation dépôt / relecture que le bucket verrouillé est censé porter.
  if (write.accessKeyId === read.accessKeyId) {
    throw new Error("AUDIT_WORM_READ_ACCESS_KEY_ID must differ from AUDIT_WORM_WRITE_ACCESS_KEY_ID: the WORM bucket uses two credential pairs.");
  }
  return {
    mode: "r2",
    bucket: required(env.AUDIT_WORM_BUCKET, "AUDIT_WORM_BUCKET"),
    endpoint: required(env.AUDIT_WORM_ENDPOINT, "AUDIT_WORM_ENDPOINT"),
    write,
    read,
    retentionDays,
  };
}

/** Production legal pages are deployment-owned files validated at startup. */
export function assertLegalFiles(config: LegalConfig): void {
  for (const slug of LEGAL_SLUGS) {
    const filePath = config.files[slug];
    if (!filePath) throw new Error(`LEGAL_${slug.toUpperCase()}_FILE is required in production.`);
    assertLegalFile(filePath, config.maxBytes, slug);
  }
}

export function assertLegalFile(filePath: string, maxBytes: number, slug = "document"): void {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new Error(`Legal ${slug} document is missing: ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`Legal ${slug} document must be a regular file: ${filePath}`);
  if (stat.size < 1) throw new Error(`Legal ${slug} document must not be empty: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`Legal ${slug} document exceeds LEGAL_MAX_BYTES: ${filePath}`);

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Legal ${slug} document cannot be read: ${filePath}`);
  }
  if (!content.trim()) throw new Error(`Legal ${slug} document must not be empty: ${filePath}`);
  if (LEGAL_PLACEHOLDER_PATTERN.test(content)) {
    throw new Error(`Legal ${slug} document contains a placeholder: ${filePath}`);
  }
}

const LEGAL_PLACEHOLDER_PATTERN = /(?:\b(?:TODO|TBD|FIXME|PLACEHOLDER|LOREM\s+IPSUM|REPLACE[_ -]?ME)\b|\{\{[^}\n]+\}\}|\[(?:YOUR|INSERT|REPLACE|TODO|TBD)[^\]\n]*\]|\bexample\.(?:com|org|net)\b)/i;

/**
 * Ce que l'hôte autorise comme canal d'administration.
 *
 * `local` administre le Hermes que CE déploiement démarre lui-même. Il n'existe
 * plus de canal vers la machine d'un client : OHB-15 a retiré la session SSH
 * sortante, et `ssh` est refusé ici : dans tous les environnements : pour que
 * la frontière tienne par le code plutôt que par une valeur d'environnement.
 *
 * En développement, l'absence de valeur vaut `local` : le poste parle au Hermes
 * du Compose. Ailleurs, elle vaut `disabled`.
 */
function readRuntimeAdminRequest(
  value: string | undefined,
  environment: ApiEnvironment,
): RuntimeAdminRequest {
  const requested = value?.trim();
  const normalized = requested || (environment === "development" ? "local" : "disabled");
  if (normalized !== "disabled" && normalized !== "local") {
    throw new Error(
      "OHB_RUNTIME_ADMIN_MODE must be disabled or local. "
      + "openedbot no longer opens a shell session toward a customer runtime; "
      + "a customer poses their own provider credentials with "
      + "`edge-setup credentials add <provider>` on their host.",
    );
  }
  return normalized;
}

const BOX_COMPUTER_API = "https://ascii.dev/api/box/v1";

function readComputerProvider(
  env: Record<string, string | undefined>,
  environment: ApiEnvironment,
): ComputerProviderConfig {
  const provider = env.OHB_COMPUTER_PROVIDER?.trim() || "disabled";
  if (provider === "disabled") return { provider: "disabled" };
  if (provider !== "box") {
    throw new Error("OHB_COMPUTER_PROVIDER must be either disabled or box.");
  }
  const token = optional(env.OHB_COMPUTER_BOX_TOKEN);
  if (!token) throw new Error("OHB_COMPUTER_BOX_TOKEN is required when OHB_COMPUTER_PROVIDER=box.");
  if (token.length > 4_096) throw new Error("OHB_COMPUTER_BOX_TOKEN is too long.");

  // A configurable provider origin would turn the API into an authenticated
  // SSRF proxy. Only tests may point at a loopback fixture; real deployments
  // always use the audited Box API origin.
  const testApiUrl = environment === "test" ? optional(env.TEST_COMPUTER_BOX_API) : null;
  if (testApiUrl) {
    const parsed = new URL(testApiUrl);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
      throw new Error("TEST_COMPUTER_BOX_API must be a loopback HTTP URL.");
    }
  }
  return {
    provider: "box",
    apiUrl: (testApiUrl ?? BOX_COMPUTER_API).replace(/\/+$/, ""),
    token,
  };
}

function readEnvironment(value: string | undefined): ApiEnvironment {
  if (value === "production" || value === "test") return value;
  return "development";
}

export function readEventsConfig(env: Record<string, string | undefined>): EventsConfig {
  return {
    fallbackPollMs: boundedInteger(
      env.API_EVENTS_FALLBACK_POLL_MS,
      DEFAULT_EVENTS_FALLBACK_POLL_MS,
      MIN_EVENTS_FALLBACK_POLL_MS,
      "API_EVENTS_FALLBACK_POLL_MS",
    ),
    replayWindowMs: positiveInteger(
      env.API_EVENTS_REPLAY_WINDOW_MS,
      DEFAULT_EVENTS_REPLAY_WINDOW_MS,
      "API_EVENTS_REPLAY_WINDOW_MS",
    ),
    replayWindowEvents: positiveInteger(
      env.API_EVENTS_REPLAY_WINDOW_EVENTS,
      DEFAULT_EVENTS_REPLAY_WINDOW_EVENTS,
      "API_EVENTS_REPLAY_WINDOW_EVENTS",
    ),
  };
}

export function readSupportConfig(env: Record<string, string | undefined>): SupportConfig {
  return {
    pollMs: boundedInteger(
      env.API_SUPPORT_POLL_MS,
      DEFAULT_SUPPORT_POLL_MS,
      MIN_SUPPORT_POLL_MS,
      "API_SUPPORT_POLL_MS",
    ),
  };
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, name: string): number {
  if (!value) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return result;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`${name} must be a positive integer.`);
  return result;
}

function legalMaxBytes(value: string | undefined): number {
  if (!value) return DEFAULT_LEGAL_MAX_BYTES;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_LEGAL_MAX_BYTES) {
    throw new Error(`LEGAL_MAX_BYTES must be an integer between 1 and ${MAX_LEGAL_MAX_BYTES}.`);
  }
  return result;
}

function legalFilePath(
  env: Record<string, string | undefined>,
  slug: LegalSlug,
  directory: string | null,
): string | null {
  const name = `LEGAL_${slug.toUpperCase()}_FILE`;
  return optional(env[name]) ?? (directory ? `${directory}/${slug}.md` : null);
}

function readTokenEncryption(
  currentValue: string | undefined,
  previousValues: string | undefined,
  _environment: ApiEnvironment,
): SecretKeyring {
  const current = secretEncryptionKey(decodeEncryptionKey(
    required(currentValue, "RUNTIME_TOKEN_ENCRYPTION_KEY"),
    "RUNTIME_TOKEN_ENCRYPTION_KEY",
  ));
  const previous = splitList(previousValues ?? "").map((value, index) => secretEncryptionKey(
    decodeEncryptionKey(value, `RUNTIME_TOKEN_ENCRYPTION_PREVIOUS_KEYS[${index}]`),
  ));

  return {
    current,
    previous: previous.filter((key, index, keys) =>
      key.id !== current.id && keys.findIndex((candidate) => candidate.id === key.id) === index),
  };
}

function decodeEncryptionKey(value: string, name: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (bytes.byteLength !== 32) throw new Error(`${name} must be 32 bytes in base64.`);
  return bytes;
}

function splitList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function uniqueOrigins(values: string[]): string[] {
  const seen = new Set<string>();
  const origins: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    origins.push(value);
  }
  return origins;
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    throw new Error("ADMIN_PUBLIC_URL must be an absolute URL.");
  }
}

function readAdminUrl(value: string | undefined, environment: ApiEnvironment): string | null {
  const raw = value?.trim();
  if (raw) return raw.replace(/\/+$/, "");
  if (environment === "production") return null;
  return "http://localhost:1421";
}

function readTransactionalEmailMailboxUrl(
  value: string | undefined,
  environment: ApiEnvironment,
): string | null {
  if (environment === "production") return null;
  const raw = value?.trim() || "http://127.0.0.1:8025";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("TRANSACTIONAL_EMAIL_MAILBOX_URL must be an absolute HTTP or HTTPS URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("TRANSACTIONAL_EMAIL_MAILBOX_URL must use HTTP or HTTPS.");
  }
  return raw.replace(/\/+$/, "");
}

function optional(value: string | undefined): string | null {
  return value?.trim() || null;
}

/** Lit un booléen d'env (1/true/on ↔ 0/false/off), sinon retombe sur le défaut. */
function readBooleanDefault(value: string | undefined, fallback: boolean, name = "BILLING_ENFORCED"): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (/^(1|true|on|yes)$/.test(normalized)) return true;
  if (/^(0|false|off|no)$/.test(normalized)) return false;
  throw new Error(`${name} must be a boolean (true/false).`);
}

/** L'ancre indépendante d'edge-setup (docs/specs/EDGE_SETUP_V2/03-SUPPLY-CHAIN.md). */
export const DEFAULT_CONNECTOR_RELEASES_URL = "https://openedbot.app/.well-known/edge-setup.json";

function readConnectorReleasesUrl(value: string | undefined, environment: ApiEnvironment): string | null {
  const text = value?.trim() ?? "";
  if (text === "off") return null;
  if (text === "") return environment === "production" ? DEFAULT_CONNECTOR_RELEASES_URL : null;
  if (!text.startsWith("https://")) throw new Error("RUNTIME_CONNECTOR_RELEASES_URL doit être une URL https (ou off).");
  return text;
}

function readConnectorVersion(value: string | undefined, name: string): string | null {
  if (!value?.trim()) return null;
  const version = parseConnectorVersion(value.trim());
  if (!version) throw new Error(`${name} doit être une version stable vX.Y.Z.`);
  return version;
}

function required(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is required.`);
  return result;
}

function readApiApnsConfig(
  env: Record<string, string | undefined>,
  production: boolean,
): ApiConfig["apns"] {
  const apns = readApnsConfig(env, production);
  return apns ? { bundleIds: apns.bundleIds } : null;
}
