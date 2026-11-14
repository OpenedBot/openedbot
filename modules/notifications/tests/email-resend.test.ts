import { afterEach, describe, expect, test } from "bun:test";
import { createTransactionalEmailSender } from "../src/application/email";

const realFetch = globalThis.fetch;

const base = {
  endpoint: null as string | null,
  smtpUrl: null as string | null,
  brevoApiKey: null as string | null,
  resendApiKey: null as string | null,
  resendBaseUrl: "https://api.resend.com",
  token: null as string | null,
  from: "Openedbot <no-reply@openedbot.app>" as string | null,
  timeoutMs: 10_000,
  leaseSeconds: 300,
  maxAttempts: 5,
};

const message = {
  id: "00000000-0000-4000-8000-000000000000",
  kind: "email_login_code" as const,
  dedupeKey: "email-login:kev@example.com",
  recipientEmail: "kev@example.com",
  locale: "fr",
  data: {},
};

type Captured = {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

function captureFetch(response: Response): Captured[] {
  const captured: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    return response;
  }) as typeof fetch;
  return captured;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("transport Resend", () => {
  test("posts rendered content with bearer auth and the stable idempotency key", async () => {
    const captured = captureFetch(new Response('{"id":"email_123"}', { status: 200 }));
    const sender = createTransactionalEmailSender({
      ...base,
      resendApiKey: "re_test-secret",
      resendBaseUrl: "https://mail-compatible.example/v1/",
    });
    await sender!.send(message);

    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.url).toBe("https://mail-compatible.example/v1/emails");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer re_test-secret");
    expect(call.headers["Idempotency-Key"]).toBe("email-login:kev@example.com");
    expect(call.body).toMatchObject({
      from: "Openedbot <no-reply@openedbot.app>",
      to: ["kev@example.com"],
      subject: "Votre code de connexion à openedbot",
    });
    expect(String(call.body.html).startsWith("<!DOCTYPE html>")).toBe(true);
    expect(String(call.body.text)).toContain("code");
    expect(Object.keys(call.body).sort()).toEqual(["from", "html", "subject", "text", "to"]);
  });

  test("reports a non-2xx response with status and at most 200 body characters", async () => {
    const detail = `provider rejected re_test-secret ${"x".repeat(240)}`;
    captureFetch(new Response(detail, { status: 503 }));
    const sender = createTransactionalEmailSender({ ...base, resendApiKey: "re_test-secret" });
    const failure = await sender!.send(message).then(() => null, (error: Error) => error);

    expect(failure?.message).toBe(`Resend returned HTTP 503: ${detail.replaceAll("re_test-secret", "[redacted]").slice(0, 200)}`);
    expect(failure?.message).not.toContain("re_test-secret");
  });

  test("reports the configured request timeout", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    })) as typeof fetch;
    const sender = createTransactionalEmailSender({
      ...base,
      resendApiKey: "re_test-secret",
      timeoutMs: 1,
    });

    await expect(sender!.send(message)).rejects.toThrow("Resend timed out.");
  });

  test("is exclusive of Brevo and requires FROM", () => {
    expect(() => createTransactionalEmailSender({
      ...base,
      brevoApiKey: "xkeysib-secret",
      resendApiKey: "re_test-secret",
    })).toThrow(/exactly one transport/);
    expect(() => createTransactionalEmailSender({
      ...base,
      resendApiKey: "re_test-secret",
      from: null,
    })).toThrow(/TRANSACTIONAL_EMAIL_FROM/);
  });
});
