import { describe, expect, test } from "bun:test";
import { HttpError, jsonBody, boundedTextBody } from "../src/interfaces/http/http-error";

describe("bounded request bodies", () => {
  test("rejects oversized JSON with an explicit 413", async () => {
    const request = new Request("http://api.test", {
      method: "POST",
      body: JSON.stringify({ value: "x".repeat(128) }),
    });
    await expect(jsonBody(request, 32)).rejects.toMatchObject({
      status: 413,
      code: "BODY_TOO_LARGE",
    } satisfies Partial<HttpError>);
  });

  test("accepts a bounded object and rejects arrays", async () => {
    await expect(jsonBody(new Request("http://api.test", {
      method: "POST", body: JSON.stringify({ ok: true }),
    }), 100)).resolves.toEqual({ ok: true });
    await expect(jsonBody(new Request("http://api.test", {
      method: "POST", body: "[]",
    }), 100)).rejects.toMatchObject({ status: 400, code: "INVALID_JSON" });
  });

  test("bounds signed webhook text before parsing or signature work", async () => {
    const request = new Request("http://api.test", { method: "POST", body: "x".repeat(64) });
    await expect(boundedTextBody(request, 8)).rejects.toMatchObject({
      status: 413,
      code: "BODY_TOO_LARGE",
    });
  });
});
