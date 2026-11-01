import { describe, expect, test } from "bun:test";
import { HermesClient } from "../../src";
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
    await client.mcpOauthStart("linear", "https://ohb.example/cb");
    expect(sent).toEqual([{ path: "/hermes-setup/mcp/servers/linear/oauth", method: "POST", kind: "mutation", body: JSON.stringify({ redirectUri: "https://ohb.example/cb" }) }]);
  });

  test("avec un profil, l'autorisation est demandée pour ce profil nommé", async () => {
    const { client, sent } = clientFor();
    const started = await client.mcpOauthStart("linear", "https://ohb.example/cb", "dev");
    expect(started.status).toBe("pending");
    expect(JSON.parse(sent[0]!.body!)).toEqual({ redirectUri: "https://ohb.example/cb", profile: "dev" });
  });
});
