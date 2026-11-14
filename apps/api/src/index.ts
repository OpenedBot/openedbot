import { memberInvitationRoutes } from "./routes/identity/member-invitation-routes";
import { describeInternalSecrets, readInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { workspaceRoutes } from "./routes/identity/workspace-routes";
import { Hono } from "hono";
import { authMiddleware, authRoutes, protectedAuthRoutes, type AppVariables } from "./routes/identity/auth";
import { mobileConnectProtectedRoutes, mobileConnectRoutes } from "./routes/identity/mobile-connect-routes";
import { nativeCodeLoginRoutes } from "./routes/identity/native-code-login-routes";
import { createBlobStore } from "./infrastructure/blob-store";
import { fileBlobRoot, otherBlobBackend } from "@openedbot/platform-config/blob-driver";
import type { AuditArchive } from "@openedbot/runtime-link/application/audit-worm";
import { responseCompression } from "./interfaces/http/compression";
import { assertProductionConfig, readApiConfig } from "./infrastructure/config";
import { flushLinkPersistence } from "./infrastructure/link-shutdown";
import { readRequestBodyLimit } from "./infrastructure/request-body-limit";
import { createDatabase } from "@openedbot/platform-db";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { eventRoutes, internalEventRoutes } from "./routes/events/event-routes";
import { createEventRealtime } from "./routes/events/replay-pollers";
import { runtimeRoutes } from "./routes/runtimes/runtime-routes";
import { connectorReleaseRoutes } from "./routes/runtimes/connector-release-routes";
import { createConnectorReleaseFeed } from "@openedbot/runtime-link/application/connector-release-feed";
import { createHermesUpstreamFeed } from "@openedbot/runtime-link/application/hermes-upstream-feed";
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
import { integrationRouteContext } from "./routes/runtimes/runtime-integration-context";
import { createInventoryWarmer, internalInventoryRoutes } from "./routes/runtimes/runtime-inventory-warm";
import { runtimeModelRoutes } from "./routes/runtimes/runtime-model-routes";
import { runtimeAdminRoutes } from "./routes/runtimes/runtime-admin-routes";
import { runtimeProviderUsageRoutes } from "./routes/runtimes/runtime-provider-usage-routes";
import { runtimeModelContextRoutes } from "./routes/runtimes/runtime-model-context-routes";
import { creationAuditRoutes, runtimeAuditRoutes } from "./routes/runtimes/runtime-audit-routes";
import { createVerdictSigner } from "@openedbot/runtime-link/application/audit-verdict";
import { botRoutes, sectionRoutes } from "./routes/roster/bot-routes";
import { botRoutineRoutes, groupRoutineRoutes, routineRoutes } from "./routes/execution/routine-routes";
import { routineToolMcpRoutes } from "./routes/execution/routine-tool-routes";
import { botRoutineToolRoutes } from "./routes/execution/routine-tool-install-routes";
import { createRoutineToolInstaller, withRoutineToolReconcile } from "./routes/execution/routine-tool-install";
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
import { createPostgresOAuthAttemptStore } from "@openedbot/identity/application/oauth-attempt-store";
import { pushSubscriptionRoutes } from "./routes/notifications/push-subscription-routes";
import { apnsDeviceRoutes } from "./routes/notifications/apns-device-routes";
import { mvpRoutes } from "./routes/mvp-routes";
import { alertChannelRoutes } from "./routes/notifications/alert-channel-routes";
import { miscRoutes } from "./routes/overview/misc-routes";
import { groupRoutes } from "./routes/roster/group-routes";
import { memberRoutes } from "./routes/identity/member-routes";
import { permissionPolicyRoutes } from "./routes/identity/permission-policy-routes";
import { ApiRuntimeMetrics, internalMetricsRoutes, recordApiHeartbeat } from "./routes/platform/metrics-routes";
import { HttpError } from "./interfaces/http/http-error";
import { corsMiddleware } from "./interfaces/http/cors";
import { clientVersionGate } from "./interfaces/http/client-version";
import { createUnhandledErrorJournal, respondToUnhandledError, unhandledErrorJournalWriter } from "./interfaces/http/unhandled-error-journal";
import { HermesEndpointError } from "@openedbot/hermes";
import { accessLogMiddleware, logger, recordErrorCode } from "@openedbot/platform-observability";
import { isRoutineRequest } from "./interfaces/http/routine-requests";
import { API_RATE_RULES, rateLimiter } from "./interfaces/http/rate-limit";
import { apiSecurityHeaders } from "./interfaces/http/security-headers";
import { legalRoutes } from "./routes/legal/legal-routes";
import { workflowRoutes } from "./routes/execution/workflow-routes";
import { teamImportRoutes } from "./routes/portability/team-import-routes";
import { computerRoutes } from "./routes/roster/computer-routes";
import { createComputerProvider } from "./infrastructure/computer-provider";
import { webhookIngressRoutes } from "./routes/webhooks/webhook-ingress-routes";
import { webhookManagementRoutes } from "./routes/webhooks/webhook-management-routes";
import { searchRoutes } from "./routes/conversation/search-routes";
import { inboxRoutes } from "./routes/inbox/inbox-routes";
import { messageVersionRoutes } from "./routes/conversation/message-version-routes";
import { liveProductFeatures, readProductFeatures } from "@openedbot/identity/application/product-features";
import { createEntitlementSource, PRO_ENTITLEMENTS, type EntitlementScope } from "@openedbot/identity/application/entitlements";
import { installOrganizationCreatedListener } from "@openedbot/identity/application/organization-created";
import { installSubscriptionPort } from "@openedbot/identity/application/subscription-port";
import { installOrganizationCreatingListener } from "@openedbot/identity/application/organization-creating";
import { approvalReviewerOf, assertDistinctPluginEnv, assertRequiredPlugins, auditArchiveOf, compatPathAliasesOf, declaredEntitlements, RequiredPluginsMissingError, type ProPlugin } from "@openedbot/platform-plugins";
import { installApprovalReviewer } from "@openedbot/runtimes/application/approval-reviewer";
import { compatPathRedirects } from "./application/compat-aliases";
import {
  assertProPluginProductionEnv,
  describeSkip,
  guardProPlugins,
  hookEntitlementCheck,
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

/** HTTP body ceiling: bounds memory abuse (Bun default ≈ 128 MB). Legitimate
 * attachments (≤ 3 MB decoded, base64 ≈ 4 MB) pass comfortably. */
const MAX_REQUEST_BODY_BYTES = readRequestBodyLimit(process.env.API_MAX_BODY_BYTES);

const baseConfig = readApiConfig();
const runtimeLinkConfig = readRuntimeLinkConfig();
if (baseConfig.environment === "production") assertProductionConfig(baseConfig);
// One secret per internal role: the API checks all four and relays.
const internalSecrets = readInternalSecrets("api", baseConfig.environment);
const db = createDatabase(baseConfig.databaseUrl, baseConfig.databaseMaxConnections);
const productFeatures = await readProductFeatures(db);
// Features toggled from the backoffice: reread live, never frozen at boot.
const liveFeatures = liveProductFeatures(db);
// The other store rereads and deletes objects written before a driver toggle.
const blobs = createBlobStore(baseConfig.blob, otherBlobBackend(
  process.env, baseConfig.blob.driver, fileBlobRoot(process.env, baseConfig.environment === "production"),
));
// Pro plug-ins: empty or absent `OPENEDBOT_PLUGINS` = solo mode, and
// no route is added. An absent, invalid, or refused plug-in is ignored
// with a warning: the API starts anyway.
const loadedPro = await loadApiProPlugins(process.env.OPENEDBOT_PLUGINS, {
  warn: (skip) => logger.warn({ event: "api.pro_plugin_skipped", ...describeSkip(skip) }, "pro plug-in skipped"),
});
// A deployment variable (`manifest.env`) has only one plug-in: two
// loaded plug-ins that declare the same name prevent startup, whatever
// the environment (step 11.5).
assertDistinctPluginEnv(loadedPro.plugins);
// In production, a loaded plug-in missing one of its mandatory deployment
// variables (`manifest.env`, `requiredInProduction`) prevents
// startup (step 11.5); solo requires none.
if (baseConfig.environment === "production") assertProPluginProductionEnv(loadedPro.plugins, process.env);
// A plug-in never receives anything but a database under RLS: if the pool role can
// bypass it, no plug-in is loaded and the API starts in solo.
const pro = {
  ...loadedPro,
  plugins: await guardProPlugins(loadedPro.plugins, db, (reason) =>
    logger.error({ event: "api.pro_plugins_refused", reason }, "pro plug-ins refused: database role is not under row-level security")),
};
const proMode = proModeLabel(pro.plugins);
logger.info({ event: "api.mode", mode: proMode, plugins: pro.plugins.map((plugin) => plugin.manifest.id) }, proMode);
// Legacy installation: empty since step 8, every plug-in comes through
// OPENEDBOT_PLUGINS. Without any: solo.
const legacyPlugins = await loadLegacyPlugins(pro.plugins, {
  skipped: (skip) => logger.warn({ event: "api.legacy_plugin_skipped", ...describeSkip(skip) }, "legacy plug-in skipped"),
  superseded: (event) => logger.info({ event: "api.legacy_plugin_superseded", ...event }, "legacy plug-in already loaded by OPENEDBOT_PLUGINS"),
});
logger.info({ event: "api.legacy_plugins", plugins: legacyPlugins.map((plugin) => plugin.manifest.id) }, "legacy plug-ins installed");
const installedPlugins: readonly ProPlugin[] = [...pro.plugins, ...legacyPlugins];
// OPENEDBOT_REQUIRED_PLUGINS: a deployment that needs a plug-in (the audit
// archive, the reviewer) never starts without it, whatever dropped it.
try {
  assertRequiredPlugins(process.env, installedPlugins, loadedPro.skipped);
} catch (error) {
  if (error instanceof RequiredPluginsMissingError) {
    logger.fatal({ event: "api.required_plugins_missing", missing: error.missing, loaded: installedPlugins.map((plugin) => plugin.manifest.id) }, error.message);
  }
  throw error;
}
// Identity, the queue, and routines read subscriptions only through this port:
// the billing plug-in's (step 8d), otherwise none (solo: neither limit nor paywall).
installSubscriptionPort(subscriptionPortOf(installedPlugins));
// PERM2-7: the automatic reviewer belongs to the plug-in `permissions`; without
// it `auto` acts as `manual` and a new bot starts in `manual`.
installApprovalReviewer(approvalReviewerOf(installedPlugins), (error) =>
  logger.warn({ event: "api.approval_reviewer_ready_failed", error: error instanceof Error ? error.message : String(error) }, "approval reviewer readiness failed"));
const proMountWarning: MountWarning = (event) => logger.warn({ event: "api.pro_mount_skipped", ...event }, "pro api mount skipped");
// What the API lends to plug-ins, under their own id: each sees only its own
// entry. Read at mount, once `config`, the bus, and the blobs are ready.
const proHosts = (): Readonly<Record<string, unknown>> => ({
  // billing (step 8d): the resolved config (`billing.enforced` included).
  billing: { config },
});
const proContext = (plugin: ProPlugin) => proPluginContext(plugin, db, process.env, proHosts());
// What a workspace can use: the whole core; the rest comes from plug-ins,
// and from BILLING_ENFORCED.
const entitlements = createEntitlementSource({
  features: liveFeatures,
  billingEnforced: baseConfig.billingEnforced,
  pro: {
    declared: declaredEntitlements(installedPlugins),
    grant: hookEntitlementCheck(installedPlugins, (event) => logger.warn({ event: "api.pro_entitlement_hook_failed", ...event }, "pro entitlement hook failed"), process.env),
  },
});
const config = { ...baseConfig, billingEnforced: await entitlements.has(PRO_ENTITLEMENTS.billingEnforced) };
if (installedPlugins.length > 0) {
  installOrganizationCreatedListener((organizationId) => notifyOrganizationCreated(installedPlugins, organizationId, (event) =>
    logger.warn({ event: "api.pro_organization_created_hook_failed", organizationId, ...event }, "pro onOrganizationCreated hook failed"), process.env));
}
// What billing attaches to a new organization (the welcome subscription)
// is written INSIDE the creation transaction, by the billing plug-in alone; a
// failure or a deadline overrun cancels creation. In solo: nothing.
const organizationCreating = organizationCreatingHookOf(installedPlugins, process.env);
installOrganizationCreatingListener(organizationCreating);
const isProPublicPath = proPublicPathMatcher(installedPlugins);
const paymentWebhook = paymentWebhookMountOf(loadedPro.plugins, installedPlugins, process.env);
const isPaymentWebhookPath = (path: string) => paymentWebhook !== null && path === paymentWebhook.path;
const hub = new EventHub();
// One LISTEN connection per replica: each commit of
// `run_events` wakes the SSE streams of every replica. Unavailable,
// the API still serves, via the worker's hints and the fallback poll.
const eventRealtime = createEventRealtime(db, baseConfig.databaseUrl, hub);
eventRealtime.start();
const instanceId = `api-${crypto.randomUUID()}`;
const startedAt = new Date();
const authenticate = authMiddleware(db);
// The latest edge-setup release: refreshes config.connectorVersions in place.
const connectorReleases = createConnectorReleaseFeed({ url: config.connectorReleasesUrl, versions: config.connectorVersions });
connectorReleases.start();
createHermesUpstreamFeed({ url: config.hermesUpstreamReleasesUrl, versions: config.connectorVersions }).start();
const app = new Hono<{ Variables: AppVariables }>();
const runtimeMetrics = new ApiRuntimeMetrics();
const computer = createComputerProvider(config.computer);
// A single verdict key per process: publish and sign with the same one.
const verdictSigner = createVerdictSigner(config.auditVerdictSigning);
// The external audit archive of the plug-in `audit` (`auditArchive`); `null`
// (solo, or no such plug-in): PostgreSQL only, the local chain is the anchoring.
const auditArchive: AuditArchive | null = auditArchiveOf(installedPlugins);
// AuditAnchor: the local chain always, then the archive when one is
// installed. A failed external anchoring blocks the write
// for an organization that holds `audit.anchor`; otherwise it is journaled.
const anchorBlocking = (organizationId: string) => entitlements.has(PRO_ENTITLEMENTS.auditAnchor, { organizationId });
// The connector-link broker lives in the process: one connection per
// runtime, held by THIS instance. Routes reach it through `runtimeLinks()`.
// `inventory.changed`: the host says its inventory moved; it is reread
// in the background so Réglages › Connecteurs opens already up to date. The
// embedded broker calls it here; a separate gateway goes through
// `/internal/runtime-inventory/changed`.
// The same signal installs « Programmer depuis le chat » on the bots that lack it (0187).
const routineTools = createRoutineToolInstaller(db, config);
routineTools.startSweep();
const inventoryWarmer = withRoutineToolReconcile(createInventoryWarmer(integrationRouteContext(db, config, {})), routineTools);
const linkBroker = runtimeLinkConfig.mode === "embedded"
  ? new RuntimeLinkBroker({
    instanceId,
    liveness: createLinkLivenessStore(db, { archive: auditArchive, anchorBlocking }),
    onInventoryChanged: (link) => inventoryWarmer.warm(link.organizationId, link.runtimeId),
    onDispatch: (dispatch) => runtimeMetrics.recordHostCall(dispatch),
  })
  : null;
const instanceRegistry = createApiInstanceRegistry(db, {
  instanceId,
  apiInternalUrl: config.apiInternalUrl,
  relay: internalSecrets,
}, startedAt);
const linkLocator = createRuntimeLinkLocator(db, {
  instanceId,
  apiInternalUrl: config.apiInternalUrl,
  relay: internalSecrets,
});
installRuntimeLinkLocator(linkLocator);
installRuntimeLinks(instanceAwareRuntimeLinks(linkBroker ? brokerRuntimeLinks(linkBroker) : NO_RUNTIME_LINKS, linkLocator));
const linkGateway = linkBroker ? createRuntimeLinkGateway({ db, config, broker: linkBroker }) : null;
const idleTimeout = Number(process.env.API_IDLE_TIMEOUT ?? 255);
if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 1 || idleTimeout > 255) {
  throw new Error("API_IDLE_TIMEOUT must be an integer between 1 and 255 seconds.");
}

// Access log: one line per request, before any other logic so the
// measured duration covers CORS, auth, rate limiting, and the route itself.
// The middleware lives in `@openedbot/platform-observability` so it is testable without a database.
app.use("*", accessLogMiddleware({ isRoutine: isRoutineRequest }));

app.use("*", async (context, next) => {
  runtimeMetrics.recordRequest();
  const startedAt = performance.now();
  await next();
  const durationMs = Math.round(performance.now() - startedAt);
  const method = context.req.method;
  const status = context.res.status;
  runtimeMetrics.recordRoute(method, context.req.routePath, status, durationMs);
});
app.use("*", corsMiddleware({ browserOrigins: config.browserOrigins, nativeOrigins: config.nativeClients.origins }));
app.use("/api/*", clientVersionGate(config.nativeClients.minDesktopVersion));

// The outermost of the `/api/*` middlewares: it sees the final response,
// compressed or refused by the rate limiter included. Before `/api/health`:
// a route registered higher would answer without these headers.
app.use("/api/*", apiSecurityHeaders());
app.get("/api/health", async (context) => {
  await db`select 1`;
  // `environment` (dev, preprod, prod) is the tier connectors already receive:
  // the console shows it on the Edge card, where a dev and a prod openedbot linked to
  // the same host otherwise look alike. A tier name is no secret.
  return context.json({ ok: true, version: "0.1.0", architecture: "cloud-only", environment: config.deployEnvironment });
});
// Before the rate limiter: even a 429 is a JSON body, and the compressor must
// wrap every `/api/*` response except those it excludes itself
// (SSE stream `/api/events`, bodies carrying the CSRF token `/api/auth/*`).
app.use("/api/*", responseCompression());
app.use("/api/*", rateLimiter(API_RATE_RULES, { trustProxy: config.trustProxy }));
app.route("/api/auth", authRoutes(db, config));
// Exchange of a Mobile Connect ticket: under `/api/auth/native/`, therefore with no session.
app.route("/api/auth/native/mobile-connect", mobileConnectRoutes(db, config));
// Native sign-in by email code alone (desktop): `/api/auth/native/code/verify`, with no session.
app.route("/api/auth/native/code", nativeCodeLoginRoutes(db, config));
// A member invitation: anonymous preview by its token, answered with the session.
app.route("/api/invite/member", memberInvitationRoutes(db, config));
// The payment webhook, at the path the `billing` plug-in declares
// (`billing.webhookPath`, step 11.5) and outside the session; the core only
// delegates (steps 8c-8d, 11.4). Billing refused by the role guard: 503
// PAYMENT_WEBHOOK_UNAVAILABLE at this path. Solo: no route.
if (paymentWebhook) app.route(paymentWebhook.path, paymentWebhookRoute(db, config, paymentWebhook.delegate));
app.route("/api/legal", legalRoutes(config.legal));
app.route("/internal/events", internalEventRoutes(db, internalSecrets, hub, undefined, () => !eventRealtime.connected()));
app.route("/internal/runtime-inventory", internalInventoryRoutes(internalSecrets, inventoryWarmer));
// Connector-link relay for the worker: the relay secret, flow in
// both directions, never compressed (outside `/api/*`, and excluded by path).
app.route(RUNTIME_LINK_INTERNAL_PREFIX, runtimeLinkInternalRoutes(internalSecrets, linkBroker, linkLocator));
app.route("/internal/metrics", internalMetricsRoutes(config, db, hub, blobs, runtimeMetrics, () => eventRealtime.status()));

app.route("/api/hooks", webhookIngressRoutes(db, config));
// OAuth return of an MCP server: the provider sends the browser there, with no
// guaranteed openedbot session (top-level navigation). This route's only power
// is to relay `code` + `state` to the host, which validates `state`.
app.route("/api/mcp-oauth", mcpOauthCallbackRoutes(db, config));
// `routine_manage` (DEV-209): called by the host's Hermes gateway, over
// https, with the runtime bearer and the run key; never a session.
app.route("/api/mcp/routines", routineToolMcpRoutes(db, internalSecrets));
app.route("/api/mcp/bot-settings", botSettingsToolMcpRoutes(db, internalSecrets));
// `public` mounts of pro plug-ins, under `/api/pro/<id>`: before auth, and
// named in the allow-list below by `isProPublicPath`.
if (installedPlugins.length > 0) {
  app.route("/", proPublicRoutes(installedPlugins, proContext, proMountWarning, { trustProxy: config.trustProxy }));
}
// Old URLs declared by a plug-in (`aliases.paths`): 308 to the new one,
// before auth; never over a core route.
app.use("/api/*", compatPathRedirects(compatPathAliasesOf(installedPlugins), () => app.routes,
  (event) => logger.warn({ event: "api.pro_alias_skipped", ...event }, "pro path alias skipped")));
// Removed API roots (`REMOVED_API_ROOTS`: the
// waitlist, the help desk): 404 in solo as in pro, before auth, so a client
// still on one reads « route introuvable » and not « authentification requise ».
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
  billingEnforced: config.billingEnforced,
  environment: config.environment,
}));
app.route("/api/runtime-enrollments", runtimeEnrollmentClaimRoutes(db, config));
// Before `/api/runtime` so `/exposures/:id` does not fall on `/:runtimeId`.
app.route("/api/runtime/exposures", runtimeExposureRoutes(db, config));
app.route("/api/runtime", runtimeRoutes(db, config, undefined, undefined, productFeatures.connectorOnlyEnrollment));
app.route("/api/runtimes", connectorReleaseRoutes(db, connectorReleases));
app.route("/api/runtimes", runtimeRoutes(db, config, undefined, undefined, productFeatures.connectorOnlyEnrollment));
app.route("/api/runtime", runtimeIntegrationRoutes(db, config));
app.route("/api/runtimes", runtimeModelRoutes(db, config));
app.route("/api/runtimes", runtimeProviderUsageRoutes(db, config));
app.route("/api/runtimes", runtimeModelContextRoutes(db, config));
app.route("/api/runtimes", runtimePermissionRoutes(db));
// Sealed creation audit: verification of an export, history of
// verdicts, key rotation: owner/admin, never the host.
app.route("/api/runtimes", runtimeAuditRoutes(db, config, { signer: verdictSigner, archive: auditArchive, anchorBlocking }));
app.route("/api/creation-audit", creationAuditRoutes(config, { signer: verdictSigner }));
// Always mounted: a `connector` runtime whose host announces
// `provider_management` receives its credentials THROUGH THE LINK, in production
// too. With no channel (neither a local Dashboard, nor a capable link), each route
// answers 404 itself.
app.route("/api/runtimes", runtimeAdminRoutes(db, config));
app.route("/api/bots", botRoutes(db, config));
app.route("/api/bots", computerRoutes(db, computer));
app.route("/api/team-imports", teamImportRoutes(db, config, { blobs }));
app.route("/api/bots", botRoutineRoutes(db));
app.route("/api/bots", botRoutineToolRoutes(routineTools));
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
app.route("/api", mvpRoutes(db));
app.route("/api/attachments", attachmentRoutes(db, blobs));
app.route("/api/events", eventRoutes(db, hub, config.events));
app.route("/api/account/deletion", accountDeletionRoutes(db, config));
// The Google link starts from « Mon compte » and returns through the shared callback
// of `auth.ts`: same attempt store, therefore the same `oauth_attempts` table.
app.route("/api/account/security", accountSecurityRoutes(db, {
  google: createGoogleAuth(config, createPostgresOAuthAttemptStore(db, config.tokenEncryption)),
}));
app.route("/api/push-subscriptions", pushSubscriptionRoutes(db, config));
app.route("/api/push/apns", apnsDeviceRoutes(db, config));
app.route("/api/alert-channels", alertChannelRoutes(db, config));
// Natural-language permission rules (PERM2-6) are no longer served
// here: the pro `permissions` plug-in serves them under `/api/pro/permissions`
// (step 8b); in solo, the route does not exist (404).
app.route("/api/organization/permissions", permissionPolicyRoutes(db));
app.route("/api/organization", memberRoutes(db, config));
// `session` mounts of pro plug-ins, under `/api/pro/<id>`: behind the
// session; without the entitlement the mount declares, the route does not exist (404).
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

// A 500's reference also names an `api_errors` row (0161), written
// after the response, at most a few in flight (unhandled-error-journal.ts).
const unhandledErrors = createUnhandledErrorJournal(unhandledErrorJournalWriter(db));

app.onError((error, context) => {
  if (error instanceof HttpError) {
    if (error.status >= 500) runtimeMetrics.recordServerError();
    for (const [name, value] of Object.entries(error.headers)) context.header(name, value);
    // The code goes in the response AND in the access-log line: the screen
    // shows `SERVER_EXISTS` and a reference, and that reference names a
    // row that says the same thing. Without that it only says « status 409 ».
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
  // A refused Hermes URL is an entry mistake, not an outage. Without this
  // translation, `HermesEndpointError` passed through `onError`: the operator who
  // typed `http://` or a private address read « Erreur interne » with a
  // reference number, instead of the reason: which is already written for them
  // and carries a stable code.
  if (error instanceof HermesEndpointError) {
    recordErrorCode(context.req.raw, error.code);
    return context.json({ error: { code: error.code, message: error.message } }, 400);
  }
  runtimeMetrics.recordServerError();
  return respondToUnhandledError(context, error, { environment: config.environment, journal: unhandledErrors });
});

app.notFound((context) => context.json({ error: { code: "NOT_FOUND", message: "Route introuvable." } }, 404));
// Every route is in place: the payment webhook path must not
// be served by any core route (step 11.5), otherwise no startup.
assertPaymentWebhookPathFree(paymentWebhook, app.routes);

const server = Bun.serve<LinkSocketData>({
  hostname: config.host,
  port: config.port,
  // The connector-link WebSocket upgrade is decided HERE, before Hono:
  // authentication then `server.upgrade`, or an HTTP response (426 without
  // `Upgrade`, 401/409/410/429 otherwise). No Hono route knows this path.
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
  internalSecrets: describeInternalSecrets(internalSecrets),
}, "api started");
// Disk in place of R2: every startup says so, with what R2 is missing.
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

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  // A second signal (dev-watch relays the one the group already received) does not
  // restart the shutdown and does not kill the process before `stopped_at`.
  if (stopping) return;
  stopping = true;
  logger.info({ event: "api.stopping", signal }, "api stopping");
  clearInterval(metricsHeartbeat);
  clearInterval(instanceHeartbeat);
  // 1001: the host reconnects with backoff; `stopped_at` tells the other
  // replicas that this instance no longer holds any link.
  linkBroker?.closeAll();
  if (linkBroker) {
    await flushLinkPersistence(linkBroker, (error) => {
      logger.error({ event: "runtime_link.shutdown_persistence_failed", error }, "link shutdown persistence failed");
    });
  }
  await instanceRegistry.stop().catch(() => undefined);
  await eventRealtime.stop();
  server.stop(false);
  await db`delete from service_instances where id = ${instanceId}`.catch(() => undefined);
  await db.close({ timeout: 5 });
  process.exit(0);
}

// SIGHUP: terminal or tab closed under `make dev`. Without a clean shutdown,
// `stopped_at` stays empty and links stay « connectés » to a dead
// instance: the next one relays to it at startup (503/508).
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => void shutdown(signal));
}
