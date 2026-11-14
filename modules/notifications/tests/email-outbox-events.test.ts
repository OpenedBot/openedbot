import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import { processEmailOutbox, type TransactionalEmailSender } from "../src/application/email";

const claimed = {
  id: "70000000-0000-4000-8000-000000000001",
  kind: "email_login_code" as const,
  dedupeKey: "email-login:70000000-0000-4000-8000-000000000002",
  recipientEmail: "kev@example.com",
  locale: "fr",
  data: {},
  attempts: 1,
};

const config = {
  workerId: "worker-test",
  endpoint: null,
  smtpUrl: null,
  brevoApiKey: null,
  resendApiKey: null,
  resendBaseUrl: "https://api.resend.com",
  token: null,
  from: null,
  timeoutMs: 10_000,
  leaseSeconds: 300,
  maxAttempts: 5,
};

type FakeDbOptions = {
  eventWriteFails?: boolean;
  expiredFinal?: Array<{ id: string; kind: string; attempts: number }>;
  staleCodes?: Array<{ id: string; kind: string; attempts: number }>;
  claimable?: boolean;
};
const consoleSpies: Array<{ mockRestore(): void }> = [];

function fakeDb(options: FakeDbOptions = {}): {
  db: SQL;
  calls: string[];
  bindings: unknown[][];
} {
  const calls: string[] = [];
  const bindings: unknown[][] = [];
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    calls.push(sql);
    bindings.push(values);
    if (sql.includes("set status = 'failed'") && sql.includes("where kind =")) {
      return Promise.resolve(bindings.at(-1)?.[1] === "email_login_code" ? options.staleCodes ?? [] : []);
    }
    if (sql.includes("set status = 'failed'")) return Promise.resolve(options.expiredFinal ?? []);
    if (sql.includes("update email_outbox outbox")) {
      return Promise.resolve(options.claimable === false ? [] : [claimed]);
    }
    if (sql.includes("set status = 'sent'")) return Promise.resolve([{ id: claimed.id }]);
    if (sql.includes("insert into email_outbox_events") && options.eventWriteFails) {
      return Promise.reject(new Error("journal indisponible"));
    }
    return Promise.resolve([]);
  }) as unknown as SQL;
  (query as unknown as { begin: (callback: (tx: SQL) => unknown) => Promise<unknown> }).begin =
    async (callback) => callback(query);
  return { db: query, calls, bindings };
}

function eventBinding(calls: string[], bindings: unknown[][]): unknown[] | undefined {
  const index = calls.findIndex((sql) => sql.includes("insert into email_outbox_events"));
  return bindings[index];
}

afterEach(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

describe("journal de la file d'e-mails", () => {
  test("un envoi réussi écrit sent avec la tentative", async () => {
    consoleSpies.push(spyOn(console, "info").mockImplementation(() => undefined));
    const { db, calls, bindings } = fakeDb();
    const sender: TransactionalEmailSender = { send: async () => undefined };

    expect(await processEmailOutbox(db, sender, config)).toBe("sent");
    expect(eventBinding(calls, bindings)).toEqual([
      claimed.id,
      claimed.kind,
      "sent",
      1,
      {},
    ]);
  });

  test("un échec non terminal écrit retry avec l'erreur tronquée", async () => {
    consoleSpies.push(spyOn(console, "error").mockImplementation(() => undefined));
    const { db, calls, bindings } = fakeDb();
    const sender: TransactionalEmailSender = {
      send: async () => { throw new Error("x".repeat(600)); },
    };

    expect(await processEmailOutbox(db, sender, config)).toBe("retrying");
    expect(eventBinding(calls, bindings)).toEqual([
      claimed.id,
      claimed.kind,
      "retry",
      1,
      { error: "x".repeat(500) },
    ]);
  });

  test("une erreur du journal ne fait pas échouer l'envoi", async () => {
    consoleSpies.push(spyOn(console, "info").mockImplementation(() => undefined));
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    consoleSpies.push(warning);
    const { db } = fakeDb({ eventWriteFails: true });
    let sent = 0;
    const sender: TransactionalEmailSender = { send: async () => { sent += 1; } };

    expect(await processEmailOutbox(db, sender, config)).toBe("sent");
    expect(sent).toBe(1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(String(warning.mock.calls[0]?.[0])).toContain("worker.email_event_record_failed");
  });

  test("un bail expiré après la dernière tentative devient failed et s'efface", async () => {
    consoleSpies.push(spyOn(console, "error").mockImplementation(() => undefined));
    const stuck = { id: "70000000-0000-4000-8000-000000000009", kind: "email_login_code", attempts: 5 };
    const { db, calls, bindings } = fakeDb({ expiredFinal: [stuck], claimable: false });
    let sent = 0;
    const sender: TransactionalEmailSender = { send: async () => { sent += 1; } };

    expect(await processEmailOutbox(db, sender, config)).toBe("idle");
    expect(sent).toBe(0);
    const terminal = calls.find((sql) => sql.includes("set status = 'failed'")) ?? "";
    expect(terminal).toContain("recipient_email = null");
    expect(terminal).toContain("payload = '{}'::jsonb");
    expect(terminal).toContain("lease_owner = null, lease_expires_at = null");
    expect(terminal).toContain("where status = 'sending' and lease_expires_at <= now() and attempts >=");
    expect(bindings[calls.indexOf(terminal)]).toEqual(["lease expired after final attempt", 5]);
    expect(eventBinding(calls, bindings)).toEqual([
      stuck.id,
      stuck.kind,
      "failed",
      5,
      { error: "lease expired after final attempt" },
    ]);
    expect(calls.findIndex((sql) => sql.includes("set status = 'failed'")))
      .toBeLessThan(calls.findIndex((sql) => sql.includes("update email_outbox outbox")));
  });

  test("un code de connexion périmé n'est jamais envoyé en retard", async () => {
    consoleSpies.push(spyOn(console, "warn").mockImplementation(() => undefined));
    const stale = { id: "70000000-0000-4000-8000-000000000010", kind: "email_login_code", attempts: 0 };
    const { db, calls, bindings } = fakeDb({ staleCodes: [stale], claimable: false });
    let sent = 0;
    const sender: TransactionalEmailSender = { send: async () => { sent += 1; } };

    expect(await processEmailOutbox(db, sender, config)).toBe("idle");
    expect(sent).toBe(0);
    const drop = calls.findIndex((sql) => sql.includes("where kind =") && bindings[calls.indexOf(sql)]?.[1] === "email_login_code");
    expect(calls[drop]).toContain("payload = '{}'::jsonb");
    expect(calls[drop]).toContain("(status = 'pending' or (status = 'sending' and lease_expires_at <= now()))");
    expect(bindings[drop]).toEqual(["code expired before delivery", "email_login_code", 600]);
    expect(eventBinding(calls, bindings)).toEqual([
      stale.id,
      stale.kind,
      "failed",
      0,
      { error: "code expired before delivery" },
    ]);
    expect(drop).toBeLessThan(calls.findIndex((sql) => sql.includes("update email_outbox outbox")));
  });
});
