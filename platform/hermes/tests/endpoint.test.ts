import { describe, expect, test } from "bun:test";
import {
  HermesEndpointError,
  isForbiddenAddress,
  normalizeHermesEndpoint,
  parseInsecureHermesOrigins,
  type EndpointPolicy,
} from "../src/endpoint";

const production: EndpointPolicy = { environment: "production" };
const development: EndpointPolicy = { environment: "development" };
const withOrigin = (origin: string): EndpointPolicy => ({
  environment: "development",
  insecureOrigins: new Set([origin]),
});

describe("normalizeHermesEndpoint", () => {
  test("accepts HTTPS everywhere and strips trailing slashes", () => {
    expect(normalizeHermesEndpoint("https://hermes.example.com/", production)).toBe(
      "https://hermes.example.com",
    );
  });

  test("refuses cleartext HTTP when no origin is declared", () => {
    expect(() => normalizeHermesEndpoint("http://127.0.0.1:8642", development)).toThrow(
      /HTTPS/,
    );
  });

  test("accepts a declared origin in development", () => {
    expect(normalizeHermesEndpoint("http://127.0.0.1:8642", withOrigin("127.0.0.1:8642"))).toBe(
      "http://127.0.0.1:8642",
    );
  });

  test("binds the exemption to the exact port", () => {
    expect(() => normalizeHermesEndpoint("http://127.0.0.1:9999", withOrigin("127.0.0.1:8642"))).toThrow(
      /HTTPS/,
    );
  });

  test("never honours a declared origin outside development", () => {
    const policy: EndpointPolicy = {
      environment: "production",
      insecureOrigins: new Set(["127.0.0.1:8642"]),
    };
    expect(() => normalizeHermesEndpoint("http://127.0.0.1:8642", policy)).toThrow(/HTTPS/);
  });

  test("refuses credentials, query strings and fragments", () => {
    for (const raw of [
      "https://user:pass@hermes.example.com",
      "https://hermes.example.com?token=leak",
      "https://hermes.example.com#leak",
    ]) {
      expect(() => normalizeHermesEndpoint(raw, production)).toThrow(HermesEndpointError);
    }
  });
});

describe("parseInsecureHermesOrigins", () => {
  test("is empty when unset", () => {
    expect(parseInsecureHermesOrigins(undefined).size).toBe(0);
    expect(parseInsecureHermesOrigins("  ").size).toBe(0);
  });

  test("keeps explicit host:port entries", () => {
    const origins = parseInsecureHermesOrigins("127.0.0.1:8642, 10.0.0.10:8642");
    expect([...origins].sort()).toEqual(["10.0.0.10:8642", "127.0.0.1:8642"]);
  });

  test("refuses a wildcard or a CIDR instead of widening silently", () => {
    expect(() => parseInsecureHermesOrigins("198.51.100.*:8642")).toThrow(/joker|CIDR/);
    expect(() => parseInsecureHermesOrigins("198.51.100.0/24")).toThrow(/joker|CIDR/);
  });

  test("requires an explicit port", () => {
    expect(() => parseInsecureHermesOrigins("10.0.0.10")).toThrow(/hôte:port/);
  });

  test("refuses a full URL or embedded credentials", () => {
    expect(() => parseInsecureHermesOrigins("http://127.0.0.1:8642")).toThrow(/hôte:port/);
    expect(() => parseInsecureHermesOrigins("user:pass@127.0.0.1:8642")).toThrow(/hôte:port/);
  });
});

describe("isForbiddenAddress", () => {
  test("refuses loopback, private, link-local and metadata addresses", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.0.10",
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "::",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
    ]) {
      expect(isForbiddenAddress(address)).toBe(true);
    }
  });

  test("sees through every spelling of an embedded IPv4", () => {
    for (const address of [
      "::ffff:10.0.0.1",
      "::ffff:0a00:0001",
      "0:0:0:0:0:ffff:169.254.169.254",
      "64:ff9b::127.0.0.1",
      "2002:c0a8:0101::1",
    ]) {
      expect(isForbiddenAddress(address)).toBe(true);
    }
  });

  test("allows a public address", () => {
    expect(isForbiddenAddress("8.8.8.8")).toBe(false);
    expect(isForbiddenAddress("2606:4700::1111")).toBe(false);
  });

  test("defaults to forbidden when the address cannot be parsed", () => {
    expect(isForbiddenAddress("not-an-address")).toBe(true);
    expect(isForbiddenAddress("")).toBe(true);
  });
});
