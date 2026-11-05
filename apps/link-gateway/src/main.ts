import { Hono } from "hono";
import { createAuditWormStore } from "@openedbot/runtime-link/application/audit-worm";
import { assertProductionConfig, readApiConfig } from "@openedbot/platform-config/api-config";
import { createDatabase } from "@openedbot/platform-db";
import { logger } from "@openedbot/platform-observability";
import { createLinkLivenessStore, RuntimeLinkBroker } from "@openedbot/runtime-link/application/broker";
import { readRuntimeLinkConfig } from "@openedbot/runtime-link/application/config";
import { API_INSTANCE_HEARTBEAT_MS, createApiInstanceRegistry, createRuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import { startRuntimeLinkServer } from "@openedbot/runtime-link/application/server";
import { createRuntimeLinkGateway, RUNTIME_LINK_INTERNAL_PREFIX } from "@openedbot/runtime-link/application/gateway";
import { createConnectorReleaseFeed } from "@openedbot/runtime-link/application/connector-release-feed";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { runtimeLinkInternalRoutes } from "./internal-relay";
import { beforeDeadline, routingLease, SHUTDOWN_STEP_TIMEOUT_MS, stopPersistence } from "./lifecycle";

const config = readApiConfig();
const linkConfig = readRuntimeLinkConfig();
if (linkConfig.mode !== "separate") throw new Error("The persistent gateway requires RUNTIME_LINK_MODE=separate");
if (config.environment === "production") assertProductionConfig(config);
// Pool propre à la passerelle, jamais celui de l'API : voir RUNTIME_LINK_DB_MAX_DEFAULT.
const db = createDatabase(config.databaseUrl, linkConfig.dbMax);
const instanceId = `link-${crypto.randomUUID()}`;
const startedAt = new Date();
const log = (event: string, fields: Record<string, unknown>) => logger.info({ event, instanceId, ...fields }, event);
const instanceConfig = { instanceId, apiInternalUrl: linkConfig.internalUrl, workerInternalToken: config.workerInternalToken };
const registry = createApiInstanceRegistry(db, instanceConfig, startedAt);
const lease = routingLease(registry);
const locator = createRuntimeLinkLocator(db, instanceConfig);
// AuditAnchor : chaîne locale, puis le bucket WORM (installation
// legacy). Aucun plug-in n'est chargé ici : un ancrage externe en échec n'y
// est jamais bloquant, il se journalise (`worm_write_failed`).
// `inventory.changed` : la composition de l'inventaire vit dans l'API ; la
// passerelle lui transmet le runtime à relire (même bearer que les autres
// appels internes). Un signal perdu n'est pas grave : la page relit l'hôte
// quand l'instantané est périmé, et la prochaine connexion en renvoie un.
const signalInventoryChanged = (link: { organizationId: string; runtimeId: string }) => {
  void fetch(`${config.apiInternalUrl}/internal/runtime-inventory/changed`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.workerInternalToken}`, "content-type": "application/json" },
    body: JSON.stringify({ organizationId: link.organizationId, runtimeId: link.runtimeId }),
    signal: AbortSignal.timeout(5_000),
  }).then((response) => {
    if (!response.ok) log("runtime_link.inventory_signal_refused", { runtimeId: link.runtimeId, status: response.status });
  }, (error: unknown) => {
    log("runtime_link.inventory_signal_failed", { runtimeId: link.runtimeId, error: String(error) });
  });
};
const broker = new RuntimeLinkBroker({
  instanceId,
  liveness: createLinkLivenessStore(db, { worm: createAuditWormStore(config.auditWorm) }),
  log,
  onInventoryChanged: signalInventoryChanged,
});
// `link.context` annonce la dernière version d'edge-setup : la même source que l'API.
createConnectorReleaseFeed({ url: config.connectorReleasesUrl, versions: config.connectorVersions }).start();
const gateway = createRuntimeLinkGateway({ db, config, broker, log });
const app = new Hono();
app.get("/health", async (context) => {
  await db`select 1`;
  // Bail expiré : la base répond, mais plus aucune instance ne route vers ces liens.
  if (!lease.fresh()) {
    return context.json({ ok: false, role: "runtime-link-gateway", instanceId, draining: service.draining, reason: "routing_lease_expired" }, 503);
  }
  return context.json({ ok: true, role: "runtime-link-gateway", instanceId, draining: service.draining });
});
app.route(RUNTIME_LINK_INTERNAL_PREFIX, runtimeLinkInternalRoutes(config, broker, locator, {
  isDraining: () => service.draining,
}));
app.onError((error, context) => {
  if (error instanceof HttpError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  logger.error({ event: "runtime_link.http_error", instanceId, error }, "gateway request failed");
  return context.json({ error: { code: "INTERNAL_ERROR" } }, 500);
});
// Register before accepting a socket: every admitted owner must be routable.
await lease.heartbeat();
let heartbeatWork = Promise.resolve();
const heartbeat = setInterval(() => {
  heartbeatWork = heartbeatWork.then(() => lease.heartbeat()).catch((error) => {
    logger.error({ event: "runtime_link.instance_heartbeat_failed", instanceId, error }, "gateway heartbeat failed");
  });
}, API_INSTANCE_HEARTBEAT_MS);
const service = startRuntimeLinkServer({
  gateway, broker, fetch: (request) => app.fetch(request),
  hostname: linkConfig.host, port: linkConfig.port, drainTimeoutMs: linkConfig.drainTimeoutMs, log,
  onStopped: async () => {
    clearInterval(heartbeat);
    await stopPersistence({
      heartbeatWork,
      flush: () => broker.flushPersistence(),
      stopRegistry: () => registry.stop(),
    });
  },
});
log("runtime_link.gateway_started", { url: service.server.url.toString(), startedAt: startedAt.toISOString() });
let shutdownWork: Promise<void> | undefined;
function shutdown(signal: string): Promise<void> {
  return shutdownWork ??= (async () => {
    log("runtime_link.gateway_stopping", { signal });
    try { await service.drain(); }
    finally {
      await beforeDeadline(db.close({ timeout: SHUTDOWN_STEP_TIMEOUT_MS / 1_000 }), Date.now() + SHUTDOWN_STEP_TIMEOUT_MS + 1_000, "database close");
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void shutdown(signal).catch((error) => {
    logger.error({ event: "runtime_link.shutdown_failed", instanceId, error }, "gateway shutdown persistence failed");
    process.exitCode = 1;
  }); });
}
