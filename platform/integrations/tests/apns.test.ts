import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { APNS_PRODUCTION_ORIGIN, APNS_SANDBOX_ORIGIN, apnsOrigin, readApnsConfig } from "../src/apns";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = ec.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

const COMPLETE = {
  APNS_KEY_ID: "ABCDE12345",
  APNS_TEAM_ID: "TEAM123456",
  APNS_PRIVATE_KEY: PEM,
  APNS_BUNDLE_IDS: "app.openedbot.mobile, app.openedbot.mobile.dev",
};

describe("readApnsConfig", () => {
  test("all absent: disabled, in production too (iOS push is optional)", () => {
    expect(readApnsConfig({}, false)).toBeNull();
    expect(readApnsConfig({}, true)).toBeNull();
    expect(readApnsConfig({ APNS_KEY_ID: " ", APNS_TEAM_ID: "" }, true)).toBeNull();
  });

  test("a half configuration is a boot error, never a silent off", () => {
    expect(() => readApnsConfig({ APNS_KEY_ID: "ABCDE12345" }, false)).toThrow("must be set together");
    expect(() => readApnsConfig({ APNS_HOST_OVERRIDE: "http://127.0.0.1:18793" }, false)).toThrow("requires");
  });

  test("parses the PEM, its escaped one-line form and its base64 body", () => {
    const pem = readApnsConfig(COMPLETE, true);
    expect(pem?.bundleIds).toEqual(["app.openedbot.mobile", "app.openedbot.mobile.dev"]);
    expect(pem?.privateKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(readApnsConfig({ ...COMPLETE, APNS_PRIVATE_KEY: PEM.trim().replaceAll("\n", "\\n") }, true)).not.toBeNull();
    const body = PEM.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    expect(readApnsConfig({ ...COMPLETE, APNS_PRIVATE_KEY: body }, true)).not.toBeNull();
  });

  test("refuses a non P-256 key, malformed identifiers and bundle ids", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => readApnsConfig({ ...COMPLETE, APNS_PRIVATE_KEY: rsa }, false)).toThrow("EC P-256");
    expect(() => readApnsConfig({ ...COMPLETE, APNS_PRIVATE_KEY: "not a key" }, false)).toThrow(".p8");
    expect(() => readApnsConfig({ ...COMPLETE, APNS_KEY_ID: "short" }, false)).toThrow("APNS_KEY_ID");
    expect(() => readApnsConfig({ ...COMPLETE, APNS_TEAM_ID: "lowercase1" }, false)).toThrow("APNS_TEAM_ID");
    expect(() => readApnsConfig({ ...COMPLETE, APNS_BUNDLE_IDS: "nodots" }, false)).toThrow("APNS_BUNDLE_IDS");
  });

  test("the error never echoes the key", () => {
    try {
      readApnsConfig({ ...COMPLETE, APNS_PRIVATE_KEY: "SECRET-MATERIAL-123" }, false);
      throw new Error("expected a failure");
    } catch (error) {
      expect(String(error)).not.toContain("SECRET-MATERIAL-123");
    }
  });

  test("the host override is loopback http or https, and refused in production", () => {
    expect(readApnsConfig({ ...COMPLETE, APNS_HOST_OVERRIDE: "http://127.0.0.1:18793" }, false)?.hostOverride)
      .toBe("http://127.0.0.1:18793");
    expect(() => readApnsConfig({ ...COMPLETE, APNS_HOST_OVERRIDE: "http://127.0.0.1:18793" }, true)).toThrow("production");
    expect(() => readApnsConfig({ ...COMPLETE, APNS_HOST_OVERRIDE: "http://apns.example.com" }, false)).toThrow("loopback");
    expect(() => readApnsConfig({ ...COMPLETE, APNS_HOST_OVERRIDE: "https://u:p@apns.example.com" }, false)).toThrow("bare origin");
    expect(() => readApnsConfig({ ...COMPLETE, APNS_HOST_OVERRIDE: "https://apns.example.com/3/device" }, false)).toThrow("bare origin");
  });

  test("the origin follows the device environment unless overridden", () => {
    expect(apnsOrigin({ hostOverride: null }, "production")).toBe(APNS_PRODUCTION_ORIGIN);
    expect(apnsOrigin({ hostOverride: null }, "sandbox")).toBe(APNS_SANDBOX_ORIGIN);
    expect(apnsOrigin({ hostOverride: "http://127.0.0.1:1" }, "production")).toBe("http://127.0.0.1:1");
  });
});
