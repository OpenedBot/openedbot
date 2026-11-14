import { describe, expect, test } from "bun:test";
import { HermesClientError } from "../../src/errors";
import { parseHostProviderSdks, parseHostToolsets } from "../../src/parsers";

const entry = { provider: "vertex", label: "Google Vertex AI", extra: "vertex", installed: true, installable: false };

function refused(body: unknown): HermesClientError {
  try {
    parseHostProviderSdks(body);
  } catch (error) {
    expect(error).toBeInstanceOf(HermesClientError);
    return error as HermesClientError;
  }
  throw new Error("expected the parser to throw");
}

describe("parseHostProviderSdks", () => {
  test("accepts the host contract and an empty list", () => {
    expect(parseHostProviderSdks({ providers: [entry] })).toEqual([entry]);
    expect(parseHostProviderSdks({ providers: [] })).toEqual([]);
  });

  test("drops fields outside the contract", () => {
    expect(parseHostProviderSdks({ providers: [{ ...entry, secret: "x" }] })).toEqual([entry]);
  });

  test("refuses anything else with HERMES_RESPONSE_INVALID", () => {
    const bad: unknown[] = [
      null,
      [],
      {},
      { providers: "vertex" },
      { providers: [null] },
      { providers: Array.from({ length: 33 }, () => entry) },
      { providers: [{ ...entry, provider: "Vertex" }] },
      { providers: [{ ...entry, provider: "-vertex" }] },
      { providers: [{ ...entry, provider: "a".repeat(65) }] },
      { providers: [{ ...entry, label: 12 }] },
      { providers: [{ ...entry, label: "x".repeat(81) }] },
      { providers: [{ ...entry, extra: "bad extra" }] },
      { providers: [{ ...entry, extra: undefined }] },
      { providers: [{ ...entry, installed: "true" }] },
      { providers: [{ ...entry, installable: undefined }] },
    ];
    for (const body of bad) expect(refused(body).code).toBe("HERMES_RESPONSE_INVALID");
  });

  test("accepts 32 entries and an 80 character label", () => {
    const full = Array.from({ length: 32 }, () => ({ ...entry, label: "x".repeat(80) }));
    expect(parseHostProviderSdks({ providers: full })).toHaveLength(32);
  });
});

describe("parseHostToolsets availability", () => {
  const base = { platform: "api_server", settable: ["browser"] };

  test("keeps measured rows, drops invalid ones and unknown reasons", () => {
    const parsed = parseHostToolsets({
      ...base,
      availability: [
        { name: "browser", available: false, reason: "check_failed" },
        { name: "web", available: true, reason: "check_failed" },
        { name: "vision", available: null, reason: null },
        { name: "image_gen", available: false, reason: "/opt/secret" },
        { name: "Bad Name", available: true, reason: null },
        { name: "browser", available: true, reason: null },
        { name: "tts", available: "yes", reason: null },
      ],
    });
    expect(parsed.availability).toEqual([
      { name: "browser", available: false, reason: "check_failed" },
      { name: "web", available: true, reason: null },
      { name: "vision", available: null, reason: null },
      { name: "image_gen", available: false, reason: null },
    ]);
  });

  test("a host without the field, or with an unreadable one, reports not measured", () => {
    expect(parseHostToolsets(base).availability).toBeNull();
    expect(parseHostToolsets({ ...base, availability: "nope" }).availability).toBeNull();
    expect(parseHostToolsets({ ...base, availability: "nope" }).settable).toEqual(["browser"]);
  });
});
