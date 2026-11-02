import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import { encryptSecret, secretEncryptionKey } from "@openedbot/hermes/secrets";
import { HermesClientError } from "@openedbot/hermes";
import type { ApiConfig } from "../src/infrastructure/config";
import { NO_RUNTIME_LINKS, type RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { logger } from "@openedbot/platform-observability";
import {
  draftRuntimeToken,
  prepareDirectAccess,
  publicRuntime,
  publicRuntimeWithBots,
  readRosterBotCount,
  readRuntimeBotCount,
  runtimeBotCount,
  runtimeHealthStatusForError,
  runtimeManagement,
  runtimeRoutes,
  shouldMarkLinkDisconnected,
  type RuntimeProbeClient,
  type RuntimeRow,
} from "../src/routes/runtimes/runtime-routes";
import { readRuntimeSecret, runtimeClientConfig } from "@openedbot/runtimes/application/runtime-access";
import type { RuntimeLinkLocator } from "@openedbot/runtime-link/application/instances";
import type { LinkProbeResult } from "@openedbot/runtime-link/domain/link-probe";

const row: RuntimeRow = {
  id: "runtime-1",
  name: "Hermes local",
  endpoint: "https://hermes.example.test",
  tokenCiphertext: "ciphertext",
  tokenNonce: "nonce",
  tokenTag: "tag",
  tokenKeyId: null,
  reachability: "direct",
  linkConnectedAt: null,
  linkLastSeenAt: null,
  linkFeatures: [],
  linkRotatedAt: null,
  linkLastReplacedAt: null,
  linkHijackSuspectedAt: null,
  selectedProvider: null,
  selectedModel: null,
  reasoningEffort: null,
  capacity: 4,
  lastHealthStatus: "healthy",
  lastHealthError: null,
  lastProbedAt: null,
  isActive: true,
  createdAt: new Date("2026-08-21T00:00:00.000Z"),
  updatedAt: new Date("2026-08-21T00:00:00.000Z"),
};

describe("direct and connector runtime factories", () => {
  const key = secretEncryptionKey(new Uint8Array(32).fill(8));
  const config = { tokenEncryption: { current: key, previous: [] }, hermesEndpointPolicy: { environment: "test" }, hermesMtls: null } as unknown as ApiConfig;
  const encrypted = encryptSecret("direct-test-bearer", key.value);
  const direct = { ...row, tokenCiphertext: encrypted.ciphertext, tokenNonce: encrypted.nonce, tokenTag: encrypted.tag, tokenKeyId: key.id };
  const links: RuntimeLinks = {
    connected: () => true,
    dial: () => () => Promise.reject(new Error("aucune requête attendue")),
    revoke: () => false,
    notifyRotation: () => false,
    close: () => false,
  };

  test("runtimeClientConfig decrypts a direct row and selects its root transport", () => {
    const client = runtimeClientConfig(direct, config, links);
    expect("transport" in client && client.transport.kind).toBe("direct");
    expect(client.profile).toBeNull();
  });

  test("readRuntimeSecret accepts an active direct runtime without locating a link", async () => {
    const tx = (async (strings: TemplateStringsArray) => strings.join(" ").includes("from runtimes") ? [direct] : []) as unknown as SQL;
    (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin = async (callback) => callback(tx as unknown as Bun.TransactionSQL);
    const runtime = await readRuntimeSecret(tx, config, "org-1", links);
    expect(runtime?.client.profile).toBeNull();
    expect(runtime?.linkFeatures).toEqual([]);
  });

  test("les deux fabriques conservent le relais d'une ligne connector", async () => {
    const connector = {
      ...row,
      reachability: "connector" as const,
      endpoint: null,
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
    };
    const directFactoryResult = runtimeClientConfig(connector, config, links);
    expect("transport" in directFactoryResult && directFactoryResult.transport.kind).toBe("relay");

    const tx = (async (strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ? ").replace(/\s+/g, " ").trim();
      return sql.includes("from runtimes") ? [connector] : [];
    }) as unknown as SQL;
    (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin =
      async (callback) => callback(tx as unknown as Bun.TransactionSQL);
    const selected = await readRuntimeSecret(tx, config, "org-1", links);
    expect(selected && "transport" in selected.client && selected.client.transport.kind).toBe("relay");
  });
});

describe("runtime administration mode", () => {
  // OHB-15 : un runtime client n'a plus de canal du tout. La seule forme
  // d'administration restante est celle du Hermes que ce déploiement démarre
  // lui-même, et l'écran doit renvoyer vers le geste client dans tous les
  // autres cas.
  test("un runtime sans canal local est déclaré manuel", () => {
    expect(publicRuntime(row, "disabled").management).toEqual({
      kind: "manual",
      credentialsWritable: false,
      oauthWritable: false,
    });
  });

  test("direct access remains manual even with a legacy local admin mode", () => {
    expect(publicRuntime(row, "local").management).toEqual({ kind: "manual", credentialsWritable: false, oauthWritable: false });
  });

  test("aucune coordonnée SSH n’est publiée sur le fil", () => {
    expect(publicRuntime(row, "local")).not.toHaveProperty("ssh");
    expect(publicRuntime(row, "disabled")).not.toHaveProperty("ssh");
  });
});

describe("mode de jonction sur le fil", () => {
  const connector: RuntimeRow = {
    ...row,
    id: "runtime-2",
    reachability: "connector",
    endpoint: null,
    tokenCiphertext: null,
    tokenNonce: null,
    tokenTag: null,
    linkConnectedAt: new Date("2026-09-01T08:00:00.000Z"),
    linkLastSeenAt: new Date("2026-09-01T08:05:00.000Z"),
  };

  test("un runtime direct garde `transport` en alias et aucun lien", () => {
    const published = publicRuntime(row, "disabled");
    expect(published.reachability).toBe("direct");
    expect(published.transport).toBe("direct");
    expect(published.baseUrl).toBe("https://hermes.example.test");
    expect(published.link).toBeNull();
  });

  test("un runtime connector ne publie aucune URL et décrit son lien", () => {
    const published = publicRuntime(connector, "disabled");
    expect(published.reachability).toBe("connector");
    expect(published.transport).toBe("connector");
    expect(published.baseUrl).toBeNull();
    expect(published.link).toEqual({
      connector: null,
      connected: true,
      generation: null,
      connectedAt: "2026-09-01T08:00:00.000Z",
      lastSeenAt: "2026-09-01T08:05:00.000Z",
      lastReplacedAt: null,
      hijackSuspectedAt: null,
      rotatedAt: null,
      origin: null,
      originRetired: false,
      relinkCommand: null,
    });
  });

  test("un lien fermé se lit sans date de connexion", () => {
    const published = publicRuntime({ ...connector, linkConnectedAt: null, linkLastSeenAt: null }, "disabled");
    expect(published.link).toEqual({
      connector: null,
      connected: false,
      generation: null,
      connectedAt: null,
      lastSeenAt: null,
      lastReplacedAt: null,
      hijackSuspectedAt: null,
      rotatedAt: null,
      origin: null,
      originRetired: false,
      relinkCommand: null,
    });
  });

  test("une origine signée qui n'est plus acceptée se lit comme retirée, avec la commande de réenrôlement", () => {
    const published = publicRuntime(
      { ...connector, linkOrigin: "https://console.openedbot.app" },
      "disabled",
      [],
      {},
      null,
      {
        environment: "production",
        acceptedOrigins: ["https://link.openedbot.app", "https://openedbot.app"],
        relinkCommand: "edge-setup link --ohb https://link.openedbot.app --yes",
      },
    );
    expect(published.link).toMatchObject({
      origin: "https://console.openedbot.app",
      originRetired: true,
      relinkCommand: "edge-setup link --ohb https://link.openedbot.app --yes",
    });
    const current = publicRuntime(
      { ...connector, linkOrigin: "https://link.openedbot.app" },
      "disabled",
      [],
      {},
      null,
      {
        environment: "production",
        acceptedOrigins: ["https://link.openedbot.app", "https://openedbot.app"],
        relinkCommand: "edge-setup link --ohb https://link.openedbot.app --yes",
      },
    );
    expect(current.link).toMatchObject({ originRetired: false, relinkCommand: null });
  });

  test("le hash du jeton de lien ne traverse jamais la ligne publiée", () => {
    const published = publicRuntime(connector, "disabled") as Record<string, unknown>;
    expect(Object.keys(published).some((key) => /token|hash|link_token/i.test(key) && key !== "tokenConfigured")).toBe(false);
  });
});

describe("brouillon de token runtime", () => {
  test("ne prête le token enregistré qu’à son propre endpoint", () => {
    const stored = { endpoint: "https://hermes.example.test", token: "jeton-stocke" };
    expect(draftRuntimeToken("https://ailleurs.example", "", stored)).toBeNull();
    expect(draftRuntimeToken(stored.endpoint, "", stored)).toBe("jeton-stocke");
    expect(draftRuntimeToken("https://ailleurs.example", "saisi", stored)).toBe("saisi");
    expect(draftRuntimeToken("http://10.0.0.10:8642", "", null)).toBeNull();
  });
});

describe("un secret enregistré ne repart que vers son endpoint", () => {
  const key = secretEncryptionKey(new Uint8Array(32).fill(7));
  const config = { tokenEncryption: { current: key, previous: [] }, hermesEndpointPolicy: { environment: "test" }, hermesMtls: null } as unknown as ApiConfig;
  const bearer = encryptSecret("bearer-de-l-organisation", key.value);
  const stored: RuntimeRow = { ...row, endpoint: "https://hermes.example.test",
    tokenCiphertext: bearer.ciphertext, tokenNonce: bearer.nonce, tokenTag: bearer.tag, tokenKeyId: key.id };

  // La fuite mesurée : l'écran omet `token` quand le champ est laissé vide, en
  // n'envoyant que `url`. Sans cette règle, l'API déchiffrait le bearer de
  // l'organisation et l'expédiait à l'hôte indiqué, que tout `admin` invité
  // choisissait librement alors qu'il n'a jamais pu LIRE ce secret.
  test("changer la seule URL n’emporte pas le bearer vers le nouvel hôte", () => {
    expect(() => prepareDirectAccess({ url: "https://collecteur.attaquant.example" }, stored, config))
      .toThrow(/nouvelle/);
    try {
      prepareDirectAccess({ url: "https://collecteur.attaquant.example" }, stored, config);
    } catch (error) {
      expect((error as HttpError).code).toBe("RUNTIME_TOKEN_REQUIRED");
      expect((error as HttpError).status).toBe(400);
    }
  });

  test("le même hôte réutilise son bearer, y compris sous une autre forme d’URL", () => {
    expect(prepareDirectAccess({}, stored, config).endpoint).toBe("https://hermes.example.test");
    // La comparaison est faite après normalisation des deux côtés : une barre
    // finale n'est pas un autre hôte et ne doit pas exiger une ressaisie.
    expect(prepareDirectAccess({ url: "https://hermes.example.test/" }, stored, config).endpoint)
      .toBe("https://hermes.example.test");
  });

  test("un hôte nouveau est accepté dès que son propre bearer accompagne l’URL", () => {
    const moved = prepareDirectAccess({ url: "https://autre.example.test", token: "bearer-du-nouvel-hote" }, stored, config);
    expect(moved.endpoint).toBe("https://autre.example.test");
    // Ce qui est réencodé pour la base est le bearer SAISI, jamais l'ancien.
    expect(moved.encrypted.ciphertext).not.toBe(bearer.ciphertext);
  });

  test("sans runtime enregistré, le bearer reste simplement requis", () => {
    expect(() => prepareDirectAccess({ url: "https://hermes.example.test" }, null, config))
      .toThrow(/bearer Hermes est requis/);
  });
});

describe("état de santé après un test de runtime", () => {
  // Un runtime qui a répondu n'est pas « injoignable » : écrire `unreachable`
  // pour un token refusé ou un contrat d'outils violé envoyait l'opérateur
  // vérifier son réseau au lieu de son token ou de son `config.yaml`.
  test("nomme la panne réellement observée", () => {
    expect(runtimeHealthStatusForError(new HttpError(401, "HERMES_UNAUTHORIZED", "Token refusé.")))
      .toBe("unauthorized");
    expect(runtimeHealthStatusForError(new HttpError(403, "HERMES_FORBIDDEN", "Accès refusé.")))
      .toBe("unauthorized");
    expect(runtimeHealthStatusForError(new HttpError(409, "HERMES_FORBIDDEN_TOOLSETS_ACTIVE", "cronjob")))
      .toBe("missing_feature");
    expect(runtimeHealthStatusForError(new HttpError(409, "HERMES_TOOLSET_INVENTORY_REQUIRED", "inventaire absent")))
      .toBe("missing_feature");
  });

  test("garde `unreachable` pour les vraies pannes de transport", () => {
    expect(runtimeHealthStatusForError(new HttpError(502, "HERMES_UNREACHABLE", "Injoignable.")))
      .toBe("unreachable");
    expect(runtimeHealthStatusForError(new HttpError(500, "HERMES_UPSTREAM_ERROR", "Erreur amont.")))
      .toBe("unreachable");
  });
});

describe("canal d'écriture des credentials fournisseur", () => {
  // Le canal `host` n'existe que si l'hôte l'a DIT : `hello.features` par le
  // lien, `GET /hermes-setup/capabilities` en direct : aucune capacité n'est
  // supposée. Par le lien, un lien fermé garde son `kind` pour que l'écran
  // dise « reconnectez » plutôt que « faites-le à la main ».
  const linked: RuntimeRow = {
    ...row,
    id: "runtime-3",
    reachability: "connector",
    endpoint: null,
    tokenCiphertext: null,
    tokenNonce: null,
    tokenTag: null,
    linkConnectedAt: new Date("2026-09-01T08:00:00.000Z"),
    linkLastSeenAt: new Date("2026-09-01T08:05:00.000Z"),
    linkFeatures: ["provider_management"],
  };

  test("connecteur connecté qui annonce provider_management : écritures par le lien", () => {
    expect(runtimeManagement(linked, "disabled")).toEqual({
      kind: "host",
      credentialsWritable: true,
      oauthWritable: true,
    });
    expect(publicRuntime(linked, "disabled").management.kind).toBe("host");
  });

  test("connecteur sans la capacité : manuel, même lien ouvert", () => {
    expect(runtimeManagement({ ...linked, linkFeatures: [] }, "disabled")).toEqual({
      kind: "manual",
      credentialsWritable: false,
      oauthWritable: false,
    });
    expect(runtimeManagement({ ...linked, linkFeatures: ["event_replay"] }, "disabled").kind).toBe("manual");
  });

  test("connecteur déconnecté : le canal reste nommé, mais rien n'est écrivable", () => {
    expect(runtimeManagement({ ...linked, linkConnectedAt: null }, "disabled")).toEqual({
      kind: "host",
      credentialsWritable: false,
      oauthWritable: false,
    });
  });

  test("une ligne direct historique reste en lecture seule même si elle annonçait provider_management", () => {
    expect(runtimeManagement({ ...row, linkFeatures: ["provider_management"] }, "disabled")).toEqual({
      kind: "manual",
      credentialsWritable: false,
      oauthWritable: false,
    });
    expect(publicRuntime({ ...row, linkFeatures: ["provider_management"] }, "disabled").management.kind).toBe("manual");
  });

  test("direct sans la capacité (404 sur /hermes-setup/capabilities, ancien hôte) : manuel", () => {
    expect(runtimeManagement(row, "disabled")).toEqual({
      kind: "manual",
      credentialsWritable: false,
      oauthWritable: false,
    });
    expect(runtimeManagement({ ...row, linkFeatures: ["event_replay"] }, "disabled").kind).toBe("manual");
  });

  test("le Hermes intégré garde son Dashboard, quelles que soient les capacités", () => {
    expect(runtimeManagement(linked, "local").kind).toBe("hermes_dashboard");
  });
});

/**
 * `POST /test` sur un runtime `direct` : les capacités hôte sont ce que la
 * sonde vient de lire, jamais supposées. Sonde réussie → `link_features`
 * réécrit (le tableau, ou `{}` quand l'hôte a répondu « je ne l'ai pas ») ;
 * sonde en échec → `link_features` intact. Base et client Hermes sont des
 * faux : aucun réseau, aucun secret sur le fil.
 */
describe("POST /test : capacités hôte d'un runtime direct", () => {
  const owner: AuthContext = {
    sessionId: "session-1", organizationId: "org-1", userId: "user-1",
    role: "owner", kind: "web", credentialHash: "credential",
  };
  const key = secretEncryptionKey(new Uint8Array(32).fill(9));
  const config = {
    tokenEncryption: { current: key, previous: [] },
    hermesEndpointPolicy: { environment: "test" },
    hermesMtls: null,
    billingEnforced: false,
  } as unknown as ApiConfig;

  type Call = { sql: string; values: unknown[] };

  function fakeDb(rows: RuntimeRow[], enrollments: Array<{ runtimeId: string | null }> = []): { db: SQL; calls: Call[] } {
    const calls: Call[] = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = [...strings].join(" ? ").replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      if (sql.includes("from runtime_enrollments")) return enrollments;
      if (!sql.includes("from runtimes")) return [];
      const selectedId = values.find((value): value is string => typeof value === "string" && rows.some((candidate) => candidate.id === value));
      return selectedId ? rows.filter((candidate) => candidate.id === selectedId) : rows;
    }) as unknown as SQL;
    (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin =
      async (callback) => callback(tx as unknown as Bun.TransactionSQL);
    return { db: tx, calls };
  }

  function directRow(): RuntimeRow {
    const encrypted = encryptSecret("runtime-bearer-test-only", key.value);
    return {
      ...row,
      endpoint: "https://hermes.example.test",
      tokenCiphertext: encrypted.ciphertext,
      tokenNonce: encrypted.nonce,
      tokenTag: encrypted.tag,
      tokenKeyId: key.id,
    };
  }

  function mount(
    rows: RuntimeRow[],
    client: Partial<RuntimeProbeClient>,
    links: RuntimeLinks = NO_RUNTIME_LINKS,
    locator?: RuntimeLinkLocator,
    enrollments: Array<{ runtimeId: string | null }> = [],
  ) {
    const fake = fakeDb(rows, enrollments);
    const clients: Array<Record<string, unknown>> = [];
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => {
      context.set("auth", owner);
      await next();
    });
    app.onError((error, context) => error instanceof HttpError
      ? context.json({ error: { code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
    app.route("/", runtimeRoutes(fake.db, config, links, {
      locator,
      clientFactory: (clientConfig) => {
        clients.push(clientConfig as unknown as Record<string, unknown>);
        return {
          probe: async () => ({ health: { status: "ok" }, capabilities: { max_concurrent_runs: 2 } }),
          toolsets: async () => [],
          hostCapabilities: async () => {
            throw new Error("hostCapabilities ne devait pas être sondé");
          },
          ...client,
        } as RuntimeProbeClient;
      },
    }));
    return { app, calls: fake.calls, clients };
  }

  const healthWrites = (calls: Call[]) => calls.filter((call) => call.sql.startsWith("update runtimes set last_health_status"));

  test("une ligne direct historique est refusée avant toute sonde", async () => {
    let probed = 0;
    const { app, calls } = mount([directRow()], {
      hostCapabilities: async () => {
        probed += 1;
        return ["provider_management"];
      },
    });
    const response = await app.request("/test", { method: "POST" });
    expect(response.status).toBe(200);
    expect(probed).toBe(0);
    const writes = healthWrites(calls);
    expect(writes).toHaveLength(1);
  });

  test("sonde réussie, hôte sans opérateur (null) : `link_features` reçoit `{}`, pas l'ancien tableau", async () => {
    const { app, calls } = mount([{ ...directRow(), linkFeatures: ["provider_management"] }], {
      hostCapabilities: async () => null,
    });
    expect((await app.request("/test", { method: "POST" })).status).toBe(200);
    const writes = healthWrites(calls);
    expect(writes).toHaveLength(1);
  });

  test("sonde en échec : la santé est écrite, `link_features` n'est pas touché", async () => {
    let probed = 0;
    const { app, calls } = mount([directRow()], {
      probe: async () => {
        throw new HermesClientError("Token refusé.", 401, "HERMES_TOKEN_REJECTED");
      },
      hostCapabilities: async () => {
        probed += 1;
        return ["provider_management"];
      },
    });
    const response = await app.request("/test", { method: "POST" });
    expect(response.status).toBe(200);
    expect(probed).toBe(0);
    const writes = healthWrites(calls);
    expect(writes).toHaveLength(1);
  });

  test("lecture des capacités en échec (opérateur muet derrière Caddy) : sonde verte, `link_features` intact", async () => {
    const { app, calls } = mount([directRow()], {
      hostCapabilities: async () => {
        throw new HermesClientError("Panne amont.", 502, "RUNTIME_CATALOGUE_UNREADABLE");
      },
    });
    expect((await app.request("/test", { method: "POST" })).status).toBe(200);
    const writes = healthWrites(calls);
    expect(writes).toHaveLength(1);
  });

  test("runtime connector : les capacités viennent de hello, la sonde ne les relit pas", async () => {
    const connector: RuntimeRow = {
      ...row,
      reachability: "connector",
      endpoint: null,
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
      linkConnectedAt: new Date("2026-09-01T08:00:00.000Z"),
      linkFeatures: ["provider_management"],
    };
    const links: RuntimeLinks = {
      connected: () => true,
      dial: () => () => Promise.reject(new Error("le faux ne compose pas")),
      revoke: () => false,
      notifyRotation: () => false,
      close: () => false,
    };
    const { app, calls } = mount([connector], {}, links);
    expect((await app.request("/test", { method: "POST" })).status).toBe(200);
    const writes = healthWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.sql).not.toContain("link_features");
  });

  test("lien sur une autre instance vivante : sonde relayée, pas de disconnected", async () => {
    const connector: RuntimeRow = {
      ...row,
      reachability: "connector",
      endpoint: null,
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
      linkLastSeenAt: new Date(),
    };
    const locator: RuntimeLinkLocator = {
      instanceId: "api-a",
      locate: async () => ({ kind: "remote", instanceId: "api-b", internalUrl: "http://10.0.0.2:8790" }),
      forwardProxy: async () => new Response(null, { status: 599 }),
      forwardDial: async () => new Response(null, { status: 599 }),
      forwardRotate: async () => false,
      forwardClose: async () => false,
      forwardYolo: async () => false,
      forwardProbe: async () => ({ outcome: "no_link" }),
    };
    const links: RuntimeLinks = {
      connected: () => false,
      dial: () => async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
      revoke: () => false,
      notifyRotation: () => false,
      close: () => false,
    };
    const { app, calls } = mount([connector], {}, links, locator);
    expect((await app.request("/test", { method: "POST" })).status).toBe(200);
    expect(healthWrites(calls).some((call) => call.values.includes("disconnected"))).toBe(false);
  });

  test("instance morte : 503 instance_dead et écrit disconnected", async () => {
    const connector: RuntimeRow = {
      ...row,
      reachability: "connector",
      endpoint: null,
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
      linkLastSeenAt: new Date(),
    };
    const locator: RuntimeLinkLocator = {
      instanceId: "api-a",
      locate: async () => ({ kind: "unavailable", detail: "instance_dead" }),
      forwardProxy: async () => new Response(null, { status: 599 }),
      forwardDial: async () => new Response(null, { status: 599 }),
      forwardRotate: async () => false,
      forwardClose: async () => false,
      forwardYolo: async () => false,
      forwardProbe: async () => ({ outcome: "no_link" }),
    };
    const { app, calls } = mount([connector], {}, { ...NO_RUNTIME_LINKS }, locator);
    const response = await app.request("/test", { method: "POST" });
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string; detail?: string } };
    expect(body.error.code).toBe("RUNTIME_LINK_UNAVAILABLE");
    expect(body.error.detail).toBe("instance_dead");
    expect(healthWrites(calls).some((call) => call.values.includes("disconnected"))).toBe(true);
  });

  test("no_link avec last_seen frais : 503, pas de disconnected", async () => {
    const connector: RuntimeRow = {
      ...row,
      reachability: "connector",
      endpoint: null,
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
      linkLastSeenAt: new Date(),
    };
    const locator: RuntimeLinkLocator = {
      instanceId: "api-a",
      locate: async () => ({ kind: "unavailable", detail: "no_link" }),
      forwardProxy: async () => new Response(null, { status: 599 }),
      forwardDial: async () => new Response(null, { status: 599 }),
      forwardRotate: async () => false,
      forwardClose: async () => false,
      forwardYolo: async () => false,
      forwardProbe: async () => ({ outcome: "no_link" }),
    };
    const { app, calls } = mount([connector], {}, { ...NO_RUNTIME_LINKS }, locator);
    const response = await app.request("/test", { method: "POST" });
    expect(response.status).toBe(503);
    expect((await response.json() as { error: { detail?: string } }).error.detail).toBe("no_link");
    expect(healthWrites(calls).some((call) => call.values.includes("disconnected"))).toBe(false);
  });

  test("attend le nouveau runtime pendant une relève d'enrôlement", async () => {
    const oldRuntime: RuntimeRow = {
      ...row,
      reachability: "connector",
      endpoint: null,
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
      linkFeatures: ["provider_management"],
      id: "runtime-old",
      updatedAt: new Date("2026-09-01T08:05:00.000Z"),
      linkConnectedAt: new Date("2026-09-01T08:00:00.000Z"),
      linkLastSeenAt: new Date("2026-09-01T08:05:00.000Z"),
    };
    const newRuntime: RuntimeRow = {
      ...oldRuntime,
      id: "runtime-new",
      updatedAt: new Date("2026-09-01T08:06:00.000Z"),
      linkConnectedAt: new Date("2026-09-01T08:06:00.000Z"),
      linkLastSeenAt: new Date("2026-09-01T08:06:00.000Z"),
    };
    const links: RuntimeLinks = {
      connected: (runtimeId) => runtimeId === "runtime-new",
      dial: () => () => Promise.reject(new Error("le faux ne compose pas")),
      revoke: () => false,
      notifyRotation: () => false,
      close: () => false,
    };
    const locator: RuntimeLinkLocator = {
      instanceId: "api-a",
      locate: async () => ({ kind: "unavailable", detail: "no_link" }),
      forwardProxy: async () => new Response(null, { status: 599 }),
      forwardDial: async () => new Response(null, { status: 599 }),
      forwardRotate: async () => false,
      forwardClose: async () => false,
      forwardYolo: async () => false,
      forwardProbe: async () => ({ outcome: "no_link" }),
    };
    const { app } = mount([oldRuntime, newRuntime], {}, links, locator, [{ runtimeId: "runtime-new" }]);
    const response = await app.request("/test", { method: "POST" });
    expect(response.status).toBe(200);
  });

  describe("POST /:runtimeId/link/verify", () => {
    const linked: RuntimeRow = {
      ...row,
      id: "runtime-2",
      reachability: "connector",
      endpoint: null,
      tokenCiphertext: null,
      tokenNonce: null,
      tokenTag: null,
      linkConnectedAt: new Date(),
      linkLastSeenAt: new Date(),
      linkGeneration: "7",
    };
    const probingLinks = (result: LinkProbeResult, seen: Array<string | null>): RuntimeLinks => ({
      connected: () => true,
      dial: () => async () => Response.json({ status: "ok" }),
      revoke: () => false,
      notifyRotation: () => false,
      close: () => false,
      probe: async (_runtimeId, generation) => {
        seen.push(generation);
        return result;
      },
    });

    test("lien vivant : sonde le gateway et n'écrit la santé que sur la génération sondée", async () => {
      const seen: Array<string | null> = [];
      const { app, calls } = mount([linked], {}, probingLinks({ outcome: "alive", generation: "7", rttMs: 42 }, seen));
      const response = await app.request("/runtime-2/link/verify", { method: "POST" });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = await response.json() as { outcome: string; rttMs: number; gateway: { ok: boolean } };
      expect(body).toMatchObject({ outcome: "alive", rttMs: 42, gateway: { ok: true } });
      expect(seen).toEqual(["7"]);
      const writes = healthWrites(calls);
      expect(writes).toHaveLength(1);
      expect(writes[0]!.sql).toContain("link_generation");
      expect(writes[0]!.values).toContain("7");
    });

    test("gateway en panne derrière un lien vivant : verdict nommé, pas d'erreur HTTP", async () => {
      const { app } = mount([linked], {
        probe: async () => {
          throw new HttpError(502, "HERMES_UNAVAILABLE", "Le gateway ne répond pas.");
        },
      }, probingLinks({ outcome: "alive", generation: "7", rttMs: 3 }, []));
      const body = await (await app.request("/runtime-2/link/verify", { method: "POST" })).json() as { gateway: unknown };
      expect(body.gateway).toEqual({ ok: false, code: "HERMES_UNAVAILABLE", message: "Le gateway ne répond pas." });
    });

    test("lien tenu ailleurs et raccroché : la sonde part à l'instance propriétaire, le gateway n'est pas sondé", async () => {
      const forwarded: Array<string | null> = [];
      const locator: RuntimeLinkLocator = {
        instanceId: "api-a",
        locate: async () => ({ kind: "remote", instanceId: "gateway-b", internalUrl: "http://10.0.0.2:8792" }),
        forwardProxy: async () => new Response(null, { status: 599 }),
        forwardDial: async () => new Response(null, { status: 599 }),
        forwardRotate: async () => false,
        forwardClose: async () => false,
        forwardYolo: async () => false,
        forwardProbe: async (_runtimeId, generation) => {
          forwarded.push(generation);
          return { outcome: "reconnect_requested", generation: "7" };
        },
      };
      const { app, clients, calls } = mount([linked], {}, { ...NO_RUNTIME_LINKS }, locator);
      const body = await (await app.request("/runtime-2/link/verify", { method: "POST" })).json() as { outcome: string; generation: string; gateway: unknown };
      expect(body).toMatchObject({ outcome: "reconnect_requested", generation: "7", gateway: null });
      expect(forwarded).toEqual(["7"]);
      expect(clients).toHaveLength(0);
      expect(healthWrites(calls)).toHaveLength(0);
    });

    test("un lien fermé en base ne prétend à aucune génération", async () => {
      const seen: Array<string | null> = [];
      const { app } = mount([{ ...linked, linkConnectedAt: null }], {}, probingLinks({ outcome: "no_link" }, seen));
      const body = await (await app.request("/runtime-2/link/verify", { method: "POST" })).json() as { outcome: string };
      expect(body.outcome).toBe("no_link");
      expect(seen).toEqual([null]);
    });

    test("runtime direct : 409 ; runtime absent (ou d'un autre tenant) : 404", async () => {
      expect((await mount([directRow()], {}).app.request("/runtime-1/link/verify", { method: "POST" })).status).toBe(409);
      expect((await mount([], {}).app.request("/runtime-9/link/verify", { method: "POST" })).status).toBe(404);
    });
  });

  test("aucun secret ne traverse la réponse ni le journal SQL en clair", async () => {
    const { app, calls, clients } = mount([directRow()], { hostCapabilities: async () => [] });
    const body = await (await app.request("/test", { method: "POST" })).text();
    expect(body).not.toContain("runtime-bearer-test-only");
    expect(JSON.stringify(calls)).not.toContain("runtime-bearer-test-only");
    expect(clients).toHaveLength(1);
  });
});

describe("shouldMarkLinkDisconnected", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");

  test("instance_dead conclut disconnected même si last_seen est frais", () => {
    expect(shouldMarkLinkDisconnected("instance_dead", new Date(now - 1_000), now)).toBe(true);
  });

  test("no_link avec last_seen frais ne conclut pas disconnected", () => {
    expect(shouldMarkLinkDisconnected("no_link", new Date(now - 10_000), now)).toBe(false);
  });

  test("no_link avec last_seen vieux ou absent conclut disconnected", () => {
    expect(shouldMarkLinkDisconnected("no_link", new Date(now - 60_000), now)).toBe(true);
    expect(shouldMarkLinkDisconnected("no_link", null, now)).toBe(true);
  });
});

/**
 * Rotation du jeton de lien (0027) et retrait du dernier runtime actif.
 * Base factice : chaque requête est journalisée, la ligne rendue est celle
 * du test ; aucun réseau.
 */
describe("rotation du jeton de lien et retrait confirmé", () => {
  const owner: AuthContext = {
    sessionId: "session-1", organizationId: "org-1", userId: "user-1",
    role: "owner", kind: "web", credentialHash: "credential",
  };
  const config = {
    tokenEncryption: { current: secretEncryptionKey(new Uint8Array(32).fill(9)), previous: [] },
    hermesEndpointPolicy: { environment: "test" },
    hermesMtls: null,
    billingEnforced: false,
  } as unknown as ApiConfig;
  const connector: RuntimeRow = {
    ...row,
    id: "runtime-2",
    reachability: "connector",
    endpoint: null,
    tokenCiphertext: null,
    tokenNonce: null,
    tokenTag: null,
    linkConnectedAt: new Date("2026-09-01T08:00:00.000Z"),
  };
  type Call = { sql: string; values: unknown[] };

  function mount(rows: RuntimeRow[], links: Partial<RuntimeLinks> = {}, role: AuthContext["role"] = "owner", locator?: RuntimeLinkLocator) {
    const calls: Call[] = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = [...strings].join(" ? ").replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      if (sql.includes("from runtimes")) return rows;
      if (sql.startsWith("update runtimes set link_token_previous_hash = link_token_hash")) {
        return [{ id: rows[0]?.id, expiresPreviousAt: new Date("2026-09-02T10:10:00.000Z") }];
      }
      if (sql.startsWith("update runtimes set link_token_previous_hash = null")) {
        return [{ id: rows[0]?.id, expiresPreviousAt: null }];
      }
      return [];
    }) as unknown as SQL;
    (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin =
      async (callback) => callback(tx as unknown as Bun.TransactionSQL);
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => {
      context.set("auth", { ...owner, role });
      await next();
    });
    app.onError((error, context) => error instanceof HttpError
      ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
    app.route("/", runtimeRoutes(tx, config, { ...NO_RUNTIME_LINKS, ...links }, {
      clientFactory: () => { throw new Error("aucune sonde attendue"); },
      ...(locator ? { locator } : {}),
    }));
    return { app, calls };
  }

  // Le journal passe par pino : on capture ce que le logger reçoit, pas stdout.
  const logs: string[] = [];
  const spies = (["info", "error", "warn"] as const).map((level) =>
    spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logs.push(JSON.stringify(args)); }) as never));
  afterEach(() => {
    logs.length = 0;
  });
  // Les espions restent posés pour tout le describe ; ils sont retirés à la fin.
  const restore = () => { for (const spy of spies) spy.mockRestore(); };

  test("POST /:id/link/rotate rend un jeton neuf UNE fois, sans le journaliser ni le mettre en cache", async () => {
    const pushed: Array<{ runtimeId: string; token: string }> = [];
    const { app, calls } = mount([connector], {
      notifyRotation: (runtimeId, frame) => {
        pushed.push({ runtimeId, token: frame.linkToken });
        return true;
      },
    });
    const response = await app.request("/runtime-2/link/rotate", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as { linkToken: string; runtimeId: string; expiresPreviousAt: string; mode: string; pushed: boolean };
    expect(body.runtimeId).toBe("runtime-2");
    expect(body.mode).toBe("maintenance");
    expect(body.pushed).toBe(true);
    expect(body.linkToken.length).toBeGreaterThanOrEqual(32);
    expect(body.expiresPreviousAt).toBe("2026-09-02T10:10:00.000Z");
    // La trame part avec le jeton ; la base ne reçoit que son hash ; le journal ne le voit jamais.
    expect(pushed).toEqual([{ runtimeId: "runtime-2", token: body.linkToken }]);
    expect(JSON.stringify(calls)).not.toContain(body.linkToken);
    expect(logs.join("\n")).toContain("api.runtime_link_rotated");
    expect(logs.join("\n")).not.toContain(body.linkToken);
    const rotation = calls.find((call) => call.sql.startsWith("update runtimes set link_token_previous_hash = link_token_hash"));
    expect(rotation).toBeDefined();
    expect(rotation!.sql).toContain("link_token_rotated_at = now()");
    expect(calls.some((call) => call.sql.startsWith("insert into runtime_link_events") && call.values.includes("rotated"))).toBe(true);
  });

  test("mode emergency : aucune grâce, aucun push, lien fermé 4401 LINK_ROTATED", async () => {
    const closed: Array<{ runtimeId: string; code: number; reason: string }> = [];
    let pushed = 0;
    const { app, calls } = mount([connector], {
      notifyRotation: () => { pushed += 1; return true; },
      close: (runtimeId, code, reason) => { closed.push({ runtimeId, code, reason }); return true; },
    });
    const response = await app.request("/runtime-2/link/rotate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "emergency" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { linkToken: string; mode: string; pushed: boolean; expiresPreviousAt: string | null };
    expect(body.mode).toBe("emergency");
    expect(body.pushed).toBe(false);
    expect(body.expiresPreviousAt).toBeNull();
    expect(pushed).toBe(0);
    expect(closed).toEqual([{ runtimeId: "runtime-2", code: 4401, reason: "LINK_ROTATED" }]);
    const rotation = calls.find((call) => call.sql.startsWith("update runtimes set link_token_previous_hash = null"));
    expect(rotation).toBeDefined();
    expect(rotation!.sql).toContain("link_token_previous_expires_at = null");
    expect(rotation!.sql).not.toContain("link_token_previous_hash = link_token_hash");
    expect(JSON.stringify(calls)).not.toContain(body.linkToken);
    expect(logs.join("\n")).not.toContain(body.linkToken);
  });

  test("un mode inconnu est refusé 400 ; un corps vide vaut maintenance", async () => {
    const { app } = mount([connector], { notifyRotation: () => true });
    const bad = await app.request("/runtime-2/link/rotate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "yolo" }),
    });
    expect(bad.status).toBe(400);
    const empty = await app.request("/runtime-2/link/rotate", { method: "POST" });
    expect((await empty.json() as { mode: string }).mode).toBe("maintenance");
  });

  test("un membre n'a ni rotation, ni journal, ni retrait : 403", async () => {
    const { app, calls } = mount([connector], {}, "member");
    expect((await app.request("/runtime-2/link/rotate", { method: "POST" })).status).toBe(403);
    expect((await app.request("/runtime-2/link/events")).status).toBe(403);
    expect((await app.request("/runtime-2", { method: "DELETE" })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("la rotation refuse un runtime direct (409) et un runtime inconnu (404)", async () => {
    const direct = mount([row]);
    expect((await direct.app.request("/runtime-1/link/rotate", { method: "POST" })).status).toBe(409);
    const missing = mount([]);
    expect((await missing.app.request("/runtime-9/link/rotate", { method: "POST" })).status).toBe(404);
  });

  test("DELETE du seul runtime actif : 409 sans confirmation, accepté avec { confirm: true }", async () => {
    let revoked = 0;
    const refused = mount([connector], { revoke: () => { revoked += 1; return true; } });
    const withoutConfirm = await refused.app.request("/runtime-2", { method: "DELETE" });
    expect(withoutConfirm.status).toBe(409);
    expect((await withoutConfirm.json() as { error: { code: string } }).error.code).toBe("RUNTIME_ACTIVE");
    expect(revoked).toBe(0);
    expect(refused.calls.some((call) => call.sql.startsWith("update runtimes set revoked_at"))).toBe(false);

    const accepted = mount([connector], { revoke: () => { revoked += 1; return true; } });
    const withConfirm = await accepted.app.request("/runtime-2", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(withConfirm.status).toBe(200);
    expect(revoked).toBe(1);
    // `runtimes_active_not_revoked` (0013) rejette une ligne à la fois active
    // et révoquée : sans `is_active = false` dans le MÊME update, PostgreSQL
    // refusait la transaction entière et l'écran ne rendait qu'un 500.
    expect(accepted.calls.some((call) => call.sql.startsWith("update runtimes set revoked_at")
      && call.sql.includes("is_active = false"))).toBe(true);
    expect(accepted.calls.some((call) => call.sql.startsWith("insert into runtime_link_events") && call.values.includes("revoked"))).toBe(true);
  });

  test("DELETE d'un runtime actif quand il en existe un autre : 409 sans confirmation, accepté avec", async () => {
    const refused = mount([connector, { ...row, isActive: false }]);
    expect((await refused.app.request("/runtime-2", { method: "DELETE" })).status).toBe(409);
    expect(refused.calls.some((call) => call.sql.startsWith("update runtimes set revoked_at"))).toBe(false);

    const accepted = mount([connector, { ...row, isActive: false }]);
    const response = await accepted.app.request("/runtime-2", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(response.status).toBe(200);
    expect(accepted.calls.some((call) => call.sql.startsWith("update runtimes set revoked_at")
      && call.sql.includes("is_active = false"))).toBe(true);
    restore();
  });

  // `links.revoke` ne ferme que la socket de CE processus. Avec la passerelle
  // dédiée (`separate`) ou plusieurs réplicas, le lien vit ailleurs : sans
  // relais, l'hôte garde un lien vivant jusqu'au prochain battement du bail,
  // puis retombe en refus au lieu de lire le 4004 qui l'arrête.
  describe("révocation d'un runtime connector et instance qui tient le lien", () => {
    type Closed = { runtimeId: string; code: number; reason: string };
    const confirmedDelete = {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    };
    const ownerElsewhere: RuntimeLinkLocator = {
      instanceId: "api-a",
      locate: async () => ({ kind: "remote", instanceId: "gateway-b", internalUrl: "http://10.0.0.2:8792" }),
      forwardProxy: async () => new Response(null, { status: 599 }),
      forwardDial: async () => new Response(null, { status: 599 }),
      forwardRotate: async () => false,
      forwardClose: async () => false,
      forwardYolo: async () => false,
      forwardProbe: async () => ({ outcome: "no_link" }),
    };

    test("sans socket locale : la fermeture 4004 LINK_REVOKED est relayée au propriétaire, une fois la révocation écrite", async () => {
      const forwarded: Array<Closed & { revokedInDb: boolean }> = [];
      const locator: RuntimeLinkLocator = {
        ...ownerElsewhere,
        forwardClose: async (runtimeId, code, reason) => {
          const revokedInDb = fixture.calls.some((call) => call.sql.startsWith("update runtimes set revoked_at"));
          forwarded.push({ runtimeId, code, reason, revokedInDb });
          return true;
        },
      };
      const fixture = mount([connector], { revoke: () => false }, "owner", locator);
      const response = await fixture.app.request("/runtime-2", confirmedDelete);
      expect(response.status).toBe(200);
      expect(forwarded).toEqual([{ runtimeId: "runtime-2", code: 4004, reason: "LINK_REVOKED", revokedInDb: true }]);
    });

    test("socket locale : fermée ici par `links.revoke`, rien n'est relayé", async () => {
      const revoked: string[] = [];
      const forwarded: Closed[] = [];
      const locator: RuntimeLinkLocator = {
        ...ownerElsewhere,
        forwardClose: async (runtimeId, code, reason) => {
          forwarded.push({ runtimeId, code, reason });
          return true;
        },
      };
      const { app } = mount([connector], { revoke: (runtimeId) => { revoked.push(runtimeId); return true; } }, "owner", locator);
      const response = await app.request("/runtime-2", confirmedDelete);
      expect(response.status).toBe(200);
      expect(revoked).toEqual(["runtime-2"]);
      expect(forwarded).toEqual([]);
    });
  });

  test("GET /:id/link/events liste le journal, borné", async () => {
    const { app, calls } = mount([connector]);
    const response = await app.request("/runtime-2/link/events?limit=500");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [] });
    const read = calls.find((call) => call.sql.startsWith("select id, kind, ip, agent"));
    expect(read?.values).toContain(200);
  });
});

describe("runtime bot count", () => {
  test("the active runtime counts the live roster; any other runtime serves none", async () => {
    const seen: string[] = [];
    const tx = (async (strings: TemplateStringsArray) => {
      seen.push(strings.join("?"));
      return [{ count: "2" }];
    }) as unknown as Bun.TransactionSQL;
    const count = await readRosterBotCount(tx, "org-1");
    expect(count).toBe(2);
    expect(seen[0]).toContain("from bots");
    expect(seen[0]).toContain("archived_at is null");
    expect(runtimeBotCount({ isActive: true }, count)).toBe(2);
    expect(runtimeBotCount({ isActive: false }, count)).toBe(0);
  });

  test("an empty answer reads as no bot", async () => {
    const tx = (async () => []) as unknown as Bun.TransactionSQL;
    expect(await readRosterBotCount(tx, "org-1")).toBe(0);
  });

  function countingDb(count: number | string): { db: SQL; seen: Array<{ sql: string; values: unknown[] }> } {
    const seen: Array<{ sql: string; values: unknown[] }> = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      seen.push({ sql, values });
      return sql.includes("from bots") ? [{ count }] : [];
    }) as unknown as SQL;
    (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin =
      async (callback) => callback(tx as unknown as Bun.TransactionSQL);
    return { db: tx, seen };
  }

  test("readRuntimeBotCount counts the roster under the tenant for the active runtime only", async () => {
    const active = countingDb("3");
    expect(await readRuntimeBotCount(active.db, "org-1", { isActive: true })).toBe(3);
    expect(active.seen[0]!.sql).toContain("set_config('app.organization_id'");
    expect(active.seen[0]!.values).toEqual(["org-1"]);
    expect(active.seen.some((call) => call.sql.includes("from bots") && call.values.includes("org-1"))).toBe(true);

    const inactive = countingDb("3");
    expect(await readRuntimeBotCount(inactive.db, "org-1", { isActive: false })).toBe(0);
    expect(inactive.seen).toHaveLength(0);
  });

  test("publicRuntimeWithBots answers the same DTO as publicRuntime, with the real botCount", async () => {
    const { db } = countingDb(4);
    const activeRow: RuntimeRow = { ...row, isActive: true };
    const plain = publicRuntime(activeRow, "disabled", [], undefined, null);
    expect(plain.botCount).toBe(0);
    const counted = await publicRuntimeWithBots(db, "org-1", activeRow, "disabled", [], undefined, null);
    expect(counted).toEqual({ ...plain, botCount: 4 });

    const pending = await publicRuntimeWithBots(db, "org-1", { ...row, isActive: false }, "disabled", [], undefined, null);
    expect(pending.botCount).toBe(0);
  });
});
