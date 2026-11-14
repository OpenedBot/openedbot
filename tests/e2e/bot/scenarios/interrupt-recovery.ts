import type { BotDto, RuntimeGatewayRestartDto } from "@openedbot/contracts-api";
import { completed, requireEvidence, requireNoForeignRuns, waitUntil } from "../kit/acceptance";
import { executeRecoveryCommand } from "../kit/recovery-command";
import {
  cleanRecoveryBot, denyHeldRun, finishGatewayRestart, gatewayStatus, holdRecoveryRun,
  proveRecoveryDispatch, proveSsePersistence, recoveryBot, recoveryRun, settledRecoveryRun,
} from "../kit/recovery-runs";
import type { Scenario, ScenarioContext } from "../kit/scenario";

async function nextMessage(context: ScenarioContext, bot: BotDto, phase: string): Promise<string> {
  const marker = `RECOVERY_${phase}_${context.lab.tag}`;
  const turn = await context.lab.send(bot.threadId, `Do not use any tool. Reply exactly ${marker}.`);
  completed(turn, marker);
  requireEvidence(await context.lab.answered(bot.threadId, turn.runId), "The next message has no persisted assistant reply.");
  return turn.runId;
}

async function phase(context: ScenarioContext, name: string, body: (bot: BotDto) => Promise<Record<string, string | number | boolean | null>>): Promise<void> {
  let bot: BotDto | null = null;
  try {
    await context.rec.step(name, async () => {
      bot = await recoveryBot(context, `E2E Recovery ${name}`);
      return body(bot);
    });
  } finally {
    if (bot) await context.rec.step(`Nettoyage : ${name}`, async () => {
      await cleanRecoveryBot(context, bot!);
      return { profileRemoved: true };
    });
  }
}

export const interruptRecovery: Scenario = {
  id: "interrupt-recovery",
  title: "Annulation, reconnexion et reprise après redémarrage",
  summary: "Des runs réellement tenus sur une gate traversent annulation, reconnexion SSE, redémarrage gracieux et crash explicite ; aucune recréation du run et le message suivant fonctionne sans récupération manuelle.",
  async run(context) {
    const { session, lab, config, rec } = context;
    await rec.step("Cible explicite et fonctions de redémarrage", async () => {
      requireEvidence(config.expectedRuntimeId === session.runtime.id, "interrupt-recovery requires E2E_RUNTIME_ID matching the linked lab runtime.");
      requireEvidence(config.auditDatabaseUrl, "interrupt-recovery requires API_DATABASE_URL or E2E_AUDIT_DATABASE_URL for tenant-scoped broker evidence.");
      requireEvidence(session.runtime.reachability === "connector", "Recovery acceptance requires a connector runtime and its dispatch journal.");
      requireEvidence(session.hasFeature("gateway_restart") && session.hasFeature("gateway_graceful_restart"),
        "gateway_restart and gateway_graceful_restart are required.");
      return { runtimeId: session.runtime.id, gracefulRestart: true };
    });

    await phase(context, "Annulation réelle", async (bot) => {
      const held = await holdRecoveryRun(context, bot, `CANCEL_${lab.tag}`);
      await session.api("POST", `/api/runs/${held.runId}/cancel`, undefined, 204);
      const stopped = await settledRecoveryRun(context, held);
      requireEvidence(stopped.status === "cancelled" && stopped.remoteStopState === "confirmed",
        `Cancellation ended ${stopped.status}/${stopped.remoteStopState}; a local request alone is insufficient.`);
      const evidence = await proveRecoveryDispatch(context, held);
      const nextRunId = await nextMessage(context, bot, "CANCEL");
      return { runId: held.runId, remoteStop: stopped.remoteStopState, nextRunId, ...evidence };
    });

    await phase(context, "Reconnexion SSE pendant le run", async (bot) => {
      const held = await holdRecoveryRun(context, bot, `RECONNECT_${lab.tag}`);
      const before = { connections: lab.events.connections, duplicates: lab.events.duplicates, gaps: lab.events.gaps };
      lab.events.reconnect();
      await waitUntil("SSE reconnect", async () => lab.events.connections, (count) => count > before.connections, 10_000);
      const active = await recoveryRun(context, held.runId);
      requireEvidence(active.status === "awaiting_approval" || active.status === "running", "The run ended before SSE reconnected.");
      requireEvidence(active.remoteId === held.remoteId, "SSE reconnect changed the remote identity.");
      await denyHeldRun(context, held);
      completed(await lab.follow(held.runId, held.t0));
      const evidence = await proveRecoveryDispatch(context, held);
      const events = await proveSsePersistence(context, held.runId);
      requireEvidence(lab.events.duplicates === before.duplicates && lab.events.gaps === before.gaps,
        "SSE reconnect produced duplicate frames or a stream gap.");
      return { runId: held.runId, resumedConnections: lab.events.connections - before.connections, persistedEvents: events, ...evidence };
    });

    await phase(context, "Redémarrage gracieux avec un run actif", async (bot) => {
      const held = await holdRecoveryRun(context, bot, `GRACEFUL_${lab.tag}`);
      await requireNoForeignRuns(context, bot.id);
      const before = await gatewayStatus(context);
      requireEvidence(before.activeSince && Number.isFinite(Date.parse(before.activeSince)), "Gateway startup timestamp is required before restart.");
      const job = await session.api<RuntimeGatewayRestartDto>("POST", "/api/runtime/integrations/gateway/restart", undefined, 202);
      const draining = await session.api<RuntimeGatewayRestartDto>("GET", `/api/runtime/integrations/gateway/restart/${job.jobId}`);
      const during = await recoveryRun(context, held.runId);
      requireEvidence(draining.status === "running" && during.remoteId === held.remoteId
        && ["running", "awaiting_approval"].includes(during.status), "The restart did not overlap a held active run.");
      requireEvidence((await gatewayStatus(context)).activeSince === before.activeSince, "The gateway restarted before its held run was released.");
      await denyHeldRun(context, held);
      completed(await lab.follow(held.runId, held.t0));
      await finishGatewayRestart(context, job);
      const after = await gatewayStatus(context);
      requireEvidence(after.activeSince && Date.parse(after.activeSince) > Date.parse(before.activeSince), "No independently observed new gateway startup after graceful restart.");
      const evidence = await proveRecoveryDispatch(context, held);
      const nextRunId = await nextMessage(context, bot, "GRACEFUL");
      return { runId: held.runId, jobId: job.jobId, before: before.activeSince, after: after.activeSince, nextRunId, ...evidence };
    });

    // Kept last: missing operator support must fail honestly after the supported phases ran.
    await rec.step("Pilote explicite de crash du lab", async () => {
      requireEvidence(config.recoveryCommand, "Abrupt crash acceptance requires E2E_RECOVERY_ARGV and E2E_ALLOW_RUNTIME_FAULTS=1. Supply an approved edge-setup driver returning the documented target-bound JSON; no SSH kill is guessed.");
      return { driverConfigured: true, evidenceKind: "operator-provided attestation, cross-checked with gateway API and interrupted run" };
    });
    await phase(context, "Crash abrupt et message suivant", async (bot) => {
      const held = await holdRecoveryRun(context, bot, `CRASH_${lab.tag}`);
      await requireNoForeignRuns(context, bot.id);
      const before = await gatewayStatus(context);
      requireEvidence(before.activeSince && Number.isFinite(Date.parse(before.activeSince)), "Gateway startup timestamp is required before abrupt restart.");
      const attestation = await executeRecoveryCommand(config.recoveryCommand!, {
        runtimeId: session.runtime.id, botId: bot.id, runId: held.runId, nonce: crypto.randomUUID(),
      }, Math.min(120_000, config.cleanupTimeoutMs));
      requireEvidence(Math.abs(Date.parse(attestation.before.startedAt) - Date.parse(before.activeSince)) <= 2_000,
        "Crash driver process does not match the independently observed gateway startup.");
      const after = await gatewayStatus(context);
      requireEvidence(after.activeSince && Date.parse(after.activeSince) > Date.parse(before.activeSince)
        && Math.abs(Date.parse(attestation.after.startedAt) - Date.parse(after.activeSince)) <= 2_000,
        "No matching independent gateway restart evidence after the crash driver.");
      const interrupted = await settledRecoveryRun(context, held);
      requireEvidence(interrupted.status === "failed" && interrupted.errorCode === "HERMES_RUN_INTERRUPTED",
        `Abrupt run ended ${interrupted.status}/${interrupted.errorCode}; interruption must be explicit and automatically release the thread.`);
      const evidence = await proveRecoveryDispatch(context, held);
      const nextRunId = await nextMessage(context, bot, "CRASH");
      return { runId: held.runId, priorStatus: interrupted.status, errorCode: interrupted.errorCode,
        beforePid: attestation.before.pid, afterPid: attestation.after.pid, nextRunId, ...evidence };
    });
  },
};
