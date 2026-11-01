import { describe, expect, test } from "bun:test";
import type { ConnectorVersions } from "@openedbot/platform-config/connector-version";
import { DEFAULT_CONNECTOR_RELEASES_URL } from "@openedbot/platform-config/api-config";
import {
  CONNECTOR_RELEASE_NOTES_MAX,
  CONNECTOR_RELEASE_PAGE_URL,
  createConnectorReleaseFeed,
  parseConnectorRelease,
} from "../src/application/connector-release-feed";

const release = {
  tag_name: "v0.5.9",
  html_url: "https://github.com/acme/edge-mirror/releases/tag/v0.5.9",
  published_at: "2026-10-12T00:27:03Z",
  draft: false,
  prerelease: false,
  body: "edge-setup v0.5.9\n\n\n### Le marqueur survit\r\n\n- `RuntimeDirectoryPreserve=yes` <script>x</script>",
};

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("parseConnectorRelease", () => {
  test("keeps the version, the date and the notes without their title or HTML", () => {
    expect(parseConnectorRelease(release)).toEqual({
      version: "v0.5.9",
      publishedAt: "2026-10-12T00:27:03.000Z",
      url: release.html_url,
      notes: "### Le marqueur survit\n\n- `RuntimeDirectoryPreserve=yes` x",
    });
  });

  test("drafts, pre-releases, unstable tags and non-https URLs are refused", () => {
    expect(parseConnectorRelease({ ...release, draft: true })).toBeNull();
    expect(parseConnectorRelease({ ...release, prerelease: true })).toBeNull();
    expect(parseConnectorRelease({ ...release, tag_name: "v0.6.0-rc.1" })).toBeNull();
    expect(parseConnectorRelease({ ...release, html_url: "http://mirror.example.com/v0.5.9" })).toBeNull();
    expect(parseConnectorRelease({ ...release, html_url: "javascript:alert(1)" })).toBeNull();
    expect(parseConnectorRelease("nope")).toBeNull();
  });

  test("a GitHub-shaped mirror is no longer bound to github.com", () => {
    expect(parseConnectorRelease({ ...release, html_url: "https://mirror.example.com/v0.5.9" })?.url).toBe("https://mirror.example.com/v0.5.9");
  });

  test("long notes are cut on a line and say so", () => {
    const body = Array.from({ length: 2_000 }, (_, index) => `- point ${index}`).join("\n");
    const notes = parseConnectorRelease({ ...release, body })!.notes;
    expect(notes.length).toBeLessThanOrEqual(CONNECTOR_RELEASE_NOTES_MAX + 3);
    expect(notes.endsWith("\n\n…")).toBe(true);
  });
});

const digest = "a".repeat(64);
const anchor = {
  tool: {
    version: "v0.0.1",
    sha256: { edge_setup_linux_amd64: digest, edge_setup_linux_arm64: "b".repeat(64) },
  },
  hermes: { lts: { version: "0.22.2", commit: "d923a5eb", sha256: digest } },
};

describe("parseConnectorRelease, independent anchor", () => {
  test("the default feed is the .well-known anchor on openedbot.app, never GitHub", () => {
    expect(DEFAULT_CONNECTOR_RELEASES_URL).toBe("https://openedbot.app/.well-known/edge-setup.json");
  });

  test("reads the tool version and points the dialog at the public page", () => {
    expect(parseConnectorRelease(anchor)).toEqual({
      version: "v0.0.1",
      publishedAt: null,
      notes: "",
      url: CONNECTOR_RELEASE_PAGE_URL,
    });
    expect(CONNECTOR_RELEASE_PAGE_URL.startsWith("https://")).toBe(true);
  });

  test("an anchor without well-formed digests or with an unstable version is refused", () => {
    expect(parseConnectorRelease({ tool: { version: "v0.0.1" } })).toBeNull();
    expect(parseConnectorRelease({ tool: { version: "v0.0.1", sha256: {} } })).toBeNull();
    expect(parseConnectorRelease({ tool: { version: "v0.0.1", sha256: { a: "xyz" } } })).toBeNull();
    expect(parseConnectorRelease({ tool: { version: "v0.0.1", sha256: { a: digest.toUpperCase() } } })).toBeNull();
    expect(parseConnectorRelease({ tool: { version: "v0.1.0-rc.1", sha256: { a: digest } } })).toBeNull();
    expect(parseConnectorRelease({ tool: "v0.0.1" })).toBeNull();
  });
});

describe("createConnectorReleaseFeed", () => {
  test("reads the anchor and raises the live latest version", async () => {
    const versions: ConnectorVersions = { latestVersion: null };
    const feed = createConnectorReleaseFeed({ url: "https://openedbot.test/.well-known/edge-setup.json", versions, fetch: respond(anchor) });
    await feed.refresh();
    expect(versions.latestVersion).toBe("v0.0.1");
    expect(feed.current()?.url).toBe(CONNECTOR_RELEASE_PAGE_URL);
  });

  test("raises the live latest version and keeps the release", async () => {
    const versions: ConnectorVersions = { minimumVersion: "v0.5.7", latestVersion: "v0.5.8" };
    const feed = createConnectorReleaseFeed({ url: "https://api.github.test/latest", versions, fetch: respond(release) });
    await feed.refresh();
    expect(versions.latestVersion).toBe("v0.5.9");
    expect(feed.current()?.version).toBe("v0.5.9");
  });

  test("the environment stays the floor, and a failed read changes nothing", async () => {
    const versions: ConnectorVersions = { latestVersion: "v0.6.0" };
    await createConnectorReleaseFeed({ url: "https://api.github.test/latest", versions, fetch: respond(release) }).refresh();
    expect(versions.latestVersion).toBe("v0.6.0");

    const kept: ConnectorVersions = { latestVersion: "v0.5.8" };
    const feed = createConnectorReleaseFeed({ url: "https://api.github.test/latest", versions: kept, fetch: respond({}, 503) });
    await feed.refresh();
    expect(kept.latestVersion).toBe("v0.5.8");
    expect(feed.current()).toBeNull();
  });

  test("no URL, no network", async () => {
    let called = false;
    const fetchSpy = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await createConnectorReleaseFeed({ url: null, versions: {}, fetch: fetchSpy }).refresh();
    expect(called).toBe(false);
  });
});
