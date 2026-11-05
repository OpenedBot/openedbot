import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  decodeBinaryFrame,
  decodeTextFrame,
  encodeBinaryFrame,
  encodeTextFrame,
  RELAY_CLOSE_PROBE_FAILED,
  RELAY_CLOSE_RECONNECT,
  RELAY_CLOSE_REPLACED,
  RELAY_CLOSE_REVOKED,
  RELAY_CLOSE_TOO_BIG,
  RELAY_CLOSE_UNAUTHORIZED,
  RELAY_DEFAULT_MAX_FEATURES,
  RELAY_MAX_FEATURES,
  RELAY_MAX_IN_FLIGHT,
  RELAY_MAX_REQUEST_BODY,
  RELAY_MAX_RESPONSE_BODY,
  RELAY_MAX_TEXT_FRAME,
  RelayFrameError,
  type RelayTextFrame,
} from "../src/index";

type Vector = {
  name: string;
  frame?: unknown;
  valid?: boolean;
  binary?: { id: number; chunk: string; hex: string };
};

// Les vecteurs sont partagés octet pour octet avec edge-setup
// (test/golden/relay-frames/vectors.json) : le fichier n'est pas réécrit ici,
// il est lu tel quel.
const vectors = JSON.parse(
  readFileSync(new URL("../fixtures/relay-frames.vectors.json", import.meta.url), "utf8"),
) as Vector[];

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("relay frames: golden vectors shared with edge-setup", () => {
  test("the fixture is present and non-trivial", () => {
    expect(vectors.length).toBeGreaterThan(15);
  });

  for (const vector of vectors) {
    if (vector.binary) {
      test(`binary: ${vector.name}`, () => {
        const encoded = encodeBinaryFrame(vector.binary!.id, new TextEncoder().encode(vector.binary!.chunk));
        expect(hex(encoded)).toBe(vector.binary!.hex);
        const decoded = decodeBinaryFrame(encoded);
        expect(decoded.id).toBe(vector.binary!.id);
        expect(new TextDecoder().decode(decoded.chunk)).toBe(vector.binary!.chunk);
      });
      continue;
    }
    test(`text: ${vector.name} (valid=${vector.valid})`, () => {
      const raw = JSON.stringify(vector.frame);
      if (vector.valid) {
        const frame = decodeTextFrame(raw);
        expect(frame.t as string).toBe((vector.frame as { t: string }).t);
      } else {
        expect(() => decodeTextFrame(raw)).toThrow(RelayFrameError);
      }
    });
  }
});

describe("relay frames: validation identical to Go DecodeText", () => {
  test("round-trips every frame type", () => {
    const frames: RelayTextFrame[] = [
      { t: "hello", protocol: 1, agent: "edge-setup/1.0", hermesVersion: "0.20.5" },
      { t: "capabilities", features: ["provider_management"] },
      { t: "link.issued", runtimeId: "rt", linkToken: "tok" },
      { t: "link.rotate", runtimeId: "rt", linkToken: "tok2" },
      { t: "link.context", environment: "prod", openedbot: "https://console.openedbot.app", organization: { id: "org", name: "Acme", slug: "acme" }, owner: { email: "o@example.com" } },
      { t: "link.context", environment: "dev", openedbot: "http://127.0.0.1:8790" },
      { t: "link.context", environment: "prod", openedbot: "https://console.openedbot.app", latestVersion: "v0.2.0", minimumVersion: "v0.1.0" },
      { t: "link.context", environment: "prod", openedbot: "https://console.openedbot.app", limits: { features: 64 } },
      { t: "link.context", environment: "prod", openedbot: "https://console.openedbot.app", limits: {} },
      { t: "req", id: 7, method: "POST", path: "/v1/runs", headers: { "content-type": "application/json" }, body: "stream" },
      { t: "res", id: 7, status: 200, headers: { "content-type": "text/event-stream" } },
      { t: "end", id: 7 },
      { t: "cancel", id: 7 },
      { t: "err", id: 7, code: "HERMES_LINK_PATH_FORBIDDEN", message: "x", stage: "before_dispatch" },
      { t: "ping" },
      { t: "pong" },
    ];
    for (const frame of frames) {
      const decoded = decodeTextFrame(encodeTextFrame(frame));
      expect(decoded).toEqual(frame);
    }
  });

  test("capabilities use the same bounded feature inventory as hello", () => {
    expect(decodeTextFrame('{"t":"capabilities","features":[]}')).toEqual({ t: "capabilities", features: [] });
    for (const features of ["provider_management", ["bad-feature"], [1], Array(65).fill("valid")]) {
      expect(() => decodeTextFrame(JSON.stringify({ t: "capabilities", features }))).toThrow(RelayFrameError);
    }
  });

  test("hello and capabilities accept 0 to 64 feature names and refuse the 65th", () => {
    const names = (count: number) => Array.from({ length: count }, (_, index) => `feature_${index + 1}`);
    for (let count = 0; count <= 64; count += 1) {
      expect(decodeTextFrame(JSON.stringify({ t: "hello", protocol: 1, features: names(count) }))).toMatchObject({ t: "hello" });
      expect(decodeTextFrame(JSON.stringify({ t: "capabilities", features: names(count) }))).toMatchObject({ t: "capabilities" });
    }
    for (const frame of [{ t: "hello", protocol: 1 }, { t: "capabilities" }]) {
      expect(() => decodeTextFrame(JSON.stringify({ ...frame, features: names(65) }))).toThrow(/more than 64/);
    }
  });

  test("link.context carries the feature bound in limits and validates it like the Go test", () => {
    const base = { t: "link.context", environment: "prod", openedbot: "https://openedbot.app" } as const;
    expect(decodeTextFrame(JSON.stringify({ ...base, limits: { features: 64 } }))).toEqual({ ...base, limits: { features: 64 } });
    // A bound the host does not know, and a limits object without features, announce nothing.
    expect(decodeTextFrame(JSON.stringify({ ...base, limits: { features: 64, requests: 10 } }))).toEqual({ ...base, limits: { features: 64 } });
    expect(decodeTextFrame(JSON.stringify({ ...base, limits: {} }))).toEqual({ ...base, limits: {} });
    expect(decodeTextFrame(JSON.stringify({ ...base, limits: null }))).toEqual(base);
    for (const limits of [{ features: 0 }, { features: -1 }, { features: 1.5 }, { features: "64" }, 64, "64", [64]]) {
      expect(() => decodeTextFrame(JSON.stringify({ ...base, limits })), JSON.stringify(limits)).toThrow(RelayFrameError);
    }
  });

  test("refuses the same malformed frames as the Go test", () => {
    const bad = [
      '{"t":"hello","protocol":2}',
      '{"t":"req","id":1,"method":"GET","path":"/health","body":"maybe"}',
      '{"t":"res","id":1}',
      '{"t":"err","id":1,"code":"X","stage":"later"}',
      '{"t":"exec","id":1}',
      '{"t":"end"}',
      "not json",
      "[]",
      '{"t":"req","id":-1,"method":"GET","path":"/health","body":"none"}',
      '{"t":"req","id":1.5,"method":"GET","path":"/health","body":"none"}',
      '{"t":"req","id":4294967296,"method":"GET","path":"/health","body":"none"}',
      '{"t":"req","id":1,"method":"GET","path":"/health","headers":{"accept":1},"body":"none"}',
      '{"t":"res","id":"1","status":200}',
      '{"t":"link.rotate","runtimeId":"rt"}',
      '{"t":"link.rotate","linkToken":"tok"}',
      '{"t":"link.context","environment":"staging","openedbot":"https://x"}',
      '{"t":"link.context","environment":"prod"}',
      '{"t":"link.context","environment":"prod","openedbot":"https://x","owner":{"displayName":"no email"}}',
    ];
    for (const raw of bad) {
      expect(() => decodeTextFrame(raw), raw).toThrow(RelayFrameError);
    }
  });

  test("accepts a uint8 buffer as input and the maximal uint32 id", () => {
    const raw = new TextEncoder().encode('{"t":"end","id":4294967295}');
    expect(decodeTextFrame(raw)).toEqual({ t: "end", id: 4294967295 });
  });

  test("bounds a text frame at 64 KiB in both directions", () => {
    const oversized = "x".repeat(RELAY_MAX_TEXT_FRAME);
    expect(() => encodeTextFrame({ t: "err", id: 1, code: "X", message: oversized, stage: "after_dispatch" }))
      .toThrow(/exceeds/);
    expect(() => decodeTextFrame(`{"t":"ping","pad":"${oversized}"}`)).toThrow(/exceeds/);
  });

  test("refuses a frame without type on encode", () => {
    expect(() => encodeTextFrame({ t: "" } as unknown as RelayTextFrame)).toThrow(/without type/);
  });
});

describe("relay frames: binary framing", () => {
  test("prefixes the chunk with a big-endian uint32 id", () => {
    const encoded = encodeBinaryFrame(0x01020304, new TextEncoder().encode("abc"));
    expect(encoded.byteLength).toBe(7);
    expect(encoded[0]).toBe(1);
    expect(encoded[3]).toBe(4);
    const decoded = decodeBinaryFrame(encoded);
    expect(decoded.id).toBe(0x01020304);
    expect(new TextDecoder().decode(decoded.chunk)).toBe("abc");
  });

  test("refuses a frame shorter than the id and an id outside uint32", () => {
    expect(() => decodeBinaryFrame(new Uint8Array([1, 2]))).toThrow(/shorter/);
    expect(() => encodeBinaryFrame(-1, new Uint8Array())).toThrow(/uint32/);
    expect(() => encodeBinaryFrame(2 ** 32, new Uint8Array())).toThrow(/uint32/);
  });
});

describe("relay bounds and close codes", () => {
  test("match docs/CONNECTOR.md", () => {
    expect(RELAY_MAX_IN_FLIGHT).toBe(64);
    expect(RELAY_MAX_REQUEST_BODY).toBe(1024 * 1024);
    expect(RELAY_MAX_RESPONSE_BODY).toBe(4 * 1024 * 1024);
    expect(RELAY_MAX_TEXT_FRAME).toBe(64 * 1024);
    // La borne que l'API annonce (`link.context.limits.features`) et celle d'avant l'annonce,
    // que l'hôte garde tant qu'il n'en connaît pas d'autre (`DefaultMaxFeatures` et `MaxFeatures` en Go).
    expect(RELAY_MAX_FEATURES).toBe(64);
    expect(RELAY_DEFAULT_MAX_FEATURES).toBe(16);
    expect(RELAY_CLOSE_TOO_BIG).toBe(1009);
    expect(RELAY_CLOSE_REPLACED).toBe(4001);
    expect(RELAY_CLOSE_PROBE_FAILED).toBe(4003);
    expect(RELAY_CLOSE_REVOKED).toBe(4004);
    expect(RELAY_CLOSE_RECONNECT).toBe(4005);
    expect(RELAY_CLOSE_UNAUTHORIZED).toBe(4401);
  });
});
