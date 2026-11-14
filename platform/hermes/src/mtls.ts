import { readFileSync, statSync } from "node:fs";

export type HermesMtlsIdentity = Readonly<{
  cert: string;
  key: string;
  /** Server trust roots, not the private CA used to issue client identities. */
  ca: string;
}>;

export function assertHermesMtlsRuntime(versions: object = process.versions): void {
  if (typeof Reflect.get(versions, "bun") !== "string") {
    throw new Error("HERMES_MTLS_MODE=required requires the Bun runtime.");
  }
}

export function readHermesMtlsIdentity(
  env: Record<string, string | undefined> = process.env,
): HermesMtlsIdentity | null {
  const mode = env.HERMES_MTLS_MODE?.trim().toLowerCase() || "off";
  if (mode !== "off" && mode !== "required") {
    throw new Error("HERMES_MTLS_MODE must be off or required.");
  }
  if (mode === "off") return null;

  // Node fetch ignores Bun's client-certificate extension. Fail startup
  // instead of silently falling back to bearer-only authentication.
  assertHermesMtlsRuntime();
  return {
    cert: readIdentityFile(env.HERMES_MTLS_CERT_FILE, "HERMES_MTLS_CERT_FILE", "certificate"),
    key: readIdentityFile(env.HERMES_MTLS_KEY_FILE, "HERMES_MTLS_KEY_FILE", "private-key"),
    ca: readIdentityFile(env.HERMES_MTLS_CA_FILE, "HERMES_MTLS_CA_FILE", "certificate"),
  };
}

/** Bun fetch TLS fields; kept pure so their exact mapping is unit-testable. */
export function hermesMtlsTlsOptions(identity: HermesMtlsIdentity) {
  return { key: identity.key, cert: identity.cert, ca: [identity.ca] };
}

function readIdentityFile(
  pathValue: string | undefined,
  variable: string,
  kind: "certificate" | "private-key",
): string {
  const path = pathValue?.trim();
  if (!path) throw new Error(`${variable} is required when HERMES_MTLS_MODE=required.`);
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size === 0) throw new Error("invalid identity file");
    // root:hermes_runtime 0640/0440 is the intended shared-service boundary.
    // Group read is allowed; group write/execute and every "other" bit are not.
    if (kind === "private-key" && (metadata.mode & 0o027) !== 0) {
      throw new Error("private key permissions are too broad");
    }
    const contents = readFileSync(path, "utf8");
    if (!contents.trim()) throw new Error("empty identity file");
    if (kind === "certificate" && !contents.includes("-----BEGIN CERTIFICATE-----")) {
      throw new Error("invalid certificate PEM");
    }
    if (kind === "private-key" && !contents.includes("PRIVATE KEY-----")) {
      throw new Error("invalid private key PEM");
    }
    return contents;
  } catch {
    // Deliberately omit both the path and fs error: neither belongs in logs.
    throw new Error(`${variable} must reference a protected, readable, non-empty PEM file.`);
  }
}
