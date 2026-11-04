import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
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
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
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
  // Une réservation par abonnement, pour suivre laquelle est supprimée ou confirmée.
  let reservations = 0;
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
      reservations += 1;
      return Promise.resolve(state.reserved === false ? [] : [{ id: `del-${reservations}` }]);
    }
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  (query as unknown as { begin: (callback: (inner: Bun.SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: Bun.SQL) => unknown) => callback(query);
  return query;
}

function recordingTransport(statusCode = 201): PushTransport & { payloads: string[]; endpoints: string[] } {
  const payloads: string[] = [];
  const endpoints: string[] = [];
  return {
    payloads,
    endpoints,
    async send(input) {
      payloads.push(input.payload);
      endpoints.push(input.endpoint);
      return { statusCode };
    },
  };
}

const requeued = (queries: Query[]) =>
  queries.some((q) => q.sql.startsWith("update push_outbox set status = 'pending'"));
const markedAs = (queries: Query[], status: string) =>
  queries.some((q) => q.sql.startsWith("update push_outbox set status =") && q.values[0] === status);

afterEach(() => {
  setSystemTime();
});

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

  test("destinataires : abonnements de membres actifs seulement", async () => {
    const queries: Query[] = [];
    await processPushNotifications(
      fakeDb({ queries, outbox: OUTBOX, subscriptions: [SUB] }),
      { vapid: VAPID, workerId: "worker-1" },
      recordingTransport(),
    );
    const recipients = queries.find((q) => q.sql.includes("from push_subscriptions s"))!.sql;
    expect(recipients).toContain("join memberships m on m.organization_id = s.organization_id and m.user_id = s.user_id");
    expect(recipients).toContain("m.revoked_at is null");
  });

  test("endpoint hors services Push déjà en base : jamais contacté, marqué en échec", async () => {
    const queries: Query[] = [];
    const transport = recordingTransport();
    const internal = { ...SUB, id: "sub-internal", endpoint: "https://127.0.0.1:9443/push/e2e" };
    const result = await processPushNotifications(
      fakeDb({ queries, outbox: OUTBOX, subscriptions: [internal, SUB] }),
      { vapid: VAPID, workerId: "worker-1" },
      transport,
    );
    expect(transport.endpoints).toEqual([SUB.endpoint]);
    expect(result.delivered).toBe(1);
    const rejected = queries.find((q) => q.sql.startsWith("update push_subscriptions set failed_at = now()"));
    expect(rejected?.values).toEqual(["sub-internal"]);
  });

  test("boucle locale : contactée seulement avec l'opt-in du serveur push simulé", async () => {
    const transport = recordingTransport();
    const loopback = { ...SUB, endpoint: "https://127.0.0.1:9443/push/e2e" };
    await processPushNotifications(
      fakeDb({ queries: [], outbox: OUTBOX, subscriptions: [loopback] }),
      { vapid: { ...VAPID, allowLoopbackEndpoints: true }, workerId: "worker-1" },
      transport,
    );
    expect(transport.endpoints).toEqual([loopback.endpoint]);
  });

  test("envoi suspendu : l'échéance libère le job, la livraison est rejouée plus tard", async () => {
    const queries: Query[] = [];
    const hanging = { ...SUB, id: "sub-hanging", endpoint: "https://fcm.googleapis.com/fcm/send/hang" };
    const sent: string[] = [];
    const transport: PushTransport = {
      send(input) {
        if (input.endpoint === hanging.endpoint) return new Promise(() => {});
        sent.push(input.endpoint);
        return Promise.resolve({ statusCode: 201 });
      },
    };
    const started = performance.now();
    const result = await processPushNotifications(
      fakeDb({ queries, outbox: OUTBOX, subscriptions: [hanging, SUB] }),
      { vapid: VAPID, workerId: "worker-1", sendDeadlineMs: 20 },
      transport,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(sent).toEqual([SUB.endpoint]);
    expect(result.delivered).toBe(1);
    // La réservation de l'envoi suspendu est retirée : le prochain essai le refait.
    expect(queries.some((q) => q.sql.startsWith("delete from push_deliveries") && q.values[0] === "del-1")).toBe(true);
    expect(requeued(queries)).toBe(true);
  });

  test("budget de la passe épuisé : aucun nouvel envoi, le reste au prochain essai", async () => {
    const queries: Query[] = [];
    const second = { ...SUB, id: "sub-2", endpoint: "https://fcm.googleapis.com/fcm/send/second" };
    const sent: string[] = [];
    const transport: PushTransport = {
      async send(input) {
        sent.push(input.endpoint);
        // Le premier envoi consomme tout le budget sous le bail.
        setSystemTime(new Date(Date.now() + 31_000));
        return { statusCode: 201 };
      },
    };
    await processPushNotifications(
      fakeDb({ queries, outbox: OUTBOX, subscriptions: [SUB, second] }),
      { vapid: VAPID, workerId: "worker-1" },
      transport,
    );
    expect(sent).toEqual([SUB.endpoint]);
    expect(requeued(queries)).toBe(true);
  });

  test("réservation `pending` abandonnée par un worker tombé : reprise, seule une livraison `sent` est sautée", async () => {
    const queries: Query[] = [];
    await processPushNotifications(
      fakeDb({ queries, outbox: OUTBOX, subscriptions: [SUB] }),
      { vapid: VAPID, workerId: "worker-1" },
      recordingTransport(),
    );
    const reserve = queries.find((q) => q.sql.includes("insert into push_deliveries"))!.sql;
    expect(reserve).toContain(
      "on conflict (workflow_id, notification_sequence, subscription_id) do update set status = excluded.status where push_deliveries.status = 'pending' returning id",
    );
    expect(reserve).not.toContain("do nothing");
  });

  test("échec avant le dernier essai : l'outbox repart en attente", async () => {
    const queries: Query[] = [];
    await processPushNotifications(
      fakeDb({ queries, outbox: { ...OUTBOX, attempts: 4 }, subscriptions: [SUB] }),
      { vapid: VAPID, workerId: "worker-1" },
      recordingTransport(503),
    );
    expect(requeued(queries)).toBe(true);
    expect(markedAs(queries, "failed")).toBe(false);
  });

  test("échec au dernier essai : l'outbox est close en failed, pas remise en attente", async () => {
    const queries: Query[] = [];
    await processPushNotifications(
      fakeDb({ queries, outbox: { ...OUTBOX, attempts: 5 }, subscriptions: [SUB] }),
      { vapid: VAPID, workerId: "worker-1" },
      recordingTransport(503),
    );
    expect(requeued(queries)).toBe(false);
    expect(markedAs(queries, "failed")).toBe(true);
  });

  test("bail expiré au dernier essai : clos en failed avant toute réclamation", async () => {
    const queries: Query[] = [];
    await processPushNotifications(
      fakeDb({ queries, outbox: null }),
      { vapid: VAPID, workerId: "worker-1" },
      recordingTransport(),
    );
    const abandon = queries.findIndex((q) => q.sql.startsWith("update push_outbox set status = 'failed'"));
    const claim = queries.findIndex((q) => q.sql.includes("with candidate as"));
    expect(abandon).toBeGreaterThanOrEqual(0);
    expect(abandon).toBeLessThan(claim);
    const sql = queries[abandon]!.sql;
    expect(sql).toContain("(status = 'pending' or (status = 'sending' and lease_expires_at <= now()))");
    expect(queries[abandon]!.values).toContain(5);
  });
});
