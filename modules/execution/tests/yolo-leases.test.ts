import { describe, expect, test } from "bun:test";
import { HttpError } from "@openedbot/contracts-errors/http-error";
import { YOLO_THREAD_DEFAULT_SECONDS } from "@openedbot/contracts-api";
import { createYoloLeaseSigner, readYoloGrantInput, requireHumanSession } from "../src/application/yolo-leases";
import { yoloSigningKeyFromSeed } from "../src/domain/yolo-lease";

const BOT = "7c000000-0000-4000-8000-000000000001";
const THREAD = "7c000000-0000-4000-8000-000000000002";
// Public TEST seeds, never real keys.
const seed = (start: number) => Uint8Array.from({ length: 32 }, (_, index) => (start + index) % 256);

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof HttpError) return `${error.status} ${error.code}`;
    throw error;
  }
}

describe("readYoloGrantInput", () => {
  test("a thread lease lasts 4 h by default, any scope at most 24 h", () => {
    expect(readYoloGrantInput({ scope: "thread", botId: BOT, threadId: THREAD })).toEqual({
      scope: "thread", runtimeId: null, botId: BOT, threadId: THREAD, durationSeconds: YOLO_THREAD_DEFAULT_SECONDS, acknowledged: false,
    });
    expect(readYoloGrantInput({ scope: "runtime", durationMinutes: 1440, acknowledged: true })).toMatchObject({ durationSeconds: 86_400, acknowledged: true });
    expect(code(() => readYoloGrantInput({ scope: "runtime", durationMinutes: 1441 }))).toBe("400 YOLO_LEASE_INVALID");
    expect(code(() => readYoloGrantInput({ scope: "runtime", durationMinutes: 1.5 }))).toBe("400 YOLO_LEASE_INVALID");
  });

  test("the target must match the scope, never widened nor narrowed", () => {
    for (const body of [
      { scope: "thread", botId: BOT },
      { scope: "bot", threadId: THREAD, botId: BOT },
      { scope: "runtime", botId: BOT },
      { scope: "bot" },
      { scope: "org" },
      { scope: "bot", botId: BOT, acknowledged: "yes" },
      { scope: "runtime", runtimeId: "x" },
    ]) {
      expect(code(() => readYoloGrantInput(body))).toBe("400 YOLO_LEASE_INVALID");
    }
  });
});

describe("requireHumanSession", () => {
  test("only a web or native session that is not an assistance one", () => {
    expect(code(() => requireHumanSession({ kind: "web" }))).toBeNull();
    expect(code(() => requireHumanSession({ kind: "native", impersonatedByStaffUserId: null }))).toBeNull();
    for (const actor of [{ kind: "bot" }, { kind: "mcp" }, { kind: "" }, { kind: "web", impersonatedByStaffUserId: "staff" }]) {
      expect(code(() => requireHumanSession(actor))).toBe("403 YOLO_HUMAN_REQUIRED");
    }
  });
});

describe("createYoloLeaseSigner", () => {
  test("no seed: nothing signs and nothing is published", () => {
    expect(createYoloLeaseSigner({ seed: null, previousSeeds: [] })).toEqual({ current: null, keys: [] });
  });

  test("the current key first, retired ones by their public part only, without duplicates", () => {
    const signer = createYoloLeaseSigner({ seed: seed(0), previousSeeds: [seed(100), seed(0)] });
    const current = yoloSigningKeyFromSeed(seed(0));
    const retired = yoloSigningKeyFromSeed(seed(100));
    expect(signer.current?.keyId).toBe(current.keyId);
    expect(signer.keys).toEqual([
      { keyId: current.keyId, publicKey: current.publicKey, current: true },
      { keyId: retired.keyId, publicKey: retired.publicKey, current: false },
    ]);
    // A published entry never carries private material.
    expect(JSON.stringify(signer.keys)).not.toContain(Buffer.from(seed(100)).toString("base64"));
  });
});
