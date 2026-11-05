import { afterAll, describe, expect, test } from "bun:test";
import { RELAY_CLOSE_UNAUTHORIZED, RELAY_FEATURE_CREATION_AUDIT_V2, RELAY_MAX_FEATURES } from "@openedbot/contracts-connector";
import {
  LINK_ORGANIZATION_ID,
  LINK_RUNTIME_ID,
  linkConfig,
  openLinkSession,
  stopLinkSessions,
} from "./fixtures/link-gateway-session";

afterAll(() => stopLinkSessions());

describe("link.context remis à la liaison", () => {
  test("nomme le palier, l'origine, l'organisation et son owner, après audit.key et sans secret", async () => {
    // OPENEDBOT_ENV=preprod would bring the whole production guard set: only
    // the label matters here (deployEnvironment is covered in alerting-webhook).
    const config = { ...linkConfig({ API_PUBLIC_URL: "https://preprod.openedbot.app" }), deployEnvironment: "preprod" as const };
    const session = await openLinkSession({ registeredDeviceKey: null, features: [RELAY_FEATURE_CREATION_AUDIT_V2], auditKeyRows: [], config });
    const frame = await session.waitFrame((entry) => entry.t === "link.context");
    if (frame.t !== "link.context") throw new Error("unreachable");
    expect(frame).toEqual({
      t: "link.context",
      environment: "preprod",
      openedbot: "https://preprod.openedbot.app",
      organization: { id: LINK_ORGANIZATION_ID, name: "Acme", slug: "acme" },
      owner: { email: "owner@example.com", displayName: "Owner" },
      limits: { features: RELAY_MAX_FEATURES },
      // Ce que ce broker sait recevoir : l'hôte ne signale son inventaire qu'à lui.
      accepts: ["inventory.changed"],
    });
    // La liaison précède la trame, et la clé d'audit la précède sur le fil.
    expect(session.shared.liveness.some((entry) => entry.write === "connected")).toBe(true);
    expect(session.frames.findIndex((entry) => entry.t === "audit.key")).toBeLessThan(session.frames.findIndex((entry) => entry.t === "link.context"));
    // La lecture s'est faite sous le tenant du runtime, pas en global.
    const lookup = session.shared.statements.findIndex((entry) => entry.sql.includes("from organizations o"));
    expect(lookup).toBeGreaterThan(0);
    expect(session.shared.statements[lookup - 1]!.sql).toContain("app.organization_id");
    expect(JSON.stringify(frame)).not.toContain("linkToken");
    expect(session.shared.logs.some((entry) => entry.event === "runtime_link.context_sent" && entry.fields.runtimeId === LINK_RUNTIME_ID)).toBe(true);
  });

  test("sans owner : le palier par défaut (dev) et l'organisation partent, sans owner", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null, organizationOwner: null });
    const frame = await session.waitFrame((entry) => entry.t === "link.context");
    if (frame.t !== "link.context") throw new Error("unreachable");
    expect(frame.environment).toBe("dev");
    expect(frame.organization?.name).toBe("Acme");
    expect(frame.owner).toBeUndefined();
  });
});

describe("borne des features annoncée à l'hôte", () => {
  const names = (count: number) => Array.from({ length: count }, (_, index) => `feature_${index + 1}`);

  async function announcedFeatures(session: Awaited<ReturnType<typeof openLinkSession>>): Promise<string[]> {
    await session.waitLiveness((entry) => entry.write === "connected");
    for (let attempt = 0; attempt < 200; attempt++) {
      const entry = session.shared.logs.find((log) => log.event === "runtime_link.connected");
      if (entry) return entry.fields.features as string[];
      await Bun.sleep(5);
    }
    throw new Error("runtime_link.connected was not logged");
  }

  test("link.context annonce la borne que l'API applique à hello et à capabilities", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null });
    const frame = await session.waitFrame((entry) => entry.t === "link.context");
    if (frame.t !== "link.context") throw new Error("unreachable");
    expect(frame.limits).toEqual({ features: RELAY_MAX_FEATURES });
    expect(RELAY_MAX_FEATURES).toBe(64);
  });

  test("un hello de 16, 17 ou 64 noms est admis : au-delà de 16, le lien ne se ferme plus", async () => {
    for (const count of [16, 17, 64]) {
      const session = await openLinkSession({ registeredDeviceKey: null, features: names(count) });
      expect(await announcedFeatures(session)).toEqual(names(count));
      expect(session.shared.broker.connected(LINK_RUNTIME_ID)).toBe(true);
    }
  });

  test("un hello de 65 noms est refusé 4401 avant toute liaison", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null, features: names(65) });
    expect(await session.waitClose()).toBe(RELAY_CLOSE_UNAUTHORIZED);
    expect(session.shared.broker.connected(LINK_RUNTIME_ID)).toBe(false);
    expect(session.shared.liveness.some((entry) => entry.write === "connected")).toBe(false);
  });

  test("capabilities accepte 64 noms sur le lien lié ; la 65e entrée est ignorée sans fermer le lien", async () => {
    const session = await openLinkSession({ registeredDeviceKey: null, features: names(2) });
    await session.waitFrame((entry) => entry.t === "link.context");
    const pongs = () => session.frames.filter((entry) => entry.t === "pong").length;
    const ignored = () => session.shared.logs.filter((log) => log.event === "runtime_link.frame_ignored").length;
    // Le pong prouve que la trame précédente a été traitée : le serveur lit dans l'ordre.
    session.send({ t: "capabilities", features: names(64) });
    session.send({ t: "ping" });
    await session.waitFrame(() => pongs() >= 1);
    expect(ignored()).toBe(0);
    session.send({ t: "capabilities", features: names(65) });
    session.send({ t: "ping" });
    await session.waitFrame(() => pongs() >= 2);
    expect(ignored()).toBe(1);
    expect(session.shared.broker.connected(LINK_RUNTIME_ID)).toBe(true);
  });
});
