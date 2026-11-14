import type { HermesClient } from "@openedbot/hermes";
import { RUN_INACTIVITY_STOP_CODE, RUN_TIMEOUT_STOP_CODE } from "@openedbot/contracts-errors";
import { isHermesRunWorking } from "../../domain/silent-run";
import type { ReconcileStopCause } from "./reconcile";
import { describe, log } from "./util";

/**
 * Le watchdog d'inactivité demande à Hermes avant d'arrêter un run muet. Un
 * modèle qui raisonne longtemps n'émet rien : le silence seul ne prouve pas
 * la panne (vu en prod le 2026-11-04 : gpt-6.1-sol, plus de 2 min sans trame
 * après une recherche web, arrêté en « Run Hermes annulé »). Seul un run que
 * Hermes ne dit plus actif, ou qu'on ne peut pas lire, est arrêté ; le délai
 * du run reste la borne d'un run vivant mais sans fin.
 */
export async function silentRunStillWorking(
  client: Pick<HermesClient, "getRunStatus">,
  hermesRunId: string | null,
  signal: AbortSignal,
  runId: string,
  lastFrameAt: number,
): Promise<boolean> {
  if (!hermesRunId) return false;
  try {
    const details = await client.getRunStatus(hermesRunId, signal);
    log("worker.stream_idle_probe", { runId, hermesStatus: details.status, silentMs: Date.now() - lastFrameAt });
    return isHermesRunWorking(details.status);
  } catch (error) {
    log("worker.stream_idle_probe_failed", { runId, error: describe(error) });
    return false;
  }
}

/** Pourquoi openedbot a arrêté le run lui-même : jamais « Run Hermes annulé », qui fait croire à une annulation. */
export function watchdogStopCause(idle: boolean, inactivityMs: number, workflowExpired = false): ReconcileStopCause {
  return idle
    ? {
      errorCode: RUN_INACTIVITY_STOP_CODE,
      message: `Le run ne donnait plus signe de vie depuis ${Math.round(inactivityMs / 1_000)} s : openedbot l’a arrêté.`,
    }
    : workflowExpired
      ? { errorCode: "WORKFLOW_DEADLINE_EXCEEDED", message: "Le workflow a dépassé sa durée maximale : openedbot a arrêté le run." }
      : { errorCode: RUN_TIMEOUT_STOP_CODE, message: "Le run a dépassé sa durée maximale : openedbot l’a arrêté." };
}
