import { describe, expect, test } from "bun:test";
import { isVapidSubject, parseVapidConfig, readVapidConfig } from "../src/vapid";

/** Point P-256 non compressé (0x04 + 32 + 32), URL-safe base64. */
const PUBLIC_KEY = Buffer.alloc(65, 7);
PUBLIC_KEY[0] = 0x04;
const PUBLIC_B64 = Buffer.from(PUBLIC_KEY).toString("base64url");
const PRIVATE_B64 = Buffer.alloc(32, 9).toString("base64url");
const SUBJECT = "mailto:ops@ohb.example";

describe("readVapidConfig", () => {
  test("absentes toutes les trois : fonctionnalité éteinte", () => {
    expect(readVapidConfig({}, false)).toBeNull();
    expect(readVapidConfig({
      PUSH_VAPID_PUBLIC_KEY: "",
      PUSH_VAPID_PRIVATE_KEY: "  ",
      PUSH_VAPID_SUBJECT: "",
    }, false)).toBeNull();
  });

  test("production sans clés : erreur nommée", () => {
    expect(() => readVapidConfig({}, true)).toThrow(/PUSH_VAPID_PUBLIC_KEY/);
  });

  test("un seul secret posé n'est pas un push désactivé", () => {
    expect(() => readVapidConfig({ PUSH_VAPID_PUBLIC_KEY: PUBLIC_B64 }, false))
      .toThrow(/together/);
  });

  test("triplet valide", () => {
    expect(readVapidConfig({
      PUSH_VAPID_PUBLIC_KEY: PUBLIC_B64,
      PUSH_VAPID_PRIVATE_KEY: PRIVATE_B64,
      PUSH_VAPID_SUBJECT: SUBJECT,
    }, false)).toEqual({
      publicKey: PUBLIC_B64,
      privateKey: PRIVATE_B64,
      subject: SUBJECT,
    });
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
      subject: "http://ohb.example",
    })).toThrow(/mailto/);
  });
});

describe("isVapidSubject", () => {
  test("accepte mailto et https, refuse le reste", () => {
    expect(isVapidSubject("mailto:ops@ohb.example")).toBe(true);
    expect(isVapidSubject("https://ohb.example/push")).toBe(true);
    expect(isVapidSubject("http://ohb.example")).toBe(false);
    expect(isVapidSubject("ops@ohb.example")).toBe(false);
  });
});
