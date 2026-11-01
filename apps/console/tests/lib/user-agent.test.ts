import { describe, expect, test } from "bun:test";
import { describeUserAgent } from "../../src/lib/user-agent";

const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/17.0 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const FIREFOX_MACOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

describe("describeUserAgent", () => {
  test("Safari sur iPhone", () => {
    expect(describeUserAgent(SAFARI_IPHONE)).toEqual({ browser: "Safari", platform: "iPhone" });
  });

  test("Chrome sur Android", () => {
    expect(describeUserAgent(CHROME_ANDROID)).toEqual({ browser: "Chrome", platform: "Android" });
  });

  test("Firefox sur macOS", () => {
    expect(describeUserAgent(FIREFOX_MACOS)).toEqual({ browser: "Firefox", platform: "macOS" });
  });

  test("Edge sur Windows", () => {
    expect(describeUserAgent(EDGE_WINDOWS)).toEqual({ browser: "Edge", platform: "Windows" });
  });

  test("null -> inconnu des deux côtés", () => {
    expect(describeUserAgent(null)).toEqual({ browser: null, platform: null });
  });

  test("chaîne vide -> inconnu des deux côtés", () => {
    expect(describeUserAgent("")).toEqual({ browser: null, platform: null });
  });

  test("chaîne inconnue -> inconnu des deux côtés, pas d'erreur", () => {
    expect(describeUserAgent("SomeCustomBot/1.0")).toEqual({ browser: null, platform: null });
  });
});
