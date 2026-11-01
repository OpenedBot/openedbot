import { createECDH, randomBytes } from "node:crypto";
/**
 * OHB-20 / OHB-33 — Web Push prouvable contre un serveur push simulé.
 * Exige l'API locale déjà lancée (`make e2e-api`). N'appelle jamais FCM ni Mozilla.
 */
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { startFakePush } from "../fake-push/server";
import { passwordLogin } from "../../scripts/lib/password-login";

const baseUrl = (process.env.E2E_API_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
const email = process.env.E2E_EMAIL ?? "dev@ohb.local";
const password = process.env.E2E_PASSWORD || (() => { throw new Error("E2E_PASSWORD is not set: run `make setup` (it generates one in .env.local), or export it."); })();

const health = await fetch(`${baseUrl}/api/health`);
if (!health.ok) {
  throw new Error("API cloud locale indisponible: lancer « make dev » dans un autre terminal.");
}

const certDir = "tmp/fake-push";
mkdirSync(certDir, { recursive: true });
const certFile = `${certDir}/cert.pem`;
const keyFile = `${certDir}/key.pem`;
const openssl = spawnSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1", "-nodes",
  "-subj", "/CN=127.0.0.1", "-keyout", keyFile, "-out", certFile,
], { encoding: "utf8" });
if (openssl.status !== 0) {
  throw new Error(`openssl failed to mint a loopback certificate: ${openssl.stderr || openssl.stdout}`);
}

const fake = startFakePush({
  port: 0,
  cert: await Bun.file(certFile).text(),
  key: await Bun.file(keyFile).text(),
});

const login = await passwordLogin(baseUrl, { email, password });
if (!login.ok) throw new Error(`Cloud login failed with HTTP ${login.status}: ${await login.text()}`);
const loginBody = await login.json() as { csrfToken: string; organizationId: string };
const setCookie = login.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(",").map((part) => part.trim().split(";")[0]).filter(Boolean).join("; ");
const headers = {
  Cookie: cookie,
  "X-CSRF-Token": loginBody.csrfToken,
  "X-OHB-Organization": loginBody.organizationId,
  "Content-Type": "application/json",
};

try {
  const vapid = await fetch(`${baseUrl}/api/push-subscriptions/vapid-public-key`, { headers });
  if (vapid.status === 404) {
    throw new Error(
      "PUSH_NOT_CONFIGURED: the running API has no PUSH_VAPID_* keys. They were written to .env.local; restart the local stack and re-run make e2e-push.",
    );
  }
  if (!vapid.ok) throw new Error(`vapid-public-key failed with HTTP ${vapid.status}: ${await vapid.text()}`);

  const endpoint = `${fake.url}/push/e2e`;
  const subscribe = await fetch(`${baseUrl}/api/push-subscriptions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      endpoint,
      // De vraies clés client (P-256 non compressée, 65 octets ; auth 16 octets) :
      // mesuré le 04-09, des valeurs de remplissage passent la validation de
      // l'API mais font lever `web-push` dans le worker à chaque tentative
      // (« Livraison partielle » ×5) sans qu'aucun envoi ne parte.
      keys: clientKeys(),
      locale: "fr",
    }),
  });
  if (!subscribe.ok) {
    throw new Error(`POST /api/push-subscriptions failed with HTTP ${subscribe.status}: ${await subscribe.text()}`);
  }

  const bots = await fetch(`${baseUrl}/api/bots`, { headers });
  if (!bots.ok) throw new Error(`GET /api/bots failed with HTTP ${bots.status}: ${await bots.text()}`);
  const botsBody = await bots.json() as { bots: Array<{ id: string }> };
  const botId = botsBody.bots[0]?.id;
  if (!botId) throw new Error("e2e-push needs at least one bot in the seeded organization.");

  const created = await fetch(`${baseUrl}/api/bots/${botId}/routines`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "e2e-push",
      schedule: "0 9 * * 1-5",
      timezone: "UTC",
      message: "Canary push.",
      enabled: false,
    }),
  });
  if (!created.ok) throw new Error(`create routine failed with HTTP ${created.status}: ${await created.text()}`);
  const routine = await created.json() as { id: string };

  const fire = async (label: string) => {
    const run = await fetch(`${baseUrl}/api/routines/${routine.id}/runs`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    });
    if (run.status !== 202) {
      throw new Error(`${label}: manual routine run failed with HTTP ${run.status}: ${await run.text()}`);
    }
  };

  await fire("first");
  await waitFor(() => fake.journal().length >= 1, "first Web Push delivery", 90_000);
  if (fake.journal().length !== 1) {
    throw new Error(`expected exactly one push after the first run, got ${fake.journal().length}`);
  }
  await Bun.sleep(3_000);
  if (fake.journal().length !== 1) {
    throw new Error(`idempotence failed: journal grew to ${fake.journal().length} without a new sequence`);
  }

  fake.setStatus(410);
  await fire("second");
  await waitFor(async () => {
    const listed = await fetch(`${baseUrl}/api/push-subscriptions`, { headers });
    if (!listed.ok) throw new Error(`GET /api/push-subscriptions failed with HTTP ${listed.status}`);
    const body = await listed.json() as { subscriptions: Array<{ endpoint: string }> };
    return body.subscriptions.every((row) => row.endpoint !== endpoint);
  }, "410 purge of the push subscription", 90_000);

  const listed = await fetch(`${baseUrl}/api/push-subscriptions`, { headers });
  const remaining = await listed.json() as { subscriptions: Array<{ endpoint: string }> };
  if (remaining.subscriptions.some((row) => row.endpoint === endpoint)) {
    throw new Error("push subscription was not purged after 410");
  }

  await fetch(`${baseUrl}/api/routines/${routine.id}`, { method: "DELETE", headers });
  console.log(JSON.stringify({
    event: "e2e-push.ok",
    deliveries: fake.journal().length,
    endpointHost: new URL(endpoint).host,
  }));
} finally {
  fake.stop();
}

function clientKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}
