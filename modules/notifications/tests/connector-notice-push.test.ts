import { describe, expect, test } from "bun:test";
import { processPushNotifications, type PushTransport } from "../src/application/push-notifications";

const VAPID = {
  publicKey: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 3)]).toString("base64url"),
  privateKey: Buffer.alloc(32, 5).toString("base64url"),
  subject: "mailto:ops@ohb.example",
};

const NOTICE = {
  id: "notice-1",
  organizationId: "org-1",
  organizationSlug: "atelier",
  runtimeName: "VPS production",
  installedVersion: "v0.5.3",
  targetVersion: "v0.5.7",
  pushStatus: "sending",
};

const OWNER_SUB = {
  id: "sub-1",
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  p256dh: "p256dhKeyValue012345",
  auth: "authKeyValue01",
  locale: "en",
};

type Query = { sql: string; values: unknown[] };

/** No workflow outbox row; one claimable connector notice, then idle. */
function fakeDb(state: { queries: Query[]; notice: typeof NOTICE | null; subscriptions: typeof OWNER_SUB[] }): Bun.SQL {
  let claimed = false;
  const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = [...strings].join(" ").replace(/\s+/g, " ").trim();
    state.queries.push({ sql, values });
    if (sql.includes("with notice as")) {
      if (claimed || !state.notice) return Promise.resolve([]);
      claimed = true;
      return Promise.resolve([state.notice]);
    }
    if (sql.includes("from push_subscriptions s")) return Promise.resolve(state.subscriptions);
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  (query as unknown as { begin: (callback: (inner: Bun.SQL) => unknown) => Promise<unknown> }).begin =
    async (callback: (inner: Bun.SQL) => unknown) => callback(query);
  return query;
}

function recordingTransport(): PushTransport & { payloads: string[] } {
  const payloads: string[] = [];
  return {
    payloads,
    async send(input) {
      payloads.push(input.payload);
      return { statusCode: 201 };
    },
  };
}

describe("outdated connector notice push", () => {
  test("pushes the owner subscription once, in its locale, toward the runtime settings", async () => {
    const queries: Query[] = [];
    const transport = recordingTransport();
    const result = await processPushNotifications(
      fakeDb({ queries, notice: NOTICE, subscriptions: [OWNER_SUB] }),
      { vapid: VAPID, workerId: "worker-1" },
      transport,
    );
    expect(result).toEqual({ processed: 1, delivered: 1, gone: 0 });
    expect(transport.payloads).toHaveLength(1);
    const payload = JSON.parse(transport.payloads[0]!) as { title: string; body: string; url: string };
    expect(payload.title).toBe("VPS production: connector update needed");
    expect(payload.body).toContain("v0.5.3");
    expect(payload.body).toContain("v0.5.7");
    expect(payload.body).toContain("sudo edge-setup upgrade --yes");
    expect(payload.url).toBe("/o/atelier/settings/runtime");
    const recipients = queries.find((q) => q.sql.includes("from push_subscriptions s"))!.sql;
    expect(recipients).toContain("m.role = 'owner'");
    expect(recipients).toContain("m.revoked_at is null");
    expect(queries.find((q) => q.sql.startsWith("update runtime_connector_notices set push_status"))?.values).toEqual(["sent", "notice-1"]);
  });

  test("a stale or unsubscribed notice sends nothing", async () => {
    const stale = recordingTransport();
    await processPushNotifications(
      fakeDb({ queries: [], notice: { ...NOTICE, pushStatus: "skipped" }, subscriptions: [OWNER_SUB] }),
      { vapid: VAPID, workerId: "worker-1" },
      stale,
    );
    expect(stale.payloads).toHaveLength(0);

    const queries: Query[] = [];
    const unsubscribed = recordingTransport();
    await processPushNotifications(
      fakeDb({ queries, notice: NOTICE, subscriptions: [] }),
      { vapid: VAPID, workerId: "worker-1" },
      unsubscribed,
    );
    expect(unsubscribed.payloads).toHaveLength(0);
    expect(queries.find((q) => q.sql.startsWith("update runtime_connector_notices set push_status"))?.values).toEqual(["skipped", "notice-1"]);
  });
});
