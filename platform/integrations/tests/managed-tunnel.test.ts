import { describe, expect, test } from "bun:test";
import { DEFAULT_MANAGED_TUNNEL_SUFFIX, managedTunnelUrl, readManagedTunnelConfig } from "../src/managed-tunnel";

const URL_NAME = "OPENEDBOT_MANAGED_TUNNEL_URL";

describe("OPENEDBOT_MANAGED_TUNNEL_URL", () => {
  test("absent or empty: no managed tunnel, no error", () => {
    expect(readManagedTunnelConfig({})).toBeNull();
    expect(readManagedTunnelConfig({ [URL_NAME]: "  " })).toBeNull();
  });

  test("reads token, account, zone and the default suffix", () => {
    expect(readManagedTunnelConfig({ [URL_NAME]: "cloudflare://tok_en-1@acc123/zone456" })).toEqual({
      apiToken: "tok_en-1",
      accountId: "acc123",
      zoneId: "zone456",
      hostSuffix: DEFAULT_MANAGED_TUNNEL_SUFFIX,
    });
  });

  test("an optional suffix, normalised", () => {
    expect(readManagedTunnelConfig({ [URL_NAME]: "cloudflare://t@a/z?suffix=.Example.TEST." })?.hostSuffix).toBe("example.test");
  });

  test("round-trips a token that needs percent-encoding", () => {
    const config = { apiToken: "a/b+c@d", accountId: "acc", zoneId: "zone", hostSuffix: "example.test" };
    expect(readManagedTunnelConfig({ [URL_NAME]: managedTunnelUrl(config) })).toEqual(config);
  });

  test("a malformed value fails without quoting it", () => {
    for (const value of ["https://t@a/z", "cloudflare://a/z", "cloudflare://t@a", "cloudflare://t@a/z/extra", "cloudflare://t:secret-value@a/z", "not a url"]) {
      let message = "";
      try {
        readManagedTunnelConfig({ [URL_NAME]: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect([value, message.startsWith(URL_NAME)]).toEqual([value, true]);
      expect(message).not.toContain("secret-value");
    }
    expect(() => readManagedTunnelConfig({ [URL_NAME]: "cloudflare://t@a/z?suffix=bad_suffix" })).toThrow(/suffix/u);
  });
});
