import { afterEach, expect, test } from "bun:test";
import { request } from "../../../src/lib/api/http";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; window.localStorage.clear(); });

test("every API call names the console's own language, which the API writes a gate's description in", async () => {
  const seen: Array<string | null> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("Accept-Language"));
    return Response.json({});
  }) as typeof fetch;
  window.localStorage.setItem("openedbot:locale", "en");
  await request("/api/ping", undefined, { skipOrganizationHeader: true });
  window.localStorage.setItem("openedbot:locale", "fr");
  await request("/api/ping", undefined, { skipOrganizationHeader: true });
  expect(seen).toEqual(["en", "fr"]);
});
