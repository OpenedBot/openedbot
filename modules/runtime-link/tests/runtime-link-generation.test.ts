import { describe, expect, test } from "bun:test";
import { LinkLeaseLostError, RuntimeLinkBroker, type LinkIdentity, type LinkLivenessStore } from "../src/application/broker";

const identity: LinkIdentity = { runtimeId: "lease-runtime", organizationId: "lease-org", tokenHash: "hash", expiresAt: null };
const request = { method: "GET", path: "/health", headers: {}, body: null };
const settle = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function fencedStore() {
  let sequence = 0;
  let owner: { generation: bigint; instance: string | null; features: string[] } = { generation: 0n, instance: null, features: [] };
  const owned = (link: LinkIdentity, instance: string | undefined) => {
    if (owner.instance !== instance || owner.generation !== BigInt(link.generation!)) throw new LinkLeaseLostError();
  };
  const store: LinkLivenessStore = {
    reserveGeneration: async () => String(++sequence),
    connected: async (link, instance, features) => {
      const generation = BigInt(link.generation!);
      if (generation < owner.generation || (generation === owner.generation && instance !== owner.instance)) throw new LinkLeaseLostError();
      owner = { generation, instance, features };
    },
    seen: async (link, instance) => { owned(link, instance); },
    capabilities: async (link, instance, features) => { owned(link, instance); owner.features = features; },
    disconnected: async (link, instance) => { owned(link, instance); owner.instance = null; },
  };
  return { store, owner: () => owner, sequence: () => sequence };
}
function makeBroker(store: LinkLivenessStore, instanceId = "api-a") {
  return new RuntimeLinkBroker({ instanceId, liveness: store, seenDebounceMs: 0, log: () => {} });
}
function socket() {
  const closes: Array<{ code?: number; reason?: string }> = [];
  return { closes, send: () => 1, close: (code?: number, reason?: string) => { closes.push({ code, reason }); } };
}

describe("connection generation admission and fencing", () => {
  test("reservation and claim must finish before admission or dispatch", async () => {
    const fixture = fencedStore(), reservation = deferred(), claim = deferred();
    const reserve = fixture.store.reserveGeneration!, connected = fixture.store.connected;
    fixture.store.reserveGeneration = async (link) => { await reservation.promise; return reserve(link); };
    fixture.store.connected = async (...args) => { await claim.promise; await connected(...args); };
    const broker = makeBroker(fixture.store), connection = broker.open(socket());
    const admitted = broker.bind(connection, identity);
    expect(broker.connected(identity.runtimeId)).toBe(false);
    await expect(connection.dispatch(request)).rejects.toMatchObject({ code: "LINK_CLAIM_PENDING", stage: "before_dispatch" });
    reservation.release(); await settle();
    expect(broker.connected(identity.runtimeId)).toBe(false);
    claim.release(); await admitted;
    expect(broker.connected(identity.runtimeId)).toBe(true);
    expect(connection.link?.generation).toBe("1");
    broker.closeAll();
  });

  test("a delayed claim from another process cannot overwrite the newer generation", async () => {
    const fixture = fencedStore(), delayed = deferred(), connected = fixture.store.connected;
    fixture.store.connected = async (...args) => { if (args[0].generation === "1") await delayed.promise; await connected(...args); };
    const a = makeBroker(fixture.store, "api-a"), b = makeBroker(fixture.store, "api-b");
    const oldSocket = socket(), old = a.open(oldSocket), fresh = b.open(socket());
    const oldAdmission = a.bind(old, identity);
    await settle();
    await b.bind(fresh, identity);
    delayed.release();
    await expect(oldAdmission).rejects.toBeInstanceOf(LinkLeaseLostError);
    expect(fixture.owner()).toMatchObject({ generation: 2n, instance: "api-b" });
    expect(oldSocket.closes).toEqual([{ code: 1012, reason: "LINK_LEASE_LOST" }]);
    a.closeAll(); b.closeAll();
  });

  test("transient claim errors retain the reservation; verified lease loss closes only the stale heartbeat socket", async () => {
    const fixture = fencedStore(), connected = fixture.store.connected;
    let first = true;
    fixture.store.connected = async (...args) => { if (first) { first = false; throw new Error("temporary DB failure"); } await connected(...args); };
    const a = makeBroker(fixture.store, "api-a"), b = makeBroker(fixture.store, "api-b");
    const oldSocket = socket(), old = a.open(oldSocket), fresh = b.open(socket());
    const admitted = a.bind(old, identity);
    await settle(); expect(old.isClosed).toBe(false);
    old.handleText({ t: "pong" }); await admitted;
    expect(fixture.sequence()).toBe(1);
    await b.bind(fresh, identity);
    old.handleText({ t: "pong" }); await settle();
    expect(oldSocket.closes).toEqual([{ code: 1012, reason: "LINK_LEASE_LOST" }]);
    expect(fresh.isClosed).toBe(false);
    expect(fixture.owner().instance).toBe("api-b");
    a.closeAll(); b.closeAll();
    await a.flushPersistence(); // The recovered transient claim failure predates shutdown.
    await b.flushPersistence();
  });

  test("release waits for its pending claim so a late successful write cannot leave a closed owner", async () => {
    const fixture = fencedStore(), gate = deferred(), connected = fixture.store.connected;
    fixture.store.connected = async (...args) => { await gate.promise; await connected(...args); };
    const broker = makeBroker(fixture.store), connection = broker.open(socket());
    const admitted = broker.bind(connection, identity);
    await settle();
    broker.release(connection, 1000, "closed during claim");
    gate.release();
    await expect(admitted).rejects.toBeInstanceOf(LinkLeaseLostError); await settle();
    expect(fixture.owner()).toMatchObject({ generation: 1n, instance: null });
    broker.closeAll();
  });

  test("same-process stale release is fenced and aggregate in-flight count includes live requests", async () => {
    const fixture = fencedStore(), broker = makeBroker(fixture.store);
    const old = broker.open(socket()), fresh = broker.open(socket());
    await broker.bind(old, identity);
    await broker.bind(fresh, identity);
    broker.release(old, 4001, "replaced"); await settle();
    expect(fixture.owner()).toMatchObject({ generation: 2n, instance: "api-a" });
    const pending = fresh.dispatch(request).catch(error => error);
    expect(broker.inFlightCount).toBe(1);
    broker.closeAll(); await pending;
    expect(broker.inFlightCount).toBe(0);
  });

  test("forced and stale closes journal their own generation exactly once", async () => {
    const fixture = fencedStore();
    const events: Array<{ generation?: string; kind: string; meta: unknown }> = [];
    fixture.store.event = async (link, kind, meta) => { events.push({ generation: link.generation, kind, meta }); };
    const a = makeBroker(fixture.store, "api-a"), b = makeBroker(fixture.store, "api-b");
    const old = a.open(socket()), fresh = b.open(socket());
    await a.bind(old, identity);
    await b.bind(fresh, identity);
    a.closeAll(1012, "LINK_LEASE_LOST");
    a.release(old, 1006, "late callback");
    await settle();
    expect(fixture.owner().instance).toBe("api-b");
    b.closeAll(1012, "LINK_DRAIN_TIMEOUT");
    b.release(fresh, 1006, "late callback");
    await settle();
    expect(events.filter(event => event.kind === "disconnected")).toEqual([
      { generation: "1", kind: "disconnected", meta: { ip: null, agent: null, instanceId: "api-a", generation: "1", closeCode: 1012, closeReason: "LINK_LEASE_LOST", ownershipCurrent: false } },
      { generation: "2", kind: "disconnected", meta: { ip: null, agent: null, instanceId: "api-b", generation: "2", closeCode: 1012, closeReason: "LINK_DRAIN_TIMEOUT", ownershipCurrent: true } },
    ]);
  });


  test("flush waits for release and subsequently queued journal, and reports persistence failures", async () => {
    const fixture = fencedStore(), release = deferred(), journal = deferred();
    const disconnected = fixture.store.disconnected;
    fixture.store.disconnected = async (...args) => { await release.promise; await disconnected(...args); };
    fixture.store.event = async (_link, kind) => { if (kind === "disconnected") await journal.promise; };
    const broker = makeBroker(fixture.store);
    await broker.bind(broker.open(socket()), identity);
    broker.closeAll();
    let flushed = false;
    const flush = broker.flushPersistence().then(() => { flushed = true; });
    await settle(); expect(flushed).toBe(false);
    release.release(); await settle(); expect(flushed).toBe(false);
    journal.release(); await flush; expect(flushed).toBe(true);

    const failing = fencedStore();
    failing.store.event = async (_link, kind) => { if (kind === "disconnected") throw new Error("synthetic journal failure"); };
    const failedBroker = makeBroker(failing.store);
    await failedBroker.bind(failedBroker.open(socket()), identity);
    failedBroker.closeAll();
    await expect(failedBroker.flushPersistence()).rejects.toThrow("persistence failed");
  });

});
