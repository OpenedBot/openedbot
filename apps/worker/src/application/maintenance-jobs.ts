import type { SQL } from "bun";
import type { WorkerConfig } from "../config";
import { guardedPass, type BackgroundJob } from "./background-jobs";
import { deleteBlob } from "../infrastructure/blob-store";
import { reapPoisonRuns, sweepExpiredRuns } from "@openedbot/execution/application/queue";
import { purgeOldToolErrors } from "@openedbot/execution/application/tool-errors";
import { processTenantDeletion } from "@openedbot/identity/application/tenant-deletion";
import { tenantPurgeProfileJobs } from "@openedbot/portability/application/tenant-purge";
import { purgeDeadSessions, purgeSpentEmailLoginCodes } from "@openedbot/identity/application/auth-retention";
import { purgeDeliveredEmails } from "@openedbot/notifications/application/email-retention";
import {
  createTransactionalEmailSender,
  processEmailOutbox,
  type TransactionalEmailSender,
} from "@openedbot/notifications/application/email";
import { maintainMessageIngress } from "@openedbot/conversation/application/message-ingress-maintenance";
import { processPushNotifications } from "@openedbot/notifications/application/push-notifications";
import { processApnsDeliveries } from "@openedbot/notifications/application/apns-deliveries";
import { processAlertDeliveries } from "@openedbot/notifications/application/alert-deliveries";
import { processProfileImport, purgeOldProfileImports } from "../maintenance/profile-imports";
import { processProfileDelete, purgeOldProfileDeletes } from "../maintenance/profile-deletes";
import { processProfileProvision } from "../maintenance/profile-provisions";
import { processRuntimeModelSelection } from "../maintenance/runtime-model-selection";
import { processBotHostCleanup } from "../maintenance/bot-host-cleanups";
import { purgeOldApiErrors } from "../maintenance/api-errors";
import { reconcileHostApprovalPolicies } from "../maintenance/approval-policy-reconciliation";
import { reconcileCapabilityBaselines } from "../maintenance/capability-baseline-reconciliation";
import { handOffReviewGates } from "@openedbot/execution/application/review-handoff";
import { approvalReviewerInstalled } from "@openedbot/runtimes/application/approval-reviewer";
import { processExecutionCommands } from "../maintenance/execution-commands";
import { COMMAND_RETENTION_DAYS } from "@openedbot/execution/application/execution-commands";
import { purgeSettledExecutionCommands } from "@openedbot/execution/application/execution-commands";
import { fireDueRoutine, purgeOldRunEvents } from "@openedbot/execution/application/routines";
import { purgeStaleRuntimeEnrollments } from "@openedbot/runtimes/application/runtime-enrollment";
import { expireRotatedLinkTokens } from "@openedbot/runtimes/application/runtime-link-rows";
import {
  LINK_SECURITY_TICK_MS,
  purgeOldRuntimeLinkEvents,
  reconcileRuntimeSessions,
  rotateStaleLinkTokens,
  sweepDisconnectedRuntimeLinks,
} from "@openedbot/runtime-link/application/runtime-links";
import { evaluateRuntimeLinkAlerts } from "@openedbot/runtime-link/application/link-alerts";
import { DIRECT_PROBE_TICK_MS, probeDirectRuntimes, failRunsOnUnhealthyDirectRuntimes } from "@openedbot/execution/application/runtime-direct";
import { failRunsOnDisconnectedRuntimes } from "@openedbot/execution/application/disconnected-runtime-runs";
import { MANAGED_EXPOSURE_TICK_MS, cleanupRevokedManagedExposures, reconcileManagedExposures } from "@openedbot/runtimes/application/managed-exposure-reconciliation";
import { logEvent } from "@openedbot/platform-observability";
import { API_INSTANCE_DEAD_AFTER_MS } from "@openedbot/runtime-link/application/instances";

/** Poison leases only exist once a 30 s lease has expired: a second is ample. */
const POISON_REAP_TICK_MS = 1_000;
/** A recorded command is claimed within this, LISTEN or not: the API is waiting for it. */
const EXECUTION_COMMAND_TICK_MS = 250;
const EVENT_RETENTION_TICK_MS = 60_000;
/**
 * Rework-flux-api step 3: safety nets, not the path a person waits on.
 * Provisioning writes and proves the approval policy and the capability
 * baseline itself; these passes repair what drifted or failed. A bot whose
 * policy write failed is refused a `v2` run until repaired: 15 s, not 30.
 */
const APPROVAL_POLICY_RECONCILE_TICK_MS = 15_000;
const CAPABILITY_BASELINE_TICK_MS = 30_000;
/** A gate under review with no reviewer reaches a person within this. */
const REVIEW_HANDOFF_TICK_MS = 1_000;
const REVIEW_HANDOFF_BATCH = 20;
/**
 * With a reviewer installed (plug-in `permissions`), the hand-off is only a
 * safety net: it waits well past the reviewer's 15 s budget and its 25 s
 * lease, so it never races a live review.
 */
const REVIEW_HANDOFF_GRACE_MS = 120_000;

/**
 * Every periodic worker pass, each on its own single-flight fiber. A job that
 * calls a third party (SMTP, push, R2, Hermes, Cloudflare) is alone in its job,
 * so its latency never reaches the claim loop nor the database-only passes.
 */
export function maintenanceJobs(
  db: SQL,
  config: WorkerConfig,
  emailSender: TransactionalEmailSender | null = createTransactionalEmailSender(config.transactionalEmail),
): BackgroundJob[] {
  // Le début de l'observation des liens : voir `observingSince` (link-alerts.ts).
  const observingSince = new Date();
  const jobs: BackgroundJob[] = [
    {
      name: "poison-reaper",
      everyMs: Math.max(config.pollMs, POISON_REAP_TICK_MS),
      run: async () => {
        await reapPoisonRuns(db, config);
      },
    },
    {
      // The same pass `claimRun` runs at its head, so an expired lease or
      // deadline is settled even while no claim is in flight.
      name: "expired-run-sweep",
      everyMs: config.pollMs,
      run: async () => {
        await sweepExpiredRuns(db, config);
      },
    },
    {
      name: "runtime-direct",
      everyMs: DIRECT_PROBE_TICK_MS,
      run: (signal) => guardedPass("worker.runtime_direct_probe_failed", async () => {
        await probeDirectRuntimes(db, config, undefined, signal);
        const failed = await failRunsOnUnhealthyDirectRuntimes(db, config.linkQueueTimeoutMs);
        if (failed > 0) logEvent("worker.runs_failed_runtime_direct", { count: failed });
      }),
    },
    {
      name: "profile-import",
      everyMs: config.routineTickMs,
      run: (signal) => guardedPass("profile_import.worker_failed", () => processProfileImport(db, config, signal)),
    },
    {
      name: "profile-delete",
      everyMs: config.routineTickMs,
      run: (signal) => guardedPass("profile_delete.worker_failed", () => processProfileDelete(db, config, signal)),
    },
    {
      name: "profile-provision",
      everyMs: config.routineTickMs,
      run: (signal) => guardedPass("profile_provision.worker_failed", () => processProfileProvision(db, config, signal)),
    },
    {
      name: "runtime-model-selection",
      everyMs: config.routineTickMs,
      run: (signal) => guardedPass("runtime_model_selection.worker_failed", () => processRuntimeModelSelection(db, config, signal)),
    },
    {
      name: "bot-host-cleanup",
      everyMs: config.routineTickMs,
      run: (signal) => guardedPass("bot_host_cleanup.worker_failed", () => processBotHostCleanup(db, config, signal)),
    },
    {
      name: "approval-policy-reconciliation",
      firstAfterMs: API_INSTANCE_DEAD_AFTER_MS,
      everyMs: Math.max(config.routineTickMs, APPROVAL_POLICY_RECONCILE_TICK_MS),
      run: (signal) => guardedPass("worker.approval_policy_reconcile_failed", () => reconcileHostApprovalPolicies(db, config, signal)),
    },
    {
      // PERM2-7 without a reviewer: a gate left under review goes to a person
      // (the reviewer itself is the plug-in `permissions`, its passes come
      // with the plug-in jobs). Read per pass: the plug-in installs it at boot.
      name: "approval-review-handoff",
      everyMs: Math.max(config.pollMs, REVIEW_HANDOFF_TICK_MS),
      run: (signal) => guardedPass("approval.review_handoff_failed", async () => {
        await handOffReviewGates(db, {
          limit: REVIEW_HANDOFF_BATCH,
          minAgeMs: approvalReviewerInstalled() ? REVIEW_HANDOFF_GRACE_MS : 0,
          signal,
        });
      }),
    },
    {
      // The execution mutations the API recorded (room compaction).
      name: "execution-commands",
      everyMs: Math.max(config.pollMs, EXECUTION_COMMAND_TICK_MS),
      run: (signal, track) => guardedPass("execution_command.pass_failed", () => processExecutionCommands(db, config, signal, track), { withError: true }),
    },
    {
      name: "capability-baseline",
      firstAfterMs: API_INSTANCE_DEAD_AFTER_MS,
      everyMs: Math.max(config.routineTickMs, CAPABILITY_BASELINE_TICK_MS),
      run: (signal) => guardedPass("worker.capability_baseline_failed", () => reconcileCapabilityBaselines(db, config, signal)),
    },
    {
      // Les routines dues et suppressions se matérialisent en runs ; le lien
      // connecteur : un runtime muet depuis 45 s passe `disconnected`, et les
      // runs qui l'attendent depuis trop longtemps échouent.
      name: "routines-and-links",
      everyMs: config.routineTickMs,
      run: async () => {
        // A routine that throws is deferred by `fireDueRoutine` itself; this
        // guard keeps anything left (claim, database down) from skipping the
        // link maintenance below.
        await guardedPass("worker.routine_tick_failed", async () => {
          await fireDueRoutine(db, config.billingEnforced);
        }, { withError: true });
        await sweepDisconnectedRuntimeLinks(db);
        // Une panne qui dure devient une alerte et un e-mail (outbox) au propriétaire.
        await guardedPass("worker.runtime_link_alerts_failed", async () => {
          const alerts = await evaluateRuntimeLinkAlerts(db, {
            downAfterMinutes: config.runtimeLinkAlertAfterMinutes,
            webAppUrl: config.webAppUrl,
            observingSince,
            environment: config.deployEnvironment,
          });
          if (alerts.opened > 0 || alerts.resolved > 0) {
            logEvent("worker.runtime_link_alerts", { ...alerts });
          }
        }, { withError: true });
        // Rotation du jeton de lien : l'ancien hash meurt à la fin de sa grâce.
        await expireRotatedLinkTokens(db);
        await purgeOldRuntimeLinkEvents(db, config.linkEventsRetentionDays);
        const disconnectedRuns = await failRunsOnDisconnectedRuntimes(db, config.linkQueueTimeoutMs);
        if (disconnectedRuns > 0) {
          logEvent("worker.runs_failed_runtime_disconnected", { count: disconnectedRuns });
        }
      },
    },
    {
      name: "tenant-deletion",
      everyMs: config.routineTickMs,
      run: async () => {
        await processTenantDeletion(db, {
          workerId: config.workerId,
          webAppUrl: config.webAppUrl,
          deleteBlob: (key, driver) => deleteBlob(config, key, driver),
          profileJobs: tenantPurgeProfileJobs,
        });
      },
    },
    {
      name: "message-ingress",
      everyMs: config.routineTickMs,
      run: async () => {
        const ingressMaintenance = await maintainMessageIngress(db, config, {
          // Un manifeste d'ingestion ne nomme pas son driver.
          deleteObject: (key) => deleteBlob(config, key, null),
        });
        if (ingressMaintenance.failed > 0) {
          logEvent("worker.message_ingress_maintenance_failed", {
            ...ingressMaintenance,
          }, "error");
        }
      },
    },
    {
      name: "push-notifications",
      everyMs: config.routineTickMs,
      run: () => guardedPass("worker.push_notifications_failed", async () => {
        const push = await processPushNotifications(db, config);
        if (push.processed > 0) {
          logEvent("worker.push_notifications", { ...push });
        }
      }, { withError: true }),
    },
    {
      // DEV-308: the APNs half of the push outbox. Deliveries are reserved by
      // the pass above and sent here, with their own lease and backoff.
      name: "apns-deliveries",
      everyMs: config.routineTickMs,
      run: () => guardedPass("worker.apns_deliveries_failed", async () => {
        const apns = await processApnsDeliveries(db, config);
        if (apns.sent + apns.retried + apns.failed + apns.revoked > 0) {
          logEvent("worker.apns_deliveries", { ...apns });
        }
      }, { withError: true }),
    },
    {
      // DEV-OPE2-7 : les alertes de lien vers Discord, déposées par la passe
      // « routines-and-links » et envoyées ici, avec leur bail et leur recul.
      name: "alert-deliveries",
      everyMs: config.routineTickMs,
      run: () => guardedPass("worker.alert_deliveries_failed", async () => {
        const alerts = await processAlertDeliveries(db, config);
        if (alerts.sent + alerts.retried + alerts.failed + alerts.cancelled > 0) {
          logEvent("worker.alert_deliveries", { ...alerts });
        }
      }, { withError: true }),
    },
    {
      // Sécurité du lien, une fois par heure : les jetons trop vieux tournent,
      // les sessions Hermes inconnues d'openedbot sont journalisées.
      name: "link-security",
      firstAfterMs: API_INSTANCE_DEAD_AFTER_MS,
      everyMs: LINK_SECURITY_TICK_MS,
      run: () => guardedPass("worker.link_security_failed", async () => {
        const rotated = await rotateStaleLinkTokens(db, config.linkTokenMaxAgeHours, config);
        if (rotated > 0) logEvent("worker.link_tokens_rotated", { rotated });
        const reconciled = await reconcileRuntimeSessions(db, config);
        if (reconciled.unattributed > 0) logEvent("worker.unattributed_sessions", { ...reconciled }, "error");
      }, { withError: true }),
    },
    {
      // Tunnels gérés par openedbot : l'état Cloudflare est relu toutes les cinq minutes.
      name: "managed-exposures",
      everyMs: MANAGED_EXPOSURE_TICK_MS,
      run: (signal) => guardedPass("worker.managed_exposures_failed", async () => {
        const reconciled = await reconcileManagedExposures(db, config.managedTunnel, undefined, signal);
        if (reconciled > 0) logEvent("worker.managed_exposures_reconciled", { count: reconciled });
        const cleaned = await cleanupRevokedManagedExposures(db, config.managedTunnel, undefined, signal);
        if (cleaned > 0) logEvent("worker.managed_exposures_cleanup", { count: cleaned });
      }),
    },
    {
      name: "event-retention",
      everyMs: EVENT_RETENTION_TICK_MS,
      run: async () => {
        await purgeOldProfileImports(db);
        await purgeOldProfileDeletes(db);
        await purgeSettledExecutionCommands(db, COMMAND_RETENTION_DAYS);
        await purgeOldRunEvents(db, config.runEventsRetentionDays);
        await purgeOldToolErrors(db, config.toolErrorsRetentionDays);
        await purgeStaleRuntimeEnrollments(db);
        await purgeOldApiErrors(db);
        await purgeSpentEmailLoginCodes(db);
        await purgeDeadSessions(db);
        await purgeDeliveredEmails(db);
      },
    },
  ];
  if (emailSender) {
    jobs.push({
      name: "email-outbox",
      everyMs: config.routineTickMs,
      run: async () => {
        await processEmailOutbox(db, emailSender, { ...config.transactionalEmail, workerId: config.workerId, webAppUrl: config.webAppUrl });
      },
    });
  }
  return jobs;
}
