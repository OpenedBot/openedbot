import type { RunDto } from "@openedbot/contracts-api";
import type { StoredProductEvent } from "@openedbot/contracts-events";
import type { ApprovalRequestDto } from "@openedbot/contracts-api";
import { readAttachment, readToolOutcome, runToolTerminalStates, toolCallKey } from "@openedbot/conversation/domain/thread-tools";
import { HANDOFF_NOTICE_KIND, handoffNoticeTarget } from "@openedbot/roster/domain/bot-mode";
import { isExecutingThreadRun, isWaitingThreadRun } from "./current-thread-run";

export type ActivityToolState = "running" | "completed" | "failed" | "interrupted" | "result_missing";

export type ActivityTool = {
  key: string;
  tool: string;
  preview: string | null;
  result: string | null;
  truncated: boolean;
  state: ActivityToolState;
  /** `tool.result.errorMessage` : le pourquoi de l'échec, `null` tant que le runtime n'en transmet pas. */
  errorMessage: string | null;
};

export type RunActivity = { run: RunDto; tools: ActivityTool[]; approvals: ApprovalRequestDto[] };

/** Projection prudente du journal : l'absence de `tool.result` n'est jamais transformée en succès. */
export function buildThreadActivity(
  runs: readonly RunDto[],
  events: readonly StoredProductEvent[],
  approvals: readonly ApprovalRequestDto[],
): RunActivity[] {
  const outcomes = new Map(
    events.filter((event) => event.type === "tool.result")
      .map((event) => [toolCallKey(event), readToolOutcome(event.payload)] as const),
  );
  const attachments = new Map<string, ReturnType<typeof readAttachment>>();
  for (const event of events) {
    if (event.type === "tool.result.attached") attachments.set(toolCallKey(event), readAttachment(event.payload));
  }
  const terminalStates = runToolTerminalStates(events);

  return runs.map((run) => ({
    run,
    approvals: approvals.filter((approval) => approval.runId === run.id),
    tools: events.filter((event) => event.runId === run.id && event.type === "tool.call").map((event) => {
      const key = toolCallKey(event);
      const outcome = outcomes.get(key);
      const terminal = terminalStates.get(run.id);
      const attachment = attachments.get(key);
      const state: ActivityToolState = outcome
        ? outcome.failed ? "failed" : "completed"
        : terminal === "interrupted" || run.status === "cancelled" || run.status === "failed"
          ? "interrupted"
          : terminal === "completed" || run.status === "completed"
            ? "result_missing"
            : "running";
      return {
        key,
        tool: typeof event.payload.tool === "string" && event.payload.tool ? event.payload.tool : "tool",
        preview: typeof event.payload.preview === "string" && event.payload.preview ? event.payload.preview : null,
        result: attachment && "result" in attachment && typeof attachment.result === "string" ? attachment.result : null,
        truncated: Boolean(attachment && "result" in attachment && attachment.truncated),
        state,
        errorMessage: outcome?.errorMessage ?? (attachment && "errorMessage" in attachment ? attachment.errorMessage ?? null : null),
      };
    }),
  }));
}

/** Ce que fait le tour en cours, sans libellé : l'écran le traduit. */
export type RunActivityState = { runId: string; startedAt: string | null } & (
  | { kind: "queued" }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "tool"; tool: string; preview: string | null }
  | { kind: "waitingFor"; name: string }
);

const TERMINAL_RUN_STATUSES: ReadonlySet<RunDto["status"]> = new Set(["completed", "failed", "cancelled"]);
/** Bruit sans rendu : ne dit rien de ce que fait le bot. */
const SILENT_EVENT_TYPES: ReadonlySet<StoredProductEvent["type"]> = new Set(["raw", "tool.result.attached"]);

function noticeText(event: StoredProductEvent): string {
  const value = event.payload.text ?? event.payload.message ?? event.payload.output;
  return typeof value === "string" ? value : "";
}

/**
 * L'activité du tour en cours, pour la rangée posée au-dessus du composer.
 *
 * Chaque état du fil a une sortie définie, sans dépendre d'une position :
 * - approbation ouverte : `null`, la gate occupe déjà cette place ;
 * - run conclu (événement terminal OU statut terminal) : jamais retenu ;
 * - le run vivant du DERNIER événement l'emporte : un run qui émet s'exécute,
 *   quel que soit le statut resté en cache ; sinon le premier run exécutable,
 *   sinon le premier run en file ;
 * - un run en file qui n'a rien émis d'autre qu'une notice : `queued`.
 */
export function deriveRunActivity(
  runs: readonly RunDto[],
  events: readonly StoredProductEvent[],
  approvals: readonly ApprovalRequestDto[],
): RunActivityState | null {
  if (approvals.length > 0) return null;
  const concluded = new Set(
    events.filter((event) => event.type === "run.completed" || event.type === "run.error").map((event) => event.runId),
  );
  const byId = new Map(runs.map((run) => [run.id, run] as const));
  const live = (run: RunDto | undefined): run is RunDto =>
    run !== undefined && !concluded.has(run.id) && !TERMINAL_RUN_STATUSES.has(run.status);
  const lastLiveEvent = events.findLast((event) => live(byId.get(event.runId)));
  const run = (lastLiveEvent ? byId.get(lastLiveEvent.runId) : undefined)
    ?? runs.find((candidate) => live(candidate) && isExecutingThreadRun(candidate))
    ?? runs.find((candidate) => live(candidate) && isWaitingThreadRun(candidate));
  if (!run) return null;

  // Le chrono part de l'envoi du tour (`createdAt`, daté par le serveur dès la
  // 202), jamais de `startedAt` : le cache le pose à l'heure de RÉCEPTION du
  // premier événement, et le chrono repartait à 0 quand le texte arrivait
  // (DEV-OHB-245).
  const base = { runId: run.id, startedAt: run.createdAt ?? run.startedAt ?? null };
  const runEvents = events.filter((event) => event.runId === run.id && !SILENT_EVENT_TYPES.has(event.type));
  if (isWaitingThreadRun(run) && runEvents.every((event) => event.type === "system.notice")) {
    return { ...base, kind: "queued" };
  }
  // Hand-off : le tour attend la cible, pas le modèle. Le nom vient du texte
  // de la notice ; illisible, on retombe sur l'état générique.
  const lastMeaningful = runEvents.findLast((event) => event.type !== "agent.reasoning");
  if (lastMeaningful?.type === "system.notice" && lastMeaningful.payload.kind === HANDOFF_NOTICE_KIND.sent) {
    const target = handoffNoticeTarget(noticeText(lastMeaningful));
    if (target) return { ...base, kind: "waitingFor", name: target.name };
  }
  const last = runEvents.at(-1);
  if (last?.type === "tool.call") {
    const tool = typeof last.payload.tool === "string" && last.payload.tool ? last.payload.tool : "tool";
    const preview = typeof last.payload.preview === "string" && last.payload.preview ? last.payload.preview : null;
    return { ...base, kind: "tool", tool, preview };
  }
  if (last?.type === "agent.message") return { ...base, kind: "writing" };
  return { ...base, kind: "thinking" };
}
