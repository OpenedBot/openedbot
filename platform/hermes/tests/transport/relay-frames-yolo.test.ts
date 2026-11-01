import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  decodeTextFrame,
  encodeTextFrame,
  RELAY_FEATURE_YOLO_LEASE,
  RELAY_FEATURE_YOLO_THREAD_SCOPE,
  RelayFrameError,
  YOLO_AUDIT_MAX_ENTRIES,
  YOLO_STATE_MAX_LEASES,
  type RelayTextFrame,
} from "@openedbot/contracts-connector";

type Vector = { name: string; frame: Record<string, unknown>; valid: boolean };

/**
 * Les trames `yolo.*` du mode YOLO. Leurs vecteurs vivent à part de
 * `relay-frames.vectors.json` tant que `DecodeText` côté Go ne les connaît
 * pas (PR 3 du mode YOLO) : copiés dans le golden Go aujourd'hui, ils y
 * feraient échouer chaque vecteur valide. Ils rejoindront alors les deux
 * copies de `vectors.json`, sous `make contract-check`.
 */
const vectors = JSON.parse(
  readFileSync(new URL("../fixtures/relay-frames-yolo.vectors.json", import.meta.url), "utf8"),
) as Vector[];
const shared = JSON.parse(
  readFileSync(new URL("../fixtures/relay-frames.vectors.json", import.meta.url), "utf8"),
) as Array<{ frame?: { t?: string } }>;

describe("relay frames yolo.*: vectors", () => {
  test("every frame type is covered, valid and invalid, under unique names", () => {
    expect(new Set(vectors.map((vector) => vector.name)).size).toBe(vectors.length);
    for (const t of ["yolo.lease", "yolo.revoke", "yolo.state", "yolo.audit", "yolo.audit.ack"]) {
      expect(vectors.some((vector) => vector.frame.t === t && vector.valid)).toBe(true);
      expect(vectors.some((vector) => vector.frame.t === t && !vector.valid)).toBe(true);
    }
  });

  test("not in the vectors shared with Go yet (its decoder would refuse them)", () => {
    expect(shared.some((vector) => vector.frame?.t?.startsWith("yolo."))).toBe(false);
  });

  for (const vector of vectors) {
    test(`text: ${vector.name} (valid=${vector.valid})`, () => {
      const raw = JSON.stringify(vector.frame);
      if (vector.valid) {
        const frame = decodeTextFrame(raw);
        expect(frame).toEqual(vector.frame as RelayTextFrame);
        expect(decodeTextFrame(encodeTextFrame(frame))).toEqual(frame);
      } else {
        expect(() => decodeTextFrame(raw)).toThrow(RelayFrameError);
      }
    });
  }
});

describe("relay frames yolo.*: bounds", () => {
  const leaseFrame = vectors.find((vector) => vector.name === "yolo.lease signed")!.frame;
  const lease = leaseFrame.lease as Record<string, unknown>;
  const state = (count: number) => ({ t: "yolo.state", leases: Array.from({ length: count }, () => ({ leaseId: lease.leaseId, status: "expired" })) });

  test("feature names stay fixed", () => {
    expect(RELAY_FEATURE_YOLO_LEASE).toBe("yolo_lease");
    expect(RELAY_FEATURE_YOLO_THREAD_SCOPE).toBe("yolo_thread_scope");
  });

  test("yolo.state lists at most the bound", () => {
    expect(() => decodeTextFrame(JSON.stringify(state(YOLO_STATE_MAX_LEASES)))).not.toThrow();
    expect(() => decodeTextFrame(JSON.stringify(state(YOLO_STATE_MAX_LEASES + 1)))).toThrow(RelayFrameError);
  });

  test("yolo.audit carries at most the bound", () => {
    const vector = vectors.find((entry) => entry.name === "yolo.audit two chained entries")!.frame;
    const first = (vector.entries as Array<Record<string, unknown>>)[0]!;
    const entries = Array.from({ length: YOLO_AUDIT_MAX_ENTRIES + 1 }, (_, index) => ({
      ...first, seq: index + 1, prevHash: index.toString(16).padStart(64, "0"), entryHash: (index + 1).toString(16).padStart(64, "0"),
    }));
    const frame = { t: "yolo.audit", runtimeId: vector.runtimeId, entries, fromSeq: 1, toSeq: entries.length, tail: entries.at(-1)!.entryHash };
    expect(() => decodeTextFrame(JSON.stringify(frame))).toThrow(RelayFrameError);
  });

  test("a deny-list is bounded in entries and length", () => {
    const deny = (commands: string[]) => JSON.stringify({ ...leaseFrame, lease: { ...lease, deny: { commands, tools: [], paths: [] } } });
    expect(() => decodeTextFrame(deny(Array.from({ length: 50 }, (_, index) => `cmd${index}`)))).not.toThrow();
    expect(() => decodeTextFrame(deny(Array.from({ length: 51 }, (_, index) => `cmd${index}`)))).toThrow(RelayFrameError);
    expect(() => decodeTextFrame(deny(["x".repeat(257)]))).toThrow(RelayFrameError);
    expect(() => decodeTextFrame(deny([""]))).toThrow(RelayFrameError);
  });

  test("protect lists distinct ids", () => {
    const protect = (ids: string[]) => JSON.stringify({ ...leaseFrame, lease: { ...lease, protect: ids } });
    expect(() => decodeTextFrame(protect(["ssh", "ssh"]))).toThrow(RelayFrameError);
    expect(() => decodeTextFrame(protect(["Keychain"]))).toThrow(RelayFrameError);
  });
});
