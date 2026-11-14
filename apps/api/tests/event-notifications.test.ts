import { describe, expect, test } from "bun:test";
import type { OrganizationEvent } from "@openedbot/contracts-events";
import { EventHub } from "@openedbot/notifications/application/event-hub";
import { createEventNotifications, EVENTS_CHANNEL, RUNTIME_CHANNEL } from "../src/infrastructure/event-notifications";
import { acquireReplayPoller, wakeAllReplayPollers, wakeReplayPoller } from "../src/routes/events/replay-pollers";

const ORG = "6a000000-0000-4000-8000-000000000001";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Subscription = { channel: string; onnotify: (payload: string) => void; onlisten?: () => void };

/** A Bun SQL stand-in: `fail` refuses the next `listen` calls, `subscriptions` keeps the accepted ones. */
function fakeClients(fail: number) {
  const subscriptions: Subscription[] = [];
  let refusals = fail;
  let closed = 0;
  const factory = () => ({
    listen: async (channel: string, onnotify: (payload: string) => void, onlisten?: () => void) => {
      expect([EVENTS_CHANNEL, RUNTIME_CHANNEL]).toContain(channel);
      if (refusals > 0) { refusals -= 1; throw new Error("Failed to connect"); }
      subscriptions.push({ channel, onnotify, onlisten });
      onlisten?.();
      return {};
    },
    close: async () => { closed += 1; },
  });
  return { factory, subscriptions, closed: () => closed };
}

describe("lien LISTEN openedbot_runtime (rework des flux, étape 5c)", () => {
  const RUNTIME = "6a000000-0000-4000-8000-0000000000aa";

  test("sans handler runtime, le canal n'est pas écouté", async () => {
    const clients = fakeClients(0);
    const link = createEventNotifications("postgres://unused", { notify: () => {}, subscribed: () => {} }, { clientFactory: clients.factory });
    link.start();
    await sleep(1);
    expect(clients.subscriptions.map((subscription) => subscription.channel)).toEqual([EVENTS_CHANNEL]);
    await link.stop();
  });

  test("une notification runtime est relayée, une charge illisible ignorée, chaque ACK resynchronise", async () => {
    const clients = fakeClients(0);
    const changed: string[] = [];
    let resyncs = 0;
    const link = createEventNotifications("postgres://unused", {
      notify: () => { throw new Error("not a run event"); },
      subscribed: () => {},
      runtimeChanged: (organizationId, runtimeId) => changed.push(`${organizationId}:${runtimeId}`),
      runtimeSubscribed: () => { resyncs += 1; },
    }, { clientFactory: clients.factory });
    link.start();
    await sleep(1);
    const runtime = clients.subscriptions.find((subscription) => subscription.channel === RUNTIME_CHANNEL)!;
    expect(resyncs).toBe(1);
    runtime.onnotify(`${ORG}:${RUNTIME}`);
    runtime.onnotify(`${ORG}`);
    runtime.onnotify(`${ORG}:not-a-runtime`);
    expect(changed).toEqual([`${ORG}:${RUNTIME}`]);
    expect(link.status()).toMatchObject({ runtimeNotifications: 1, ignored: 2 });
    runtime.onlisten?.();
    expect(resyncs).toBe(2);
    await link.stop();
    runtime.onnotify(`${ORG}:${RUNTIME}`);
    expect(changed).toHaveLength(1);
  });

  test("le hub ne resynchronise que les organisations qui ont un flux ouvert", () => {
    const hub = new EventHub();
    const frames: unknown[] = [];
    hub.subscribeRuntimeChanged(ORG, (frame) => frames.push(frame));
    for (const organizationId of hub.runtimeSubscribedOrganizations()) {
      hub.publishRuntimeChanged(organizationId, { runtimeId: null, reason: "resync" });
    }
    expect(frames).toEqual([{ runtimeId: null, reason: "resync" }]);
  });
});

describe("lien LISTEN openedbot_events", () => {
  test("indisponible au démarrage : repli signalé, nouvel essai, puis rattrapage à l'abonnement", async () => {
    const clients = fakeClients(2);
    let subscribed = 0;
    const link = createEventNotifications("postgres://unused", { notify: () => {}, subscribed: () => { subscribed += 1; } },
      { clientFactory: clients.factory, retryMs: 5, maxRetryMs: 10 });
    link.start();
    await sleep(1);
    expect(link.status()).toMatchObject({ state: "unavailable", connected: false, failures: 1 });
    expect(subscribed).toBe(0);
    for (let i = 0; i < 50 && subscribed === 0; i += 1) await sleep(5);
    expect(link.status()).toMatchObject({ state: "listening", connected: true, failures: 2, subscriptions: 1, resubscriptions: 0 });
    expect(subscribed).toBe(1);
    expect(clients.closed()).toBe(2);
    await link.stop();
    expect(link.status().state).toBe("stopped");
  });

  test("une notification réveille son organisation ; un ACK de plus compte un réabonnement", async () => {
    const clients = fakeClients(0);
    const woken: string[] = [];
    let subscribed = 0;
    const link = createEventNotifications("postgres://unused", { notify: (id) => woken.push(id), subscribed: () => { subscribed += 1; } },
      { clientFactory: clients.factory });
    link.start();
    await sleep(1);
    const [subscription] = clients.subscriptions;
    subscription!.onnotify(`${ORG}:42`);
    subscription!.onnotify("not-an-event");
    subscription!.onnotify(":42");
    expect(woken).toEqual([ORG]);
    // Bun reconnects a lost LISTEN by itself and acknowledges it again.
    subscription!.onlisten!();
    expect(subscribed).toBe(2);
    expect(link.status()).toMatchObject({ notifications: 1, ignored: 2, subscriptions: 2, resubscriptions: 1 });
    await link.stop();
    subscription!.onnotify(`${ORG}:43`);
    expect(woken).toEqual([ORG]);
  });

  test("un ping sans réponse rend le lien non confirmé ; sa réponse le rétablit et mesure le retard", async () => {
    const clients = fakeClients(0);
    const pings: string[] = [];
    const link = createEventNotifications("postgres://unused", { notify: () => {}, subscribed: () => {} },
      { clientFactory: clients.factory, livenessMs: 10, ping: async (payload) => { pings.push(payload); } });
    link.start();
    await sleep(1);
    expect(link.connected()).toBe(true);
    for (let i = 0; i < 50 && pings.length < 2; i += 1) await sleep(5);
    // The first ping went unanswered for a whole period.
    expect(link.connected()).toBe(false);
    expect(link.status().stalls).toBe(1);
    const subscription = clients.subscriptions[0]!;
    subscription.onnotify(pings.at(-1)!.replace(/:[0-9]+$/u, ":999"));
    expect(link.connected()).toBe(false); // Not the ping this link waits for.
    subscription.onnotify(`ping:${crypto.randomUUID()}:1`);
    expect(link.connected()).toBe(false); // Another replica's ping.
    subscription.onnotify(pings.at(-1)!);
    expect(link.connected()).toBe(true);
    expect(link.status().lagMs).toBeGreaterThanOrEqual(0);
    expect(link.status().notifications).toBe(0);
    await link.stop();
  });

  test("un ping en échec rend le lien non confirmé sans planter", async () => {
    const clients = fakeClients(0);
    const link = createEventNotifications("postgres://unused", { notify: () => {}, subscribed: () => {} },
      { clientFactory: clients.factory, livenessMs: 5, ping: async () => { throw new Error("pool down"); } });
    link.start();
    for (let i = 0; i < 50 && link.connected(); i += 1) await sleep(5);
    expect(link.connected()).toBe(false);
    expect(link.status().state).toBe("listening");
    await link.stop();
  });

  test("un pool bloqué ne reçoit jamais plus d'un ping à la fois", async () => {
    const clients = fakeClients(0);
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const link = createEventNotifications("postgres://unused", { notify: () => {}, subscribed: () => {} }, {
      clientFactory: clients.factory, livenessMs: 5,
      ping: async () => { active += 1; peak = Math.max(peak, active); await blocked; active -= 1; },
    });
    link.start();
    await sleep(60);
    expect(peak).toBe(1);
    expect(link.connected()).toBe(false);
    release();
    await sleep(20);
    expect(peak).toBe(1);
    await link.stop();
  });

  test("un Bun sans listen reste en repli, sans nouvel essai", async () => {
    let created = 0;
    const link = createEventNotifications("postgres://unused", { notify: () => {}, subscribed: () => {} }, {
      clientFactory: () => { created += 1; return { close: async () => {} } as never; },
      retryMs: 1,
    });
    link.start();
    await sleep(10);
    expect(created).toBe(1);
    expect(link.status()).toMatchObject({ state: "unavailable", connected: false, failures: 1 });
    await link.stop();
  });
});

describe("pollers par hub", () => {
  const event = (cursor: number): OrganizationEvent & { cursor: number } => ({
    version: 1, cursor, organizationId: ORG, threadId: "thread-1", runId: "run-1", botId: null, turnId: null,
    sessionKey: null, leaseGeneration: null, sequence: cursor, type: "agent.message", payload: {}, occurredAt: "2026-11-06T00:00:00.000Z",
  });

  test("deux hubs du même processus ne partagent pas de pompe ; wakeAll rattrape chacun", async () => {
    const left = new EventHub();
    const right = new EventHub();
    const received = { left: [] as number[], right: [] as number[] };
    left.subscribe(ORG, (entry) => received.left.push(entry.cursor!));
    right.subscribe(ORG, (entry) => received.right.push(entry.cursor!));
    const rows: Array<OrganizationEvent & { cursor: number }> = [];
    const page = async (cursor: number) => rows.filter((row) => row.cursor > cursor);
    const releaseLeft = acquireReplayPoller(left, ORG, 0, page, 60_000);
    const releaseRight = acquireReplayPoller(right, ORG, 0, page, 60_000);
    try {
      await sleep(1); // The initial read of each acquisition finds nothing yet.
      rows.push(event(1));
      wakeReplayPoller(left, ORG);
      await sleep(1);
      expect(received).toEqual({ left: [1], right: [] });
      rows.push(event(2));
      wakeAllReplayPollers(right);
      await sleep(1);
      expect(received).toEqual({ left: [1], right: [1, 2] });
      wakeAllReplayPollers(left);
      await sleep(1);
      expect(received).toEqual({ left: [1, 2], right: [1, 2] });
    } finally {
      releaseLeft();
      releaseRight();
    }
    rows.push(event(3));
    wakeAllReplayPollers(left);
    await sleep(1);
    expect(received.left).toEqual([1, 2]);
  });
});
