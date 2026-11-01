import { describe, expect, test } from "bun:test";
import { invalidateSnapshots, readThrough, type RuntimeReadKind, type SnapshotStore } from "../src/application/runtime-read-snapshots";

type Row = { document: unknown; observedAt: Date; invalidatedAt: Date | null };

// Same fence as the PostgreSQL store: a write observed before the last
// invalidation, or before the kept document, changes nothing.
function memoryStore(): SnapshotStore & { rows: Map<string, Row>; failRead: boolean; writeDelay: Promise<void> | null } {
  const rows = new Map<string, Row>();
  const key = (org: string, runtime: string, kind: RuntimeReadKind) => `${org}/${runtime}/${kind}`;
  return {
    rows,
    failRead: false,
    writeDelay: null,
    async read(org, runtime, kind) {
      if (this.failRead) throw new Error("store unavailable");
      const row = rows.get(key(org, runtime, kind));
      if (!row || row.document === null) return null;
      if (row.invalidatedAt && row.observedAt <= row.invalidatedAt) return null;
      return { document: row.document, observedAt: row.observedAt };
    },
    async write(org, runtime, kind, document, observedAt) {
      if (this.writeDelay) await this.writeDelay;
      const row = rows.get(key(org, runtime, kind));
      if (row?.invalidatedAt && observedAt <= row.invalidatedAt) return;
      if (row && row.document !== null && observedAt <= row.observedAt) return;
      rows.set(key(org, runtime, kind), { document, observedAt, invalidatedAt: row?.invalidatedAt ?? null });
    },
    async invalidate(org, kind, at) {
      for (const kindName of kind ? [kind] : (["mcp", "models", "profiles", "integrations"] as const)) {
        const name = key(org, "runtime", kindName);
        const row = rows.get(name);
        rows.set(name, { document: null, observedAt: row?.observedAt ?? at, invalidatedAt: at });
      }
    },
  };
}

const input = (organizationId: string, read: () => Promise<string>, now = 100_000) => ({
  organizationId, runtimeId: "runtime", kind: "mcp" as const, read, now: () => now,
});
const saved = (document: unknown, observedAt: number): Row => ({ document, observedAt: new Date(observedAt), invalidatedAt: null });

describe("runtime read snapshots", () => {
  test("serves a fresh snapshot without a live read", async () => {
    const store = memoryStore();
    store.rows.set("fresh/runtime/mcp", saved("saved", 80_000));
    let reads = 0;
    await expect(readThrough(store, input("fresh", async () => { reads += 1; return "live"; }))).resolves.toBe("saved");
    expect(reads).toBe(0);
  });

  test("serves stale data immediately and rewrites it after background refresh", async () => {
    const store = memoryStore();
    store.rows.set("stale/runtime/mcp", saved("old", 0));
    let finish!: (value: string) => void;
    const response = await readThrough(store, input("stale", () => new Promise((resolve) => { finish = resolve; }), 300_000));
    expect(response).toBe("old");
    finish("new");
    await Bun.sleep(0);
    expect(store.rows.get("stale/runtime/mcp")?.document).toBe("new");
  });

  test("waits for the live read after expiry", async () => {
    const store = memoryStore();
    store.rows.set("expired/runtime/mcp", saved("old", 0));
    await expect(readThrough(store, input("expired", async () => "live", 700_000))).resolves.toBe("live");
  });

  test("shares one live read across five concurrent misses", async () => {
    const store = memoryStore();
    let reads = 0;
    const values = await Promise.all(Array.from({ length: 5 }, () => readThrough(store, input("shared", async () => {
      reads += 1;
      await Bun.sleep(5);
      return "live";
    }))));
    expect(values).toEqual(["live", "live", "live", "live", "live"]);
    expect(reads).toBe(1);
  });

  test("a slow pre-write read that saves after the invalidation never overwrites the proof read", async () => {
    const store = memoryStore();
    let clock = 100_000;
    let finishOld!: (value: string) => void;
    const old = readThrough(store, { ...input("race", () => new Promise((resolve) => { finishOld = resolve; })), now: () => clock, fresh: true });
    clock = 100_010;
    await invalidateSnapshots(store, "race", "mcp", () => clock);
    clock = 100_020;
    await expect(readThrough(store, { ...input("race", async () => "after-write"), now: () => clock, fresh: true })).resolves.toBe("after-write");
    // The old read saves last, after the proof read was stored.
    let release!: () => void;
    store.writeDelay = new Promise((resolve) => { release = resolve; });
    finishOld("before-write");
    release();
    await expect(old).resolves.toBe("before-write");
    await Bun.sleep(0);
    expect(store.rows.get("race/runtime/mcp")?.document).toBe("after-write");
  });

  test("falls back to a live read when the store read fails", async () => {
    const store = memoryStore();
    store.failRead = true;
    await expect(readThrough(store, input("fallback", async () => "live"))).resolves.toBe("live");
  });

  test("does not persist a value rejected by keep", async () => {
    const store = memoryStore();
    await readThrough(store, { ...input("keep", async () => "failed"), keep: () => false });
    expect(store.rows.has("keep/runtime/mcp")).toBe(false);
  });

  test("a snapshot observed before the change watermark is read again", async () => {
    const store = memoryStore();
    store.rows.set("mark/runtime/mcp", saved("before-job", 95_000));
    let reads = 0;
    const value = await readThrough(store, {
      ...input("mark", async () => { reads += 1; return "after-job"; }),
      notOlderThan: new Date(99_000),
    });
    expect(value).toBe("after-job");
    expect(reads).toBe(1);
  });

  test("a caller with a newer watermark does not join a read that began before it", async () => {
    const store = memoryStore();
    let clock = 100_000;
    let finishOld!: (value: string) => void;
    const old = readThrough(store, { ...input("join", () => new Promise((resolve) => { finishOld = resolve; })), now: () => clock });
    await Bun.sleep(0);
    clock = 100_050;
    const fresh = readThrough(store, { ...input("join", async () => "after-job"), now: () => clock, notOlderThan: new Date(100_020) });
    finishOld("before-job");
    await expect(old).resolves.toBe("before-job");
    await expect(fresh).resolves.toBe("after-job");
  });

  test("a proof read never joins a read that began before it (another process may have written)", async () => {
    const store = memoryStore();
    let clock = 100_000;
    let finishOld!: (value: string) => void;
    let reads = 0;
    const old = readThrough(store, { ...input("cross", () => { reads += 1; return new Promise((resolve) => { finishOld = resolve; }); }), now: () => clock });
    await Bun.sleep(0);
    // Another API process wrote and invalidated: nothing in this process saw it.
    clock = 100_050;
    const proof = readThrough(store, { ...input("cross", async () => { reads += 1; return "after-write"; }), now: () => clock, fresh: true });
    finishOld("before-write");
    await expect(old).resolves.toBe("before-write");
    await expect(proof).resolves.toBe("after-write");
    expect(reads).toBe(2);
  });
});
