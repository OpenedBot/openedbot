import { afterEach, describe, expect, test } from "bun:test";
import { randomId } from "../../src/lib/random-id";

/** The server validator's regex (`apps/api/src/application/message-ingress.ts`). */
const IDEMPOTENCY_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const nativeRandomUUID = crypto.randomUUID;

afterEach(() => {
  Object.defineProperty(crypto, "randomUUID", { value: nativeRandomUUID, configurable: true });
});

/** What the browser exposes on LAN http: `getRandomValues` without `randomUUID`. */
function withoutRandomUUID(): void {
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
}

describe("randomId", () => {
  test("contexte sécurisé : délègue à crypto.randomUUID", () => {
    let calls = 0;
    Object.defineProperty(crypto, "randomUUID", {
      value: () => {
        calls += 1;
        return "550e8400-e29b-41d4-a716-446655440000";
      },
      configurable: true,
    });

    expect(randomId()).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(calls).toBe(1);
  });

  test("sans randomUUID : un UUID que l'API accepte comme clé d'idempotence", () => {
    withoutRandomUUID();

    for (let index = 0; index < 200; index += 1) {
      const id = randomId();
      expect(id).toMatch(IDEMPOTENCY_KEY);
      // Version 4 and RFC 4122 variant: the only two quartets the regex fixes.
      expect(id[14]).toBe("4");
      expect("89ab").toContain(id[19]!);
    }
  });

  test("sans randomUUID : pas de collision sur un tirage large", () => {
    withoutRandomUUID();

    const ids = new Set(Array.from({ length: 500 }, () => randomId()));
    expect(ids.size).toBe(500);
  });
});
