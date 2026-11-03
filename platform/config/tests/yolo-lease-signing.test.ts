import { describe, expect, test } from "bun:test";
import { readYoloLeaseSigningConfig } from "../src/yolo-lease-signing";

// Public TEST seeds, never real keys.
const seed = (fill: number) => Buffer.alloc(32, fill).toString("base64");

describe("readYoloLeaseSigningConfig", () => {
  test("optional: absent or empty, the API starts without a signing key", () => {
    expect(readYoloLeaseSigningConfig({})).toEqual({ seed: null, previousSeeds: [] });
    expect(readYoloLeaseSigningConfig({ OPENEDBOT_YOLO_LEASE_SIGNING_KEY: "  ", OPENEDBOT_YOLO_LEASE_PREVIOUS_KEYS: " , " }))
      .toEqual({ seed: null, previousSeeds: [] });
  });

  test("reads the current seed and the retired ones", () => {
    const config = readYoloLeaseSigningConfig({
      OPENEDBOT_YOLO_LEASE_SIGNING_KEY: seed(1),
      OPENEDBOT_YOLO_LEASE_PREVIOUS_KEYS: `${seed(2)}, ${seed(3)}`,
    });
    expect(config.seed).toEqual(new Uint8Array(32).fill(1));
    expect(config.previousSeeds).toEqual([new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)]);
  });

  test("a malformed value stops the start, named without its value", () => {
    const short = Buffer.alloc(31, 7).toString("base64");
    expect(() => readYoloLeaseSigningConfig({ OPENEDBOT_YOLO_LEASE_SIGNING_KEY: short })).toThrow("OPENEDBOT_YOLO_LEASE_SIGNING_KEY must be an Ed25519 seed");
    expect(() => readYoloLeaseSigningConfig({ OPENEDBOT_YOLO_LEASE_SIGNING_KEY: "not base64!" })).toThrow("must be an Ed25519 seed");
    try {
      readYoloLeaseSigningConfig({ OPENEDBOT_YOLO_LEASE_PREVIOUS_KEYS: `${seed(2)},${short}` });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(String(error)).toContain("OPENEDBOT_YOLO_LEASE_PREVIOUS_KEYS[1]");
      expect(String(error)).not.toContain(short);
    }
  });
});
