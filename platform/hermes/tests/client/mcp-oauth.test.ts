import { describe, expect, test } from "bun:test";
import { HermesClient, HermesMcpOauthConflictError } from "../../src";
import type { HermesRequestKind, HermesTransport } from "../../src/transport/types";

type Sent = { path: string; method: string; kind: HermesRequestKind; body?: string };

const session = {
  sessionId: "s1", server: "linear", status: "pending", authorizationUrl: "https://mcp.linear.app/authorize?state=p",
  error: null, errorCode: null, discoveredTools: [], expiresAt: "2026-10-31T12:00:00Z",
};

function clientFor() {
  const sent: Sent[] = [];
  const transport: HermesTransport = {
    kind: "relay",
    async send(path, init, kind) {
      sent.push({ path, method: (init.method ?? "GET").toUpperCase(), kind, body: typeof init.body === "string" ? init.body : undefined });
      return Response.json(session);
    },
  };
  return { client: new HermesClient({ transport }), sent };
}

describe("mcpOauthStart", () => {
  test("sans profil, le corps reste celui d'un hôte ancien : l'URL de retour seule", async () => {
    const { client, sent } = clientFor();
    await client.mcpOauthStart("linear", "https://openedbot.example/cb");
    expect(sent).toEqual([{ path: "/hermes-setup/mcp/servers/linear/oauth", method: "POST", kind: "mutation", body: JSON.stringify({ redirectUri: "https://openedbot.example/cb" }) }]);
  });

  test("avec un profil, l'autorisation est demandée pour ce profil nommé", async () => {
    const { client, sent } = clientFor();
    const started = await client.mcpOauthStart("linear", "https://openedbot.example/cb", "dev");
    expect(started.status).toBe("pending");
    expect(JSON.parse(sent[0]!.body!)).toEqual({ redirectUri: "https://openedbot.example/cb", profile: "dev" });
  });
});

function conflictClient(pending: Record<string, unknown>) {
  const transport: HermesTransport = {
    kind: "relay",
    async send() {
      return Response.json(
        { error: { code: "MCP_OAUTH_IN_PROGRESS", message: "an authorization is already pending for linear" }, session: pending },
        { status: 409 },
      );
    },
  };
  return new HermesClient({ transport });
}

describe("mcpOauthStart : une autorisation déjà en cours pour ce serveur", () => {
  test("la session en cours du MÊME profil est reprise", async () => {
    const started = await conflictClient({ ...session, profile: "dev" }).mcpOauthStart("linear", "https://openedbot.example/cb", "dev");
    expect(started).toMatchObject({ sessionId: "s1", profile: "dev" });
  });

  test("la racine reprend la sienne, dite par un profil null", async () => {
    const started = await conflictClient({ ...session, profile: null }).mcpOauthStart("linear", "https://openedbot.example/cb");
    expect(started).toMatchObject({ sessionId: "s1", profile: null });
  });

  test("celle d'un AUTRE profil n'est jamais rendue comme la session demandée", async () => {
    const attempt = conflictClient({ ...session, profile: "alpha" }).mcpOauthStart("linear", "https://openedbot.example/cb", "beta");
    await expect(attempt).rejects.toBeInstanceOf(HermesMcpOauthConflictError);
    await expect(attempt).rejects.toMatchObject({ code: "MCP_OAUTH_IN_PROGRESS", status: 409, pendingSessionId: "s1" });
  });

  test("un hôte ancien, qui ne nomme pas le profil : conflit, ni pour un bot ni pour la racine", async () => {
    await expect(conflictClient(session).mcpOauthStart("linear", "https://openedbot.example/cb", "beta"))
      .rejects.toBeInstanceOf(HermesMcpOauthConflictError);
    await expect(conflictClient(session).mcpOauthStart("linear", "https://openedbot.example/cb"))
      .rejects.toBeInstanceOf(HermesMcpOauthConflictError);
  });

  test("un profil illisible dans la session est une réponse invalide", async () => {
    await expect(conflictClient({ ...session, profile: "../root" }).mcpOauthStart("linear", "https://openedbot.example/cb", "beta"))
      .rejects.toMatchObject({ code: "HERMES_RESPONSE_INVALID" });
  });
});

describe("callbackReceived", () => {
  test("rendu tel que l'hôte le dit, absent d'un hôte ancien, refusé s'il n'est pas booléen", async () => {
    expect(await conflictClient({ ...session, profile: "dev", callbackReceived: true }).mcpOauthStart("linear", "https://openedbot.example/cb", "dev"))
      .toMatchObject({ callbackReceived: true });
    expect("callbackReceived" in await conflictClient({ ...session, profile: "dev" }).mcpOauthStart("linear", "https://openedbot.example/cb", "dev")).toBe(false);
    await expect(conflictClient({ ...session, profile: "dev", callbackReceived: "yes" }).mcpOauthStart("linear", "https://openedbot.example/cb", "dev"))
      .rejects.toMatchObject({ code: "HERMES_RESPONSE_INVALID" });
  });
});
