import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  EDGE_SETUP_HERMES_VERSION,
  parseHermesVersion,
  runtimeHermesUpdate,
} from "../src/connector-version";

describe("EDGE_SETUP_HERMES_VERSION", () => {
  test("stays equal to the Hermes pinned by edge-setup (pins.go)", () => {
    const pins = readFileSync(new URL("../../../edge-setup/internal/pins/pins.go", import.meta.url), "utf8");
    const pinned = pins.match(/^\s*HermesVersion\s*=\s*"([^"]+)"/m)?.[1];
    expect(pinned).toBeDefined();
    // When this fails, edge-setup pins another Hermes: set the constant to the same value.
    expect(EDGE_SETUP_HERMES_VERSION).toBe(pinned!);
    expect(parseHermesVersion(EDGE_SETUP_HERMES_VERSION)).toBe(EDGE_SETUP_HERMES_VERSION);
  });
});

describe("parseHermesVersion", () => {
  test("keeps stable X.Y.Z, with or without the v of upstream tags", () => {
    expect(parseHermesVersion("0.22.6")).toBe("0.22.6");
    expect(parseHermesVersion("v0.22.6")).toBe("0.22.6");
  });

  test("a canary, a pre-release or a malformed value is no version", () => {
    for (const value of [null, undefined, "", "v0.22.5+canary.20261101T120000", "0.23.0-rc.1", "0.22", "0.22.x", "hermes 0.22.2", "00.22.2", "0.22.2\n"]) {
      expect(parseHermesVersion(value)).toBeNull();
    }
  });
});

describe("runtimeHermesUpdate", () => {
  test("older than the release's Hermes: an update is available", () => {
    expect(runtimeHermesUpdate("0.22.2", { hermesVersion: "0.22.6" })).toEqual({
      current: "0.22.2", latest: "0.22.6", available: true, upgradeCommand: "sudo edge-setup upgrade --yes",
    });
    expect(runtimeHermesUpdate("0.9.9", { hermesVersion: "0.10.0" }).available).toBe(true);
  });

  test("equal or newer: nothing to say", () => {
    expect(runtimeHermesUpdate("0.22.6", { hermesVersion: "v0.22.6" }).available).toBe(false);
    expect(runtimeHermesUpdate("0.23.0", { hermesVersion: "0.22.6" }).available).toBe(false);
  });

  test("a canary on either side never counts as an update", () => {
    expect(runtimeHermesUpdate("0.22.2", { hermesVersion: "v0.22.5+canary.20261101" })).toMatchObject({
      latest: EDGE_SETUP_HERMES_VERSION, available: false,
    });
    expect(runtimeHermesUpdate("0.22.5+canary.20261101", { hermesVersion: "0.22.6" })).toMatchObject({ current: null, available: false });
  });

  test("unknown or malformed: no alert", () => {
    expect(runtimeHermesUpdate(null, { hermesVersion: "0.22.6" })).toMatchObject({ current: null, available: false });
    expect(runtimeHermesUpdate("garbage", { hermesVersion: "0.22.6" }).available).toBe(false);
  });

  test("without the anchor's value, the Hermes pinned by this repository is the target", () => {
    expect(runtimeHermesUpdate("0.0.1").latest).toBe(EDGE_SETUP_HERMES_VERSION);
    expect(runtimeHermesUpdate("0.0.1", { hermesVersion: null })).toMatchObject({ latest: EDGE_SETUP_HERMES_VERSION, available: true });
    expect(runtimeHermesUpdate(EDGE_SETUP_HERMES_VERSION).available).toBe(false);
  });
});
