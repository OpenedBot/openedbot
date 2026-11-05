/**
 * Preuve SMTP : un e-mail `provider_quota_reached` part vers Mailpit
 * (infra-mailpit, 127.0.0.1:1025 / 8025) et se relit par son API.
 * S'arrête proprement (« non jouée ») si Mailpit ne répond pas.
 */
import { createTransactionalEmailSender } from "@openedbot/notifications/application/email";

const smtpUrl = process.env.TRANSACTIONAL_EMAIL_SMTP_URL?.trim() || "smtp://127.0.0.1:1025";
const mailpitUrl = (process.env.E2E_MAILPIT_URL?.trim() || "http://127.0.0.1:8025").replace(/\/+$/, "");
const from = process.env.TRANSACTIONAL_EMAIL_FROM?.trim() || "openedbot@openedbot.local";
const recipient = process.env.E2E_EMAIL?.trim() || "dev@openedbot.local";

const probe = await fetch(`${mailpitUrl}/api/v1/messages`).catch(() => null);
if (!probe?.ok) {
  console.warn("make e2e-email: Mailpit ne répond pas sur %s — non jouée.", mailpitUrl);
  process.exit(0);
}

const sender = createTransactionalEmailSender({
  endpoint: null,
  smtpUrl,
  brevoApiKey: null,
  resendApiKey: null,
  resendBaseUrl: "https://api.resend.com",
  token: null,
  from,
  timeoutMs: 10_000,
  leaseSeconds: 300,
  maxAttempts: 1,
});
if (!sender) {
  throw new Error("SMTP sender was not created.");
}

const token = crypto.randomUUID();
const subjectNeedle = `Quota atteint sur e2e-provider-${token.slice(0, 8)}`;
await sender.send({
  id: crypto.randomUUID(),
  kind: "provider_quota_reached",
  dedupeKey: `e2e-email:${token}`,
  recipientEmail: recipient,
  locale: "fr",
  data: {
    provider: `e2e-provider-${token.slice(0, 8)}`,
    occurredAt: new Date().toISOString(),
    fallback: "opencode-free / nemotron",
    settingsUrl: "http://localhost:1420/settings/models",
  },
});

const deadline = Date.now() + 8_000;
let found = false;
while (Date.now() < deadline) {
  const response = await fetch(`${mailpitUrl}/api/v1/messages`);
  if (!response.ok) throw new Error(`Mailpit messages HTTP ${response.status}`);
  const body = await response.json() as {
    messages?: Array<{ Subject?: string; To?: Array<{ Address?: string }> }>;
  };
  found = (body.messages ?? []).some((message) => {
    const subject = message.Subject ?? "";
    const to = (message.To ?? []).map((entry) => entry.Address ?? "");
    return subject.includes(subjectNeedle.replace("Quota atteint sur ", "")) && to.includes(recipient);
  }) || (body.messages ?? []).some((message) =>
    (message.Subject ?? "").includes(`e2e-provider-${token.slice(0, 8)}`)
    && (message.To ?? []).some((entry) => entry.Address === recipient)
  );
  if (found) break;
  await Bun.sleep(250);
}

if (!found) {
  throw new Error(`Mailpit did not receive the provider_quota_reached test mail for ${recipient}.`);
}

console.log("make e2e-email: Mailpit a reçu « %s » pour %s.", subjectNeedle, recipient);
