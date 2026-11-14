import { discordRetryAfterSeconds, type DiscordMessage } from "../domain/alert-channels";

/**
 * Les deux appels faits à un webhook Discord : le lire (à l'ajout, pour
 * prouver qu'il existe et prendre son nom) et y poster un message.
 *
 * L'URL est un secret : elle n'apparaît dans aucune erreur levée ici, et
 * aucun corps de réponse n'est remonté (Discord peut y répéter la requête).
 * Une redirection est refusée : seul l'hôte validé à l'ajout est appelé.
 */
export type DiscordTransport = {
  inspect(webhookUrl: string): Promise<{ status: number; name: string | null }>;
  post(webhookUrl: string, message: DiscordMessage): Promise<{ status: number; retryAfterSeconds: number | null }>;
};

/** Discord injoignable : délai dépassé, DNS, TLS, connexion coupée ou redirection. */
export class DiscordTransportError extends Error {
  constructor(readonly code: "timeout" | "network") {
    super(code === "timeout" ? "Discord did not answer in time." : "Discord could not be reached.");
    this.name = "DiscordTransportError";
  }
}

const TIMEOUT_MS = 10_000;

export function createDiscordTransport(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): DiscordTransport {
  const call = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new DiscordTransportError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
  };

  return {
    async inspect(webhookUrl) {
      const response = await call(webhookUrl, { method: "GET", headers: { Accept: "application/json" } });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, name: null };
      }
      const body = await response.json().catch(() => null) as { name?: unknown } | null;
      return { status: response.status, name: typeof body?.name === "string" ? body.name : null };
    },
    async post(webhookUrl, message) {
      const response = await call(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(message),
      });
      if (response.status !== 429) {
        await response.body?.cancel();
        return { status: response.status, retryAfterSeconds: null };
      }
      const body = await response.json().catch(() => null);
      return { status: response.status, retryAfterSeconds: discordRetryAfterSeconds(body, response.headers.get("retry-after")) };
    },
  };
}
