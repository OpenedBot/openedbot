import { afterEach, describe, expect, test } from "bun:test";
import { createTransactionalEmailSender, parseEmailAddress } from "../src/application/email";

const realFetch = globalThis.fetch;

const base = {
  endpoint: null as string | null,
  smtpUrl: null as string | null,
  brevoApiKey: null as string | null,
  resendApiKey: null as string | null,
  resendBaseUrl: "https://api.resend.com",
  token: null as string | null,
  from: "openedbot <no-reply@openedbot.app>",
  timeoutMs: 10_000,
  leaseSeconds: 300,
  maxAttempts: 5,
};

const message = {
  id: "00000000-0000-4000-8000-000000000000",
  kind: "waitlist_confirmation" as const,
  dedupeKey: "waitlist:kev@example.com",
  recipientEmail: "kev@example.com",
  locale: "fr",
  data: {},
};

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function captureFetch(response: Response): Captured[] {
  const captured: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
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

describe("parseEmailAddress", () => {
  test("sépare le nom de l'adresse, ou rend l'adresse seule", () => {
    expect(parseEmailAddress("openedbot <no-reply@openedbot.app>")).toEqual({ name: "openedbot", email: "no-reply@openedbot.app" });
    expect(parseEmailAddress('"openedbot" <no-reply@openedbot.app>')).toEqual({ name: "openedbot", email: "no-reply@openedbot.app" });
    expect(parseEmailAddress("  no-reply@openedbot.app ")).toEqual({ email: "no-reply@openedbot.app" });
    expect(parseEmailAddress("<no-reply@openedbot.app>")).toEqual({ email: "no-reply@openedbot.app" });
  });
});

describe("transport Brevo", () => {
  test("poste le message rendu, la clé en en-tête et jamais dans l'URL", async () => {
    const captured = captureFetch(new Response("{}", { status: 201 }));
    const sender = createTransactionalEmailSender({ ...base, brevoApiKey: "xkeysib-secret" });
    await sender!.send(message);

    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(call.url).not.toContain("xkeysib-secret");
    expect(call.headers["api-key"]).toBe("xkeysib-secret");
    expect(call.body.sender).toEqual({ name: "openedbot", email: "no-reply@openedbot.app" });
    expect(call.body.to).toEqual([{ email: "kev@example.com" }]);
    expect(call.body.subject).toBe("Votre place sur la liste d’attente openedbot");
    expect(String(call.body.textContent)).toContain("liste d’attente");
    // Brevo reçoit un document complet, pas un fragment : c'est le worker qui
    // rend, le fournisseur ne porte aucun gabarit.
    expect(String(call.body.htmlContent).startsWith("<!DOCTYPE html>")).toBe(true);
    expect(call.body.headers).toEqual({ "Idempotency-Key": "waitlist:kev@example.com" });
  });

  test("rend le message dans la langue de la ligne", async () => {
    const captured = captureFetch(new Response("{}", { status: 201 }));
    const sender = createTransactionalEmailSender({ ...base, brevoApiKey: "xkeysib-secret" });
    await sender!.send({ ...message, locale: "en" });
    expect(captured[0]!.body.subject).toBe("Your place on the openedbot waiting list");
  });

  test("un refus de Brevo est nommé avec son statut, sans la clé", async () => {
    captureFetch(new Response('{"code":"unauthorized","message":"Key not found"}', { status: 401 }));
    const sender = createTransactionalEmailSender({ ...base, brevoApiKey: "xkeysib-secret" });
    const failure = await sender!.send(message).then(() => null, (error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain("HTTP 401");
    expect(failure!.message).toContain("Key not found");
    expect(failure!.message).not.toContain("xkeysib-secret");
  });

  test("deux transports posés ensemble sont une erreur de configuration", () => {
    expect(() => createTransactionalEmailSender({
      ...base,
      brevoApiKey: "xkeysib-secret",
      smtpUrl: "smtp://127.0.0.1:1025",
    })).toThrow(/exactly one transport/);
    expect(() => createTransactionalEmailSender({
      ...base,
      brevoApiKey: "xkeysib-secret",
      endpoint: "https://mail.example.test/send",
    })).toThrow(/exactly one transport/);
  });

  test("Brevo sans expéditeur est une erreur de configuration", () => {
    expect(() => createTransactionalEmailSender({ ...base, brevoApiKey: "xkeysib-secret", from: null }))
      .toThrow(/TRANSACTIONAL_EMAIL_FROM/);
  });

  test("aucun transport : pas d'envoi, pas d'erreur", () => {
    expect(createTransactionalEmailSender(base)).toBeNull();
  });
});
