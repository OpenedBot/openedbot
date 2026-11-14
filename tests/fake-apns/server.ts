/**
 * Local APNs stand-in (DEV-314). Cleartext HTTP/2 (h2c) on loopback, the
 * same `POST /3/device/<token>` contract as Apple: headers checked, JSON
 * payload checked, 200 with `apns-id`, or the scripted error with its
 * `{"reason": ...}` body. Never talks to Apple.
 *
 *   make fake-apns                                  # 127.0.0.1:18793
 *   bun tests/fake-apns/server.ts --dev-key         # prints throwaway APNS_* lines for .env.local
 *
 * Control, over HTTP/2 (`curl --http2-prior-knowledge`):
 *   GET  /health   GET /journal   POST /reset
 *   POST /control  {"status":410,"reason":"Unregistered","times":1,"token":"<hex>","delayMs":0}
 *
 * The journal stays in memory and is printed nowhere: it holds device tokens.
 */
import http2 from "node:http2";
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";

export const FAKE_APNS_HOST = "127.0.0.1";
export const FAKE_APNS_PORT = Number(process.env.FAKE_APNS_PORT ?? 18_793);

export type FakeApnsDelivery = {
  at: string;
  token: string;
  topic: string | null;
  pushType: string | null;
  priority: string | null;
  collapseId: string | null;
  apnsId: string | null;
  expiration: string | null;
  payload: unknown;
  status: number;
  reason: string | null;
  /** `iat` of the provider JWT the request carried (the JWT itself is not kept). */
  providerIssuedAt: number | null;
};

/** One scripted answer. `token` limits it to one device; `times` bounds how often it applies. */
export type FakeApnsRule = {
  status: number;
  reason?: string;
  token?: string;
  times?: number;
  /** Delay before answering, to exercise the client timeout. */
  delayMs?: number;
};

export type FakeApnsOptions = {
  hostname?: string;
  port?: number;
  /** When set, the provider JWT signature is verified with this ES256 public key. */
  publicKey?: KeyObject;
  /** Expected `kid` / `iss` of the provider JWT, when set. */
  keyId?: string;
  teamId?: string;
};

export type FakeApnsServer = {
  url: string;
  port: number;
  journal: () => FakeApnsDelivery[];
  script: (rule: FakeApnsRule) => void;
  reset: () => void;
  stop: () => Promise<void>;
};

const DEVICE_PATH = /^\/3\/device\/([0-9a-f]+)$/;

export async function startFakeApns(options: FakeApnsOptions = {}): Promise<FakeApnsServer> {
  const hostname = options.hostname ?? FAKE_APNS_HOST;
  const deliveries: FakeApnsDelivery[] = [];
  let rules: Array<FakeApnsRule & { remaining: number }> = [];

  function nextRule(token: string): FakeApnsRule | null {
    const index = rules.findIndex((rule) => !rule.token || rule.token === token);
    if (index < 0) return null;
    const rule = rules[index]!;
    rule.remaining -= 1;
    if (rule.remaining <= 0) rules.splice(index, 1);
    return rule;
  }

  function addRule(rule: FakeApnsRule): void {
    rules.push({ ...rule, remaining: rule.times ?? 1 });
  }

  function authorizationReason(header: string | undefined): string | null {
    const match = /^bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header ?? "");
    if (!match) return "MissingProviderToken";
    try {
      const head = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as { alg?: unknown; kid?: unknown };
      const claims = JSON.parse(Buffer.from(match[2]!, "base64url").toString("utf8")) as { iss?: unknown; iat?: unknown };
      if (head.alg !== "ES256" || typeof head.kid !== "string" || typeof claims.iss !== "string" || typeof claims.iat !== "number") {
        return "InvalidProviderToken";
      }
      if (options.keyId && head.kid !== options.keyId) return "InvalidProviderToken";
      if (options.teamId && claims.iss !== options.teamId) return "InvalidProviderToken";
      if (options.publicKey) {
        const valid = verify(
          "sha256",
          Buffer.from(`${match[1]}.${match[2]}`),
          { key: options.publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(match[3]!, "base64url"),
        );
        if (!valid) return "InvalidProviderToken";
      }
      if (Math.abs(Date.now() / 1_000 - claims.iat) > 3_600) return "ExpiredProviderToken";
      return null;
    } catch {
      return "InvalidProviderToken";
    }
  }

  const server = http2.createServer();
  server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    const method = String(headers[":method"] ?? "");
    const path = String(headers[":path"] ?? "");
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", () => undefined);
    stream.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const json = (status: number, value: unknown, extra: Record<string, string> = {}) => {
        if (stream.closed || stream.destroyed) return;
        stream.respond({ ":status": status, "content-type": "application/json", ...extra });
        stream.end(JSON.stringify(value));
      };

      if (method === "GET" && path === "/health") return json(200, { ok: true, deliveries: deliveries.length });
      if (method === "GET" && path === "/journal") return json(200, { deliveries });
      if (method === "POST" && path === "/reset") {
        deliveries.length = 0;
        rules = [];
        return json(200, { ok: true });
      }
      if (method === "POST" && path === "/control") {
        try {
          const rule = JSON.parse(body) as FakeApnsRule;
          if (!Number.isSafeInteger(rule.status) || rule.status < 200 || rule.status > 599) throw new Error();
          addRule(rule);
          return json(200, { ok: true });
        } catch {
          return json(400, { error: "body must be {status, reason?, token?, times?, delayMs?}" });
        }
      }

      const device = DEVICE_PATH.exec(path);
      if (method !== "POST" || !device) return json(404, { reason: "BadPath" });
      const token = device[1]!;
      const record = (status: number, reason: string | null, payload: unknown) => {
        deliveries.push({
          providerIssuedAt: providerIssuedAt(headerValue(headers.authorization)),
          at: new Date().toISOString(),
          token,
          topic: headerValue(headers["apns-topic"]),
          pushType: headerValue(headers["apns-push-type"]),
          priority: headerValue(headers["apns-priority"]),
          collapseId: headerValue(headers["apns-collapse-id"]),
          apnsId: headerValue(headers["apns-id"]),
          expiration: headerValue(headers["apns-expiration"]),
          payload,
          status,
          reason,
        });
      };

      const tokenReason = authorizationReason(headerValue(headers.authorization) ?? undefined);
      if (tokenReason) {
        record(403, tokenReason, null);
        return json(403, { reason: tokenReason });
      }
      if (!headerValue(headers["apns-topic"])) {
        record(400, "MissingTopic", null);
        return json(400, { reason: "MissingTopic" });
      }
      if (headerValue(headers["apns-push-type"]) !== "alert") {
        record(400, "InvalidPushType", null);
        return json(400, { reason: "InvalidPushType" });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
        if (!payload || typeof payload !== "object" || !("aps" in payload)) throw new Error();
      } catch {
        record(400, "PayloadEmpty", null);
        return json(400, { reason: "PayloadEmpty" });
      }
      if (Buffer.byteLength(body) > 4_096) {
        record(413, "PayloadTooLarge", payload);
        return json(413, { reason: "PayloadTooLarge" });
      }

      const rule = nextRule(token);
      const answer = () => {
        const status = rule?.status ?? 200;
        const reason = status === 200 ? null : rule?.reason ?? "InternalServerError";
        record(status, reason, payload);
        const apnsId = headerValue(headers["apns-id"]) ?? crypto.randomUUID();
        if (status === 200) {
          if (stream.closed || stream.destroyed) return;
          stream.respond({ ":status": 200, "apns-id": apnsId });
          stream.end();
          return;
        }
        json(status, status === 410 ? { reason, timestamp: Date.now() } : { reason }, { "apns-id": apnsId });
      };
      if (rule?.delayMs) setTimeout(answer, rule.delayMs);
      else answer();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? FAKE_APNS_PORT, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake APNs did not bind a TCP port");
  return {
    url: `http://${hostname}:${address.port}`,
    port: address.port,
    journal: () => [...deliveries],
    script: addRule,
    reset: () => {
      deliveries.length = 0;
      rules = [];
    },
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

function providerIssuedAt(authorization: string | null): number | null {
  const claims = authorization?.split(".")[1];
  if (!claims) return null;
  try {
    const iat = (JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as { iat?: unknown }).iat;
    return typeof iat === "number" ? iat : null;
  } catch {
    return null;
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** A throwaway P-256 key and the `.env.local` lines pointing the API and worker at the fake. */
export function fakeApnsDevEnv(port = FAKE_APNS_PORT): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString().trim().replaceAll("\n", "\\n");
  return [
    "APNS_KEY_ID=FAKEKEY001",
    "APNS_TEAM_ID=FAKETEAM01",
    `APNS_PRIVATE_KEY="${pem}"`,
    "APNS_BUNDLE_IDS=app.openedbot.mobile",
    `APNS_HOST_OVERRIDE=http://${FAKE_APNS_HOST}:${port}`,
  ].join("\n");
}

if (import.meta.main) {
  if (process.argv.includes("--dev-key")) {
    console.log(fakeApnsDevEnv());
  } else {
    const server = await startFakeApns();
    console.log(JSON.stringify({ event: "fake-apns.listen", url: server.url, protocol: "h2c" }));
  }
}
