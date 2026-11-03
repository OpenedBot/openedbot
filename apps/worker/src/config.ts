import { isAbsolute, resolve, basename, dirname } from "node:path";
import {
  normalizeHermesEndpoint,
  parseInsecureHermesOrigins,
  type EndpointPolicy,
} from "@openedbot/hermes/endpoint";
import type { HermesClientTimeouts } from "@openedbot/hermes";
import { readHermesMtlsIdentity, type HermesMtlsIdentity } from "@openedbot/hermes/mtls";
import { readApiInternalUrl } from "@openedbot/platform-config/api-address";
import { readHermesTimeouts } from "@openedbot/platform-config/hermes-timeouts";
import { readManagedTunnelConfig, type ManagedTunnelConfig } from "@openedbot/platform-integrations/managed-tunnel";
import { RUNTIME_MODE } from "@openedbot/platform-config/runtime-mode";
import { deployEnvironment, isProductionEnvironment, type DeployEnvironment } from "@openedbot/platform-config/deploy-environment";
import { fileBlobRoot, resolveBlobDriver } from "@openedbot/platform-config/blob-driver";
import type { RuntimeMode } from "@openedbot/contracts-api";
import { secretEncryptionKey, type SecretKeyring } from "@openedbot/hermes/secrets";
import { readVapidConfig, type VapidConfig } from "@openedbot/platform-integrations/vapid";
import { readApnsConfig, type ApnsConfig } from "@openedbot/platform-integrations/apns";
import type { TransactionalEmailConfig } from "@openedbot/notifications/application/email";

export type WorkerConfig = {
  environment: "development" | "test" | "production";
  runtimeMode: RuntimeMode;
  databaseUrl: string;
  workerId: string;
  apiInternalUrl: string;
  /** Dedicated connector gateway; omitted by legacy callers in monolithic mode. */
  runtimeLinkInternalUrl?: string;
  apiInternalToken: string;
  databaseMaxConnections: number;
  /** Limite process, distincte des limites par organisation/runtime. */
  maxActiveRuns: number;
  tokenEncryption: SecretKeyring;
  /** Process-wide outbound identity; certificate material is never persisted. */
  hermesMtls: HermesMtlsIdentity | null;
  /** Timeouts of the Hermes run and session calls; unset entries keep the client defaults. */
  hermesTimeouts: Partial<HermesClientTimeouts>;
  developmentHermesUrl: string;
  testHermesUrl: string | null;
  /** Même politique d'endpoint que l'API : une seule construction, aucun oubli. */
  hermesEndpointPolicy: EndpointPolicy;
  /** OHB-75 : compte Cloudflare d'openedbot, pour relire l'état des tunnels gérés ; `null` sans compte. */
  managedTunnel: ManagedTunnelConfig | null;
  leaseSeconds: number;
  pollMs: number;
  /** Un run en streaming sans aucune frame depuis ce délai est avorté (retryable). */
  runInactivityMs: number;
  /** Durée maximale absolue d'un run, même si Hermes continue d'envoyer des frames. */
  runTimeoutMs: number;
  /** Fenêtre de polling GET après rupture SSE ou arrêt demandé. */
  reconciliationTimeoutMs: number;
  /** Cadence de service des routines/suppressions, indépendante du drain de la file. */
  routineTickMs: number;
  /** Fichier rafraîchi tant que la boucle de claim tourne (`WORKER_HEALTH_FILE`) ; `null` : aucun. */
  healthFile: string | null;
  /**
   * Au-delà de ce délai sans lien connecteur, un run `queued` sans run Hermes
   * échoue `RUNTIME_DISCONNECTED` plutôt que d'attendre un hôte qui ne revient
   * pas (`WORKER_LINK_QUEUE_TIMEOUT_MS`).
   */
  linkQueueTimeoutMs: number;
  /** Conservation des événements SSE des runs terminés (jours). */
  runEventsRetentionDays: number;
  supportEventsRetentionDays: number;
  supportRetentionDays: number;
  /** Rétention des événements ordinaires du lien connecteur (`connected`/`replaced`/`disconnected`), en jours. */
  linkEventsRetentionDays: number;
  /** Minutes de lien coupé avant d'ouvrir une alerte et d'envoyer l'e-mail (`RUNTIME_LINK_ALERT_AFTER_MINUTES`). */
  runtimeLinkAlertAfterMinutes: number;
  /**
   * Âge maximal d'un jeton de lien avant rotation automatique en mode
   * maintenance (`LINK_TOKEN_MAX_AGE_HOURS` : 24 en production, 168 ailleurs
   * où un poste reste souvent éteint plus d'une journée). Un jeton volé meurt
   * dans cette fenêtre.
   */
  linkTokenMaxAgeHours: number;
  /** Rétention des échecs d'outils (`tool_errors`), en jours, plus longue que les événements SSE qu'ils résument. */
  toolErrorsRetentionDays: number;
  /** Applique le filtre d'abonnement à la réclamation des runs. false en phase de test. */
  billingEnforced: boolean;
  /**
   * Part du prix plein qu'on impute à un jeton d'entrée servi par le CACHE du
   * fournisseur, entre 0 et 1. Ce n'est pas une caractéristique de notre code
   * mais du fournisseur derrière Hermes : elle se règle, elle ne se grave pas.
   * Défaut 0,1 = 10 %, la remise usuelle sur une lecture de cache. 0 revient à
   * ne rien compter (interdit : un jeton de cache coûte), 1 revient à facturer
   * au prix fort comme avant cette option.
   */
  cachedInputTokenWeight: number;
  transactionalEmail: TransactionalEmailConfig;
  /** Origine de la PWA, pour les liens des e-mails transactionnels. */
  webAppUrl: string;
  /** Palier de déploiement (dérivé de `OPENEDBOT_ENV`), nommé dans les alertes Discord. */
  deployEnvironment: DeployEnvironment;
  blob:
    | { driver: "file"; root: string; fallbackReason?: string | null }
    | { driver: "r2"; bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string };
  /**
   * Clés VAPID du Web Push. `null` hors production quand elles sont absentes :
   * la passe de maintenance est un no-op.
   */
  vapid: VapidConfig | null;
  /**
   * iOS push (DEV-308), second transport of the push outbox. `null` when the
   * four `APNS_*` variables are absent: no APNs delivery is created or sent.
   */
  apns: ApnsConfig | null;
};

export function readWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const linkMode = env.RUNTIME_LINK_MODE?.trim() || "embedded";
  if (linkMode !== "embedded" && linkMode !== "separate") throw new Error("RUNTIME_LINK_MODE must be embedded or separate.");
  if (linkMode === "separate" && !env.RUNTIME_LINK_INTERNAL_URL?.trim()) {
    throw new Error("RUNTIME_LINK_INTERNAL_URL is required when RUNTIME_LINK_MODE=separate.");
  }
  const environment = isProductionEnvironment(env.OPENEDBOT_ENV) ? "production" : env.OPENEDBOT_ENV === "test" ? "test" : "development";
  // La même règle que l'API : R2 s'il est configuré, sinon le volume partagé avec elle.
  const blobChoice = resolveBlobDriver(env, environment === "production");
  const blobDriver = blobChoice.driver;
  const tokenEncryption = readTokenEncryption(
    env.RUNTIME_TOKEN_ENCRYPTION_KEY,
    env.RUNTIME_TOKEN_ENCRYPTION_PREVIOUS_KEYS,
    environment,
  );
  const runtimeMode = RUNTIME_MODE;
  const declaredInsecureOrigins = parseInsecureHermesOrigins(env.HERMES_ALLOW_INSECURE_ORIGINS);
  const hermesEndpointPolicy: EndpointPolicy = {
    environment,
    testHttpUrl: environment === "test" ? env.TEST_HERMES_URL?.trim() || undefined : undefined,
    insecureOrigins: declaredInsecureOrigins,
  };
  if (environment === "production" && (hermesEndpointPolicy.insecureOrigins?.size ?? 0) > 0) {
    throw new Error("HERMES_ALLOW_INSECURE_ORIGINS must be empty in production; Hermes requires HTTPS.");
  }
  const transactionalEmailEndpoint = env.TRANSACTIONAL_EMAIL_ENDPOINT?.trim() || null;
  const transactionalEmailSmtpUrl = env.TRANSACTIONAL_EMAIL_SMTP_URL?.trim() || null;
  const transactionalEmailBrevoApiKey = env.TRANSACTIONAL_EMAIL_BREVO_API_KEY?.trim() || null;
  const transactionalEmailResendApiKey = env.TRANSACTIONAL_EMAIL_RESEND_API_KEY?.trim() || null;
  const transactionalEmailResendBaseUrl = env.TRANSACTIONAL_EMAIL_RESEND_BASE_URL?.trim() || "https://api.resend.com";
  const transactionalEmailToken = env.TRANSACTIONAL_EMAIL_TOKEN?.trim() || null;
  const transactionalEmailFrom = env.TRANSACTIONAL_EMAIL_FROM?.trim() || null;
  /**
   * Quatre transports possibles, un seul à la fois : Mailpit en local par SMTP,
   * Brevo ou Resend par leur clé sur les paliers hébergés, et l'endpoint HTTP
   * pour un opérateur qui rend lui-même ses messages. Deux valeurs posées
   * ensemble sont une configuration ambiguë : on refuse de deviner laquelle gagne.
   */
  const transactionalEmailTransports = [
    transactionalEmailEndpoint ? "TRANSACTIONAL_EMAIL_ENDPOINT" : null,
    transactionalEmailSmtpUrl ? "TRANSACTIONAL_EMAIL_SMTP_URL" : null,
    transactionalEmailBrevoApiKey ? "TRANSACTIONAL_EMAIL_BREVO_API_KEY" : null,
    transactionalEmailResendApiKey ? "TRANSACTIONAL_EMAIL_RESEND_API_KEY" : null,
  ].filter((name): name is string => name !== null);
  if (transactionalEmailTransports.length > 1) {
    throw new Error(
      `Transactional email accepts exactly one transport; ${transactionalEmailTransports.join(" and ")} are set together.`,
    );
  }
  const transactionalEmailTimeoutMs = boundedInteger(
    env.TRANSACTIONAL_EMAIL_TIMEOUT_MS, 10_000, 1_000, 120_000, "TRANSACTIONAL_EMAIL_TIMEOUT_MS",
  );
  const transactionalEmailLeaseSeconds = boundedInteger(
    env.TRANSACTIONAL_EMAIL_LEASE_SECONDS, 300, 30, 3_600, "TRANSACTIONAL_EMAIL_LEASE_SECONDS",
  );
  if (transactionalEmailLeaseSeconds < Math.ceil(transactionalEmailTimeoutMs / 1_000) + 10) {
    throw new Error("TRANSACTIONAL_EMAIL_LEASE_SECONDS must exceed the HTTP timeout by at least 10 seconds.");
  }
  if (environment === "production") {
    required(transactionalEmailFrom ?? undefined, "TRANSACTIONAL_EMAIL_FROM");
    if (transactionalEmailTransports.length < 1) {
      throw new Error(
        "Production transactional email requires TRANSACTIONAL_EMAIL_BREVO_API_KEY, TRANSACTIONAL_EMAIL_RESEND_API_KEY, TRANSACTIONAL_EMAIL_ENDPOINT or TRANSACTIONAL_EMAIL_SMTP_URL.",
      );
    }
    if (transactionalEmailEndpoint) {
      const parsed = new URL(required(transactionalEmailEndpoint, "TRANSACTIONAL_EMAIL_ENDPOINT"));
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error("TRANSACTIONAL_EMAIL_ENDPOINT must be an HTTPS URL without embedded credentials.");
      }
      required(transactionalEmailToken ?? undefined, "TRANSACTIONAL_EMAIL_TOKEN");
    }
    let resendBase: URL;
    try {
      resendBase = new URL(transactionalEmailResendBaseUrl);
    } catch {
      throw new Error("TRANSACTIONAL_EMAIL_RESEND_BASE_URL must be an HTTPS URL without embedded credentials.");
    }
    if (resendBase.protocol !== "https:" || resendBase.username || resendBase.password) {
      throw new Error("TRANSACTIONAL_EMAIL_RESEND_BASE_URL must be an HTTPS URL without embedded credentials.");
    }
  }
  const databaseMaxConnections = positiveInteger(env.WORKER_DB_MAX, 32);
  const base = {
    environment,
    runtimeMode,
    databaseUrl:
      env.WORKER_DATABASE_URL?.trim() ||
      "postgres://ohb_worker:ohb_worker_dev@127.0.0.1:5432/ohb",
    workerId: workerInstanceId(env.WORKER_ID),
    apiInternalUrl: readApiInternalUrl(env.API_INTERNAL_URL, env.API_PORT),
    runtimeLinkInternalUrl: readApiInternalUrl(env.RUNTIME_LINK_INTERNAL_URL?.trim() || env.API_INTERNAL_URL, env.API_PORT),
    databaseMaxConnections,
    maxActiveRuns: boundedInteger(
      env.WORKER_MAX_ACTIVE_RUNS,
      Math.max(1, Math.min(16, databaseMaxConnections - 4)),
      1,
      Math.max(1, databaseMaxConnections - 2),
      "WORKER_MAX_ACTIVE_RUNS",
    ),
    apiInternalToken:
      env.WORKER_INTERNAL_TOKEN?.trim() ||
      (environment === "production" ? required(undefined, "WORKER_INTERNAL_TOKEN") : "ohb-worker-dev-token"),
    tokenEncryption,
    hermesMtls: readHermesMtlsIdentity(env),
    hermesTimeouts: readHermesTimeouts(env),
    developmentHermesUrl: environment === "development" && env.DEV_HERMES_URL?.trim()
      ? normalizeHermesEndpoint(env.DEV_HERMES_URL.trim(), hermesEndpointPolicy) : "",
    testHermesUrl: environment === "test" ? env.TEST_HERMES_URL?.trim() || null : null,
    hermesEndpointPolicy,
    managedTunnel: readManagedTunnelConfig(env),
    leaseSeconds: positiveInteger(env.WORKER_LEASE_SECONDS, 30),
    pollMs: positiveInteger(env.WORKER_POLL_MS, 100),
    runInactivityMs: positiveInteger(env.WORKER_RUN_INACTIVITY_MS, 120_000),
    runTimeoutMs: positiveInteger(env.WORKER_RUN_TIMEOUT_MS, 900_000),
    reconciliationTimeoutMs: positiveInteger(env.WORKER_RECONCILIATION_TIMEOUT_MS, 300_000),
    routineTickMs: positiveInteger(env.WORKER_ROUTINE_TICK_MS, 1_000),
    healthFile: env.WORKER_HEALTH_FILE?.trim() || null,
    linkQueueTimeoutMs: positiveInteger(env.WORKER_LINK_QUEUE_TIMEOUT_MS, 900_000),
    runEventsRetentionDays: positiveInteger(env.WORKER_RUN_EVENTS_RETENTION_DAYS, 30),
    supportEventsRetentionDays: positiveInteger(env.WORKER_SUPPORT_EVENTS_RETENTION_DAYS, 30),
    supportRetentionDays: positiveInteger(env.WORKER_SUPPORT_RETENTION_DAYS, 180),
    linkEventsRetentionDays: positiveInteger(env.WORKER_LINK_EVENTS_RETENTION_DAYS, 30),
    runtimeLinkAlertAfterMinutes: positiveInteger(env.RUNTIME_LINK_ALERT_AFTER_MINUTES, 5),
    linkTokenMaxAgeHours: positiveInteger(env.LINK_TOKEN_MAX_AGE_HOURS, environment === "production" ? 24 : 168),
    toolErrorsRetentionDays: positiveInteger(env.WORKER_TOOL_ERRORS_RETENTION_DAYS, 90),
    billingEnforced: readBoolean(env.BILLING_ENFORCED, environment === "production"),
    cachedInputTokenWeight: boundedFraction(
      env.WORKER_CACHED_INPUT_TOKEN_WEIGHT, 0.1, "WORKER_CACHED_INPUT_TOKEN_WEIGHT",
    ),
    transactionalEmail: {
      endpoint: transactionalEmailEndpoint,
      smtpUrl: transactionalEmailSmtpUrl,
      brevoApiKey: transactionalEmailBrevoApiKey,
      resendApiKey: transactionalEmailResendApiKey,
      resendBaseUrl: transactionalEmailResendBaseUrl,
      token: transactionalEmailToken,
      from: transactionalEmailFrom,
      timeoutMs: transactionalEmailTimeoutMs,
      leaseSeconds: transactionalEmailLeaseSeconds,
      maxAttempts: boundedInteger(env.TRANSACTIONAL_EMAIL_MAX_ATTEMPTS, 5, 1, 10, "TRANSACTIONAL_EMAIL_MAX_ATTEMPTS"),
    },
    webAppUrl: (env.WEB_APP_URL?.trim() || "http://localhost:1420").replace(/\/+$/, ""),
    deployEnvironment: deployEnvironment(env.OPENEDBOT_ENV),
    vapid: readVapidConfig(env, environment === "production"),
    apns: readApnsConfig(env, environment === "production"),
  } satisfies Omit<WorkerConfig, "blob">;
  if (blobDriver === "file") {
    return {
      ...base,
      blob: {
        driver: "file",
        root: sharedFileBlobRoot(fileBlobRoot(env, environment === "production")),
        fallbackReason: blobChoice.fallbackReason,
      },
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
    },
  };
}

/**
 * `bun --filter` lance le worker depuis `apps/worker` et l'API depuis
 * `apps/api`. Un `BLOB_FILE_ROOT` relatif se résolvait donc en deux
 * répertoires : le worker posait le fichier, `GET /api/attachments/:id`
 * ne le trouvait pas. L'API est le lecteur : un chemin relatif, vu du
 * worker, vise le magasin de l'API. Un chemin absolu (prod, tests) reste.
 */
export function sharedFileBlobRoot(root: string, cwd = process.cwd()): string {
  if (isAbsolute(root)) return root;
  if (basename(cwd) === "worker" && basename(dirname(cwd)) === "apps") {
    return resolve(cwd, "../api", root);
  }
  return resolve(cwd, root);
}

function workerInstanceId(value: string | undefined): string {
  const prefix = value?.trim() || "worker";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(prefix)) {
    throw new Error("WORKER_ID must be a 1-64 character instance prefix using letters, digits, dot, underscore or dash.");
  }
  // Le suffixe par processus est obligatoire : deux replicas qui partagent le
  // même préfixe opérateur ne doivent jamais posséder ni libérer les mêmes baux.
  return `${prefix}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

function readTokenEncryption(
  currentValue: string | undefined,
  previousValues: string | undefined,
  _environment: WorkerConfig["environment"],
): SecretKeyring {
  const current = secretEncryptionKey(decodeEncryptionKey(
    required(currentValue, "RUNTIME_TOKEN_ENCRYPTION_KEY"),
    "RUNTIME_TOKEN_ENCRYPTION_KEY",
  ));
  const previous = (previousValues ?? "").split(",").map((value) => value.trim()).filter(Boolean)
    .map((value, index) => secretEncryptionKey(
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

function required(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`${name} is required.`);
  return result;
}
function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (/^(1|true|on|yes)$/.test(normalized)) return true;
  if (/^(0|false|off|no)$/.test(normalized)) return false;
  throw new Error("BILLING_ENFORCED must be a boolean (true/false).");
}
function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Worker timing value is invalid.");
  return parsed;
}

/**
 * Une valeur illisible ou hors [0,1] est REFUSÉE au démarrage : une remise de
 * cache mal saisie fausse silencieusement tous les budgets, ce qu'aucun
 * repli implicite ne rendrait visible.
 */
function boundedFraction(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1.`);
  }
  return parsed;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}
