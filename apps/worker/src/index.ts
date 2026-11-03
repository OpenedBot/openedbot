import "@openedbot/platform-config/legacy-env-guard"; // first: refuses a retired OHB_* variable before any module reads the environment
import { SQL } from "bun";
import { createWorkerService } from "./application/worker-service";
import { readWorkerConfig } from "./config";
import { createRunQueueNotifications } from "./infrastructure/run-queue-notifications";
import { loadWorkerPro } from "./application/pro-plugins";
import { maintenanceJobs } from "./application/maintenance-jobs";
import { readQueuedRunsSignature } from "@openedbot/execution/application/queue";
import { installSubscriptionPort } from "@openedbot/identity/application/subscription-port";
import { installTenantDeletingListener } from "@openedbot/identity/application/tenant-deleting";
import { installPermissionRuleSelector } from "@openedbot/execution/application/runner/permission-rule-sources";

const baseConfig = readWorkerConfig();
const db = new SQL({
  url: baseConfig.databaseUrl,
  max: baseConfig.databaseMaxConnections,
  idleTimeout: 30,
  connectionTimeout: 10,
});
const pro = await loadWorkerPro(process.env, db, baseConfig, {
  skipped: (skip) => console.warn(JSON.stringify({ event: "worker.pro_plugin_skipped", specifier: skip.specifier, reason: skip.reason })),
  refused: (reason) => console.error(JSON.stringify({ event: "worker.pro_plugins_refused", reason })),
  jobDisabled: (job) => console.info(JSON.stringify({ event: "worker.pro_job_disabled", job: job.name, reason: job.reason })),
});
installTenantDeletingListener(pro.tenantDeleting);
// Subscriptions are read through the port of the plug-in billing (step 8d);
// without it, none (solo: no limit, no paywall).
installSubscriptionPort(pro.subscriptions);
// PERM2 v2: without the plug-in `permissions` (or for an organization without
// `permissions.v2`) the gates read the core rules, as in solo.
installPermissionRuleSelector(pro.permissionRules, (error) =>
  console.warn(JSON.stringify({ event: "worker.permission_rules_selector_failed", error: error instanceof Error ? error.message : String(error) })));
// `billing.enforced` comes from the EntitlementSource, like the API's.
const config = { ...baseConfig, billingEnforced: pro.billingEnforced };
const worker = createWorkerService(db, config, {
  // The core maintenance passes, then the enabled plug-in jobs.
  jobs: [...maintenanceJobs(db, config), ...pro.jobs],
  // OHB-139: the probe reads the shared pool only while no LISTEN is acknowledged.
  runQueueNotifications: createRunQueueNotifications(config.databaseUrl, {
    probe: () => readQueuedRunsSignature(db),
  }),
});

function stop(signal: string): void {
  console.info(JSON.stringify({ event: "worker.stopping", signal }));
  worker.stop(signal);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

console.info(JSON.stringify({
  event: "worker.started", workerId: config.workerId, environment: config.environment, bunVersion: Bun.version,
  mode: pro.plugins.length ? "pro" : "solo", plugins: pro.plugins.map((plugin) => plugin.manifest.id),
}));
if (config.blob.driver === "file" && config.blob.fallbackReason) {
  console.warn(JSON.stringify({ event: "worker.blob_fallback_file", root: config.blob.root, reason: config.blob.fallbackReason }));
}
await worker.run();
// All tracked runs/jobs and database connections have finished. Explicit exit
// also ends Bun's development watcher after an operator-requested shutdown.
process.exit(0);
