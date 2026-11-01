import type { SQL } from "bun";
import type { WorkerConfig } from "../config";
import { guardedPass, type BackgroundJob } from "./background-jobs";
import { deleteBlob } from "../infrastructure/blob-store";
import { reapPoisonRuns, sweepExpiredRuns } from "@openedbot/execution/application/queue";
import { purgeOldToolErrors } from "@openedbot/execution/application/tool-errors";
import { processTenantDeletion } from "@openedbot/identity/application/tenant-deletion";
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
import { reconcileHostApprovalPolicies } from "../maintenance/approval-policy-reconciliation";
import { reconcileCapabilityBaselines } from "../maintenance/capability-baseline-reconciliation";
import { processReviewProfiles } from "../maintenance/review-profiles";
import { processApprovalReviews } from "../maintenance/approval-reviews";
import { fireDueRoutine, purgeOldRunEvents } from "@openedbot/execution/application/routines";
import { purgeStaleRuntimeEnrollments } from "@openedbot/runtimes/sql/runtime-enrollments";
import { expireRotatedLinkTokens } from "@openedbot/runtimes/sql/runtime-link-rows";
import { purgeClosedSupportConversations, purgeOldSupportEvents } from "@openedbot/support/sql/support-retention";
import {
  failRunsOnDisconnectedRuntimes,
  LINK_SECURITY_TICK_MS,
  purgeOldRuntimeLinkEvents,
  reconcileRuntimeSessions,
  rotateStaleLinkTokens,
  sweepDisconnectedRuntimeLinks,
} from "@openedbot/runtime-link/application/runtime-links";
import { evaluateRuntimeLinkAlerts } from "@openedbot/runtime-link/application/link-alerts";
import { DIRECT_PROBE_TICK_MS, probeDirectRuntimes, failRunsOnUnhealthyDirectRuntimes } from "@openedbot/execution/application/runtime-direct";
import { MANAGED_EXPOSURE_TICK_MS, reconcileManagedExposures } from "@openedbot/runtimes/application/managed-exposure-reconciliation";

/** Poison leases only exist once a 30 s lease has expired: a second is ample. */
const POISON_REAP_TICK_MS = 1_000;
const EVENT_RETENTION_TICK_MS = 60_000;

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
        if (failed > 0) console.info(JSON.stringify({ event: "worker.runs_failed_runtime_direct", count: failed }));
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
      everyMs: config.routineTickMs,
      run: (signal) => guardedPass("worker.approval_policy_reconcile_failed", () => reconcileHostApprovalPolicies(db, config, signal)),
    },
    {
      // PERM2-7: a gate under review has 15 s end to end; claim it fast.
      name: "approval-reviews",
      everyMs: Math.min(config.pollMs * 5, 500),
      run: (signal) => guardedPass("approval.review_worker_failed", () => processApprovalReviews(db, config, signal)),
    },
    {
      name: "review-profiles",
      everyMs: config.routineTickMs,
      run: (signal) => guardedPass("review_profile.worker_failed", () => processReviewProfiles(db, config, signal)),
    },
    {
      name: "capability-baseline",
      everyMs: config.routineTickMs,
      run: (signal) => guardedPass("worker.capability_baseline_failed", () => reconcileCapabilityBaselines(db, config, signal)),
    },
    {
      // Les routines dues et suppressions se matérialisent en runs ; le lien
      // connecteur : un runtime muet depuis 45 s passe `disconnected`, et les
      // runs qui l'attendent depuis trop longtemps échouent.
      name: "routines-and-links",
      everyMs: config.routineTickMs,
      run: async () => {
        await fireDueRoutine(db, config.billingEnforced);
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
            console.info(JSON.stringify({ event: "worker.runtime_link_alerts", ...alerts }));
          }
        }, { withError: true });
        // Rotation du jeton de lien : l'ancien hash meurt à la fin de sa grâce.
        await expireRotatedLinkTokens(db);
        await purgeOldRuntimeLinkEvents(db, config.linkEventsRetentionDays);
        const disconnectedRuns = await failRunsOnDisconnectedRuntimes(db, config.linkQueueTimeoutMs);
        if (disconnectedRuns > 0) {
          console.info(JSON.stringify({ event: "worker.runs_failed_runtime_disconnected", count: disconnectedRuns }));
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
          deleteBlob: (key) => deleteBlob(config, key),
        });
      },
    },
    {
      name: "message-ingress",
      everyMs: config.routineTickMs,
      run: async () => {
        const ingressMaintenance = await maintainMessageIngress(db, config, {
          deleteObject: (key) => deleteBlob(config, key),
        });
        if (ingressMaintenance.failed > 0) {
          console.error(JSON.stringify({
            event: "worker.message_ingress_maintenance_failed",
            ...ingressMaintenance,
          }));
        }
      },
    },
    {
      name: "push-notifications",
      everyMs: config.routineTickMs,
      run: () => guardedPass("worker.push_notifications_failed", async () => {
        const push = await processPushNotifications(db, config);
        if (push.processed > 0) {
          console.info(JSON.stringify({ event: "worker.push_notifications", ...push }));
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
          console.info(JSON.stringify({ event: "worker.apns_deliveries", ...apns }));
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
          console.info(JSON.stringify({ event: "worker.alert_deliveries", ...alerts }));
        }
      }, { withError: true }),
    },
    {
      // Sécurité du lien, une fois par heure : les jetons trop vieux tournent,
      // les sessions Hermes inconnues d'openedbot sont journalisées.
      name: "link-security",
      everyMs: LINK_SECURITY_TICK_MS,
      run: () => guardedPass("worker.link_security_failed", async () => {
        const rotated = await rotateStaleLinkTokens(db, config.linkTokenMaxAgeHours, config);
        if (rotated > 0) console.info(JSON.stringify({ event: "worker.link_tokens_rotated", rotated }));
        const reconciled = await reconcileRuntimeSessions(db, config);
        if (reconciled.unattributed > 0) console.error(JSON.stringify({ event: "worker.unattributed_sessions", ...reconciled }));
      }, { withError: true }),
    },
    {
      // Tunnels gérés par openedbot : l'état Cloudflare est relu toutes les cinq minutes.
      name: "managed-exposures",
      everyMs: MANAGED_EXPOSURE_TICK_MS,
      run: (signal) => guardedPass("worker.managed_exposures_failed", async () => {
        const reconciled = await reconcileManagedExposures(db, config.managedTunnel, undefined, signal);
        if (reconciled > 0) console.info(JSON.stringify({ event: "worker.managed_exposures_reconciled", count: reconciled }));
      }),
    },
    {
      name: "event-retention",
      everyMs: EVENT_RETENTION_TICK_MS,
      run: async () => {
        await purgeOldProfileImports(db);
        await purgeOldProfileDeletes(db);
        await purgeOldRunEvents(db, config.runEventsRetentionDays);
        await purgeOldToolErrors(db, config.toolErrorsRetentionDays);
        await purgeStaleRuntimeEnrollments(db);
        await purgeOldSupportEvents(db, config.supportEventsRetentionDays);
        await purgeClosedSupportConversations(db, config.supportRetentionDays);
      },
    },
  ];
  if (emailSender) {
    jobs.push({
      name: "email-outbox",
      everyMs: config.routineTickMs,
      run: async () => {
        await processEmailOutbox(db, emailSender, { ...config.transactionalEmail, workerId: config.workerId });
      },
    });
  }
  return jobs;
}
