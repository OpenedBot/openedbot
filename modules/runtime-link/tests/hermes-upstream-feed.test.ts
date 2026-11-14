import { describe, expect, test } from "bun:test";
import type { ConnectorVersions } from "@openedbot/platform-config/connector-version";
import { readApiConfig, DEFAULT_HERMES_UPSTREAM_RELEASES_URL } from "@openedbot/platform-config/api-config";
import { createHermesUpstreamFeed, parseHermesUpstreamRelease } from "../src/application/hermes-upstream-feed";

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("parseHermesUpstreamRelease", () => {
  test("keeps a stable tag, without its v", () => {
    expect(parseHermesUpstreamRelease({ tag_name: "v0.23.0", draft: false, prerelease: false })).toBe("0.23.0");
  });

  test("a draft, a pre-release, a canary tag or garbage: nothing", () => {
    expect(parseHermesUpstreamRelease({ tag_name: "v0.23.1", draft: true })).toBeNull();
    expect(parseHermesUpstreamRelease({ tag_name: "v0.23.1", prerelease: true })).toBeNull();
    expect(parseHermesUpstreamRelease({ tag_name: "v0.23.0+canary.20261108T064411Z" })).toBeNull();
    expect(parseHermesUpstreamRelease({ tag_name: 23 })).toBeNull();
    expect(parseHermesUpstreamRelease(null)).toBeNull();
    expect(parseHermesUpstreamRelease("v0.23.0")).toBeNull();
  });
});

describe("createHermesUpstreamFeed", () => {
  test("writes the upstream version into the live versions object", async () => {
    const versions: ConnectorVersions = {};
    await createHermesUpstreamFeed({ url: "https://example.test/latest", versions, fetch: respond({ tag_name: "v0.23.0" }) }).refresh();
    expect(versions.hermesUpstreamVersion).toBe("0.23.0");
  });

  test("an HTTP error, an invalid body or a network failure keeps the last known value", async () => {
    const versions: ConnectorVersions = { hermesUpstreamVersion: "0.23.0" };
    const url = "https://example.test/latest";
    await createHermesUpstreamFeed({ url, versions, fetch: respond({ message: "rate limited" }, 403) }).refresh();
    await createHermesUpstreamFeed({ url, versions, fetch: respond({ tag_name: "v0.24.0", prerelease: true }) }).refresh();
    const failing = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    await createHermesUpstreamFeed({ url, versions, fetch: failing }).refresh();
    expect(versions.hermesUpstreamVersion).toBe("0.23.0");
  });

  test("no URL: never fetches", async () => {
    let calls = 0;
    const counting = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    const feed = createHermesUpstreamFeed({ url: null, versions: {}, fetch: counting });
    await feed.refresh();
    feed.start();
    feed.stop();
    expect(calls).toBe(0);
  });
});

describe("HERMES_UPSTREAM_RELEASES_URL", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  test("off outside production by default, the GitHub release in production", () => {
    expect(readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: key }).hermesUpstreamReleasesUrl).toBeNull();
    expect(readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: key, HERMES_UPSTREAM_RELEASES_URL: "https://mirror.test/latest" }).hermesUpstreamReleasesUrl)
      .toBe("https://mirror.test/latest");
    expect(() => readApiConfig({ OPENEDBOT_ENV: "test", RUNTIME_TOKEN_ENCRYPTION_KEY: key, HERMES_UPSTREAM_RELEASES_URL: "http://plain.test" })).toThrow();
    expect(DEFAULT_HERMES_UPSTREAM_RELEASES_URL).toBe("https://api.github.com/repos/NousResearch/hermes-agent/releases/latest");
  });
});
