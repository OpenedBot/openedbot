import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getConfig } from "./config";
import { log } from "./log";
import { tokensFileName } from "./target";

// Shape of POST /api/auth/native/token responses.
export type NativeTokens = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  organizationId: string;
};

// One file per API (production keeps `tokens.bin`): a session is only ever
// replayed against the server that issued it, whatever the target switch says.
function tokensFile(): string {
  return path.join(app.getPath("userData"), tokensFileName(getConfig().apiOrigin));
}

export function isNativeTokens(value: unknown): value is NativeTokens {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accessToken === "string" &&
    typeof record.accessTokenExpiresAt === "string" &&
    typeof record.refreshToken === "string" &&
    typeof record.organizationId === "string"
  );
}

let warnedUnavailable = false;

/**
 * Persists the tokens encrypted with the OS keystore (DPAPI on Windows).
 * Without encryption we keep the session in memory only: a plaintext refresh
 * token on disk would outlive the session and is worse than asking the user to
 * sign in again.
 */
export function saveTokens(tokens: NativeTokens): void {
  if (!safeStorage.isEncryptionAvailable()) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      log.warn("safeStorage encryption unavailable: session kept in memory only, nothing persisted");
    }
    return;
  }
  const file = tokensFile();
  mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash mid-write cannot leave a truncated file: the
  // refresh token rotates on every use, a lost write means a lost session.
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(tokens)), { mode: 0o600 });
  renameSync(temporary, file);
}

export function loadTokens(): NativeTokens | null {
  const file = tokensFile();
  if (!existsSync(file)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const parsed: unknown = JSON.parse(safeStorage.decryptString(readFileSync(file)));
    if (isNativeTokens(parsed)) return parsed;
    log.warn("tokens.bin has an unexpected shape, discarding it");
  } catch (error) {
    // Typically a keystore change (another Windows user or a profile reset).
    log.warn(`tokens.bin could not be decrypted, discarding it (${error instanceof Error ? error.name : "error"})`);
  }
  clearTokens();
  return null;
}

export function clearTokens(): void {
  rmSync(tokensFile(), { force: true });
  rmSync(`${tokensFile()}.tmp`, { force: true });
}
