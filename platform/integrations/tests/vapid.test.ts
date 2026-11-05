import { describe, expect, test } from "bun:test";
import { isVapidSubject, parseVapidConfig, readVapidConfig } from "../src/vapid";

/** Point P-256 non compressé (0x04 + 32 + 32), URL-safe base64. */
const PUBLIC_KEY = Buffer.alloc(65, 7);
PUBLIC_KEY[0] = 0x04;
const PUBLIC_B64 = Buffer.from(PUBLIC_KEY).toString("base64url");
const PRIVATE_B64 = Buffer.alloc(32, 9).toString("base64url");
const SUBJECT = "mailto:ops@openedbot.example";

describe("readVapidConfig", () => {
  test("absentes toutes les trois : fonctionnalité éteinte", () => {
    expect(readVapidConfig({}, false, false)).toBeNull();
    expect(readVapidConfig({
      PUSH_VAPID_PUBLIC_KEY: "",
      PUSH_VAPID_PRIVATE_KEY: "  ",
      PUSH_VAPID_SUBJECT: "",
    }, false, false)).toBeNull();
  });

  test("production sans clés : erreur nommée", () => {
    expect(() => readVapidConfig({}, true, true)).toThrow(/PUSH_VAPID_PUBLIC_KEY/);
  });

  test("un seul secret posé n'est pas un push désactivé", () => {
    expect(() => readVapidConfig({ PUSH_VAPID_PUBLIC_KEY: PUBLIC_B64 }, false, false))
      .toThrow(/together/);
  });

  test("triplet valide", () => {
    expect(readVapidConfig({
      PUSH_VAPID_PUBLIC_KEY: PUBLIC_B64,
      PUSH_VAPID_PRIVATE_KEY: PRIVATE_B64,
      PUSH_VAPID_SUBJECT: SUBJECT,
    }, false, false)).toEqual({
      publicKey: PUBLIC_B64,
      privateKey: PRIVATE_B64,
      subject: SUBJECT,
      allowLoopbackEndpoints: false,
    });
  });

  test("boucle locale : opt-in explicite, refusé en production", () => {
    const triplet = {
      PUSH_VAPID_PUBLIC_KEY: PUBLIC_B64,
      PUSH_VAPID_PRIVATE_KEY: PRIVATE_B64,
      PUSH_VAPID_SUBJECT: SUBJECT,
    };
    expect(readVapidConfig({ ...triplet, PUSH_ALLOW_LOOPBACK_ENDPOINTS: "1" }, false, false)?.allowLoopbackEndpoints)
      .toBe(true);
    expect(() => readVapidConfig({ ...triplet, PUSH_ALLOW_LOOPBACK_ENDPOINTS: "1" }, true, true))
      .toThrow(/refused in production/);
    expect(() => readVapidConfig({ ...triplet, PUSH_ALLOW_LOOPBACK_ENDPOINTS: "yes" }, false, false))
      .toThrow(/PUSH_ALLOW_LOOPBACK_ENDPOINTS/);
  });
});

describe("parseVapidConfig", () => {
  test("refuse une clé publique trop courte", () => {
    expect(() => parseVapidConfig({
      publicKey: Buffer.alloc(32, 4).toString("base64url"),
      privateKey: PRIVATE_B64,
      subject: SUBJECT,
    })).toThrow(/P-256/);
  });

  test("refuse un sujet ni mailto ni https", () => {
    expect(() => parseVapidConfig({
      publicKey: PUBLIC_B64,
      privateKey: PRIVATE_B64,
      subject: "http://openedbot.example",
    })).toThrow(/mailto/);
  });
});

describe("isVapidSubject", () => {
  test("accepte mailto et https, refuse le reste", () => {
    expect(isVapidSubject("mailto:ops@openedbot.example")).toBe(true);
    expect(isVapidSubject("https://openedbot.example/push")).toBe(true);
    expect(isVapidSubject("http://openedbot.example")).toBe(false);
    expect(isVapidSubject("ops@openedbot.example")).toBe(false);
  });
});
