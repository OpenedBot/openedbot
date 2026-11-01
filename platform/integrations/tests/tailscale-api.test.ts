import { describe, expect, test } from "bun:test";
import {
  createTailscaleApiClient,
  policyWithFunnelTag,
  tailnetDomainFromDevices,
  TailscaleApiError,
} from "../src/tailscale-api";

type Call = { method: string; url: string; body: string | null; authorization: string | null; ifMatch: string | null; accept: string | null };

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = {
      method: init?.method ?? "GET", url: String(input), body: init?.body ? String(init.body) : null,
      authorization: headers.get("authorization"), ifMatch: headers.get("if-match"), accept: headers.get("accept"),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const credentials = { clientId: "ohb-client-id", clientSecret: "ohb-client-secret" };

describe("OHB-75 Tailscale API client", () => {
  test("échange le client OAuth une seule fois, porte le jeton, et ne le laisse fuir ni en URL ni en erreur", async () => {
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.url.endsWith("/oauth/token")) return Response.json({ access_token: "tskey-access-1", expires_in: 3600 });
      if (call.url.endsWith("/acl")) return Response.json({ acls: [] }, { headers: { etag: "etag-7" } });
      if (call.url.endsWith("/keys")) return Response.json({ id: "key-1", key: "tskey-auth-1" });
      return Response.json({ message: "forbidden" }, { status: 403 });
    });
    const client = createTailscaleApiClient(credentials, { fetch: fetchImpl });

    expect(await client.readPolicy()).toEqual({ policy: { acls: [] }, etag: "etag-7" });
    expect(await client.createAuthKey({ tag: "tag:ohb-hermes", description: "d", expirySeconds: 60 })).toEqual({ id: "key-1", key: "tskey-auth-1" });

    // Un seul échange OAuth pour toute la passe, puis le jeton en en-tête.
    expect(calls.filter((call) => call.url.endsWith("/oauth/token"))).toHaveLength(1);
    expect(calls.slice(1).every((call) => call.authorization === "Bearer tskey-access-1")).toBe(true);
    expect(calls.every((call) => !call.url.includes("ohb-client-secret"))).toBe(true);
    // Le fichier de politique est demandé en JSON : le HuJSON par défaut serait illisible.
    expect(calls[1]?.accept).toBe("application/json");

    let caught: unknown;
    try { await client.listDevices(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(TailscaleApiError);
    expect((caught as TailscaleApiError).code).toBe("TAILSCALE_CREDENTIALS_REJECTED");
    expect(String(caught)).not.toContain("ohb-client-secret");
    expect(String(caught)).not.toContain("forbidden");
  });

  test("écrit la politique sous son ETag, traduit un 412 en conflit et tolère une ressource déjà absente", async () => {
    const { calls, fetchImpl } = fakeFetch((call) => {
      if (call.url.endsWith("/oauth/token")) return Response.json({ access_token: "tskey-access-1" });
      if (call.method === "DELETE") return Response.json({ message: "gone" }, { status: 404 });
      return Response.json({ message: "precondition failed" }, { status: 412 });
    });
    const client = createTailscaleApiClient(credentials, { fetch: fetchImpl });

    await client.deleteAuthKey("key-1");
    await client.deleteDevice("dev-1");

    let caught: unknown;
    try { await client.writePolicy({ acls: [] }, "etag-7"); } catch (error) { caught = error; }
    expect((caught as TailscaleApiError).code).toBe("TAILSCALE_CONFLICT");
    expect(calls.at(-1)?.ifMatch).toBe("etag-7");
  });

  test("un client OAuth refusé ne rend aucun jeton", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ error: "invalid_client" }, { status: 401 }));
    const client = createTailscaleApiClient(credentials, { fetch: fetchImpl });
    let caught: unknown;
    try { await client.listDevices(); } catch (error) { caught = error; }
    expect((caught as TailscaleApiError).code).toBe("TAILSCALE_CREDENTIALS_REJECTED");
  });
});

describe("OHB-75 politique Funnel", () => {
  test("ajoute le tag et l’attribut funnel une seule fois, sans toucher au reste", () => {
    const first = policyWithFunnelTag({ acls: [{ action: "accept" }], tagOwners: { "tag:autre": ["autogroup:admin"] } }, "tag:ohb-hermes");
    expect(first.changed).toBe(true);
    expect(first.policy).toEqual({
      acls: [{ action: "accept" }],
      tagOwners: { "tag:autre": ["autogroup:admin"], "tag:ohb-hermes": ["autogroup:admin"] },
      nodeAttrs: [{ target: ["tag:ohb-hermes"], attr: ["funnel"] }],
    });
    // Rejouer ne réécrit rien : le fichier d'un client ne bouge que si nécessaire.
    expect(policyWithFunnelTag(first.policy, "tag:ohb-hermes").changed).toBe(false);
  });

  test("respecte la casse déjà présente dans le fichier", () => {
    const revised = policyWithFunnelTag({ TagOwners: {}, NodeAttrs: [] }, "tag:ohb-hermes");
    expect(Object.keys(revised.policy).sort()).toEqual(["NodeAttrs", "TagOwners"]);
    expect(revised.policy.TagOwners).toEqual({ "tag:ohb-hermes": ["autogroup:admin"] });
  });

  test("le domaine du tailnet se lit sur une machine connectée, et nulle part ailleurs", () => {
    expect(tailnetDomainFromDevices([{ id: "1", name: "Laptop.tail1234.ts.net", hostname: "laptop", tags: [] }])).toBe("tail1234.ts.net");
    expect(tailnetDomainFromDevices([])).toBeNull();
    expect(tailnetDomainFromDevices([{ id: "1", name: "laptop", hostname: "laptop", tags: [] }])).toBeNull();
  });
});
