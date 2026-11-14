import { afterEach, describe, expect, test } from "bun:test";
import { listMailpitMessageIds, passwordLogin, readMailpitLoginCode } from "./password-login";

type TestMessage = {
  ID: string;
  Created: string;
  Subject: string;
  To: Array<{ Address: string }>;
  Text: string;
};

const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];
const originalFetch = globalThis.fetch;
const savedEnv = {
  E2E_MAILPIT_URL: process.env.E2E_MAILPIT_URL,
  TRANSACTIONAL_EMAIL_MAILBOX_URL: process.env.TRANSACTIONAL_EMAIL_MAILBOX_URL,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const server of servers.splice(0)) server.stop(true);
  if (savedEnv.E2E_MAILPIT_URL === undefined) delete process.env.E2E_MAILPIT_URL;
  else process.env.E2E_MAILPIT_URL = savedEnv.E2E_MAILPIT_URL;
  if (savedEnv.TRANSACTIONAL_EMAIL_MAILBOX_URL === undefined) delete process.env.TRANSACTIONAL_EMAIL_MAILBOX_URL;
  else process.env.TRANSACTIONAL_EMAIL_MAILBOX_URL = savedEnv.TRANSACTIONAL_EMAIL_MAILBOX_URL;
});

function message(
  id: string,
  code: string,
  options: { ageMs?: number; email?: string; subject?: string } = {},
): TestMessage {
  return {
    ID: id,
    Created: new Date(Date.now() - (options.ageMs ?? 0)).toISOString(),
    Subject: options.subject ?? "Votre code de connexion à openedbot",
    To: [{ Address: options.email ?? "person@example.test" }],
    Text: `Votre code de connexion\n\nCode : ${code}\n`,
  };
}

function startMailpit(messages: TestMessage[] = []) {
  let searches = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/search") {
        searches += 1;
        return Response.json({
          messages: messages.map(({ ID, Created, Subject, To }) => ({ ID, Created, Subject, To })),
        });
      }
      const id = decodeURIComponent(url.pathname.slice("/api/v1/message/".length));
      const found = messages.find((entry) => entry.ID === id);
      return found ? Response.json(found) : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, messages, get searches() { return searches; } };
}

function startApi(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function captureFetch(capture: (url: URL, init: RequestInit | undefined) => void) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    capture(new URL(input instanceof Request ? input.url : String(input)), init);
    return originalFetch(input, init);
  }) as typeof fetch;
}

describe("Mailpit sign-in code lookup", () => {
  test("lists message IDs and selects the newest matching message", async () => {
    const mailbox = startMailpit([
      message("older", "111111", { ageMs: 500 }),
      message("newer", "222222"),
    ]);
    const ids = await listMailpitMessageIds("person@example.test", { mailboxUrl: mailbox.url });
    expect([...ids]).toEqual(["older", "newer"]);
    expect(await readMailpitLoginCode("person@example.test", {
      knownIds: new Set(), mailboxUrl: mailbox.url, since: Date.now() - 1_000, timeoutMs: 1_000,
    })).toBe("222222");
  });

  test("ignores a newly visible message created before since", async () => {
    const since = Date.now();
    const mailbox = startMailpit([message("delayed-old", "111111", { ageMs: 1 })]);
    await expect(readMailpitLoginCode("person@example.test", {
      knownIds: new Set(), mailboxUrl: mailbox.url, since, timeoutMs: 500,
    })).rejects.toThrow(/Timed out waiting/);
  });

  test("uses only a still-open fallback code from the 60 second cooldown window", async () => {
    const since = Date.now() - 1_000;
    // 58 s before `since`: still inside the API's reuse window, so usable.
    const freshEnough = startMailpit([message("open", "333333", { ageMs: 59_000 })]);
    expect(await readMailpitLoginCode("person@example.test", {
      knownIds: new Set(["open"]), mailboxUrl: freshEnough.url, since, timeoutMs: 0, fallback: true,
    })).toBe("333333");

    // 61 s before `since`: the API would have issued and mailed a new code.
    const outsideWindow = startMailpit([message("old-62", "444444", { ageMs: 62_000 })]);
    await expect(readMailpitLoginCode("person@example.test", {
      knownIds: new Set(["old-62"]), mailboxUrl: outsideWindow.url, since, timeoutMs: 0, fallback: true,
    })).rejects.toThrow(/Timed out waiting/);

    const olderThan70 = startMailpit([message("old-71", "555555", { ageMs: 71_000 })]);
    await expect(readMailpitLoginCode("person@example.test", {
      knownIds: new Set(["old-71"]), mailboxUrl: olderThan70.url, since, timeoutMs: 0, fallback: true,
    })).rejects.toThrow(/Timed out waiting/);
  });

  test("waits for a late fresh message before choosing an older in-window code", async () => {
    const since = Date.now();
    const mailbox = startMailpit([message("older-open", "666666", { ageMs: 10_000 })]);
    setTimeout(() => mailbox.messages.push(message("late-new", "777777")), 300);
    expect(await readMailpitLoginCode("person@example.test", {
      knownIds: new Set(["older-open"]), mailboxUrl: mailbox.url, since, timeoutMs: 15_000, fallback: true,
    })).toBe("777777");
  });

  test("rejects another recipient and another email template, with an address and URL on timeout", async () => {
    const mailbox = startMailpit([
      message("wrong-address", "111111", { email: "other@example.test" }),
      message("wrong-template", "222222", { subject: "Your openedbot back office sign-in code" }),
    ]);
    let error: Error | undefined;
    try {
      await readMailpitLoginCode("person@example.test", {
        knownIds: new Set(), mailboxUrl: mailbox.url, timeoutMs: 500,
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toContain("person@example.test");
    expect(error?.message).toContain(mailbox.url);
    expect(error?.message).not.toContain("111111");
    expect(error?.message).not.toContain("222222");
  });
});

describe("passwordLogin", () => {
  test("posts the password, reads the code, then returns the unread final response", async () => {
    const mailbox = startMailpit();
    process.env.E2E_MAILPIT_URL = mailbox.url;
    const code = "482913";
    const bodies: Array<Record<string, unknown>> = [];
    const visibleBeforeSecond: boolean[] = [];
    const codes: string[] = [];
    const baseUrl = startApi(async (request) => {
      const body = await request.json() as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        mailbox.messages.push(message("login-code", code));
        return Response.json({ status: "code_required" }, { status: 202 });
      }
      visibleBeforeSecond.push(codes.length === 1);
      return Response.json({ csrfToken: "csrf", organizationId: "org" }, {
        status: 200,
        headers: { "Set-Cookie": "session=ok; HttpOnly; Path=/" },
      });
    });
    const redirects: Array<RequestRedirect | undefined> = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    const controller = new AbortController();
    captureFetch((url, init) => {
      if (url.origin === baseUrl) {
        redirects.push(init?.redirect);
        signals.push(init?.signal);
      }
    });
    const response = await passwordLogin(baseUrl, { email: "person@example.test", password: "safe-password" }, {
      redirect: "manual",
      signal: controller.signal,
      onCode: (value) => { codes.push(value); controller.abort(); },
    });
    expect(response.status).toBe(200);
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toMatchObject({ csrfToken: "csrf", organizationId: "org" });
    expect(bodies).toEqual([
      { email: "person@example.test", password: "safe-password" },
      { email: "person@example.test", password: "safe-password", emailCode: code },
    ]);
    expect(redirects).toEqual(["manual", "manual"]);
    expect(signals[0]).toBe(controller.signal);
    expect(signals[1]).not.toBe(controller.signal);
    expect(controller.signal.aborted).toBe(true);
    expect(visibleBeforeSecond).toEqual([true]);
    expect(codes).toEqual([code]);
  });

  test("returns a 401 unchanged without retrying", async () => {
    // A fake mailbox, so the test never reaches a real Mailpit on 8025.
    const mailbox = startMailpit();
    process.env.E2E_MAILPIT_URL = mailbox.url;
    let requests = 0;
    const baseUrl = startApi(() => {
      requests += 1;
      return Response.json({ error: { code: "EMAIL_LOGIN_CODE_INVALID" } }, { status: 401 });
    });
    const response = await passwordLogin(baseUrl, { email: "person@example.test", password: "safe-password" });
    expect(response.status).toBe(401);
    expect(response.bodyUsed).toBe(false);
    expect(requests).toBe(1);
  });

  test("waits once after the email-code cooldown and retries without stale fallback", async () => {
    const mailbox = startMailpit();
    process.env.E2E_MAILPIT_URL = mailbox.url;
    const bodies: Array<Record<string, unknown>> = [];
    const waits: number[] = [];
    const baseUrl = startApi(async (request) => {
      const body = await request.json() as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return Response.json({ error: { code: "EMAIL_LOGIN_CODE_COOLDOWN" } }, { status: 429 });
      }
      if (bodies.length === 2) {
        mailbox.messages.push(message("retry-code", "828282"));
        return Response.json({ status: "code_required" }, { status: 202 });
      }
      return Response.json({ authenticated: true });
    });
    const response = await passwordLogin(baseUrl, { email: "person@example.test", password: "safe-password" }, {
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(response.status).toBe(200);
    expect(waits).toEqual([61_000]);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toMatchObject({ emailCode: "828282" });
    expect(mailbox.searches).toBeGreaterThanOrEqual(3);
  });

  test("does not consult a configured transactional mailbox for a remote API", async () => {
    const mailbox = startMailpit();
    delete process.env.E2E_MAILPIT_URL;
    process.env.TRANSACTIONAL_EMAIL_MAILBOX_URL = mailbox.url;
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === "https://remote.example.test") return Promise.resolve(Response.json({ authenticated: true }));
      return original(input, init);
    }) as typeof fetch;
    const response = await passwordLogin("https://remote.example.test", {
      email: "person@example.test", password: "safe-password",
    });
    expect(response.status).toBe(200);
    expect(mailbox.searches).toBe(0);
  });

  test("throws mailbox errors without including the password or a code", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("safe-password 391027", { status: 500 }),
    });
    servers.push(server);
    process.env.E2E_MAILPIT_URL = `http://127.0.0.1:${server.port}`;
    let error: Error | undefined;
    try {
      await passwordLogin("http://127.0.0.1:8790", {
        email: "person@example.test", password: "safe-password",
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeDefined();
    expect(error!.message).not.toContain("safe-password");
    expect(error!.message).not.toContain("391027");
  });
});
