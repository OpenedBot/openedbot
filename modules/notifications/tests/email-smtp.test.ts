import { describe, expect, test } from "bun:test";
import nodemailer from "nodemailer";
import { renderTransactionalEmail } from "../src/domain/email/templates";
import { createTransactionalEmailSender, parseTransactionalSmtpUrl } from "../src/application/email";

describe("parseTransactionalSmtpUrl", () => {
  test("accepts smtp:// without auth or TLS (Mailpit)", () => {
    expect(parseTransactionalSmtpUrl("smtp://127.0.0.1:1025")).toMatchObject({
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      ignoreTLS: true,
    });
  });

  test("accepts smtps:// and STARTTLS", () => {
    expect(parseTransactionalSmtpUrl("smtps://mail.example.test:465")).toMatchObject({
      host: "mail.example.test",
      port: 465,
      secure: true,
    });
    expect(parseTransactionalSmtpUrl("smtp://mail.example.test:587?starttls=true")).toMatchObject({
      port: 587,
      requireTLS: true,
    });
  });

  test("refuses anything but smtp/smtps", () => {
    expect(() => parseTransactionalSmtpUrl("https://mail.example.test/send")).toThrow(/smtp/);
  });
});

describe("createTransactionalEmailSender", () => {
  const base = {
    endpoint: null as string | null,
    smtpUrl: null as string | null,
    brevoApiKey: null as string | null,
    resendApiKey: null as string | null,
    resendBaseUrl: "https://api.resend.com",
    token: null as string | null,
    from: "openedbot@openedbot.local",
    timeoutMs: 10_000,
    leaseSeconds: 300,
    maxAttempts: 5,
  };

  test("HTTP and SMTP together are a config error", () => {
    expect(() => createTransactionalEmailSender({
      ...base,
      endpoint: "https://mail.openedbot.example/send",
      smtpUrl: "smtp://127.0.0.1:1025",
      token: "token",
    })).toThrow(/exactly one transport/);
  });

  test("neither transport: sender is off", () => {
    expect(createTransactionalEmailSender(base)).toBeNull();
  });

  test("SMTP jsonTransport delivers a rendered quota mail", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sender = createTransactionalEmailSender({
      ...base,
      smtpUrl: "smtp://127.0.0.1:1025",
    }, transport);
    expect(sender).not.toBeNull();
    await sender!.send({
      id: "mail-1",
      kind: "provider_quota_reached",
      dedupeKey: "provider-quota:rt-1:openai-codex:2026-09-04:user-1",
      recipientEmail: "owner@openedbot.local",
      locale: "fr",
      data: {
        provider: "openai-codex",
        occurredAt: "2026-09-04T20:03:00.000Z",
        fallback: "opencode-free / nemotron",
        settingsUrl: "http://localhost:1420/settings/models",
      },
    });
  });
});

describe("renderTransactionalEmail", () => {
  test("quota mail names the provider, time, fallback and settings link", () => {
    const rendered = renderTransactionalEmail({
      kind: "provider_quota_reached",
      locale: "fr",
      data: {
        provider: "openai-codex",
        occurredAt: "2026-09-04T20:03:00.000Z",
        fallback: "opencode-free / nemotron",
        settingsUrl: "http://localhost:1420/settings/models",
      },
    });
    expect(rendered.subject).toContain("openai-codex");
    expect(rendered.text).toContain("opencode-free / nemotron");
    expect(rendered.text).toContain("/settings/models");
    expect(rendered.html).toContain("openai-codex");
  });
});
