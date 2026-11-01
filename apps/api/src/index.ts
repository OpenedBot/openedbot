import { memberInvitationRoutes } from "./routes/identity/member-invitation-routes";
import { workspaceRoutes } from "./routes/identity/workspace-routes";
import { Hono } from "hono";
import { authMiddleware, authRoutes, protectedAuthRoutes, type AppVariables } from "./routes/identity/auth";
import { mobileConnectProtectedRoutes, mobileConnectRoutes } from "./routes/identity/mobile-connect-routes";
import { createBlobStore } from "./infrastructure/blob-store";
import { createAuditWormStore } from "@openedbot/runtime-link/application/audit-worm";
import { responseCompression } from "./interfaces/http/compression";
import { assertProductionConfig, readApiConfig } from "./infrastructure/config";
import { createDatabase } from "@openedbot/platform-db";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { createOrderedReplayPump, eventRoutes, internalEventRoutes, replayPagesUntil, shouldEmitSseCursor } from "./routes/events/event-routes";
import { runtimeRoutes } from "./routes/runtimes/runtime-routes";
import { connectorReleaseRoutes } from "./routes/runtimes/connector-release-routes";
import { createConnectorReleaseFeed } from "@openedbot/runtime-link/application/connector-release-feed";
import { runtimeExposureRoutes } from "./routes/runtimes/runtime-exposure-routes";
import {
  createRuntimeLinkGateway,
  RUNTIME_LINK_INTERNAL_PREFIX,
  RUNTIME_LINK_WEBSOCKET_OPTIONS,
  RUNTIME_LINK_WS_PATH,
  runtimeLinkInternalRoutes,
  type LinkSocketData,
} from "./routes/runtimes/runtime-link-routes";
import { readRuntimeLinkConfig } from "@openedbot/runtime-link/application/config";
import { createLinkLivenessStore, RuntimeLinkBroker } from "@openedbot/runtime-link/application/broker";
import { brokerRuntimeLinks, instanceAwareRuntimeLinks, installRuntimeLinks, NO_RUNTIME_LINKS } from "@openedbot/runtime-link/application/dialer";
import {
  API_INSTANCE_HEARTBEAT_MS,
  createApiInstanceRegistry,
  createRuntimeLinkLocator,
  installRuntimeLinkLocator,
} from "@openedbot/runtime-link/application/instances";
import {
  runtimeEnrollmentClaimRoutes,
} from "./routes/runtimes/runtime-enrollment-routes";
import { mcpOauthCallbackRoutes, runtimeIntegrationRoutes } from "./routes/runtimes/runtime-integration-routes";
import { runtimeModelRoutes } from "./routes/runtimes/runtime-model-routes";
import { runtimeAdminRoutes } from "./routes/runtimes/runtime-admin-routes";
import { runtimeProviderUsageRoutes } from "./routes/runtimes/runtime-provider-usage-routes";
import { runtimeModelContextRoutes } from "./routes/runtimes/runtime-model-context-routes";
import { creationAuditRoutes, runtimeAuditRoutes } from "./routes/runtimes/runtime-audit-routes";
import { createVerdictSigner } from "@openedbot/runtime-link/application/audit-verdict";
import { botRoutes, personaDraftRoutes, sectionRoutes } from "./routes/roster/bot-routes";
import { botRoutineRoutes, groupRoutineRoutes, routineRoutes } from "./routes/execution/routine-routes";
import { routineToolMcpRoutes } from "./routes/execution/routine-tool-routes";
import { botRoutineToolRoutes } from "./routes/execution/routine-tool-install-routes";
import { botSettingsToolMcpRoutes } from "./routes/execution/bot-settings-tool-routes";
import { botSettingsToolRoutes } from "./routes/execution/bot-settings-tool-install-routes";
import { botSettingProposalRoutes } from "./routes/roster/bot-setting-proposal-routes";
import { botPermissionGrantRoutes } from "./routes/roster/bot-permission-grant-routes";
import { runtimePermissionRoutes } from "./routes/runtimes/runtime-permission-routes";
import { approvalRoutes, attachmentRoutes, conversationRoutes, runRoutes } from "./routes/conversation/conversation-routes";
import { threadHistoryRoutes } from "./routes/conversation/thread-history-routes";
import { threadCompactRoutes } from "./routes/conversation/thread-compact-routes";
import { paymentWebhookRoute } from "./routes/payments/payment-webhook-route";
import { accountDeletionRoutes, accountDeletionWriteGuard } from "./routes/identity/account-deletion-routes";
import { accountSecurityRoutes } from "./routes/identity/account-security-routes";
import { createGoogleAuth } from "@openedbot/identity/application/google-auth";
import { createPostgresOAuthAttemptStore } from "@openedbot/identity/sql/oauth-attempt-store";
import { pushSubscriptionRoutes } from "./routes/notifications/push-subscription-routes";
import { apnsDeviceRoutes } from "./routes/notifications/apns-device-routes";
import { alertChannelRoutes } from "./routes/notifications/alert-channel-routes";
import { miscRoutes } from "./routes/overview/misc-routes";
import { groupRoutes } from "./routes/roster/group-routes";
import { memberRoutes } from "./routes/identity/member-routes";
import { permissionPolicyRoutes } from "./routes/identity/permission-policy-routes";
import { ApiRuntimeMetrics, internalMetricsRoutes, normalizeOperationalMetrics, recordApiHeartbeat } from "./routes/platform/metrics-routes";
import { HttpError } from "./interfaces/http/http-error";
import { unhandledErrorBody } from "./interfaces/http/unhandled-error";
import { HermesEndpointError } from "@openedbot/hermes";
import { accessLogMiddleware, logger, recordErrorCode, requestIdOf } from "@openedbot/platform-observability";
import { API_RATE_RULES, rateLimiter } from "./interfaces/http/rate-limit";
import { apiSecurityHeaders } from "./interfaces/http/security-headers";
import { legalRoutes } from "./routes/legal/legal-routes";
import { waitlistRoutes } from "./routes/identity/waitlist-routes";
import { workflowRoutes } from "./routes/execution/workflow-routes";
import { teamImportRoutes } from "./routes/portability/team-import-routes";
import { computerRoutes } from "./routes/roster/computer-routes";
import { createComputerProvider } from "./infrastructure/computer-provider";
import { webhookIngressRoutes } from "./routes/webhooks/webhook-ingress-routes";
import { webhookManagementRoutes } from "./routes/webhooks/webhook-management-routes";
import { searchRoutes } from "./routes/conversation/search-routes";
import { inboxRoutes } from "./routes/inbox/inbox-routes";
import { messageVersionRoutes } from "./routes/conversation/message-version-routes";
import {
  initializeProductFeatures,
  isExplicitDevelopmentEnvironment,
  liveProductFeatures,
  readProductFeatures,
} from "@openedbot/identity/application/product-features";
import { fleetBillingEnabled, createEntitlementSource, PRO_ENTITLEMENTS, type EntitlementScope } from "@openedbot/identity/application/entitlements";
import { installOrganizationCreatedListener } from "@openedbot/identity/application/organization-created";
import { installSubscriptionPort } from "@openedbot/identity/application/subscription-port";
import { installOrganizationCreatingListener } from "@openedbot/identity/application/organization-creating";
import { assertDistinctPluginEnv, compatAliasesOf, declaredEntitlements, type ProPlugin } from "@openedbot/platform-plugins";
import { compatHeaderNames, compatPathRedirects, installCompatAliases } from "./application/compat-aliases";
import { fleetHost, optionalSession } from "./application/fleet-host";
import {
  assertProPluginProductionEnv,
  describeSkip,
  guardProPlugins,
  hookEntitlementCheck,
  impersonationSourceOf,
  supportDeskOf,
  supportDeskRoutes,
  loadApiProPlugins,
  notifyOrganizationCreated,
  organizationCreatingHookOf,
  proModeLabel,
  proPublicPathMatcher,
  proPluginContext,
  proPublicRoutes,
  proSessionRoutes,
  assertPaymentWebhookPathFree,
  paymentWebhookMountOf,
  subscriptionPortOf,
  type MountWarning,
} from "./application/pro-plugins";
import { loadLegacyPlugins } from "./application/legacy-plugins";
import { removedApiRoutes } from "./routes/platform/removed-routes";
import { isSessionlessCorePath } from "./interfaces/http/sessionless-paths";

/** Plafond du corps HTTP: borne l'abus mémoire (défaut Bun ≈ 128 Mo). Les pièces
 * jointes légitimes (≤ 3 Mo décodés, base64 ≈ 4 Mo) passent largement. */
const MAX_REQUEST_BODY_BYTES = readRequestBodyLimit(process.env.API_MAX_BODY_BYTES);

const baseConfig = readApiConfig();
const runtimeLinkConfig = readRuntimeLinkConfig();
if (baseConfig.environment === "production") assertProductionConfig(baseConfig);
const db = createDatabase(baseConfig.databaseUrl, baseConfig.databaseMaxConnections);
await initializeProductFeatures(db, isExplicitDevelopmentEnvironment());
const productFeatures = await readProductFeatures(db);
// Features basculées depuis le backoffice : relues à chaud, jamais figées au boot.
const liveFeatures = liveProductFeatures(db);
const blobs = createBlobStore(baseConfig.blob);
// Plug-ins pro : `OPENEDBOT_PLUGINS` vide ou absent = mode solo, et
// aucune route n'est ajoutée. Un plug-in absent, invalide ou refusé est ignoré
// avec un avertissement : l'API démarre quand même.
const loadedPro = await loadApiProPlugins(process.env.OPENEDBOT_PLUGINS, {
  warn: (skip) => logger.warn({ event: "api.pro_plugin_skipped", ...describeSkip(skip) }, "pro plug-in skipped"),
});
// Une variable de déploiement (`manifest.env`) n'a qu'un plug-in : deux
// plug-ins chargés qui déclarent le même nom empêchent le démarrage, quel que
// soit l'environnement (étape 11.5).
assertDistinctPluginEnv(loadedPro.plugins);
// En production, un plug-in chargé à qui manque une de ses variables de
// déploiement obligatoires (`manifest.env`, `requiredInProduction`) empêche
// le démarrage (étape 11.5) ; le solo n'en exige aucune.
if (baseConfig.environment === "production") assertProPluginProductionEnv(loadedPro.plugins, process.env);
// Un plug-in ne reçoit jamais qu'une base sous RLS : si le rôle du pool peut
// la contourner, aucun plug-in n'est chargé et l'API démarre en solo.
const pro = {
  ...loadedPro,
  plugins: await guardProPlugins(loadedPro.plugins, db, (reason) =>
    logger.error({ event: "api.pro_plugins_refused", reason }, "pro plug-ins refused: database role is not under row-level security")),
};
const proMode = proModeLabel(pro.plugins);
logger.info({ event: "api.mode", mode: proMode, plugins: pro.plugins.map((plugin) => plugin.manifest.id) }, proMode);
// Installation legacy : vide depuis l'étape 8, le backoffice (`staff`) vient
// d'un plug-in externe par OPENEDBOT_PLUGINS et sert `/api/pro/staff`. Sans lui :
// solo, sans backoffice.
const legacyPlugins = await loadLegacyPlugins(pro.plugins, {
  skipped: (skip) => logger.warn({ event: "api.legacy_plugin_skipped", ...describeSkip(skip) }, "legacy plug-in skipped"),
  superseded: (event) => logger.info({ event: "api.legacy_plugin_superseded", ...event }, "legacy plug-in already loaded by OPENEDBOT_PLUGINS"),
});
logger.info({ event: "api.legacy_plugins", plugins: legacyPlugins.map((plugin) => plugin.manifest.id) }, "legacy plug-ins installed");
const installedPlugins: readonly ProPlugin[] = [...pro.plugins, ...legacyPlugins];
// Identity, la file et les routines ne lisent les abonnements que par ce port :
// celui du plug-in billing (étape 8d), sinon aucun (solo : ni limite ni paywall).
installSubscriptionPort(subscriptionPortOf(installedPlugins));
const proMountWarning: MountWarning = (event) => logger.warn({ event: "api.pro_mount_skipped", ...event }, "pro api mount skipped");
// Ce que l'API prête aux plug-ins qu'elle connaît, par id : chacun ne voit que
// sa propre entrée. Lu au montage, une fois `config`, le bus et les blobs prêts.
const proHosts = (): Readonly<Record<string, unknown>> => ({
  // billing (étape 8d) : la config résolue (billing.enforced compris) et le
  // switch `fleet.billing` lu pour le même spectateur que le cœur le lisait.
  billing: {
    config,
    fleetBillingEnabled: (viewer: EntitlementScope) => fleetBillingEnabled(entitlements, viewer),
  },
  // fleet (étape 11.2) : prêté au plug-in qui apporte la capacité
  // `fleet.workspaces`, quel que soit son id (`capabilitiesOf`).
  fleet: fleetHost(db, config, entitlements),
  // staff : le backoffice et, depuis l'étape 11.3, le guichet de support
  // (`supportDesk`). Le cœur ne prête que des ports neutres : la session
  // facultative, la mécanique de rejeu SSE et la normalisation des métriques.
  staff: {
    config,
    blobs,
    session: { optional: optionalSession(db) },
    services: {
      sse: { createOrderedReplayPump, replayPagesUntil, shouldEmitSseCursor },
      normalizeOperationalMetrics,
    },
  },
});
const proContext = (plugin: ProPlugin) => proPluginContext(plugin, db, process.env, proHosts());
// Ce qu'un espace peut utiliser : tout le cœur ; le reste vient des plug-ins,
// et de BILLING_ENFORCED. Les switches staff de flotte n'ouvrent la capacité
// `fleet.*` que si un plug-in chargé la déclare : en solo, pas de flotte.
// Les anciens noms (en-tête, URL, clé d'entitlement) ne vivent que dans les
// alias déclarés par un plug-in (étape 11.2) : le cœur n'en garde aucun.
const compatAliases = compatAliasesOf(installedPlugins);
installCompatAliases(compatAliases);
const entitlements = createEntitlementSource({
  features: liveFeatures,
  billingEnforced: baseConfig.billingEnforced,
  pro: {
    aliases: compatAliases.entitlements,
    declared: declaredEntitlements(installedPlugins),
    grant: hookEntitlementCheck(installedPlugins, (event) => logger.warn({ event: "api.pro_entitlement_hook_failed", ...event }, "pro entitlement hook failed"), process.env),
  },
});
const config = { ...baseConfig, billingEnforced: await entitlements.has(PRO_ENTITLEMENTS.billingEnforced) };
if (installedPlugins.length > 0) {
  installOrganizationCreatedListener((organizationId) => notifyOrganizationCreated(installedPlugins, organizationId, (event) =>
    logger.warn({ event: "api.pro_organization_created_hook_failed", organizationId, ...event }, "pro onOrganizationCreated hook failed"), process.env));
}
// Ce que billing attache à une organisation neuve (l'abonnement de bienvenue)
// s'écrit DANS la transaction de création, par le seul plug-in billing ; un
// échec ou un dépassement du délai annule la création. En solo : rien.
const organizationCreating = organizationCreatingHookOf(installedPlugins, process.env);
installOrganizationCreatingListener(organizationCreating);
const isProPublicPath = proPublicPathMatcher(installedPlugins);
const paymentWebhook = paymentWebhookMountOf(loadedPro.plugins, installedPlugins, process.env);
const isPaymentWebhookPath = (path: string) => paymentWebhook !== null && path === paymentWebhook.path;
// Le mode assistance : seul le plug-in du backoffice ouvre une session ; en solo, aucune.
const impersonation = impersonationSourceOf(installedPlugins, (event) =>
  logger.warn({ event: "api.pro_impersonation_ignored", ...event }, "second impersonation source ignored"));
const hub = new EventHub();
// Le guichet de support (étape 11.3) : celui d'un plug-in, le premier qui en apporte un ; en solo, aucun.
const supportDesk = supportDeskOf(installedPlugins, (event) =>
  logger.warn({ event: "api.pro_support_desk_ignored", ...event }, "second support desk ignored"));
const instanceId = `api-${crypto.randomUUID()}`;
const startedAt = new Date();
const authenticate = authMiddleware(db, entitlements);
// La dernière release d'edge-setup : relève config.connectorVersions en place.
const connectorReleases = createConnectorReleaseFeed({ url: config.connectorReleasesUrl, versions: config.connectorVersions });
connectorReleases.start();
const app = new Hono<{ Variables: AppVariables }>();
const runtimeMetrics = new ApiRuntimeMetrics();
const computer = createComputerProvider(config.computer);
// Une seule clé de verdict par processus : la publier et signer avec la même.
const verdictSigner = createVerdictSigner(config.auditVerdictSigning);
// Le bucket WORM (OHB-57) : ancres et verdicts y sont déposés une fois ; `null` hors production sans R2.
const auditWorm = createAuditWormStore(config.auditWorm);
// AuditAnchor : la chaîne locale toujours, puis le bucket WORM (installation
// legacy jusqu'à l'étape 8). Un ancrage externe en échec bloque l'écriture
// pour une organisation qui tient `audit.anchor` ; sinon il se journalise.
const anchorBlocking = (organizationId: string) => entitlements.has(PRO_ENTITLEMENTS.auditAnchor, { organizationId });
// Le broker du lien connecteur vit dans le processus : une connexion par
// runtime, tenue par CETTE instance. Les routes le joignent par `runtimeLinks()`.
const linkBroker = runtimeLinkConfig.mode === "embedded"
  ? new RuntimeLinkBroker({ instanceId, liveness: createLinkLivenessStore(db, { worm: auditWorm, anchorBlocking }) })
  : null;
const instanceRegistry = createApiInstanceRegistry(db, {
  instanceId,
  apiInternalUrl: config.apiInternalUrl,
  workerInternalToken: config.workerInternalToken,
}, startedAt);
const linkLocator = createRuntimeLinkLocator(db, {
  instanceId,
  apiInternalUrl: config.apiInternalUrl,
  workerInternalToken: config.workerInternalToken,
});
installRuntimeLinkLocator(linkLocator);
installRuntimeLinks(instanceAwareRuntimeLinks(linkBroker ? brokerRuntimeLinks(linkBroker) : NO_RUNTIME_LINKS, linkLocator));
const linkGateway = linkBroker ? createRuntimeLinkGateway({ db, config, broker: linkBroker }) : null;
const idleTimeout = Number(process.env.API_IDLE_TIMEOUT ?? 255);
if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 1 || idleTimeout > 255) {
  throw new Error("API_IDLE_TIMEOUT must be an integer between 1 and 255 seconds.");
}

// Access-log : une ligne par requête, avant toute autre logique pour que la
// durée mesurée couvre CORS, l'auth, le rate limiting et la route elle-même.
// Le middleware vit dans `@openedbot/platform-observability` pour être testable sans base.
app.use("*", accessLogMiddleware());

app.use("*", async (context, next) => {
  runtimeMetrics.recordRequest();
  const origin = context.req.header("Origin");
  if (origin && config.browserOrigins.includes(origin)) {
    context.header("Access-Control-Allow-Origin", origin);
    context.header("Access-Control-Allow-Credentials", "true");
    context.header("Vary", "Origin");
  }
  if (context.req.method === "OPTIONS") {
    context.header("Access-Control-Allow-Headers", ["Authorization", "Content-Type", "Idempotency-Key", "X-CSRF-Token", "X-OHB-Organization", "X-OHB-Fleet", ...compatHeaderNames(), "X-OHB-Support-Token", "Last-Event-ID"].join(", "));
    context.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    return context.body(null, 204);
  }
  await next();
});

// Le plus à l'extérieur des middlewares `/api/*` : il voit la réponse finale,
// compressée ou refusée par le rate limiter comprise. Avant `/api/health` :
// une route enregistrée plus haut répondrait sans ces en-têtes.
app.use("/api/*", apiSecurityHeaders());
app.get("/api/health", async (context) => {
  await db`select 1`;
  // `environment` (dev, preprod, prod) is the tier connectors already receive:
  // the console shows it on the Edge card, where a dev and a prod openedbot linked to
  // the same host otherwise look alike. A tier name is no secret.
  // `supportDesk` : un plug-in sert le guichet (`/api/support`) ; la console
  // cache le lanceur, le bouton d'en-tête et l'écran sans lui (solo).
  return context.json({ ok: true, version: "1.0.0", architecture: "cloud-only", environment: config.deployEnvironment, supportDesk: supportDesk !== null });
});
// Avant le rate limiter : même un 429 est un corps JSON, et le compresseur doit
// envelopper toutes les réponses `/api/*` sauf celles qu'il exclut lui-même
// (flux SSE `/api/events`, corps porteurs du jeton CSRF `/api/auth/*`).
app.use("/api/*", responseCompression());
app.use("/api/*", rateLimiter(API_RATE_RULES, { trustProxy: config.trustProxy }));
app.route("/api/auth", authRoutes(db, config, entitlements, impersonation));
// Échange d’un ticket Mobile Connect : sous `/api/auth/native/`, donc sans session.
app.route("/api/auth/native/mobile-connect", mobileConnectRoutes(db, config));
app.route("/api/invite/member", memberInvitationRoutes(db, config));
// Le webhook de paiement, au chemin que déclare le plug-in `billing`
// (`billing.webhookPath`, étape 11.5) et hors session ; le cœur ne fait que
// déléguer (étapes 8c-8d, 11.4). Billing refusé par le garde de rôle : 503
// PAYMENT_WEBHOOK_UNAVAILABLE à ce chemin. Solo : aucune route.
if (paymentWebhook) app.route(paymentWebhook.path, paymentWebhookRoute(db, config, paymentWebhook.delegate));
app.route("/api/legal", legalRoutes(config.legal));
app.route("/api/waitlist", waitlistRoutes(db, config));
// Le guichet de support : sans session, hors tenant. Monté AVANT l'auth, et
// nommé dans l'allow-list ci-dessous : l'ordre d'enregistrement seul a déjà
// suffi à rendre une route publique par accident, il ne suffira pas ici.
// Depuis l'étape 11.3, le plug-in qui apporte `supportDesk` y répond ; sans
// lui, 404 `NOT_FOUND` sur tout le préfixe (solo).
app.route("/", supportDeskRoutes(supportDesk, proContext, proMountWarning, { trustProxy: config.trustProxy }));
app.route("/internal/events", internalEventRoutes(db, config, hub));
// Relais du lien connecteur pour le worker : même bearer interne, flux dans
// les deux sens, jamais compressé (hors `/api/*`, et exclu par chemin).
app.route(RUNTIME_LINK_INTERNAL_PREFIX, runtimeLinkInternalRoutes(config, linkBroker, linkLocator));
app.route("/internal/metrics", internalMetricsRoutes(config, db, hub, blobs, runtimeMetrics));

app.route("/api/hooks", webhookIngressRoutes(db, config));
// Retour OAuth d'un serveur MCP : le fournisseur y renvoie le navigateur, sans
// session openedbot garantie (navigation de premier niveau). Le seul pouvoir de
// cette route est de relayer `code` + `state` à l'hôte, qui valide `state`.
app.route("/api/mcp-oauth", mcpOauthCallbackRoutes(db, config));
// `routine_manage` (DEV-209) : appelé par le gateway Hermes de l'hôte, en
// https, avec le bearer du runtime et la clé du run ; jamais une session.
app.route("/api/mcp/routines", routineToolMcpRoutes(db, config));
app.route("/api/mcp/bot-settings", botSettingsToolMcpRoutes(db, config));
// Montages `public` des plug-ins pro, sous `/api/pro/<id>` : avant l'auth, et
// nommés dans l'allow-list ci-dessous par `isProPublicPath`.
if (installedPlugins.length > 0) {
  app.route("/", proPublicRoutes(installedPlugins, proContext, proMountWarning, { trustProxy: config.trustProxy }));
}
// Anciennes URL déclarées par un plug-in (`aliases.paths`, étape 11.2) : 308
// vers la nouvelle, avant l'auth ; jamais par-dessus une route du cœur.
app.use("/api/*", compatPathRedirects(compatAliases.paths, () => app.routes,
  (event) => logger.warn({ event: "api.pro_alias_skipped", ...event }, "pro path alias skipped")));
// L'ancien chemin du backoffice, retiré : 404 en solo comme en pro, avant
// l'auth, pour qu'un client resté sur `/api/staff` lise « route introuvable »
// et non « authentification requise ». Le backoffice est sous `/api/pro/staff`.
app.route("/", removedApiRoutes());

app.use("/api/*", async (context, next) => {
  const path = context.req.path;
  if (isSessionlessCorePath(path) || isProPublicPath(path) || isPaymentWebhookPath(path)) return next();
  return authenticate(context, next);
});
app.use("/api/*", accountDeletionWriteGuard(db));

app.route("/api/auth", protectedAuthRoutes(db, entitlements));
app.route("/api/auth/mobile-connect", mobileConnectProtectedRoutes(db, config));
app.route("/api/account", workspaceRoutes(db, {
  agencyAvailable: entitlements,
  billingEnforced: config.billingEnforced,
  environment: config.environment,
}));
app.route("/api/runtime-enrollments", runtimeEnrollmentClaimRoutes(db, config));
// OHB-75 : avant `/api/runtime` pour que `/exposures/:id` ne tombe pas sur `/:runtimeId`.
app.route("/api/runtime/exposures", runtimeExposureRoutes(db, config));
app.route("/api/runtime", runtimeRoutes(db, config, undefined, undefined, productFeatures.connectorOnlyEnrollment));
app.route("/api/runtimes", connectorReleaseRoutes(db, connectorReleases));
app.route("/api/runtimes", runtimeRoutes(db, config, undefined, undefined, productFeatures.connectorOnlyEnrollment));
app.route("/api/runtime", runtimeIntegrationRoutes(db, config));
app.route("/api/runtimes", runtimeModelRoutes(db, config));
app.route("/api/runtimes", runtimeProviderUsageRoutes(db, config));
app.route("/api/runtimes", runtimeModelContextRoutes(db, config));
app.route("/api/runtimes", runtimePermissionRoutes(db));
// Audit de création scellé : vérification d'un export, historique des
// verdicts, rotation de la clé : owner/admin, jamais l'hôte.
app.route("/api/runtimes", runtimeAuditRoutes(db, config, { signer: verdictSigner, worm: auditWorm, anchorBlocking }));
app.route("/api/creation-audit", creationAuditRoutes(config, { signer: verdictSigner }));
// Toujours montées : un runtime `connector` dont l'hôte annonce
// `provider_management` reçoit ses credentials PAR LE LIEN, en production
// aussi. Sans canal (ni Dashboard local, ni lien capable), chaque route
// répond 404 elle-même.
app.route("/api/runtimes", runtimeAdminRoutes(db, config));
app.route("/api/bots", botRoutes(db, config));
app.route("/api/persona-drafts", personaDraftRoutes(db, config));
app.route("/api/bots", computerRoutes(db, computer));
app.route("/api/team-imports", teamImportRoutes(db, config, { blobs }));
app.route("/api/bots", botRoutineRoutes(db));
app.route("/api/bots", botRoutineToolRoutes(db, config));
app.route("/api/bots", botSettingsToolRoutes(db, config));
app.route("/api/bots", botSettingProposalRoutes(db));
app.route("/api/bots", botPermissionGrantRoutes(db));
app.route("/api/groups", groupRoutineRoutes(db));
app.route("/api/routines", routineRoutes(db, config.billingEnforced));
app.route("/api/sections", sectionRoutes(db));
app.route("/api/groups", groupRoutes(db));
app.route("/api/threads", conversationRoutes(db, blobs, config));
app.route("/api/threads", threadHistoryRoutes(db));
app.route("/api/threads", threadCompactRoutes(db, config));
app.route("/api/threads", messageVersionRoutes(db, blobs, config));
app.route("/api/webhooks", webhookManagementRoutes(db, config));
app.route("/api/runs", runRoutes(db));
app.route("/api/workflows", workflowRoutes(db));
app.route("/api/approvals", approvalRoutes(db));
app.route("/api/attachments", attachmentRoutes(db, blobs));
app.route("/api/events", eventRoutes(db, hub, config.events, entitlements));
app.route("/api/account/deletion", accountDeletionRoutes(db, config));
// La liaison Google part de « Mon compte » et revient par le callback commun
// d'`auth.ts` : même store de tentatives, donc même table `oauth_attempts`.
app.route("/api/account/security", accountSecurityRoutes(db, {
  google: createGoogleAuth(config, createPostgresOAuthAttemptStore(db, config.tokenEncryption)),
}));
app.route("/api/push-subscriptions", pushSubscriptionRoutes(db, config));
app.route("/api/push/apns", apnsDeviceRoutes(db, config));
app.route("/api/alert-channels", alertChannelRoutes(db, config));
// Les règles de permission en langage naturel (PERM2-6) ne sont plus servies
// ici : le plug-in pro `permissions` les sert sous `/api/pro/permissions`
// (étape 8b) ; en solo, la route n'existe pas (404).
app.route("/api/organization/permissions", permissionPolicyRoutes(db));
app.route("/api/organization", memberRoutes(db, config));
// Montages `session` des plug-ins pro, sous `/api/pro/<id>` : derrière la
// session ; sans l'entitlement déclaré par le montage, la route n'existe pas (404).
if (installedPlugins.length > 0) {
  app.route("/", proSessionRoutes(installedPlugins, proContext, {
    entitled: (caller, entitlement) => entitlements.has(entitlement, caller as EntitlementScope),
    caller: (context) => (context.var as Partial<AppVariables>).auth,
    warn: proMountWarning,
  }));
}
app.route("/api", miscRoutes(db, config));
app.route("/api", searchRoutes(db));
app.route("/api", inboxRoutes(db));

app.onError((error, context) => {
  if (error instanceof HttpError) {
    if (error.status >= 500) runtimeMetrics.recordServerError();
    for (const [name, value] of Object.entries(error.headers)) context.header(name, value);
    // Le code part dans la réponse ET dans la ligne d'access-log : l'écran
    // affiche `SERVER_EXISTS` et une référence, et cette référence désigne une
    // ligne qui dit la même chose. Sans ça elle ne dit que « status 409 ».
    recordErrorCode(context.req.raw, error.code);
    return context.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.detail ? { detail: error.detail } : {}),
          ...(error.details ? { details: error.details } : {}),
        },
      },
      error.status as 400,
    );
  }
  // Une URL Hermes refusée est une faute de saisie, pas une panne. Sans cette
  // traduction, `HermesEndpointError` traversait `onError` : l'opérateur qui
  // tapait `http://` ou une adresse privée lisait « Erreur interne » avec un
  // numéro de référence, au lieu de la raison : qui est déjà rédigée pour lui
  // et porte un code stable.
  if (error instanceof HermesEndpointError) {
    recordErrorCode(context.req.raw, error.code);
    return context.json({ error: { code: error.code, message: error.message } }, 400);
  }
  runtimeMetrics.recordServerError();
  // Le MÊME identifiant que la ligne d'access-log et que l'en-tête
  // `X-Request-Id` : la référence lue par l'utilisateur désigne une ligne
  // qu'un opérateur peut retrouver.
  const requestId = requestIdOf(context.req.raw);
  recordErrorCode(context.req.raw, "INTERNAL_ERROR");
  // `String(error)` seul rendait la référence inexploitable : une erreur
  // PostgreSQL se lit par son `code`, sa `constraint` et son `detail`.
  const pg = error as Partial<{ code: string; constraint: string; detail: string; stack: string }>;
  logger.error({
    event: "api.unhandled_error",
    requestId,
    error: String(error),
    stack: typeof pg.stack === "string" ? pg.stack : undefined,
    pgCode: typeof pg.code === "string" ? pg.code : undefined,
    constraint: typeof pg.constraint === "string" ? pg.constraint : undefined,
    detail: typeof pg.detail === "string" ? pg.detail : undefined,
  }, "unhandled error");
  // Jamais « HTTP 500 » nu à l'écran : la cause, traduite, et la référence ;
  // le texte brut en plus hors production (unhandled-error.ts).
  return context.json({ error: unhandledErrorBody(error, requestId, config.environment) }, 500);
});

app.notFound((context) => context.json({ error: { code: "NOT_FOUND", message: "Route introuvable." } }, 404));
// Toutes les routes sont posées : le chemin du webhook de paiement ne doit
// être servi par aucune route du cœur (étape 11.5), sinon pas de démarrage.
assertPaymentWebhookPathFree(paymentWebhook, app.routes);

const server = Bun.serve<LinkSocketData>({
  hostname: config.host,
  port: config.port,
  // La montée WebSocket du lien connecteur est décidée ICI, avant Hono :
  // authentification puis `server.upgrade`, ou une réponse HTTP (426 sans
  // `Upgrade`, 401/409/410/429 sinon). Aucune route Hono ne connaît ce chemin.
  fetch(request, bunServer) {
    if (new URL(request.url).pathname === RUNTIME_LINK_WS_PATH) {
      if (linkGateway) return linkGateway.handleUpgrade(request, bunServer);
      return Response.json({ error: { code: "RUNTIME_LINK_SEPARATE", message: "Le lien connecteur est servi par la passerelle dédiée." } }, { status: 503 });
    }
    return app.fetch(request, bunServer);
  },
  websocket: {
    ...RUNTIME_LINK_WEBSOCKET_OPTIONS,
    open: (ws) => linkGateway?.websocket.open(ws),
    message: (ws, message) => linkGateway?.websocket.message(ws, message),
    close: (ws, code, reason) => linkGateway?.websocket.close(ws, code, reason),
    pong: (ws) => linkGateway?.websocket.pong(ws),
  },
  idleTimeout,
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
});

logger.info({
  event: "api.started",
  url: server.url.toString(),
  environment: config.environment,
  blobDriver: config.blob.driver,
}, "api started");
// Le disque à la place de R2 : chaque démarrage le dit, avec ce qui manque à R2.
if (config.blob.driver === "file" && config.blob.fallbackReason) {
  logger.warn({
    event: "api.blob_fallback_file",
    root: config.blob.root,
    reason: config.blob.fallbackReason,
  }, "attachments stored on the server volume: R2 is not configured");
}

await recordApiHeartbeat(db, instanceId, hub.subscriberCount(), startedAt);
await instanceRegistry.heartbeat().catch((error) => {
  logger.error({ event: "api.instance_heartbeat_failed", error: String(error) }, "instance heartbeat failed");
});
const metricsHeartbeat = setInterval(() => {
  void recordApiHeartbeat(db, instanceId, hub.subscriberCount(), startedAt).catch((error) => {
    logger.error({ event: "api.metrics_heartbeat_failed", error: String(error) }, "metrics heartbeat failed");
  });
}, 5_000);
const instanceHeartbeat = setInterval(() => {
  void instanceRegistry.heartbeat().catch((error) => {
    logger.error({ event: "api.instance_heartbeat_failed", error: String(error) }, "instance heartbeat failed");
  });
}, API_INSTANCE_HEARTBEAT_MS);

async function shutdown(signal: string): Promise<void> {
  logger.info({ event: "api.stopping", signal }, "api stopping");
  clearInterval(metricsHeartbeat);
  clearInterval(instanceHeartbeat);
  // 1001 : l'hôte reconnecte avec backoff ; `stopped_at` dit aux autres
  // répliques que cette instance ne tient plus aucun lien.
  linkBroker?.closeAll();
  if (linkBroker) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        linkBroker.flushPersistence(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Link persistence shutdown timeout")), 5_000); }),
      ]);
    } catch (error) {
      logger.error({ event: "runtime_link.shutdown_persistence_failed", error }, "link shutdown persistence failed");
    } finally { clearTimeout(timer); }
  }
  await instanceRegistry.stop().catch(() => undefined);
  server.stop(false);
  await db`delete from service_instances where id = ${instanceId}`.catch(() => undefined);
  await db.close({ timeout: 5 });
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

function readRequestBodyLimit(value: string | undefined): number {
  const limit = Number(value ?? 16 * 1024 * 1024);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024 * 1024) {
    throw new Error("API_MAX_BODY_BYTES must be an integer between 1 and 67108864.");
  }
  return limit;
}
