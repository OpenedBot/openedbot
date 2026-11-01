import { describe, expect, test } from "bun:test";
import gate, { allowed, parseNets } from "../worker/gate.js";

const NETS = "192.0.2.10, 198.51.100.0/24, 2001:db8:1:2::/64";
const assets = { fetch: async () => new Response("asset", { status: 200 }) };
const call = (ip: string | null, ...list: [string | undefined] | []) =>
  gate.fetch(new Request("https://docs.example.com/install", { headers: ip ? { "CF-Connecting-IP": ip } : {} }),
    { ALLOWED_NETS: list.length ? list[0] : NETS, ASSETS: assets });

describe("ip gate", () => {
  test("serves the listed networks", async () => {
    for (const ip of ["192.0.2.10", "198.51.100.0", "198.51.100.255", "2001:db8:1:2::1", "2001:0db8:0001:0002:ffff:ffff:ffff:ffff"]) {
      const res = await call(ip);
      expect([ip, res.status]).toEqual([ip, 200]);
    }
  });
  test("refuses every other address, and a missing header", async () => {
    for (const ip of ["192.0.2.11", "198.51.101.1", "2001:db8:1:3::1", "::1", "::ffff:192.0.2.10", "garbage", "", null]) {
      const res = await call(ip);
      expect([ip, res.status]).toEqual([ip, 403]);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });
  test("fails closed without a list or with an invalid one", async () => {
    for (const list of [undefined, "", " , ", "192.0.2.300", "198.51.100.0/33", "2001:db8::/129", "10.0.0.0/x"]) {
      expect((await call("192.0.2.10", list)).status).toBe(403);
    }
  });
  test("parses IPv6 forms", () => {
    const nets = parseNets("2001:db8::/32, ::1, ::ffff:198.51.100.7");
    expect(allowed("2001:db8:ffff::1", nets)).toBe(true);
    expect(allowed("::1", nets)).toBe(true);
    expect(allowed("0:0:0:0:0:ffff:c633:6407", nets)).toBe(true);
    expect(allowed("2001:db9::1", nets)).toBe(false);
    expect(() => parseNets("1:2:3:4:5:6:7:8:9")).toThrow();
    expect(() => parseNets("1::2::3")).toThrow();
  });
});
