import { afterAll, describe, expect, test } from "bun:test";
import { RELAY_CLOSE_UNAUTHORIZED } from "@openedbot/contracts-connector";
import { acceptedLinkOrigins, devTunnelWsUrl, expectedLinkWsUrls, isRetiredLinkOrigin, linkPopMessage, linkSignedOrigin, verifyLinkProof } from "@openedbot/runtime-link/application/link-pop";
import {
  deviceKey,
  LINK_RUNTIME_ID,
  linkConfig,
  openLinkSession,
  proveLink,
  startShared,
  stopLinkSessions,
} from "./fixtures/link-gateway-session";

afterAll(() => stopLinkSessions());

/**
 * La preuve de possession du lien, côté API : un jeton
 * volé n'ouvre rien sans la clé device de la machine enrôlée.
 */
describe("preuve de possession du lien connecteur", () => {
  test("clé enregistrée : défi après hello, preuve correcte, liaison", async () => {
    const key = deviceKey();
    const session = await openLinkSession({ registeredDeviceKey: key.publicKey, offeredDeviceKey: key.publicKey });
    const challenge = await session.waitFrame((frame) => frame.t === "link.challenge");
    if (challenge.t !== "link.challenge") throw new Error("unreachable");
    expect(session.shared.broker.connected(LINK_RUNTIME_ID)).toBe(false);
    session.send({ t: "link.proof", signature: proveLink(key, challenge.nonce, session.wsUrl) });
    await session.waitLiveness((entry) => entry.write === "connected");
    expect(session.shared.broker.connected(LINK_RUNTIME_ID)).toBe(true);
    expect(session.shared.liveness.some((entry) => entry.write === "event" && entry.kind === "pop_failed")).toBe(false);
    expect(session.shared.logs.some((entry) => entry.event === "runtime_link.pop_verified")).toBe(true);
  });

  test("une trame envoyée juste derrière une preuve correcte ne coupe pas la liaison", async () => {
    const key = deviceKey();
    const session = await openLinkSession({ registeredDeviceKey: key.publicKey, offeredDeviceKey: key.publicKey, dbLatencyMs: 20 });
    const challenge = await session.waitFrame((frame) => frame.t === "link.challenge");
    if (challenge.t !== "link.challenge") throw new Error("unreachable");
    // Même tick : l'hôte n'attend pas la liaison pour parler.
    session.send({ t: "link.proof", signature: proveLink(key, challenge.nonce, session.wsUrl) });
    session.send({ t: "ping" });
    await session.waitLiveness((entry) => entry.write === "connected");
    expect(session.shared.broker.connected(LINK_RUNTIME_ID)).toBe(true);
    expect(session.shared.liveness.some((entry) => entry.write === "event" && entry.kind === "pop_failed")).toBe(false);
  });

  test("une signature d'un autre nonce (rejeu) est refusée 4401 et journalisée pop_failed", async () => {
    const key = deviceKey();
    const session = await openLinkSession({ registeredDeviceKey: key.publicKey });
    await session.waitFrame((frame) => frame.t === "link.challenge");
    const stale = Buffer.alloc(32, 3).toString("base64");
    session.send({ t: "link.proof", signature: proveLink(key, stale, session.wsUrl) });
    expect(await session.waitClose()).toBe(RELAY_CLOSE_UNAUTHORIZED);
    const failed = session.shared.liveness.find((entry) => entry.write === "event" && entry.kind === "pop_failed");
    expect(failed).toMatchObject({ meta: { reason: "signature" } });
    expect(session.shared.broker.connected(LINK_RUNTIME_ID)).toBe(false);
  });

  test("une preuve signée pour une autre URL de serveur est refusée", async () => {
    const key = deviceKey();
    const session = await openLinkSession({ registeredDeviceKey: key.publicKey });
    const challenge = await session.waitFrame((frame) => frame.t === "link.challenge");
    if (challenge.t !== "link.challenge") throw new Error("unreachable");
    session.send({ t: "link.proof", signature: proveLink(key, challenge.nonce, "wss://other.example/api/runtime-links/ws") });
    expect(await session.waitClose()).toBe(RELAY_CLOSE_UNAUTHORIZED);
  });

  test("sans link.proof dans le délai, la montée est refusée 4401 (timeout)", async () => {
    const key = deviceKey();
    const session = await openLinkSession({ registeredDeviceKey: key.publicKey, popTimeoutMs: 100 });
    await session.waitFrame((frame) => frame.t === "link.challenge");
    expect(await session.waitClose()).toBe(RELAY_CLOSE_UNAUTHORIZED);
    expect(session.shared.liveness.find((entry) => entry.write === "event" && entry.kind === "pop_failed")).toMatchObject({ meta: { reason: "timeout" } });
  });

  test("une autre trame que link.proof pendant le défi ferme la session", async () => {
    const key = deviceKey();
    const session = await openLinkSession({ registeredDeviceKey: key.publicKey });
    await session.waitFrame((frame) => frame.t === "link.challenge");
    session.send({ t: "ping" });
    expect(await session.waitClose()).toBe(RELAY_CLOSE_UNAUTHORIZED);
    expect(session.shared.liveness.find((entry) => entry.write === "event" && entry.kind === "pop_failed")).toMatchObject({ meta: { reason: "proof_expected" } });
  });

  test("aucune clé nulle part, hors production : liaison directe et pop_missing au journal", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null });
    await session.waitLiveness((entry) => entry.write === "connected");
    expect(session.frames.some((frame) => frame.t === "link.challenge")).toBe(false);
    expect(session.shared.liveness.some((entry) => entry.write === "event" && entry.kind === "pop_missing")).toBe(true);
  });

  test("aucune clé nulle part avec RUNTIME_LINK_REQUIRE_POP=1 : refus 4401 pop_failed", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null, requirePop: true });
    expect(await session.waitClose()).toBe(RELAY_CLOSE_UNAUTHORIZED);
    expect(session.shared.liveness.find((entry) => entry.write === "event" && entry.kind === "pop_failed")).toMatchObject({ meta: { reason: "no_device_key" } });
    expect(session.shared.liveness.some((entry) => entry.write === "connected")).toBe(false);
  });

  test("rekey sous le jeton courant : preuve avec la NOUVELLE clé, clé enregistrée mise à jour, rotated au journal", async () => {
    const old = deviceKey();
    const fresh = deviceKey();
    const session = await openLinkSession({ registeredDeviceKey: old.publicKey, offeredDeviceKey: fresh.publicKey });
    const challenge = await session.waitFrame((frame) => frame.t === "link.challenge");
    if (challenge.t !== "link.challenge") throw new Error("unreachable");
    session.send({ t: "link.proof", signature: proveLink(fresh, challenge.nonce, session.wsUrl) });
    await session.waitLiveness((entry) => entry.write === "connected");
    const update = session.shared.statements.find((entry) => entry.sql.includes("update runtimes set link_device_pubkey ="));
    expect(update).toBeDefined();
    expect(update!.values).toContain(fresh.publicKey);
    expect(session.shared.liveness.find((entry) => entry.write === "event" && entry.kind === "rotated")).toMatchObject({ meta: { reason: "device_key" } });
  });

  test("première clé sous le jeton courant : inscription de A après preuve, puis rekey vers B sous le même jeton", async () => {
    const a = deviceKey();
    const b = deviceKey();
    const first = await openLinkSession({ registeredDeviceKey: null, offeredDeviceKey: a.publicKey, forwardedFor: "203.0.113.10" });
    const challengeA = await first.waitFrame((frame) => frame.t === "link.challenge");
    if (challengeA.t !== "link.challenge") throw new Error("unreachable");
    expect(first.shared.statements.some((entry) => entry.sql.includes("update runtimes set link_device_pubkey ="))).toBe(false);
    expect(first.shared.broker.connected(LINK_RUNTIME_ID)).toBe(false);
    first.send({ t: "link.proof", signature: proveLink(a, challengeA.nonce, first.wsUrl) });
    await first.waitLiveness((entry) => entry.write === "connected");
    const updateA = first.shared.statements.find((entry) => entry.sql.includes("update runtimes set link_device_pubkey ="));
    expect(updateA).toBeDefined();
    expect(updateA!.values[0]).toBe(a.publicKey);
    expect(updateA!.sql).toContain("and link_token_hash =");
    expect(first.shared.liveness.find((entry) => entry.write === "event" && entry.kind === "device_key_registered")).toMatchObject({ meta: { ip: "203.0.113.10", agent: "edge-setup/test" } });
    expect(first.shared.liveness.some((entry) => entry.write === "event" && entry.kind === "rotated")).toBe(false);

    // La base factice rend à la seconde montée la clé écrite par la première.
    const second = await openLinkSession({ registeredDeviceKey: updateA!.values[0] as string, offeredDeviceKey: b.publicKey });
    const challengeB = await second.waitFrame((frame) => frame.t === "link.challenge");
    if (challengeB.t !== "link.challenge") throw new Error("unreachable");
    expect(second.shared.broker.connected(LINK_RUNTIME_ID)).toBe(false);
    second.send({ t: "link.proof", signature: proveLink(b, challengeB.nonce, second.wsUrl) });
    await second.waitLiveness((entry) => entry.write === "connected");
    const updateB = second.shared.statements.find((entry) => entry.sql.includes("update runtimes set link_device_pubkey ="));
    expect(updateB!.values[0]).toBe(b.publicKey);
    expect(second.shared.liveness.find((entry) => entry.write === "event" && entry.kind === "rotated")).toMatchObject({ meta: { reason: "device_key" } });
    expect(second.shared.liveness.some((entry) => entry.write === "event" && entry.kind === "device_key_registered")).toBe(false);
  });

  test("première clé sous l'ANCIEN jeton en grâce : refusée sans défi ni inscription", async () => {
    const key = deviceKey();
    const session = await openLinkSession({ registeredDeviceKey: null, offeredDeviceKey: key.publicKey, previousToken: true });
    expect(await session.waitClose()).toBe(RELAY_CLOSE_UNAUTHORIZED);
    expect(session.frames.some((frame) => frame.t === "link.challenge")).toBe(false);
    expect(session.shared.statements.some((entry) => entry.sql.includes("update runtimes set link_device_pubkey ="))).toBe(false);
    expect(session.shared.liveness.find((entry) => entry.write === "event" && entry.kind === "pop_failed")).toMatchObject({ meta: { reason: "first_key_with_previous_token" } });
    expect(session.shared.liveness.some((entry) => entry.write === "event" && entry.kind === "device_key_registered")).toBe(false);
    expect(session.shared.broker.connected(LINK_RUNTIME_ID)).toBe(false);
  });

  test("rekey sous l'ANCIEN jeton en grâce : refusé avant tout défi", async () => {
    const old = deviceKey();
    const fresh = deviceKey();
    const session = await openLinkSession({ registeredDeviceKey: old.publicKey, offeredDeviceKey: fresh.publicKey, previousToken: true });
    expect(await session.waitClose()).toBe(RELAY_CLOSE_UNAUTHORIZED);
    expect(session.frames.some((frame) => frame.t === "link.challenge")).toBe(false);
    expect(session.shared.liveness.find((entry) => entry.write === "event" && entry.kind === "pop_failed")).toMatchObject({ meta: { reason: "rekey_with_previous_token" } });
  });

  test("deux sockets valides d'adresses différentes en dix minutes : rotation d'urgence et fermeture 4401", async () => {
    const shared = startShared({ registeredDeviceKey: null, forwardedFor: "203.0.113.10" });
    const first = await openLinkSession({ shared, forwardedFor: "203.0.113.10" });
    await first.waitLiveness((entry) => entry.write === "connected");
    const second = await openLinkSession({ shared, forwardedFor: "198.51.100.7" });
    await second.waitLiveness((entry) => entry.write === "emergency_rotate");
    expect(await second.waitClose()).toBe(RELAY_CLOSE_UNAUTHORIZED);
    expect(shared.liveness.some((entry) => entry.write === "event" && entry.kind === "hijack_suspected")).toBe(true);
    expect(shared.liveness.find((entry) => entry.write === "emergency_rotate")).toMatchObject({ meta: { automatic: true, reason: "hijack_suspected", previousIp: "203.0.113.10" } });
  });

  test("le remplacement depuis la MÊME adresse ne déclenche pas de rotation d'urgence", async () => {
    const shared = startShared({ registeredDeviceKey: null });
    const first = await openLinkSession({ shared, forwardedFor: "203.0.113.10" });
    await first.waitLiveness((entry) => entry.write === "connected");
    const second = await openLinkSession({ shared, forwardedFor: "203.0.113.10" });
    await second.waitLiveness((entry) => entry.write === "event" && entry.kind === "replaced");
    await Bun.sleep(50);
    expect(shared.liveness.some((entry) => entry.write === "emergency_rotate")).toBe(false);
    expect(shared.broker.connected(LINK_RUNTIME_ID)).toBe(true);
  });
});

describe("URL acceptées par la preuve et message signé", () => {
  test("en production, seule l'origine publique en wss:// est acceptée", () => {
    const config = { environment: "production" as const, publicUrl: "https://api.openedbot.example", port: 8790 };
    expect(expectedLinkWsUrls(config)).toEqual(["wss://api.openedbot.example/api/runtime-links/ws"]);
  });

  test("en production, une ancienne origine publique reste acceptée après l'actuelle, en wss:// seulement", () => {
    const config = {
      environment: "production" as const,
      publicUrl: "https://openedbot.example",
      port: 8790,
      linkLegacyPublicUrls: ["https://console.openedbot.example", "http://plain.openedbot.example"],
    };
    expect(expectedLinkWsUrls(config)).toEqual([
      "wss://openedbot.example/api/runtime-links/ws",
      "wss://console.openedbot.example/api/runtime-links/ws",
    ]);
  });

  test("l'origine dédiée du lien passe d'abord, l'origine de l'API reste acceptée", () => {
    const config = { environment: "production" as const, publicUrl: "https://openedbot.example", linkPublicUrl: "https://link.openedbot.example", port: 8790, linkLegacyPublicUrls: ["https://console.openedbot.example"] };
    expect(expectedLinkWsUrls(config)).toEqual([
      "wss://link.openedbot.example/api/runtime-links/ws",
      "wss://openedbot.example/api/runtime-links/ws",
      "wss://console.openedbot.example/api/runtime-links/ws",
    ]);
  });

  test("l'origine signée se réduit au nom, et une adresse retirée se voit", () => {
    expect(linkSignedOrigin("wss://console.openedbot.app/api/runtime-links/ws")).toBe("https://console.openedbot.app");
    expect(linkSignedOrigin("ws://127.0.0.1:8822/api/runtime-links/ws")).toBe("http://127.0.0.1:8822");
    expect(linkSignedOrigin("https://evil.example/x")).toBeNull();
    const publication = {
      environment: "production" as const,
      acceptedOrigins: acceptedLinkOrigins({ publicUrl: "https://openedbot.app", linkPublicUrl: "https://link.openedbot.app" }),
    };
    expect(isRetiredLinkOrigin("https://console.openedbot.app", publication)).toBe(true);
    expect(isRetiredLinkOrigin("https://link.openedbot.app", publication)).toBe(false);
    expect(isRetiredLinkOrigin("https://openedbot.app", publication)).toBe(false);
    expect(isRetiredLinkOrigin("http://127.0.0.1:8822", { environment: "development", acceptedOrigins: publication.acceptedOrigins })).toBe(false);
  });

  test("hors production, le tunnel loopback du poste est accepté aussi", () => {
    const urls = expectedLinkWsUrls({ environment: "development", publicUrl: "http://localhost:8790", port: 8790 });
    expect(urls).toContain("ws://localhost:8790/api/runtime-links/ws");
    expect(urls).toContain("ws://127.0.0.1:8790/api/runtime-links/ws");
    expect(urls.every((url) => url.endsWith("/api/runtime-links/ws"))).toBe(true);
  });

  test("hors production, le port de tunnel composé par le poste est accepté ; jamais en production", () => {
    expect(devTunnelWsUrl({ environment: "development" }, "127.0.0.1:8822")).toBe("ws://127.0.0.1:8822/api/runtime-links/ws");
    expect(devTunnelWsUrl({ environment: "production" }, "127.0.0.1:8822")).toBeNull();
    expect(devTunnelWsUrl({ environment: "development" }, "evil.example:8822")).toBeNull();
    expect(devTunnelWsUrl({ environment: "development" }, "127.0.0.1:99999")).toBeNull();
    expect(devTunnelWsUrl({ environment: "development" }, null)).toBeNull();
  });

  test("le message signé est prefix, nonce brut, runtimeId et wsURL séparés par des sauts de ligne", () => {
    const nonce = Buffer.alloc(32, 1).toString("base64");
    const message = Buffer.from(linkPopMessage(nonce, "rt", "wss://x/api/runtime-links/ws"));
    expect(message.subarray(0, 22).toString()).toBe("openedbot-link-pop/v1\n");
    expect(message.subarray(22, 54).equals(Buffer.alloc(32, 1))).toBe(true);
    expect(message.subarray(54).toString()).toBe("\nrt\nwss://x/api/runtime-links/ws\n");
  });

  test("verifyLinkProof rend l'URL signée, et null sur une clé, un nonce ou une signature mal formés", () => {
    const key = deviceKey();
    const nonce = Buffer.alloc(32, 2).toString("base64");
    const signature = proveLink(key, nonce, "wss://x/api/runtime-links/ws", "rt");
    const wsUrls = ["wss://y/api/runtime-links/ws", "wss://x/api/runtime-links/ws"];
    expect(verifyLinkProof({ devicePublicKey: key.publicKey, nonce, runtimeId: "rt", signature, wsUrls })).toBe("wss://x/api/runtime-links/ws");
    expect(verifyLinkProof({ devicePublicKey: "short", nonce, runtimeId: "rt", signature, wsUrls })).toBeNull();
    expect(verifyLinkProof({ devicePublicKey: key.publicKey, nonce: "short", runtimeId: "rt", signature, wsUrls })).toBeNull();
    expect(verifyLinkProof({ devicePublicKey: key.publicKey, nonce, runtimeId: "other", signature, wsUrls })).toBeNull();
    expect(linkConfig().linkSecurity.requirePop).toBe(false);
  });
});
