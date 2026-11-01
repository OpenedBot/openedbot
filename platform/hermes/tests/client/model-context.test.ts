import { expect, test } from "bun:test";
import { HermesClient, HermesClientError } from "../../src/index";
import { matchRelayRoute } from "@openedbot/contracts-connector";
import type { HermesRequestKind, HermesTransport } from "../../src/transport/types";

/**
 * `GET /hermes-setup/model-context` : la seule route qui dise la fenêtre de
 * contexte d'un runtime. Le gateway ne la publie nulle part, donc ce que
 * l'hôte répond ici est la seule mesure ; tout ce qui n'est pas un compte de
 * jetons plausible doit ressortir à zéro, c'est-à-dire « inconnue ».
 */

type Sent = { path: string; method: string; kind: HermesRequestKind };

function fakeTransport(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const transport: HermesTransport = {
    kind: "relay",
    async send(path, init, kind) {
      const entry: Sent = { path, method: (init.method ?? "GET").toUpperCase(), kind };
      sent.push(entry);
      return respond(entry);
    },
  };
  return { client: new HermesClient({ transport }), sent };
}

const document = {
  model: "claude-sonnet-5",
  provider: "anthropic",
  autoContextLength: 200_000,
  configContextLength: 0,
  effectiveContextLength: 200_000,
  maxOutputTokens: 64_000,
};

test("la route est celle du contrat, à la racine, en lecture", async () => {
  const { client, sent } = fakeTransport(() => Response.json(document));
  const result = await client.modelContext();
  expect(sent[0]).toEqual({ path: "/hermes-setup/model-context", method: "GET", kind: "safe" });
  expect(result.effectiveContextLength).toBe(200_000);
  expect(result.model).toBe("claude-sonnet-5");
  expect(result.profile).toBeNull();
});

// Un bot est un profil : la fenêtre demandée est celle de SON modèle, pas
// celle du profil par défaut de l'hôte.
test("le profil voyage en paramètre de requête, échappé", async () => {
  const { client, sent } = fakeTransport(() => Response.json({ ...document, profile: "atlas" }));
  const result = await client.modelContext({ profile: "atlas" });
  expect(sent[0]!.path).toBe("/hermes-setup/model-context?profile=atlas");
  expect(result.profile).toBe("atlas");
});

test("un plafond aberrant se lit comme inconnu, jamais comme un plafond", async () => {
  const { client } = fakeTransport(() =>
    Response.json({ ...document, autoContextLength: 60_000_000_000, effectiveContextLength: -1 }));
  const result = await client.modelContext();
  expect(result.autoContextLength).toBe(0);
  expect(result.effectiveContextLength).toBe(0);
});

test("un champ manquant vaut zéro, jamais NaN", async () => {
  const { client } = fakeTransport(() => Response.json({ model: "m", provider: "p" }));
  const result = await client.modelContext();
  expect(result).toEqual({
    profile: null,
    model: "m",
    provider: "p",
    autoContextLength: 0,
    configContextLength: 0,
    effectiveContextLength: 0,
    maxOutputTokens: 0,
    preamble: null,
  });
});

// Le préambule est ce que le gateway ajoute à chaque run, mesuré par l'hôte.
// Il est facultatif : abîmé, il se lit absent et la fenêtre reste lisible.
test("le préambule garde l'ordre fixe, écarte l'inconnu et garde « non mesuré »", async () => {
  const { client } = fakeTransport(() => Response.json({
    ...document,
    preamble: {
      buckets: [
        { key: "mcp", tokens: null, items: [{ name: "linear", tokens: null }] },
        { key: "secrets", tokens: 4, items: [] },
        { key: "identity", tokens: 120, items: [] },
        { key: "identity", tokens: 999, items: [] },
        { key: "tools", tokens: 900, items: [{ name: "", tokens: 2 }, { name: "terminal", tokens: -3 }] },
      ],
    },
  }));
  const result = await client.modelContext();
  expect(result.preamble).toEqual({
    buckets: [
      { key: "identity", tokens: 120, items: [] },
      { key: "tools", tokens: 900, items: [{ name: "terminal", tokens: null }] },
      { key: "mcp", tokens: null, items: [{ name: "linear", tokens: null }] },
    ],
  });
});

test("un préambule qui n'est pas le contrat se lit absent, sans refuser la fenêtre", async () => {
  const { client } = fakeTransport(() => Response.json({ ...document, preamble: "abîmé" }));
  const result = await client.modelContext();
  expect(result.preamble).toBeNull();
  expect(result.effectiveContextLength).toBe(200_000);
});

test("un corps qui n'est pas le contrat est refusé", async () => {
  const { client } = fakeTransport(() => Response.json({ model: 42, provider: "p" }));
  await expect(client.modelContext()).rejects.toBeInstanceOf(HermesClientError);
});

// L'allowlist est la jumelle de `internal/connector/allowlist.go`. La route
// doit y être, et rien d'approchant ne doit y entrer avec elle.
test("l'allowlist du relais porte la route et rien de voisin", () => {
  expect(matchRelayRoute("GET", "/hermes-setup/model-context")?.host).toBe(true);
  expect(matchRelayRoute("GET", "/hermes-setup/model-context?profile=atlas")?.host).toBe(true);
  expect(matchRelayRoute("POST", "/hermes-setup/model-context")).toBeNull();
  expect(matchRelayRoute("GET", "/hermes-setup/model-context/atlas")).toBeNull();
});
