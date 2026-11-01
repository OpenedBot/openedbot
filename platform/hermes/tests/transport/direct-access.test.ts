import { afterEach, expect, spyOn, test } from "bun:test";
import { createDirectTransport } from "../../src/transport/direct";

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => fetchSpy?.mockRestore());
const options = { endpoint: "http://127.0.0.1:18642", token: "gateway-bearer", policy: { environment: "test" as const, testHttpUrl: "http://127.0.0.1:18642" }, mtls: null };

test("Access headers merge without overwriting bearer or Host; redirects are never followed", async () => {
  const seen: RequestInit[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init ?? {});
    return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } });
  }) as typeof fetch);
  const transport = createDirectTransport({ ...options, headers: { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "secret" } });
  const response = await transport.send("/health", { headers: { Authorization: "attacker", Host: "attacker.example.com", Accept: "text/event-stream" } }, "safe");
  expect(response.status).toBe(302);
  expect(seen).toHaveLength(1);
  const headers = new Headers(seen[0]!.headers);
  expect(headers.get("authorization")).toBe("Bearer gateway-bearer");
  expect(headers.get("host")).toBe("127.0.0.1:18642");
  expect(headers.get("cf-access-client-id")).toBe("id");
  expect(headers.get("cf-access-client-secret")).toBe("secret");
  expect(headers.get("accept")).toBe("text/event-stream");
  expect(seen[0]!.redirect).toBe("manual");
});

test("arbitrary configured edge headers are refused before sending", async () => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("must not send"); }) as unknown as typeof fetch);
  for (const name of ["Authorization", "Host", "X-Forwarded-Host"]) {
    await expect(createDirectTransport({ ...options, headers: { [name]: "forbidden" } }).send("/health", {}, "safe")).rejects.toMatchObject({ code: "HERMES_URL_INVALID" });
  }
  expect(fetchSpy).not.toHaveBeenCalled();
});
