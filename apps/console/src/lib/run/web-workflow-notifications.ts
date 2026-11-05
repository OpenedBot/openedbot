import type { OrganizationEvent } from "@openedbot/contracts-events";
import { workflowNotificationEligible } from "@openedbot/notifications/domain/workflow-notifications";
import type { ThreadSnapshot, WorkflowDto } from "@openedbot/contracts-api";

export const WEB_NOTIFICATION_STORAGE_KEY = "openedbot:web-workflow-notifications";
export const WEB_NOTIFICATION_PREFERENCE_EVENT = "openedbot:web-notification-preference";

const MAX_CHECKPOINTS = 256;
const TERMINAL_STATUSES = new Set<WorkflowDto["status"]>([
  "completed",
  "failed",
  "expired",
  "unknown",
]);
const CANDIDATE_EVENTS = new Set(["approval.requested", "run.completed", "run.error"]);

export type WebNotificationPreference = {
  enabled: boolean;
  enabledAt: string | null;
};

type StoredWebNotificationState = WebNotificationPreference & {
  version: 1;
  cursors: Record<string, number>;
  seen: Record<string, number>;
  seenOrder: string[];
};

export type WebNotificationPermissionState =
  | "unsupported"
  | "not_requested"
  | "denied"
  | "disabled"
  | "enabled";

export type WorkflowPageNotification = {
  title: string;
  body: string;
  tag: string;
  route: string;
};

export type WorkflowNotificationHandling =
  | "ignored"
  | "foreground"
  | "duplicate"
  | "shown"
  | "unavailable";

type NotificationHandle = {
  close(): void;
  setOnClick(listener: () => void): void;
};

export type WorkflowNotificationDependencies = {
  enabledAt: string;
  loadThread(threadId: string): Promise<ThreadSnapshot>;
  resolveThreadRoute(threadId: string): Promise<string | null>;
  isPageForeground(): boolean;
  wasSeen(workflowId: string, sequence: number): boolean;
  markSeen(workflowId: string, sequence: number): void;
  show(notification: WorkflowPageNotification): NotificationHandle;
  open(route: string): void;
  content: {
    approvalTitle: string;
    completedTitle: string;
    attentionTitle: string;
    approvalBody: string;
    outcomeBody: string;
  };
};

const EMPTY_STATE: StoredWebNotificationState = {
  version: 1,
  enabled: false,
  enabledAt: null,
  cursors: {},
  seen: {},
  seenOrder: [],
};

/**
 * Préférence locale et révocable. Elle n'est jamais assimilée à la permission
 * du navigateur, qui ne peut être retirée que depuis ses propres réglages.
 */
export function readWebNotificationPreference(): WebNotificationPreference {
  const state = readState();
  return { enabled: state.enabled, enabledAt: state.enabledAt };
}

export function webNotificationPermissionState(
  preference = readWebNotificationPreference(),
): WebNotificationPermissionState {
  const permission = notificationPermission();
  if (permission === "unsupported") return "unsupported";
  if (permission === "denied") return "denied";
  if (permission === "default") return "not_requested";
  return preference.enabled ? "enabled" : "disabled";
}

/**
 * Doit être appelée uniquement depuis un geste utilisateur. Le module ne
 * demande jamais la permission à l'import, au montage ou à la reconnexion SSE.
 */
export async function enableWebNotifications(): Promise<WebNotificationPermissionState> {
  const api = browserNotificationApi();
  if (!api) return "unsupported";
  let permission = api.permission;
  if (permission !== "granted") {
    try {
      permission = await api.requestPermission();
    } catch {
      return permission === "denied" ? "denied" : "not_requested";
    }
  }
  if (permission !== "granted") return permission === "denied" ? "denied" : "not_requested";

  const persisted = updateState((state) => ({
    ...state,
    enabled: true,
    // Ce watermark empêche le premier abonnement (curseur 0) de transformer
    // le rejeu SSE historique en rafale de notifications.
    enabledAt: new Date().toISOString(),
  }));
  return persisted && readWebNotificationPreference().enabled ? "enabled" : "disabled";
}

export function disableWebNotifications(): void {
  updateState((state) => ({ ...state, enabled: false, enabledAt: null }));
}

export function readWebNotificationCursor(organizationId: string): number {
  return readState().cursors[organizationId] ?? 0;
}

export function recordWebNotificationCursor(organizationId: string, cursor: number | undefined): void {
  if (cursor === undefined || !safeKey(organizationId) || !Number.isSafeInteger(cursor) || cursor < 0) return;
  updateState((state) => ({
    ...state,
    cursors: { ...state.cursors, [organizationId]: Math.max(state.cursors[organizationId] ?? 0, cursor) },
  }), false);
}

export function webWorkflowNotificationWasSeen(
  organizationId: string,
  workflowId: string,
  sequence: number,
): boolean {
  if (!safeKey(organizationId) || !safeKey(workflowId) || !Number.isSafeInteger(sequence)) return true;
  return (readState().seen[checkpointKey(organizationId, workflowId)] ?? 0) >= sequence;
}

export function markWebWorkflowNotificationSeen(
  organizationId: string,
  workflowId: string,
  sequence: number,
): void {
  if (!safeKey(organizationId) || !safeKey(workflowId) || !Number.isSafeInteger(sequence) || sequence < 1) return;
  updateState((state) => {
    const key = checkpointKey(organizationId, workflowId);
    if ((state.seen[key] ?? 0) >= sequence) return state;
    const order = state.seenOrder.filter((candidate) => candidate !== key);
    order.push(key);
    const seen = { ...state.seen, [key]: sequence };
    while (order.length > MAX_CHECKPOINTS) {
      const removed = order.shift();
      if (removed) delete seen[removed];
    }
    return { ...state, seen, seenOrder: order };
  }, false);
}

/**
 * Traduit un événement SSE en notification locale de PAGE. La SPA doit rester
 * chargée ; ce code n'est pas un service worker et ne prétend pas réveiller un
 * navigateur fermé.
 */
export async function handleWorkflowPageNotification(
  event: OrganizationEvent,
  deps: WorkflowNotificationDependencies,
): Promise<WorkflowNotificationHandling> {
  if (!event.threadId || !CANDIDATE_EVENTS.has(event.type)) return "ignored";
  const enabledAt = Date.parse(deps.enabledAt);
  const occurredAt = Date.parse(event.occurredAt);
  if (!Number.isFinite(enabledAt) || !Number.isFinite(occurredAt) || occurredAt < enabledAt) return "ignored";

  let snapshot: ThreadSnapshot;
  try {
    snapshot = await deps.loadThread(event.threadId);
  } catch {
    return "unavailable";
  }
  const run = snapshot.runs.find((candidate) => candidate.id === event.runId);
  if (!run?.workflowId) return "ignored";
  const workflow = snapshot.workflows?.find((candidate) => candidate.id === run.workflowId);
  if (!workflow || !workflowNotificationEligible({
    kind: workflow.kind,
    autonomyEnabled: workflow.autonomyEnabled === true,
  })) return "ignored";

  const sequence = workflow.notificationSequence;
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) return "ignored";
  const isApproval = event.type === "approval.requested" && workflow.status === "awaiting_approval";
  const isTerminal = event.type !== "approval.requested" && TERMINAL_STATUSES.has(workflow.status);
  if (!isApproval && !isTerminal) return "ignored";
  if (deps.wasSeen(workflow.id, Number(sequence))) return "duplicate";

  // Au premier plan, les cartes de gate et l'état durable sont la surface
  // canonique. On consomme la transition sans dupliquer une bannière système.
  if (deps.isPageForeground()) {
    deps.markSeen(workflow.id, Number(sequence));
    return "foreground";
  }

  const route = await deps.resolveThreadRoute(event.threadId).catch(() => null);
  if (!route) return "unavailable";
  const notification = publicNotification(workflow, route, deps.content);
  let handle: NotificationHandle;
  try {
    handle = deps.show(notification);
  } catch {
    return "unavailable";
  }
  deps.markSeen(workflow.id, Number(sequence));
  handle.setOnClick(() => {
    handle.close();
    deps.open(route);
  });
  return "shown";
}

export function pageNotificationForeground(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

function publicNotification(
  workflow: WorkflowDto,
  route: string,
  content: WorkflowNotificationDependencies["content"],
): WorkflowPageNotification {
  if (workflow.status === "awaiting_approval") {
    return {
      title: content.approvalTitle,
      body: content.approvalBody,
      tag: `openedbot-workflow-${workflow.id}`,
      route,
    };
  }
  if (workflow.status === "completed") {
    return {
      title: content.completedTitle,
      body: content.outcomeBody,
      tag: `openedbot-workflow-${workflow.id}`,
      route,
    };
  }
  return {
    title: content.attentionTitle,
    body: content.outcomeBody,
    tag: `openedbot-workflow-${workflow.id}`,
    route,
  };
}

function notificationPermission(): NotificationPermission | "unsupported" {
  return browserNotificationApi()?.permission ?? "unsupported";
}

/** Un champ `permission` isolé ou un stub de coque n'est pas une API utilisable. */
function browserNotificationApi(): typeof Notification | null {
  if (typeof window === "undefined") return null;
  const candidate = window.Notification;
  return typeof candidate === "function" && typeof candidate.requestPermission === "function"
    ? candidate
    : null;
}

function checkpointKey(organizationId: string, workflowId: string): string {
  return `${organizationId}:${workflowId}`;
}

function safeKey(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\n\r\0]/.test(value);
}

function readState(): StoredWebNotificationState {
  if (typeof localStorage === "undefined") return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(localStorage.getItem(WEB_NOTIFICATION_STORAGE_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY_STATE };
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1) return { ...EMPTY_STATE };
    const enabledAt = typeof candidate.enabledAt === "string" && Number.isFinite(Date.parse(candidate.enabledAt))
      ? new Date(candidate.enabledAt).toISOString()
      : null;
    const cursors = readNumberMap(candidate.cursors, 0);
    const seen = readNumberMap(candidate.seen, 1);
    const seenOrder = Array.isArray(candidate.seenOrder)
      ? candidate.seenOrder.filter((value): value is string => typeof value === "string" && value in seen).slice(-MAX_CHECKPOINTS)
      : [];
    return {
      version: 1,
      enabled: candidate.enabled === true && enabledAt !== null,
      enabledAt,
      cursors,
      seen,
      seenOrder,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function readNumberMap(value: unknown, minimum: number): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (safeKey(key) && Number.isSafeInteger(raw) && Number(raw) >= minimum) result[key] = Number(raw);
  }
  return result;
}

function updateState(
  update: (state: StoredWebNotificationState) => StoredWebNotificationState,
  notifyOtherTabs = true,
): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    const next = update(readState());
    localStorage.setItem(WEB_NOTIFICATION_STORAGE_KEY, JSON.stringify(next));
    if (notifyOtherTabs) emitPreferenceChange();
    return true;
  } catch {
    // Stockage privé/plein : aucun état actif n'est revendiqué si la
    // préférence ne peut pas être relue. La permission navigateur reste intacte.
    return false;
  }
}

function emitPreferenceChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WEB_NOTIFICATION_PREFERENCE_EVENT));
}
