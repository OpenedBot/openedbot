import http2 from "node:http2";
import { sign } from "node:crypto";
import { apnsOrigin, type ApnsConfig, type ApnsEnvironment } from "@openedbot/platform-integrations/apns";
import { apnsReasonCode } from "../domain/apns";

/** Apple rejects a provider token older than one hour; it is renewed well before. */
const PROVIDER_TOKEN_MAX_AGE_MS = 50 * 60_000;
/** Apple answers TooManyProviderTokenUpdates when a token is re-signed too often. */
const PROVIDER_TOKEN_MIN_AGE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 8_192;

export type ApnsRequest = {
  environment: ApnsEnvironment;
  /** Lower-case hex device token. Goes into the request path only; never logged. */
  deviceToken: string;
  /** Bundle identifier of the registration (`apns-topic`). */
  topic: string;
  /** Stable across retries: the delivery id. */
  apnsId: string;
  collapseId: string;
  priority: 5 | 10;
  /** Unix seconds after which Apple drops the notification if still undelivered. */
  expiration: number;
  payload: string;
};

export type ApnsResponse = {
  status: number;
  /** APNs `reason` (one word, e.g. `BadDeviceToken`), `null` on success or when unreadable. */
  reason: string | null;
};

/** The request never got an HTTP answer: retryable, recorded by code only. */
export class ApnsTransportError extends Error {
  constructor(readonly code: "Timeout" | "NetworkError") {
    super(code === "Timeout" ? "APNs request timed out." : "APNs connection failed.");
    this.name = "ApnsTransportError";
  }
}

export type ApnsTransport = {
  send(request: ApnsRequest): Promise<ApnsResponse>;
  /** Drop the cached provider JWT after a 403 so the next send signs a fresh one. */
  invalidateProviderToken(): void;
  close(): void;
};

/**
 * Token-based HTTP/2 client: one session per origin (Apple multiplexes many
 * streams on it), reopened after GOAWAY, error or close. The ES256 provider
 * JWT is cached under an hour. The fake APNs (`tests/fake-apns`) speaks
 * cleartext HTTP/2 through `APNS_HOST_OVERRIDE`; Apple's hosts are TLS.
 */
export function createApnsTransport(
  config: ApnsConfig,
  options: { timeoutMs?: number; now?: () => number } = {},
): ApnsTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, http2.ClientHttp2Session>();
  let providerToken: { value: string; issuedAt: number } | null = null;
  let invalidated = false;

  function currentProviderToken(): string {
    const at = now();
    const age = providerToken ? at - providerToken.issuedAt : Number.POSITIVE_INFINITY;
    const stale = age >= PROVIDER_TOKEN_MAX_AGE_MS || (invalidated && age >= PROVIDER_TOKEN_MIN_AGE_MS);
    if (!providerToken || stale) {
      providerToken = { value: signProviderToken(config, Math.floor(at / 1_000)), issuedAt: at };
      invalidated = false;
    }
    return providerToken.value;
  }

  function session(origin: string): http2.ClientHttp2Session {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const opened = http2.connect(origin);
    const forget = () => {
      if (sessions.get(origin) === opened) sessions.delete(origin);
    };
    // A session error also fails its open streams, which reject their own
    // promise; this handler only keeps the error from going unhandled.
    opened.on("error", forget);
    opened.on("goaway", forget);
    opened.on("close", forget);
    sessions.set(origin, opened);
    return opened;
  }

  return {
    send(request) {
      const origin = apnsOrigin(config, request.environment);
      return new Promise<ApnsResponse>((resolve, reject) => {
        let settled = false;
        const finish = (outcome: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          outcome();
        };
        let stream: http2.ClientHttp2Stream;
        try {
          stream = session(origin).request({
            ":method": "POST",
            ":path": `/3/device/${request.deviceToken}`,
            authorization: `bearer ${currentProviderToken()}`,
            "apns-push-type": "alert",
            "apns-topic": request.topic,
            "apns-id": request.apnsId,
            "apns-collapse-id": request.collapseId,
            "apns-priority": String(request.priority),
            "apns-expiration": String(request.expiration),
            "content-type": "application/json",
          });
        } catch {
          sessions.delete(origin);
          reject(new ApnsTransportError("NetworkError"));
          return;
        }
        const timer = setTimeout(() => {
          finish(() => reject(new ApnsTransportError("Timeout")));
          stream.close(http2.constants.NGHTTP2_CANCEL);
        }, timeoutMs);
        let status = 0;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        stream.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        stream.on("end", () => {
          finish(() => {
            if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
              reject(new ApnsTransportError("NetworkError"));
              return;
            }
            resolve({ status, reason: status === 200 ? null : readReason(Buffer.concat(chunks)) });
          });
        });
        stream.on("error", () => {
          finish(() => reject(new ApnsTransportError("NetworkError")));
        });
        stream.on("close", () => {
          finish(() => reject(new ApnsTransportError("NetworkError")));
        });
        stream.end(request.payload);
      });
    },
    invalidateProviderToken() {
      invalidated = true;
    },
    close() {
      for (const opened of sessions.values()) opened.close();
      sessions.clear();
    },
  };
}

/** ES256 provider token: header `{alg, kid}`, claims `{iss: teamId, iat}`, raw (r || s) signature. */
export function signProviderToken(
  config: Pick<ApnsConfig, "keyId" | "teamId" | "privateKey">,
  issuedAtSeconds: number,
): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: issuedAtSeconds }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: config.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function readReason(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { reason?: unknown };
    return apnsReasonCode(parsed?.reason);
  } catch {
    return null;
  }
}
