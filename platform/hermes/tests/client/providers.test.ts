import { describe, expect, test } from "bun:test";
import { HermesClient, HermesClientError, type HermesProviderUsageDocument } from "../../src/index";
import type { HermesRequestKind, HermesTransport } from "../../src/transport/types";

/**
 * Les routes hôte de `HermesClient` : la sonde de capacités et les quatre
 * méthodes fournisseur : face à un transport factice : chemin EXACT du
 * contrat (docs/CONNECTOR.md, « Routes hôte »), toujours à la racine,
 * méthode, corps, absorption du 409 `OAUTH_IN_PROGRESS`, refus tel quel du 409
 * `CREDENTIAL_IN_PROGRESS`, et traduction des erreurs `{error:{code,message}}`
 * en `HermesClientError(message, status, code)`.
 */

type Sent = { path: string; method: string; body: string | null; kind: HermesRequestKind; headers: Record<string, string> };

function fakeTransport(respond: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const transport: HermesTransport = {
    kind: "relay",
    async send(path, init, kind) {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const entry: Sent = {
        path,
        method: (init.method ?? "GET").toUpperCase(),
        body: typeof init.body === "string" ? init.body : null,
        kind,
        headers,
      };
      sent.push(entry);
      return respond(entry);
    },
  };
  return { client: new HermesClient({ transport }), sent };
}

async function failure(promise: Promise<unknown>): Promise<HermesClientError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HermesClientError);
  return error as HermesClientError;
}

const session = {
  sessionId: "s-1",
  provider: "openai-codex",
  status: "pending",
  verificationUri: "https://auth.example/device",
  userCode: "ABCD-EFGH",
  error: null,
  expiresAt: "2026-09-02T10:15:00Z",
};

describe("HermesClient: routes fournisseur par le lien", () => {
  test("providerCredentialAdd : POST …/credentials, corps {apiKey,label}, mutation, verdict de l'hôte", async () => {
    const { client, sent } = fakeTransport(() =>
      Response.json({ provider: "anthropic", label: "openedbot-1", verification: "confirmed", detail: null }));
    const result = await client.providerCredentialAdd("anthropic", "sk-ant-secret", "openedbot-1");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("/hermes-setup/providers/anthropic/credentials");
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.kind).toBe("mutation");
    expect(sent[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(sent[0]!.body!)).toEqual({ apiKey: "sk-ant-secret", label: "openedbot-1" });
    expect(result).toEqual({ provider: "anthropic", label: "openedbot-1", verification: "confirmed", detail: null });
  });

  test("providerCredentialAdd : sans label, le corps ne porte que la clé ; le slug est encodé", async () => {
    const { client, sent } = fakeTransport(() =>
      Response.json({ provider: "x", label: "auto", verification: "unverified", detail: "catalogue muet" }));
    const result = await client.providerCredentialAdd("open ai/x", "key");
    expect(sent[0]!.path).toBe("/hermes-setup/providers/open%20ai%2Fx/credentials");
    expect(JSON.parse(sent[0]!.body!)).toEqual({ apiKey: "key" });
    expect(result.verification).toBe("unverified");
    expect(result.detail).toBe("catalogue muet");
  });

  test("providerCredentialAdd : une clé refusée par l'hôte devient une erreur 400 API_KEY_INVALID, message de l'hôte", async () => {
    const { client } = fakeTransport(() =>
      Response.json({ error: { code: "API_KEY_INVALID", message: "La clé ne passe pas la vérification." } }, { status: 400 }));
    const error = await failure(client.providerCredentialAdd("anthropic", "bad"));
    expect(error.status).toBe(400);
    expect(error.code).toBe("API_KEY_INVALID");
    expect(error.message).toBe("La clé ne passe pas la vérification.");
    expect(error.requestDelivery).toBe("response_received");
  });

  test("providerCredentialAdd : un dépôt déjà en cours devient une erreur 409 CREDENTIAL_IN_PROGRESS, pas d'absorption", async () => {
    const { client } = fakeTransport(() =>
      Response.json({ error: { code: "CREDENTIAL_IN_PROGRESS", message: "Un ajout est déjà en cours." } }, { status: 409 }));
    const error = await failure(client.providerCredentialAdd("anthropic", "key"));
    expect(error.status).toBe(409);
    expect(error.code).toBe("CREDENTIAL_IN_PROGRESS");
    expect(error.message).toBe("Un ajout est déjà en cours.");
    expect(error.requestDelivery).toBe("response_received");
  });

  test("providerCredentialAdd : une réponse 200 d'une autre forme est refusée sans `as` aveugle", async () => {
    const { client } = fakeTransport(() => Response.json({ provider: "anthropic", verification: "maybe" }));
    const error = await failure(client.providerCredentialAdd("anthropic", "key"));
    expect(error.code).toBe("HERMES_RESPONSE_INVALID");
  });

  test("providerOauthStart : POST …/oauth, corps {}, rend la session", async () => {
    const { client, sent } = fakeTransport(() => Response.json(session));
    const started = await client.providerOauthStart("openai-codex");
    expect(sent[0]!.path).toBe("/hermes-setup/providers/openai-codex/oauth");
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.kind).toBe("mutation");
    expect(sent[0]!.body).toBe("{}");
    expect(started).toEqual({ ...session, status: "pending" });
  });

  test("providerOauthStart : 409 OAUTH_IN_PROGRESS rend la session jointe, pas une erreur", async () => {
    const { client } = fakeTransport(() =>
      Response.json(
        { error: { code: "OAUTH_IN_PROGRESS", message: "déjà en cours" }, session: { ...session, status: "starting" } },
        { status: 409 },
      ));
    const started = await client.providerOauthStart("openai-codex");
    expect(started.sessionId).toBe("s-1");
    expect(started.status).toBe("starting");
  });

  test("providerOauthStart : un 409 sans session jointe reste une erreur", async () => {
    const { client } = fakeTransport(() =>
      Response.json({ error: { code: "OAUTH_IN_PROGRESS", message: "déjà en cours" } }, { status: 409 }));
    const error = await failure(client.providerOauthStart("openai-codex"));
    expect(error.status).toBe(409);
    expect(error.code).toBe("OAUTH_IN_PROGRESS");
  });

  test("providerOauthPoll : GET …/oauth/{session}, lecture sûre, session validée", async () => {
    const { client, sent } = fakeTransport(() => Response.json({ ...session, status: "connected", userCode: null }));
    const polled = await client.providerOauthPoll("openai-codex", "s-1");
    expect(sent[0]!.path).toBe("/hermes-setup/providers/openai-codex/oauth/s-1");
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.kind).toBe("safe");
    expect(sent[0]!.body).toBeNull();
    expect(polled.status).toBe("connected");
  });

  test("providerOauthPoll : 404 OAUTH_SESSION_NOT_FOUND garde statut et code", async () => {
    const { client } = fakeTransport(() =>
      Response.json({ error: { code: "OAUTH_SESSION_NOT_FOUND", message: "Session inconnue." } }, { status: 404 }));
    const error = await failure(client.providerOauthPoll("openai-codex", "gone"));
    expect(error.status).toBe(404);
    expect(error.code).toBe("OAUTH_SESSION_NOT_FOUND");
    expect(error.message).toBe("Session inconnue.");
  });

  test("providerOauthPoll : un statut hors contrat est refusé", async () => {
    const { client } = fakeTransport(() => Response.json({ ...session, status: "done" }));
    const error = await failure(client.providerOauthPoll("openai-codex", "s-1"));
    expect(error.code).toBe("HERMES_RESPONSE_INVALID");
  });

  test("providerOauthCancel : DELETE …/oauth/{session}, 204 → void", async () => {
    const { client, sent } = fakeTransport(() => new Response(null, { status: 204 }));
    await expect(client.providerOauthCancel("anthropic", "s-1")).resolves.toBeUndefined();
    expect(sent[0]!.path).toBe("/hermes-setup/providers/anthropic/oauth/s-1");
    expect(sent[0]!.method).toBe("DELETE");
    expect(sent[0]!.kind).toBe("mutation");
  });

  test("un code hors contrat garde le statut de l'hôte mais retombe sur HERMES_RESPONSE_INVALID", async () => {
    const { client } = fakeTransport(() =>
      Response.json({ error: { code: "SOMETHING_NEW", message: "Nouveau refus." } }, { status: 400 }));
    const error = await failure(client.providerCredentialAdd("anthropic", "key"));
    expect(error.status).toBe(400);
    expect(error.code).toBe("HERMES_RESPONSE_INVALID");
    expect(error.message).toBe("Nouveau refus.");
  });

  test("un corps d'erreur illisible ne fait remonter aucun extrait upstream", async () => {
    const { client } = fakeTransport(() => new Response("<html>secret-ish</html>", { status: 502 }));
    const error = await failure(client.providerCredentialAdd("anthropic", "key"));
    expect(error.status).toBe(502);
    expect(error.message).not.toContain("secret-ish");
  });

  test("les routes hôte partent à la RACINE, sans préfixe de profil : un credential vaut pour tout le runtime", async () => {
    const paths: string[] = [];
    const transport: HermesTransport = {
      kind: "relay",
      async send(path, init) {
        paths.push(path);
        const method = (init.method ?? "GET").toUpperCase();
        if (method === "DELETE") return new Response(null, { status: 204 });
        if (path.endsWith("/capabilities")) return Response.json({ features: ["provider_management"] });
        if (path.endsWith("/credentials")) {
          return Response.json({ provider: "anthropic", label: "l", verification: "confirmed", detail: null });
        }
        return Response.json(session);
      },
    };
    const client = new HermesClient({ transport, profile: "prod-1" });
    await client.hostCapabilities();
    await client.providerCredentialAdd("anthropic", "key");
    await client.providerOauthStart("anthropic");
    await client.providerOauthPoll("anthropic", "s-1");
    await client.providerOauthCancel("anthropic", "s-1");
    expect(paths).toEqual([
      "/hermes-setup/capabilities",
      "/hermes-setup/providers/anthropic/credentials",
      "/hermes-setup/providers/anthropic/oauth",
      "/hermes-setup/providers/anthropic/oauth/s-1",
      "/hermes-setup/providers/anthropic/oauth/s-1",
    ]);
    // Les routes gateway, elles, gardent le préfixe.
    const gateway: HermesTransport = {
      kind: "relay",
      async send(path) {
        expect(path).toBe("/p/prod-1/api/model/options");
        return Response.json({ provider: null, model: null, providers: [] });
      },
    };
    await new HermesClient({ transport: gateway, profile: "prod-1" }).modelOptions();
  });

  test("le catalogue du profil par défaut se lit à la racine, même depuis un profil", async () => {
    const paths: string[] = [];
    const gateway: HermesTransport = {
      kind: "relay",
      async send(path) {
        paths.push(path);
        return Response.json({ provider: "anthropic", model: "claude-opus-5-5", providers: [] });
      },
    };
    await expect(new HermesClient({ transport: gateway, profile: "prod-1" }).defaultProfileModelOptions())
      .resolves.toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
    await new HermesClient({ transport: gateway }).defaultProfileModelOptions();
    expect(paths).toEqual(["/api/model/options", "/api/model/options"]);
  });
});

describe("HermesClient.hostCapabilities: GET /hermes-setup/capabilities", () => {
  test("200 {features:[…]} : GET, lecture sûre, rend le tableau tel quel", async () => {
    const { client, sent } = fakeTransport(() => Response.json({ features: ["provider_management", "future_thing"] }));
    await expect(client.hostCapabilities()).resolves.toEqual(["provider_management", "future_thing"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("/hermes-setup/capabilities");
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.kind).toBe("safe");
    expect(sent[0]!.body).toBeNull();
  });

  test("un tableau vide est un tableau vide, pas null", async () => {
    const { client } = fakeTransport(() => Response.json({ features: [] }));
    await expect(client.hostCapabilities()).resolves.toEqual([]);
  });

  test("404 : l'hôte n'a pas d'opérateur (Caddy sans route, ancien hermes-setup) → null", async () => {
    const { client } = fakeTransport(() => new Response("<html>not found</html>", { status: 404 }));
    await expect(client.hostCapabilities()).resolves.toBeNull();
  });

  test("par le lien, HERMES_OPERATOR_UNAVAILABLE et HERMES_LINK_PATH_FORBIDDEN valent « je ne l'ai pas » → null", async () => {
    for (const code of ["HERMES_OPERATOR_UNAVAILABLE", "HERMES_LINK_PATH_FORBIDDEN"] as const) {
      const { client } = fakeTransport(() => {
        throw new HermesClientError("refus du lien", code === "HERMES_LINK_PATH_FORBIDDEN" ? 403 : 503, code, {
          requestDelivery: "not_sent",
        });
      });
      await expect(client.hostCapabilities()).resolves.toBeNull();
    }
  });

  test("toute autre erreur remonte : 502 de l'hôte, lien coupé", async () => {
    const bad = fakeTransport(() => Response.json({ error: { code: "RUNTIME_CATALOGUE_UNREADABLE", message: "x" } }, { status: 502 }));
    const error = await failure(bad.client.hostCapabilities());
    expect(error.status).toBe(502);
    expect(error.code).toBe("RUNTIME_CATALOGUE_UNREADABLE");

    const cut = fakeTransport(() => {
      throw new HermesClientError("lien coupé", 503, "HERMES_UNREACHABLE", { requestDelivery: "not_sent" });
    });
    expect((await failure(cut.client.hostCapabilities())).code).toBe("HERMES_UNREACHABLE");
  });

  test("un corps hors contrat est refusé : features absent, non-chaîne ou hors grammaire", async () => {
    for (const body of [{}, { features: "provider_management" }, { features: [1] }, { features: ["Bad-Feature"] }]) {
      const { client } = fakeTransport(() => Response.json(body));
      expect((await failure(client.hostCapabilities())).code).toBe("HERMES_RESPONSE_INVALID");
    }
  });
});

describe("HermesClient.hostCapabilities : borne des features", () => {
  const names = (count: number) => Array.from({ length: count }, (_, index) => `feature_${index + 1}`);

  test("un opérateur qui annonce plus de 16 features reste lisible : même borne que hello (64)", async () => {
    for (const count of [16, 17, 64]) {
      const { client } = fakeTransport(() => Response.json({ features: names(count) }));
      await expect(client.hostCapabilities()).resolves.toHaveLength(count);
    }
    const { client } = fakeTransport(() => Response.json({ features: names(65) }));
    expect((await failure(client.hostCapabilities())).code).toBe("HERMES_RESPONSE_INVALID");
  });
});

describe("HermesClient.hostProviderSdks : GET /hermes-setup/provider-sdks", () => {
  const body = {
    providers: [
      { provider: "anthropic", label: "Anthropic", extra: "anthropic", installed: true, installable: true },
      { provider: "bedrock", label: "AWS Bedrock", extra: "bedrock", installed: false, installable: false },
    ],
  };

  test("200 : GET, lecture sûre, rend la liste telle quelle", async () => {
    const { client, sent } = fakeTransport(() => Response.json(body));
    await expect(client.hostProviderSdks()).resolves.toEqual(body.providers);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("/hermes-setup/provider-sdks");
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.kind).toBe("safe");
    expect(sent[0]!.body).toBeNull();
  });

  test("503 de la sonde hôte : l'erreur remonte, l'appelant choisit son repli", async () => {
    const { client } = fakeTransport(() => Response.json({ error: { code: "PROBE_FAILED", message: "x" } }, { status: 503 }));
    expect((await failure(client.hostProviderSdks())).status).toBe(503);
  });

  test("un corps hors contrat est refusé HERMES_RESPONSE_INVALID", async () => {
    const { client } = fakeTransport(() => Response.json({ providers: "anthropic" }));
    expect((await failure(client.hostProviderSdks())).code).toBe("HERMES_RESPONSE_INVALID");
  });
});

describe("HermesClient.providerUsage: GET /hermes-setup/usage", () => {
  const usage: HermesProviderUsageDocument = {
    fetchedAt: "2026-09-02T09:41:12Z",
    providers: [{
      provider: "anthropic",
      source: "oauth_usage_api",
      plan: null,
      windows: [{ label: "Current week", usedPercent: 97, resetAt: "2026-09-04T00:00:00Z", detail: null }],
      details: ["Extra usage: 3.20 / 50.00 USD"],
      unavailableReason: null,
    }],
  };

  test("part à la racine, en GET safe, et valide tous les champs publics", async () => {
    const { client, sent } = fakeTransport(() => Response.json(usage));
    await expect(client.providerUsage()).resolves.toEqual(usage);
    expect(sent).toEqual([expect.objectContaining({ path: "/hermes-setup/usage", method: "GET", kind: "safe", body: null })]);
  });

  test("une clé API facturée à l'usage est un état connu, pas une panne", async () => {
    const metered: HermesProviderUsageDocument = {
      fetchedAt: usage.fetchedAt,
      providers: [{ provider: "anthropic", source: "api_key", plan: null, windows: [], details: [], unavailableReason: null }],
    };
    const { client } = fakeTransport(() => Response.json(metered));
    await expect(client.providerUsage()).resolves.toEqual(metered);
  });

  test("« Actualiser » demande une sonde neuve à l'hôte par cache-control", async () => {
    const { client, sent } = fakeTransport(() => Response.json(usage));
    await expect(client.providerUsage({ refresh: true })).resolves.toEqual(usage);
    expect(sent[0]?.headers["cache-control"]).toBe("no-cache");
  });

  test("refuse un document malformé, une date hors RFC 3339 ou un pourcentage hors borne", async () => {
    const provider = usage.providers[0]!;
    const window = provider.windows[0]!;
    for (const body of [
      {},
      { ...usage, fetchedAt: "today", providers: [] },
      { ...usage, providers: [{ ...provider, windows: [{ ...window, resetAt: "tomorrow" }] }] },
      { ...usage, providers: [{ ...provider, windows: [{ ...window, usedPercent: 101 }] }] },
      { ...usage, providers: Array.from({ length: 33 }, () => provider) },
    ]) {
      const { client } = fakeTransport(() => Response.json(body));
      expect((await failure(client.providerUsage())).code).toBe("HERMES_RESPONSE_INVALID");
    }
  });

  test("préserve les erreurs de sonde normalisées de l'hôte", async () => {
    for (const [status, code] of [[502, "USAGE_PROBE_FAILED"], [504, "USAGE_PROBE_TIMEOUT"]] as const) {
      const { client } = fakeTransport(() => Response.json({ error: { code, message: "probe failed" } }, { status }));
      const error = await failure(client.providerUsage());
      expect(error.status).toBe(status);
      expect(error.code).toBe(code);
    }
  });
});
