import type { SQL } from "bun";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { TransactionalEmailKind } from "@openedbot/contracts-api";
import { renderTransactionalEmail } from "../domain/email/templates";

/** La configuration du transport des e-mails transactionnels, lue par le worker. */
export type TransactionalEmailConfig = {
  /** Endpoint HTTP interne fourni par l'opérateur; aucun fournisseur n'est imposé. */
  endpoint: string | null;
  /** SMTP URL (`smtp://127.0.0.1:1025`) ; exclusif des autres transports. */
  smtpUrl: string | null;
  /** Clé d'API Brevo (`https://api.brevo.com/v3/smtp/email`) ; exclusive des autres transports. */
  brevoApiKey: string | null;
  /** Clé d'API Resend ou compatible ; exclusive des autres transports. */
  resendApiKey: string | null;
  /** Origine de l'API Resend-compatible. */
  resendBaseUrl: string;
  token: string | null;
  from: string | null;
  timeoutMs: number;
  leaseSeconds: number;
  maxAttempts: number;
};

const RETRY_DELAYS_SECONDS = [30, 120, 600, 1_800];
const MAX_ERROR_LENGTH = 500;

export type TransactionalEmail = {
  id: string;
  kind: TransactionalEmailKind;
  dedupeKey: string;
  recipientEmail: string;
  locale: string;
  data: Record<string, unknown>;
};

/** L'API transactionnelle de Brevo : une seule route, une seule clé. */
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

export type TransactionalEmailSender = {
  send(message: TransactionalEmail): Promise<void>;
};

type EmailOutboxConfig = TransactionalEmailConfig & { workerId: string };

type ClaimedEmail = TransactionalEmail & { attempts: number };

type EmailOutboxEvent = "sent" | "retry" | "failed" | "lease_lost";
type FlatEventDetail = string | number | boolean | null;

function emailDomainFromValue(value: string): string {
  const afterAt = value.slice(value.lastIndexOf("@") + 1).trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*/u.exec(afterAt)?.[0]
    ?? "domaine-masque";
}

function safeEventDetail(detail: Record<string, unknown>): Record<string, FlatEventDetail> {
  const filtered: Record<string, FlatEventDetail> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (key.includes("@")) continue;
    if (typeof value === "string") {
      filtered[key] = value.includes("@") ? emailDomainFromValue(value) : value;
      continue;
    }
    if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean" || value === null) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Jumelle de `transactional-email.ts` côté API : les workspaces ne s'importent
 * pas, donc les deux insertions et leurs gardes de confidentialité doivent
 * bouger ensemble. `detail` reste un objet jsonb, jamais une chaîne sérialisée.
 */
async function recordEmailOutboxEvent(db: SQL, entry: {
  outboxId: string;
  kind: TransactionalEmailKind;
  event: EmailOutboxEvent;
  attempt?: number | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const detail = safeEventDetail(entry.detail ?? {});
  await db`
    insert into email_outbox_events (outbox_id, kind, event, attempt, detail)
    values (${entry.outboxId}, ${entry.kind}, ${entry.event}, ${entry.attempt ?? null}, ${detail}::jsonb)
  `;
}

/** Le journal observe la livraison : son échec ne doit jamais la piloter. */
async function observeEmailOutboxEvent(db: SQL, entry: Parameters<typeof recordEmailOutboxEvent>[1]): Promise<void> {
  try {
    await recordEmailOutboxEvent(db, entry);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "worker.email_event_record_failed",
      outboxId: entry.outboxId,
      kind: entry.kind,
      emailEvent: entry.event,
      error: safeErrorMessage(error),
    }));
  }
}

/**
 * Quatre transports, un seul à la fois : l'endpoint HTTP de l'opérateur (qui
 * rend lui-même le message), le SMTP (Mailpit en local, un relais ailleurs),
 * Brevo et Resend par leurs clés d'API (les paliers hébergés, preprod et
 * production). Deux transports posés ensemble sont une erreur de configuration,
 * jamais un ordre de priorité deviné.
 */
export function createTransactionalEmailSender(
  config: TransactionalEmailConfig,
  smtpTransport?: Transporter,
): TransactionalEmailSender | null {
  const chosen = [
    config.endpoint ? "TRANSACTIONAL_EMAIL_ENDPOINT" : null,
    config.smtpUrl ? "TRANSACTIONAL_EMAIL_SMTP_URL" : null,
    config.brevoApiKey ? "TRANSACTIONAL_EMAIL_BREVO_API_KEY" : null,
    config.resendApiKey ? "TRANSACTIONAL_EMAIL_RESEND_API_KEY" : null,
  ].filter((name): name is string => name !== null);
  if (chosen.length > 1) {
    throw new Error(`Transactional email accepts exactly one transport; ${chosen.join(" and ")} are set together.`);
  }
  if (chosen.length < 1) return null;
  if (!config.from) {
    throw new Error("Transactional email requires TRANSACTIONAL_EMAIL_FROM.");
  }
  if (config.endpoint) {
    if (!config.token) {
      throw new Error("Transactional email endpoint requires TRANSACTIONAL_EMAIL_TOKEN and TRANSACTIONAL_EMAIL_FROM.");
    }
    return createHttpEmailSender(config);
  }
  if (config.brevoApiKey) return createBrevoEmailSender(config);
  if (config.resendApiKey) return createResendEmailSender(config);
  return createSmtpEmailSender(config, smtpTransport);
}

/**
 * Une adresse d'expéditeur telle qu'on l'écrit dans une configuration
 * (`openedbot <hello@exemple.fr>` ou `hello@exemple.fr`), rendue au format que
 * Brevo attend : `{ name?, email }`.
 */
export function parseEmailAddress(raw: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/u.exec(raw);
  if (!match) return { email: raw.trim() };
  const name = match[1]!.replace(/^["']|["']$/gu, "").trim();
  const email = match[2]!.trim();
  return name ? { name, email } : { email };
}

/**
 * Brevo rend le message ICI, avec les mêmes gabarits que le SMTP : le
 * fournisseur reçoit un sujet, un texte et un HTML déjà écrits, jamais un nom
 * de template à retrouver dans son interface. Un palier qui change de
 * fournisseur ne change donc pas un mot de ce qui part.
 *
 * La clé voyage en en-tête `api-key`, jamais dans l'URL ni dans un message
 * d'erreur : `safeErrorMessage` recopie ce que jette cette fonction.
 */
function createBrevoEmailSender(
  config: TransactionalEmailConfig,
): TransactionalEmailSender {
  const apiKey = config.brevoApiKey!;
  const sender = parseEmailAddress(config.from!);

  return {
    async send(message) {
      const rendered = renderTransactionalEmail(message);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetch(BREVO_ENDPOINT, {
          method: "POST",
          redirect: "error",
          headers: {
            "api-key": apiKey,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sender,
            to: [{ email: message.recipientEmail }],
            subject: rendered.subject,
            textContent: rendered.text,
            htmlContent: rendered.html,
            headers: { "Idempotency-Key": message.dedupeKey },
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          // Le corps de Brevo nomme la cause (clé refusée, expéditeur non
          // vérifié, quota) ; il ne contient pas la clé.
          const detail = (await response.text().catch(() => "")).slice(0, 200).trim();
          throw new Error(`Brevo returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Brevo timed out.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function createResendEmailSender(
  config: TransactionalEmailConfig,
): TransactionalEmailSender {
  const apiKey = config.resendApiKey!;
  const endpoint = `${config.resendBaseUrl.replace(/\/+$/u, "")}/emails`;

  return {
    async send(message) {
      const rendered = renderTransactionalEmail(message);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.dedupeKey,
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.recipientEmail],
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).replaceAll(apiKey, "[redacted]").slice(0, 200);
          throw new Error(`Resend returned HTTP ${response.status}: ${detail}`);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Resend timed out.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function createHttpEmailSender(
  config: TransactionalEmailConfig,
): TransactionalEmailSender {
  const endpoint = new URL(config.endpoint!);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("Transactional email endpoint must use HTTP or HTTPS.");
  }

  return {
    async send(message) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json",
            "idempotency-key": message.dedupeKey,
          },
          body: JSON.stringify({
            from: config.from,
            to: message.recipientEmail,
            template: message.kind,
            locale: message.locale,
            data: message.data,
            idempotencyKey: message.dedupeKey,
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Transactional email endpoint returned HTTP ${response.status}.`);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Transactional email endpoint timed out.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function parseTransactionalSmtpUrl(raw: string): SMTPTransport.Options {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("TRANSACTIONAL_EMAIL_SMTP_URL must be a smtp:// or smtps:// URL.");
  }
  if (parsed.protocol !== "smtp:" && parsed.protocol !== "smtps:") {
    throw new Error("TRANSACTIONAL_EMAIL_SMTP_URL must use smtp:// or smtps://.");
  }
  const secure = parsed.protocol === "smtps:";
  const starttls = parsed.searchParams.get("starttls") === "1"
    || parsed.searchParams.get("starttls") === "true";
  const port = parsed.port ? Number(parsed.port) : (secure ? 465 : 25);
  if (!Number.isFinite(port) || port < 1 || port > 65_535) {
    throw new Error("TRANSACTIONAL_EMAIL_SMTP_URL port is invalid.");
  }
  const options: SMTPTransport.Options = {
    host: parsed.hostname || "127.0.0.1",
    port,
    secure,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  };
  if (parsed.username || parsed.password) {
    options.auth = {
      user: decodeURIComponent(parsed.username),
      pass: decodeURIComponent(parsed.password),
    };
  }
  if (!secure && !starttls) {
    options.ignoreTLS = true;
  }
  if (starttls) {
    options.requireTLS = true;
  }
  return options;
}

function createSmtpEmailSender(
  config: TransactionalEmailConfig,
  injected?: Transporter,
): TransactionalEmailSender {
  const transport = injected ?? nodemailer.createTransport(parseTransactionalSmtpUrl(config.smtpUrl!));
  const from = config.from!;
  return {
    async send(message) {
      const rendered = renderTransactionalEmail(message);
      await transport.sendMail({
        from,
        to: message.recipientEmail,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: { "Idempotency-Key": message.dedupeKey },
      });
    },
  };
}

const FINAL_LEASE_EXPIRED_ERROR = "lease expired after final attempt";

/**
 * `attempts` monte AVANT l'envoi : un worker mort pendant la dernière
 * tentative laisse une ligne `sending` que la réclamation (`attempts <
 * maxAttempts`) ne reprendra jamais. Elle est close ici comme un échec
 * définitif, et perd destinataire et charge utile (mot de passe temporaire).
 */
async function failExpiredFinalLeases(db: SQL, config: EmailOutboxConfig): Promise<number> {
  const failed = await db<Array<{ id: string; kind: TransactionalEmailKind; attempts: number }>>`
    update email_outbox set status = 'failed',
      recipient_email = null, payload = '{}'::jsonb,
      lease_owner = null, lease_expires_at = null,
      last_error = ${FINAL_LEASE_EXPIRED_ERROR}
     where status = 'sending'
       and lease_expires_at <= now()
       and attempts >= ${config.maxAttempts}
     returning id, kind, attempts
  `;
  for (const row of failed) {
    await observeEmailOutboxEvent(db, {
      outboxId: row.id,
      kind: row.kind,
      event: "failed",
      attempt: row.attempts,
      detail: { error: FINAL_LEASE_EXPIRED_ERROR },
    });
    console.error(JSON.stringify({
      event: "worker.email_failed",
      outboxId: row.id,
      attempts: row.attempts,
      error: FINAL_LEASE_EXPIRED_ERROR,
    }));
  }
  return failed.length;
}

/**
 * A sign-in code is valid ten minutes from its request (the code and its
 * outbox row are written in the same transaction). Delivered later, after a
 * worker outage, it can only fail, and it lands next to the fresh code the
 * user asked for since. It is dropped instead, like a final failure.
 */
const CODE_EMAIL_LIFETIME_SECONDS: Partial<Record<TransactionalEmailKind, number>> = {
  email_login_code: 600,
  staff_login_code: 600,
};
const CODE_EMAIL_EXPIRED_ERROR = "code expired before delivery";

async function dropStaleCodeEmails(db: SQL): Promise<number> {
  let dropped = 0;
  for (const [kind, lifetime] of Object.entries(CODE_EMAIL_LIFETIME_SECONDS)) {
    const rows = await db<Array<{ id: string; kind: TransactionalEmailKind; attempts: number }>>`
      update email_outbox set status = 'failed',
        recipient_email = null, payload = '{}'::jsonb,
        lease_owner = null, lease_expires_at = null,
        last_error = ${CODE_EMAIL_EXPIRED_ERROR}
       where kind = ${kind}
         and created_at <= now() - (${lifetime} * interval '1 second')
         and (status = 'pending' or (status = 'sending' and lease_expires_at <= now()))
       returning id, kind, attempts
    `;
    for (const row of rows) {
      await observeEmailOutboxEvent(db, {
        outboxId: row.id,
        kind: row.kind,
        event: "failed",
        attempt: row.attempts,
        detail: { error: CODE_EMAIL_EXPIRED_ERROR },
      });
      console.warn(JSON.stringify({ event: "worker.email_expired", outboxId: row.id, kind: row.kind }));
    }
    dropped += rows.length;
  }
  return dropped;
}

/**
 * Claims one durable message, sends it outside the SQL transaction, then marks
 * it terminal. A stable dedupe key is passed to the sender because a worker
 * crash after HTTP success can cause a lease reclaim and a second delivery.
 */
export async function processEmailOutbox(
  db: SQL,
  sender: TransactionalEmailSender,
  config: EmailOutboxConfig,
): Promise<"idle" | "sent" | "retrying" | "failed" | "lease_lost"> {
  await failExpiredFinalLeases(db, config);
  await dropStaleCodeEmails(db);
  const claimed = await db.begin(async (tx) => {
    const rows = await tx<ClaimedEmail[]>`
      with candidate as (
        select id from email_outbox
         where attempts < ${config.maxAttempts}
           and recipient_email is not null
           and (
             (status = 'pending' and available_at <= now())
             or (status = 'sending' and lease_expires_at <= now())
           )
         order by created_at asc
         for update skip locked
         limit 1
      )
      update email_outbox outbox
         set status = 'sending', lease_owner = ${config.workerId},
             lease_expires_at = now() + (${config.leaseSeconds} * interval '1 second'),
             attempts = outbox.attempts + 1, last_error = null
        from candidate
       where outbox.id = candidate.id
       returning outbox.id, outbox.kind, outbox.dedupe_key as "dedupeKey",
                 outbox.recipient_email as "recipientEmail", outbox.locale,
                 outbox.payload as data, outbox.attempts
    `;
    return rows[0] ?? null;
  }) as ClaimedEmail | null;

  if (!claimed) return "idle";

  try {
    await sender.send(claimed);
    // Envoyé : la ligne garde sa trace (identifiant, genre, clé, date) et perd
    // tout ce qui décrit une personne. Le destinataire s'efface depuis
    // toujours ; la charge utile le rejoint, parce qu'elle porte selon le
    // genre une adresse ou un MOT DE PASSE temporaire
    // (`staff_account_created`), et qu'un message parti n'a plus besoin de son
    // contenu. `'{}'` et non `null` : la colonne est `not null` et contrainte
    // à un objet jsonb.
    const marked = await db<Array<{ id: string }>>`
      update email_outbox set status = 'sent', sent_at = now(),
        recipient_email = null, payload = '{}'::jsonb,
        lease_owner = null, lease_expires_at = null,
        last_error = null
       where id = ${claimed.id} and status = 'sending' and lease_owner = ${config.workerId}
       returning id
    `;
    if (!marked[0]) {
      await observeEmailOutboxEvent(db, {
        outboxId: claimed.id,
        kind: claimed.kind,
        event: "lease_lost",
      });
      console.warn(JSON.stringify({ event: "worker.email_lease_lost", outboxId: claimed.id }));
      return "lease_lost";
    }
    await observeEmailOutboxEvent(db, {
      outboxId: claimed.id,
      kind: claimed.kind,
      event: "sent",
      attempt: claimed.attempts,
    });
    console.info(JSON.stringify({ event: "worker.email_sent", outboxId: claimed.id, kind: claimed.kind }));
    return "sent";
  } catch (error) {
    const terminal = claimed.attempts >= config.maxAttempts;
    const nextStatus = terminal ? "failed" : "pending";
    const delay = retryDelaySeconds(claimed.attempts);
    const errorMessage = safeErrorMessage(error);
    // Un abandon définitif ne sera jamais rejoué (la reprise n'examine que
    // `pending` et `sending`) : la ligne y perd donc destinataire et charge
    // utile comme un envoi réussi, et ne garde que `last_error` pour le
    // diagnostic. Une tentative qui repart, elle, a encore besoin des deux.
    await db`
      update email_outbox set status = ${nextStatus},
        available_at = now() + (${delay} * interval '1 second'),
        recipient_email = case when ${terminal}::boolean then null else recipient_email end,
        payload = case when ${terminal}::boolean then '{}'::jsonb else payload end,
        lease_owner = null, lease_expires_at = null, last_error = ${errorMessage}
       where id = ${claimed.id} and status = 'sending' and lease_owner = ${config.workerId}
    `;
    await observeEmailOutboxEvent(db, {
      outboxId: claimed.id,
      kind: claimed.kind,
      event: terminal ? "failed" : "retry",
      attempt: claimed.attempts,
      detail: { error: errorMessage },
    });
    console.error(JSON.stringify({
      event: terminal ? "worker.email_failed" : "worker.email_retry",
      outboxId: claimed.id,
      attempts: claimed.attempts,
      error: errorMessage,
    }));
    return terminal ? "failed" : "retrying";
  }
}

function retryDelaySeconds(attempts: number): number {
  return RETRY_DELAYS_SECONDS[Math.max(0, Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1))] ?? 1_800;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, MAX_ERROR_LENGTH) || "Transactional email failed.";
}
