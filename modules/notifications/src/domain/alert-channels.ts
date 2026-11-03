/**
 * Canaux d'alerte d'une organisation (DEV-OPE2-7) : où dire qu'un runtime ne
 * répond plus, au-delà de l'e-mail. Discord d'abord, par webhook entrant ;
 * Telegram suivra (bot openedbot officiel).
 *
 * Tout ce qui est ici est pur : l'URL acceptée, le texte envoyé, la lecture
 * d'une réponse de Discord et le délai avant un nouvel essai. Le transport et
 * la base vivent dans `application/` et `sql/`.
 */

export const ALERT_CHANNEL_KINDS = ["discord"] as const;
export type AlertChannelKind = (typeof ALERT_CHANNEL_KINDS)[number];

export const ALERT_DELIVERY_EVENTS = ["runtime_link_down", "runtime_link_restored"] as const;
export type AlertDeliveryEvent = (typeof ALERT_DELIVERY_EVENTS)[number];

/**
 * Ce qui a mal tourné, en un mot : la colonne `last_failure_reason` (0157) et
 * le texte de la console. Jamais un corps de réponse, qui peut répéter l'URL.
 */
export const ALERT_FAILURE_REASONS = [
  "webhook_revoked",
  "rejected",
  "rate_limited",
  "unreachable",
  "decryption_failed",
] as const;
export type AlertFailureReason = (typeof ALERT_FAILURE_REASONS)[number];

export const MAX_ALERT_CHANNELS_PER_ORGANIZATION = 10;
export const ALERT_CHANNEL_LABEL_MAX = 80;
/** Au plus ce nombre d'essais HTTP par livraison ; une réclamation compte pour un. */
export const ALERT_DELIVERY_MAX_ATTEMPTS = 6;
/** Un test par canal à cette cadence au plus : Discord limite chaque webhook. */
export const ALERT_CHANNEL_TEST_COOLDOWN_SECONDS = 10;

/**
 * Hôtes d'un webhook Discord. `discordapp.com` est l'ancien domaine, toujours
 * servi ; `ptb.` et `canary.` sont les clients de test, qui copient des URL
 * sur leur propre sous-domaine.
 */
const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);
const DISCORD_WEBHOOK_PATH = /^\/api(?:\/v\d{1,2})?\/webhooks\/(\d{17,21})\/([A-Za-z0-9_-]{40,120})\/?$/;

export type DiscordWebhook = {
  /** L'URL canonique, seule forme chiffrée et appelée : toujours `https://discord.com/api/webhooks/<id>/<jeton>`. */
  url: string;
  /** L'identifiant du webhook : public, il sert d'aperçu et de clé de doublon. */
  webhookId: string;
};

export type DiscordWebhookRefusal = "invalid_url" | "not_discord" | "not_a_webhook";

/**
 * L'URL de webhook Discord collée par l'utilisateur, ou la raison du refus.
 *
 * L'API appelle cette URL : n'accepter que l'hôte Discord, en HTTPS, sans
 * identifiants, port, requête ni fragment, ferme la porte à une requête
 * forgée vers le réseau interne (SSRF). L'appel lui-même refuse aussi les
 * redirections.
 */
export function parseDiscordWebhookUrl(raw: unknown): DiscordWebhook | DiscordWebhookRefusal {
  if (typeof raw !== "string") return "invalid_url";
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return "invalid_url";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "invalid_url";
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return "not_discord";
  if (!DISCORD_WEBHOOK_HOSTS.has(url.hostname.toLowerCase())) return "not_discord";
  if (url.search || url.hash) return "not_a_webhook";
  const match = DISCORD_WEBHOOK_PATH.exec(url.pathname);
  if (!match) return "not_a_webhook";
  const [, webhookId, token] = match as unknown as [string, string, string];
  return { url: `https://discord.com/api/webhooks/${webhookId}/${token}`, webhookId };
}

/** L'aperçu montré à la place du secret : l'hôte et l'identifiant, jamais le jeton. */
export function discordWebhookHint(webhookId: string): string {
  return `discord.com/api/webhooks/${webhookId}/…`;
}

/** Le libellé saisi, ou `null` s'il n'en a pas la forme. */
export function readAlertChannelLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.replace(/\s+/g, " ").trim();
  if (label.length === 0 || label.length > ALERT_CHANNEL_LABEL_MAX) return null;
  return label;
}

export type RuntimeLinkDownPayload = {
  runtimeName: string;
  reason: string | null;
  downSince: string;
  settingsUrl: string;
  environment: string;
};

export type RuntimeLinkRestoredPayload = {
  runtimeName: string;
  downSince: string;
  restoredAt: string;
  settingsUrl: string;
  environment: string;
};

export type DiscordMessage = {
  content: string;
  username: string;
  /** Aucune mention : un nom de runtime « @everyone » ne fait sonner personne. */
  allowed_mentions: { parse: [] };
};

const DISCORD_CONTENT_MAX = 2_000;
const BOT_USERNAME = "openedbot";

/**
 * Le message d'une livraison. Les heures sont des horodatages Discord
 * (`<t:…:f>`), que chaque lecteur voit dans son propre fuseau. Le nom et la
 * raison viennent de l'organisation : leur Markdown est neutralisé, et
 * `allowed_mentions` coupe toute mention.
 */
export function discordAlertMessage(
  event: AlertDeliveryEvent,
  payload: RuntimeLinkDownPayload | RuntimeLinkRestoredPayload,
): DiscordMessage {
  const where = payload.environment === "prod" ? "" : ` [${payload.environment}]`;
  const name = escapeDiscordMarkdown(payload.runtimeName);
  const since = discordTimestamp(payload.downSince);
  const lines = event === "runtime_link_down"
    ? [
      `🔴 **Runtime injoignable : ${name}**${where}`,
      `Plus de nouvelles depuis ${since.full} (${since.relative}).`,
      ...("reason" in payload && payload.reason ? [`Raison : ${escapeDiscordMarkdown(payload.reason)}`] : []),
      `Ouvrir le runtime : <${payload.settingsUrl}>`,
    ]
    : [
      `🟢 **Runtime rétabli : ${name}**${where}`,
      `Panne de ${formatOutage(payload.downSince, (payload as RuntimeLinkRestoredPayload).restoredAt)}, depuis ${since.full}.`,
      `Ouvrir le runtime : <${payload.settingsUrl}>`,
    ];
  return discordMessage(lines.join("\n"));
}

/** Le message du bouton « Envoyer un test ». */
export function discordTestMessage(label: string, environment: string): DiscordMessage {
  const where = environment === "prod" ? "" : ` [${environment}]`;
  return discordMessage([
    `✅ **Test openedbot**${where}`,
    `Ce salon recevra les alertes « ${escapeDiscordMarkdown(label)} » : un message quand un runtime ne répond plus, un autre quand il revient.`,
  ].join("\n"));
}

function discordMessage(content: string): DiscordMessage {
  return {
    content: content.length > DISCORD_CONTENT_MAX ? `${content.slice(0, DISCORD_CONTENT_MAX - 1)}…` : content,
    username: BOT_USERNAME,
    allowed_mentions: { parse: [] },
  };
}

/** Neutralise le Markdown Discord (gras, liens masqués, citations, titres, blocs). */
export function escapeDiscordMarkdown(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 300).replace(/([\\*_~`|>#[\]()<:-])/g, "\\$1");
}

function discordTimestamp(iso: string): { full: string; relative: string } {
  const seconds = Math.floor(new Date(iso).getTime() / 1_000);
  if (!Number.isFinite(seconds)) return { full: iso, relative: iso };
  return { full: `<t:${seconds}:f>`, relative: `<t:${seconds}:R>` };
}

/** « 10 h 15 min », « 7 min », « 2 j 3 h » : la durée lisible d'une panne. */
export function formatOutage(fromIso: string, toIso: string): string {
  const totalMinutes = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000));
  if (!Number.isFinite(totalMinutes)) return "durée inconnue";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days} j ${hours} h` : `${days} j`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return `${Math.max(1, minutes)} min`;
}

export type DiscordOutcome =
  | { kind: "sent" }
  | { kind: "retry"; reason: "rate_limited" | "unreachable"; delaySeconds: number | null }
  | { kind: "revoked" }
  | { kind: "rejected" };

/**
 * Ce que dit une réponse de Discord à un POST de webhook.
 *
 * - 2xx : livré.
 * - 401, 403, 404 : le webhook a été supprimé ou son jeton changé. Réessayer
 *   n'y fera rien : le canal est à refaire.
 * - 429 : Discord dit combien attendre (`retry_after` en secondes, ou
 *   `Retry-After`).
 * - 5xx : panne passagère de Discord.
 * - Autre 4xx : le message est refusé tel quel.
 */
export function classifyDiscordResponse(status: number, retryAfterSeconds: number | null): DiscordOutcome {
  if (status >= 200 && status < 300) return { kind: "sent" };
  if (status === 401 || status === 403 || status === 404) return { kind: "revoked" };
  if (status === 429) return { kind: "retry", reason: "rate_limited", delaySeconds: retryAfterSeconds };
  if (status >= 500) return { kind: "retry", reason: "unreachable", delaySeconds: null };
  return { kind: "rejected" };
}

/** Le délai annoncé par un 429 : corps JSON d'abord, en-tête ensuite ; borné à 1 s .. 30 min. */
export function discordRetryAfterSeconds(body: unknown, header: string | null): number | null {
  const fromBody = body && typeof body === "object" ? (body as { retry_after?: unknown }).retry_after : undefined;
  const raw = typeof fromBody === "number" ? fromBody : header !== null ? Number(header) : Number.NaN;
  if (!Number.isFinite(raw) || raw < 0) return null;
  return Math.min(Math.max(1, Math.ceil(raw)), 1_800);
}

/** 30 s, 2 min, 8 min, 30 min, 30 min : le recul des livraisons APNs. */
export function alertRetryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(30 * 4 ** exponent, 1_800);
}
