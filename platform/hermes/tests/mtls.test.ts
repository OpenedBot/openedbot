import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertHermesMtlsRuntime,
  hermesMtlsTlsOptions,
  readHermesMtlsIdentity,
} from "../src/mtls";
import { HermesClient, HermesClientError } from "../src/index";

const TEST_CERT = "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n";
const TEST_KEY = "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n";
const TEST_CA = "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----\n";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Hermes mTLS configuration", () => {
  test("defaults to bearer-only mode", () => {
    expect(readHermesMtlsIdentity({})).toBeNull();
    expect(readHermesMtlsIdentity({ HERMES_MTLS_MODE: "off" })).toBeNull();
  });

  test("rejects unknown modes", () => {
    expect(() => readHermesMtlsIdentity({ HERMES_MTLS_MODE: "optional" }))
      .toThrow("HERMES_MTLS_MODE must be off or required");
  });

  test("rejects required mode outside Bun", () => {
    expect(() => assertHermesMtlsRuntime({})).toThrow("requires the Bun runtime");
  });

  test("fails closed without a readable file and never reveals its path", () => {
    const privatePath = join(tmpdir(), `openedbot-private-${crypto.randomUUID()}.pem`);
    let message = "";
    try {
      readHermesMtlsIdentity({
        HERMES_MTLS_MODE: "required",
        HERMES_MTLS_CERT_FILE: privatePath,
        HERMES_MTLS_KEY_FILE: privatePath,
        HERMES_MTLS_CA_FILE: privatePath,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("HERMES_MTLS_CERT_FILE");
    expect(message).not.toContain(privatePath);
  });

  test("allows service-group read but rejects access by other", () => {
    const fixture = identityFiles();
    chmodSync(fixture.keyPath, 0o640);
    expect(readHermesMtlsIdentity({ HERMES_MTLS_MODE: "required", ...fixture.env }))
      .not.toBeNull();
    chmodSync(fixture.keyPath, 0o644);
    expect(() => readHermesMtlsIdentity({ HERMES_MTLS_MODE: "required", ...fixture.env }))
      .toThrow("HERMES_MTLS_KEY_FILE");
  });

  test("snapshots all three files and maps them to Bun fetch TLS fields", () => {
    const fixture = identityFiles();
    const identity = readHermesMtlsIdentity({ HERMES_MTLS_MODE: "required", ...fixture.env });
    expect(identity).toEqual({ cert: TEST_CERT, key: TEST_KEY, ca: TEST_CA });
    expect(hermesMtlsTlsOptions(identity!)).toEqual({
      key: TEST_KEY,
      cert: TEST_CERT,
      ca: [TEST_CA],
    });

    writeFileSync(fixture.certPath, "rotated-after-startup\n", { mode: 0o600 });
    expect(identity?.cert).toBe(TEST_CERT);
  });

  test("refuses mTLS over HTTP before sending a request", async () => {
    const client = new HermesClient({
      endpoint: "http://127.0.0.1:8642",
      token: "test-token",
      policy: { environment: "development" },
      mtls: { cert: TEST_CERT, key: TEST_KEY, ca: TEST_CA },
    });
    try {
      await client.probe();
      throw new Error("Expected the HTTP mTLS request to be refused.");
    } catch (error) {
      expect(error).toBeInstanceOf(HermesClientError);
      expect((error as HermesClientError).code).toBe("HERMES_HTTPS_REQUIRED");
      expect((error as HermesClientError).requestDelivery).toBe("not_sent");
    }
  });
});

function identityFiles() {
  const directory = mkdtempSync(join(tmpdir(), "openedbot-hermes-mtls-"));
  temporaryDirectories.push(directory);
  const certPath = join(directory, "client.crt");
  const keyPath = join(directory, "client.key");
  const caPath = join(directory, "server-ca.crt");
  writeFileSync(certPath, TEST_CERT, { mode: 0o600 });
  writeFileSync(keyPath, TEST_KEY, { mode: 0o600 });
  writeFileSync(caPath, TEST_CA, { mode: 0o600 });
  return {
    certPath,
    keyPath,
    env: {
      HERMES_MTLS_CERT_FILE: certPath,
      HERMES_MTLS_KEY_FILE: keyPath,
      HERMES_MTLS_CA_FILE: caPath,
    },
  };
}
