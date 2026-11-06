import { logEvent } from "@openedbot/platform-observability";

export function pollWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export function messageText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n");
}

/**
 * Une ligne du journal d'un run, par le logger commun (pino) : horodatée,
 * nivelée, rédigée, et portant `traceId` / `spanId` quand le worker l'écrit
 * dans le contexte de trace du run.
 */
export function log(event: string, fields: Record<string, unknown>): void {
  logEvent(event, fields);
}
/**
 * Le texte d'une panne, qu'elle arrive en `Error` ou en trame SSE brute.
 *
 * Une trame `run.failed` est un objet : `String(objet)` rendait
 * « [object Object] », qui finissait tel quel dans `runtime_provider_incidents`
 * et dans l'alerte de quota. Son diagnostic vit dans `message` ou `error`.
 */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; error?: unknown };
    const text = typeof record.message === "string" && record.message.trim()
      ? record.message
      : typeof record.error === "string" && record.error.trim()
        ? record.error
        : null;
    if (text) return text;
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
