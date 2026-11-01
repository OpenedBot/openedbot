import { describe, expect, test } from "bun:test";
import {
  processPushNotifications,
  type PushTransport,
} from "../src/application/push-notifications";

const VAPID = {
  publicKey: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 3)]).toString("base64url"),
  privateKey: Buffer.alloc(32, 5).toString("base64url"),
  subject: "mailto:ops@ohb.example",
};

const OUTBOX = {
  id: "outbox-1",
  organizationId: "org-1",
  workflowId: "wf-1",
  notificationSequence: 4,
  eventType: "approval.requested",
  botId: "bot-1",
  botName: "SEO Geo",
  attempts: 1,
};

const SUB = {
  id: "sub-1",
  endpoint: "https://push.example/abc",
  p256dh: "p256dhKeyValue012345",
  auth: "authKeyValue01",
  locale: "fr",
};

type Query = { sql: string; values: unknown[] };

function fakeDb(state: {
  queries: Query[];
  outbox?: typeof OUTBOX | null;
  subscriptions?: typeof SUB[];
  reserved?: boolean;
}): Bun.SQL {
  let claimed = false;
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    state.queries.push({ sql, values });
    if (sql.includes("with candidate as")) {
      if (claimed || !state.outbox) return Promise.resolve([]);
      claimed = true;
      return Promise.resolve([state.outbox]);
    }
    if (sql.includes("from push_subscriptions") && sql.includes("failed_at is null")) {
      return Promise.resolve(state.subscriptions ?? []);
    }
    if (sql.includes("insert into push_deliveries")) {
      return Promise.resolve(state.reserved === false ? [] : [{ id: "del-1" }]);
    }
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  (query as unknown as { begin: (callback: (inner: Bun.SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: Bun.SQL) => unknown) => callback(query);
  return query;
}

function recordingTransport(statusCode = 201): PushTransport & { payloads: string[] } {
  const payloads: string[] = [];
  return {
    payloads,
    async send(input) {
      payloads.push(input.payload);
      return { statusCode };
    },
  };
}

describe("processPushNotifications", () => {
  test("sans VAPID : no-op, aucune requête", async () => {
    const queries: Query[] = [];
    const result = await processPushNotifications(
      fakeDb({ queries }),
      { vapid: null, workerId: "worker-1" },
    );
    expect(result).toEqual({ processed: 0, delivered: 0, gone: 0 });
    expect(queries).toHaveLength(0);
  });

  test("outbox vide : idle", async () => {
    const queries: Query[] = [];
    const result = await processPushNotifications(
      fakeDb({ queries, outbox: null }),
      { vapid: VAPID, workerId: "worker-1" },
      recordingTransport(),
    );
    expect(result.processed).toBe(0);
    expect(queries.some((q) => q.sql.includes("push_outbox"))).toBe(true);
  });

  test("aucun abonnement : outbox skipped, rien n'est envoyé", async () => {
    const queries: Query[] = [];
    const transport = recordingTransport();
    const result = await processPushNotifications(
      fakeDb({ queries, outbox: OUTBOX, subscriptions: [] }),
      { vapid: VAPID, workerId: "worker-1" },
      transport,
    );
    expect(result.processed).toBe(1);
    expect(result.delivered).toBe(0);
    expect(transport.payloads).toHaveLength(0);
    expect(queries.some((q) => q.sql.includes("status =") && q.values.includes("skipped"))).toBe(true);
  });

  test("envoi : payload {title, body, url} sans contenu de message, idempotence par insert", async () => {
    const queries: Query[] = [];
    const transport = recordingTransport(201);
    const result = await processPushNotifications(
      fakeDb({ queries, outbox: OUTBOX, subscriptions: [SUB] }),
      { vapid: VAPID, workerId: "worker-1" },
      transport,
    );
    expect(result).toEqual({ processed: 1, delivered: 1, gone: 0 });
    expect(transport.payloads).toHaveLength(1);
    const payload = JSON.parse(transport.payloads[0]!) as { title: string; body: string; url: string };
    expect(payload).toEqual({
      title: "SEO Geo",
      body: "Approbation demandée",
      url: "/o/org-1/decisions",
    });
    expect(JSON.stringify(payload)).not.toMatch(/prompt|error_message|final_output/i);
    expect(queries.some((q) => q.sql.includes("on conflict (workflow_id, notification_sequence, subscription_id)"))).toBe(true);
  });

  test("404 : purge de l'abonnement", async () => {
    const queries: Query[] = [];
    const result = await processPushNotifications(
      fakeDb({ queries, outbox: OUTBOX, subscriptions: [SUB] }),
      { vapid: VAPID, workerId: "worker-1" },
      recordingTransport(404),
    );
    expect(result.gone).toBe(1);
    expect(queries.some((q) => q.sql.includes("delete from push_subscriptions"))).toBe(true);
  });

  test("410 : purge de l'abonnement", async () => {
    const queries: Query[] = [];
    const result = await processPushNotifications(
      fakeDb({ queries, outbox: OUTBOX, subscriptions: [SUB] }),
      { vapid: VAPID, workerId: "worker-1" },
      recordingTransport(410),
    );
    expect(result.gone).toBe(1);
    expect(queries.some((q) => q.sql.includes("delete from push_subscriptions"))).toBe(true);
  });

  test("livraison déjà posée : pas de second envoi", async () => {
    const transport = recordingTransport();
    await processPushNotifications(
      fakeDb({ queries: [], outbox: OUTBOX, subscriptions: [SUB], reserved: false }),
      { vapid: VAPID, workerId: "worker-1" },
      transport,
    );
    expect(transport.payloads).toHaveLength(0);
  });

  test("run.completed pointe /bot/<id>", async () => {
    const transport = recordingTransport();
    await processPushNotifications(
      fakeDb({
        queries: [],
        outbox: { ...OUTBOX, eventType: "run.completed" },
        subscriptions: [{ ...SUB, locale: "en" }],
      }),
      { vapid: VAPID, workerId: "worker-1" },
      transport,
    );
    const payload = JSON.parse(transport.payloads[0]!) as { url: string; body: string };
    expect(payload.url).toBe("/o/org-1/bot/bot-1");
    expect(payload.body).toBe("Workflow completed");
  });
});
