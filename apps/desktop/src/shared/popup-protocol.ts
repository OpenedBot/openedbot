// Host <-> popup protocol, v1. The desktop shell (host) spawns the popup with
// `--hosted` and both sides exchange one JSON object per line: host -> popup on
// the popup's stdin, popup -> host on its stdout. Logs never travel here.
//
// Pure module (no electron import): the main process uses it, `bun test`
// exercises it, and the future Windows popup (Electron) can reuse both
// directions. Mirrored in ../notch/Sources/OHBPopup/Host/HostProtocol.swift.
//
// Rules: an unknown protocol version ends the session; a malformed line is
// dropped and logged without its content; the refresh token never crosses this
// channel; no token is ever logged, on either side.

export const POPUP_PROTOCOL_VERSION = 1;

/** Longest line either side accepts, in UTF-16 code units. Real messages are a few hundred. */
export const MAX_LINE_LENGTH = 16 * 1024;

/** Popup -> host. */
export type PopupToHost =
  | { type: "ready"; protocol: number; version: string }
  /** `force` is the equivalent of `bridge.refresh()`: sent after a 401 on a token believed valid. */
  | { type: "token"; id: string; force: boolean }
  /** Show the window and navigate it to this console path. */
  | { type: "openConsole"; path: string }
  | { type: "signOut" }
  /** The popup refuses to run for a reason that a restart will not fix, then exits. */
  | { type: "fatal"; code: string };

/** Host -> popup. */
export type HostToPopup =
  | { type: "hello"; protocol: number; apiOrigin: string; consoleUrl: string }
  | TokenReply
  | { type: "signedOut" }
  | { type: "signedIn" };

/**
 * All three values are null together. Without `error`, null means signed out;
 * with `error: "unavailable"` the session lives but the host could not get a
 * valid token right now (network, 5xx): the popup keeps its state and retries.
 * `organizationId` is the tenant the popup must send as `X-OHB-Organization`.
 */
export type TokenReply = {
  type: "token";
  id: string;
  accessToken: string | null;
  expiresAt: string | null;
  organizationId: string | null;
  error?: "unavailable";
};

export type ParseFailure = "too-long" | "invalid-json" | "not-an-object" | "unknown-type" | "invalid-fields";

export type ParseResult<T> = { ok: true; message: T } | { ok: false; reason: ParseFailure };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_PATH_LENGTH = 1024;

type Fields = Record<string, unknown>;

function decodeObject(line: string): { ok: true; fields: Fields } | { ok: false; reason: ParseFailure } {
  if (line.length > MAX_LINE_LENGTH) return { ok: false, reason: "too-long" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "not-an-object" };
  return { ok: true, fields: parsed as Fields };
}

const isString = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);
const isNullableString = (value: unknown, max: number): value is string | null => value === null || isString(value, max);
const isProtocol = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

const invalid = { ok: false, reason: "invalid-fields" } as const;

/** Parses one line read from the popup. Unknown fields are ignored (forward compatible). */
export function parsePopupMessage(line: string): ParseResult<PopupToHost> {
  const decoded = decodeObject(line);
  if (!decoded.ok) return decoded;
  const f = decoded.fields;
  switch (f.type) {
    case "ready":
      return isProtocol(f.protocol) && isString(f.version, 64)
        ? { ok: true, message: { type: "ready", protocol: f.protocol, version: f.version } }
        : invalid;
    case "token":
      if (!isId(f.id) || (f.force !== undefined && typeof f.force !== "boolean")) return invalid;
      return { ok: true, message: { type: "token", id: f.id, force: f.force === true } };
    case "openConsole":
      return isString(f.path, MAX_PATH_LENGTH) ? { ok: true, message: { type: "openConsole", path: f.path } } : invalid;
    case "signOut":
      return { ok: true, message: { type: "signOut" } };
    case "fatal":
      return typeof f.code === "string" && CODE_PATTERN.test(f.code) ? { ok: true, message: { type: "fatal", code: f.code } } : invalid;
    default:
      return { ok: false, reason: "unknown-type" };
  }
}

/** Parses one line read from the host (the popup side, for a popup written in TypeScript). */
export function parseHostMessage(line: string): ParseResult<HostToPopup> {
  const decoded = decodeObject(line);
  if (!decoded.ok) return decoded;
  const f = decoded.fields;
  switch (f.type) {
    case "hello":
      return isProtocol(f.protocol) && isString(f.apiOrigin, 2048) && isString(f.consoleUrl, 2048)
        ? { ok: true, message: { type: "hello", protocol: f.protocol, apiOrigin: f.apiOrigin, consoleUrl: f.consoleUrl } }
        : invalid;
    case "token": {
      if (!isId(f.id)) return invalid;
      if (!isNullableString(f.accessToken, 8192) || !isNullableString(f.expiresAt, 64) || !isNullableString(f.organizationId, 128)) {
        return invalid;
      }
      // All present or all null: a token without its expiry or tenant is unusable.
      const nulls = [f.accessToken, f.expiresAt, f.organizationId].filter((value) => value === null).length;
      if (nulls !== 0 && nulls !== 3) return invalid;
      if (f.error !== undefined && (f.error !== "unavailable" || nulls !== 3)) return invalid;
      const reply: TokenReply = {
        type: "token",
        id: f.id,
        accessToken: f.accessToken,
        expiresAt: f.expiresAt,
        organizationId: f.organizationId,
      };
      if (f.error === "unavailable") reply.error = "unavailable";
      return { ok: true, message: reply };
    }
    case "signedOut":
      return { ok: true, message: { type: "signedOut" } };
    case "signedIn":
      return { ok: true, message: { type: "signedIn" } };
    default:
      return { ok: false, reason: "unknown-type" };
  }
}

// Serializers copy the known fields one by one: an object carrying anything
// else at runtime (a whole token record, say) cannot leak extra fields.

export function encodeHostMessage(message: HostToPopup): string {
  switch (message.type) {
    case "hello":
      return line({ type: "hello", protocol: message.protocol, apiOrigin: message.apiOrigin, consoleUrl: message.consoleUrl });
    case "token": {
      const fields: Fields = {
        type: "token",
        id: message.id,
        accessToken: message.accessToken,
        expiresAt: message.expiresAt,
        organizationId: message.organizationId,
      };
      if (message.error) fields.error = message.error;
      return line(fields);
    }
    case "signedOut":
    case "signedIn":
      return line({ type: message.type });
  }
}

export function encodePopupMessage(message: PopupToHost): string {
  switch (message.type) {
    case "ready":
      return line({ type: "ready", protocol: message.protocol, version: message.version });
    case "token":
      return line({ type: "token", id: message.id, force: message.force });
    case "openConsole":
      return line({ type: "openConsole", path: message.path });
    case "signOut":
      return line({ type: "signOut" });
    case "fatal":
      return line({ type: "fatal", code: message.code });
  }
}

function line(fields: Fields): string {
  const text = JSON.stringify(fields);
  // JSON.stringify escapes newlines inside strings, so one message stays one line.
  if (text.length > MAX_LINE_LENGTH) throw new Error("Protocol message too long");
  return `${text}\n`;
}

/**
 * Splits a byte stream (decoded as UTF-8 by the caller) into lines. An
 * overlong line is dropped up to its newline and counted, never buffered
 * without bound.
 */
export class LineSplitter {
  private buffer = "";
  private discarding = false;

  constructor(private readonly maxLength = MAX_LINE_LENGTH) {}

  push(chunk: string): { lines: string[]; overflowed: number } {
    const lines: string[] = [];
    let overflowed = 0;
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline === -1) break;
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (this.discarding) {
        this.discarding = false;
        this.buffer = "";
        continue;
      }
      const full = (this.buffer + piece).replace(/\r$/, "");
      this.buffer = "";
      if (full.length > this.maxLength) overflowed += 1;
      else if (full.trim().length > 0) lines.push(full);
    }
    if (!this.discarding) {
      this.buffer += rest;
      if (this.buffer.length > this.maxLength) {
        this.buffer = "";
        this.discarding = true;
        overflowed += 1;
      }
    }
    return { lines, overflowed };
  }
}

/**
 * Open request ids. The host opens an id when a `token` request arrives and
 * closes it when it replies: a second request with an id still open is a
 * duplicate. A popup opens an id when it asks and closes it on the reply: a
 * reply whose id is not open answers no request.
 */
export class RequestLedger {
  private readonly open = new Set<string>();

  /** false: this id is already in flight. */
  begin(id: string): boolean {
    if (this.open.has(id)) return false;
    this.open.add(id);
    return true;
  }

  /** false: no request with this id is in flight. */
  settle(id: string): boolean {
    return this.open.delete(id);
  }

  clear(): void {
    this.open.clear();
  }

  get size(): number {
    return this.open.size;
  }
}

/**
 * The console URL for a path asked by the popup, or null. Only a plain
 * absolute path on the configured console qualifies: no scheme, no
 * protocol-relative `//host`, no backslash or control character, and the
 * result must stay under the console's origin and path prefix.
 */
export function resolveConsolePath(consoleUrl: string, path: string): string | null {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return null;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return null;
  let base: URL;
  let target: URL;
  try {
    base = new URL(consoleUrl);
    target = new URL(`${consoleUrl}${path}`);
  } catch {
    return null;
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  if (target.origin !== base.origin) return null;
  // `..` segments are normalised by URL: re-check that we did not climb out of the prefix.
  if (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) return null;
  return target.href;
}
