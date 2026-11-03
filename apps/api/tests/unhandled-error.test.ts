import { describe, expect, test } from "bun:test";
import { unhandledErrorBody, unhandledErrorCause } from "../src/interfaces/http/unhandled-error";

describe("unhandled error body", () => {
  test("traduit une erreur PostgreSQL et garde le brut hors production", () => {
    const error = Object.assign(new Error('column "memory_extract_enabled" does not exist'), { code: "42703" });
    const body = unhandledErrorBody(error, "req-1", "development");
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toContain("une colonne attendue n’existe pas en base");
    expect(body.message).toContain("memory_extract_enabled");
    expect(body.message).toContain("req-1");
    expect(body.details).toMatchObject({ cause: expect.stringContaining("colonne"), reference: "req-1", pgCode: "42703" });
  });

  test("en production, la cause traduite et la référence seulement : jamais le texte brut", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    const body = unhandledErrorBody(error, "req-2", "production");
    expect(body.message).toBe("Erreur interne : un service dont l’API dépend est injoignable. Référence : req-2");
    expect(body.details.raw).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  });

  test("nomme une erreur de programme et retombe sur une cause générique", () => {
    expect(unhandledErrorCause(new TypeError("x is not a function"))).toBe("une erreur de programme dans l’API");
    expect(unhandledErrorCause("boom")).toBe("une erreur inattendue dans l’API");
  });
});
