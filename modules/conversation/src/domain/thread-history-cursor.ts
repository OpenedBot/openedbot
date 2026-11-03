import { isUuid } from "@openedbot/contracts-primitives";
import { HttpError } from "@openedbot/contracts-errors/http-error";

export type ThreadHistoryAnchor = { kind: "run" | "message"; id: string; createdAt: string };
type HistoryCursor = ThreadHistoryAnchor & { version: 1; organizationId: string; threadId: string };
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const invalid = () => new HttpError(400, "INVALID_HISTORY_CURSOR", "Le curseur d'historique est invalide pour ce fil.");

export function encodeThreadHistoryCursor(organizationId: string, threadId: string, anchor: ThreadHistoryAnchor): string {
  const cursor: HistoryCursor = { version: 1, organizationId, threadId, ...anchor };
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function parseThreadHistoryCursor(value: string | undefined, organizationId: string, threadId: string): ThreadHistoryAnchor | null {
  if (value === undefined) return null;
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw invalid();
  let cursor: unknown;
  try { cursor = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))); }
  catch { throw invalid(); }
  if (!cursor || typeof cursor !== "object") throw invalid();
  const row = cursor as Partial<HistoryCursor>;
  if (row.version !== 1 || row.organizationId !== organizationId || row.threadId !== threadId
    || (row.kind !== "run" && row.kind !== "message") || typeof row.id !== "string" || !isUuid(row.id)
    || typeof row.createdAt !== "string" || !TIME.test(row.createdAt) || !Number.isFinite(Date.parse(row.createdAt))) throw invalid();
  // JavaScript can normalize February 30, while PostgreSQL rejects that date.
  if (Number(row.createdAt.slice(0, 4)) < 1 || new Date(row.createdAt).toISOString() !== `${row.createdAt.slice(0, 23)}Z`) throw invalid();
  return { kind: row.kind, id: row.id, createdAt: row.createdAt };
}

export function parseThreadHistoryLimit(value: string | undefined): number {
  if (value === undefined) return 40;
  const parsed = /^\d{1,3}$/.test(value) ? Number(value) : 0;
  if (parsed < 1 || parsed > 100) throw new HttpError(400, "INVALID_HISTORY_LIMIT", "Une page contient de 1 à 100 tours.");
  return parsed;
}
