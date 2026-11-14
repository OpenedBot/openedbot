import { SQL } from "bun";
import { describeInternalSecrets } from "@openedbot/platform-config/internal-secrets";
import { createWorkerService } from "./application/worker-service";
import { readWorkerConfig } from "./config";
import { createRunQueueNotifications } from "./infrastructure/run-queue-notifications";
import { loadWorkerPro, reviewerJobs } from "./application/pro-plugins";
import { maintenanceJobs } from "./application/maintenance-jobs";
import { readQueuedRunsSignature } from "@openedbot/execution/application/queue";
import { installSubscriptionPort } from "@openedbot/identity/application/subscription-port";
import { installTenantDeletingListener } from "@openedbot/identity/application/tenant-deleting";
import { installPermissionRuleSelector } from "@openedbot/execution/application/runner/permission-rule-sources";
import { installApprovalReviewer } from "@openedbot/runtimes/application/approval-reviewer";
import { logEvent } from "@openedbot/platform-observability";
import { RequiredPluginsMissingError } from "@openedbot/platform-plugins";

const baseConfig = readWorkerConfig();
const db = new SQL({
  url: baseConfig.databaseUrl,
  max: baseConfig.databaseMaxConnections,
  idleTimeout: 30,
  connectionTimeout: 10,
});
const pro = await loadWorkerPro(process.env, db, baseConfig, {
  skipped: (skip) => logEvent("worker.pro_plugin_skipped", { specifier: skip.specifier, reason: skip.reason }, "warn"),
  refused: (reason) => logEvent("worker.pro_plugins_refused", { reason }, "error"),
  jobDisabled: (job) => logEvent("worker.pro_job_disabled", { job: job.name, reason: job.reason }),
}).catch((error: unknown) => {
  // OPENEDBOT_REQUIRED_PLUGINS: a deployment that needs a plug-in never runs without it.
  if (error instanceof RequiredPluginsMissingError) {
    logEvent("worker.required_plugins_missing", { missing: error.missing, error: error.message }, "error");
  }
  throw error;
});
installTenantDeletingListener(pro.tenantDeleting);
// Subscriptions are read through the port of the plug-in billing (step 8d);
// without it, none (solo: no limit, no paywall).
installSubscriptionPort(pro.subscriptions);
// PERM2 v2: without the plug-in `permissions` (or for an organization without
// `permissions.v2`) the gates read the core rules, as in solo.
installPermissionRuleSelector(pro.permissionRules, (error) =>
  logEvent("worker.permission_rules_selector_failed", { error: error instanceof Error ? error.message : String(error) }, "warn"));
// PERM2-7: the automatic reviewer is the plug-in `permissions`'. Without it,
// `auto` acts as `manual` and a gate left under review goes to a person.
installApprovalReviewer(pro.approvalReviewer, (error) =>
  logEvent("worker.approval_reviewer_ready_failed", { error: error instanceof Error ? error.message : String(error) }, "warn"));
// `billing.enforced` comes from the EntitlementSource, like the API's.
const config = { ...baseConfig, billingEnforced: pro.billingEnforced };
const worker = createWorkerService(db, config, {
  // The core maintenance passes, then the enabled plug-in jobs.
  jobs: [...maintenanceJobs(db, config), ...pro.jobs, ...reviewerJobs(pro.plugins, db, { config }, process.env)],
  // The probe reads the shared pool only while no LISTEN is acknowledged.
  runQueueNotifications: createRunQueueNotifications(config.databaseUrl, {
    probe: () => readQueuedRunsSignature(db),
  }),
});

function stop(signal: string): void {
  logEvent("worker.stopping", { signal });
  worker.stop(signal);
}

// SIGHUP : terminal fermé sous `make dev`, arrêté comme SIGTERM. `stop`
// est idempotent (abort) : un signal relayé par dev-watch ne tue pas la passe.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => stop(signal));
}

logEvent("worker.started", {
  workerId: config.workerId, environment: config.environment, bunVersion: Bun.version,
  mode: pro.plugins.length ? "pro" : "solo", plugins: pro.plugins.map((plugin) => plugin.manifest.id),
  internalSecrets: describeInternalSecrets(config.internalSecrets),
});
if (config.blob.driver === "file" && config.blob.fallbackReason) {
  logEvent("worker.blob_fallback_file", { root: config.blob.root, reason: config.blob.fallbackReason }, "warn");
}
await worker.run();
// All tracked runs/jobs and database connections have finished. Explicit exit
// also ends Bun's development watcher after an operator-requested shutdown.
process.exit(0);
