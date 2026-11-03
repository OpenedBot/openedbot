import { afterEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { Hono } from "hono";
import type { ApiConfig } from "../src/infrastructure/config";
import { HermesClientError, RelayDialError } from "@openedbot/hermes";
import { installRuntimeLinks, NO_RUNTIME_LINKS, type RuntimeLinks } from "@openedbot/runtime-link/application/dialer";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import { HttpError } from "../src/interfaces/http/http-error";
import { applyHostProfileModel } from "@openedbot/portability/application/model";
import {
  catalogValidatedSelection,
  hermesProfileFromBaseUrl,
  isEffortOnlyChange,
  readProviderSdks,
  resolvedHostProfileModel,
  runtimeModelCatalog,
  runtimeModelRoutes,
  runtimeModelSelection,
} from "../src/routes/runtimes/runtime-model-routes";
import type { RuntimeModelCatalogDto } from "@openedbot/contracts-api";
import type { RuntimeRow } from "../src/routes/runtimes/runtime-routes";
import type { RuntimeReadKind, SnapshotStore } from "@openedbot/runtimes/application/runtime-read-snapshots";
import { runtimeAdminRoutes } from "../src/routes/runtimes/runtime-admin-routes";

const row: RuntimeRow = {
  id: "runtime-1",
  name: "Hermes lab",
  endpoint: "http://10.0.0.10:8642",
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
  createdAt: new Date(),
  updatedAt: new Date(),
};

const profileCatalog = async () => ({
  provider: "openai-codex", model: "gpt-5.6-luna",
  providers: [
    { slug: "openai-codex", id: "gpt-5.6-luna" },
    { slug: "anthropic", id: "claude-sonnet-4" },
    { slug: "opencode-free", id: "nemotron-3.5-lightning-free" },
  ].map(({ slug, id }) => ({
    slug, name: slug, isCurrent: false, authenticated: true, authType: null, warning: null,
    models: [{ id, fast: false, reasoning: false }],
  })),
});

describe("profile model selection", () => {
  test("resolves the bot model's catalog provider instead of the globally pinned provider", async () => {
    const runtime = { selectedProvider: "openai-codex", selectedModel: "gpt-5.6-luna" };
    expect(await resolvedHostProfileModel({ model: "nemotron-3.5-lightning-free" }, runtime, profileCatalog))
      .toEqual({ provider: "opencode-free", model: "nemotron-3.5-lightning-free" });
    expect(await resolvedHostProfileModel({ model: "claude-sonnet-4", provider: "anthropic" }, runtime, profileCatalog))
      .toEqual({ provider: "anthropic", model: "claude-sonnet-4" });
    expect(await resolvedHostProfileModel({}, runtime, profileCatalog))
      .toEqual({ provider: "openai-codex", model: "gpt-5.6-luna" });
    expect(await resolvedHostProfileModel({}, {}, profileCatalog)).toBeNull();
  });

  test("rejects missing, unauthenticated, or mismatched models with BOT_MODEL_UNAVAILABLE", async () => {
    const catalog = await profileCatalog();
    catalog.providers[2]!.authenticated = false;
    for (const bot of [
      { model: "absent" },
      { model: "nemotron-3.5-lightning-free" },
      { model: "claude-sonnet-4", provider: "openai-codex" },
    ]) {
      try {
        await resolvedHostProfileModel(bot, {}, async () => catalog);
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect(error).toMatchObject({ status: 409, code: "BOT_MODEL_UNAVAILABLE" });
      }
    }
  });

  test("a bot following the runtime keeps a model the static catalog does not list yet", async () => {
    // The runtime already runs gpt-6-luna; Hermes' catalog stopped at gpt-5.6 (2026-10-17).
    const runtime = { selectedProvider: "openai-codex", selectedModel: "gpt-6-luna" };
    expect(await resolvedHostProfileModel({}, runtime, profileCatalog))
      .toEqual({ provider: "openai-codex", model: "gpt-6-luna" });
    // A model chosen for the bot itself is still checked against the catalog.
    await expect(resolvedHostProfileModel({ model: "gpt-6-luna" }, runtime, profileCatalog))
      .rejects.toMatchObject({ status: 409, code: "BOT_MODEL_UNAVAILABLE" });
    // The runtime's provider must still be authenticated.
    const catalog = await profileCatalog();
    catalog.providers[0]!.authenticated = false;
    await expect(resolvedHostProfileModel({}, runtime, async () => catalog))
      .rejects.toMatchObject({ status: 409, code: "BOT_MODEL_UNAVAILABLE" });
  });

  test("applyHostProfileModel reports an unverified host write without throwing", async () => {
    await expect(applyHostProfileModel({
      hostSetProfileModel: async () => ({ profile: "scout", provider: "anthropic", model: "claude-sonnet-4", applied: true }),
    }, "scout", { provider: "anthropic", model: "claude-sonnet-4" })).resolves.toEqual({ applied: true });
    await expect(applyHostProfileModel({
      hostSetProfileModel: async () => {
        throw new Error("down");
      },
    }, "scout", { provider: "anthropic", model: "claude-sonnet-4" })).resolves.toEqual({ applied: false });
    await expect(applyHostProfileModel({
      hostSetProfileModel: async () => {
        throw new Error("should not run");
      },
    }, "scout", null)).resolves.toEqual({ applied: false });
  });
});

describe("runtime model management", () => {
  test("an effort-only change keeps the proven provider and model", () => {
    const stored = { selectedProvider: "openai-codex", selectedModel: "gpt-6-luna" };
    expect(isEffortOnlyChange(stored, { provider: "openai-codex", model: "gpt-6-luna", reasoningEffort: "high" })).toBe(true);
    expect(isEffortOnlyChange(stored, { provider: "openai-codex", model: "gpt-6", reasoningEffort: "high" })).toBe(false);
    expect(isEffortOnlyChange(stored, { provider: "anthropic", model: "gpt-6-luna", reasoningEffort: null })).toBe(false);
    expect(isEffortOnlyChange({ selectedProvider: null, selectedModel: null }, {
      provider: null, model: null, reasoningEffort: null,
    })).toBe(false);
  });

  test("normalizes a complete model preference", () => {
    expect(runtimeModelSelection({ provider: " openai-api ", model: " gpt-5.6-luna ", reasoningEffort: "high" }))
      .toEqual({ provider: "openai-api", model: "gpt-5.6-luna", reasoningEffort: "high" });
  });

  test("rejects an unknown reasoning effort", () => {
    expect(() => runtimeModelSelection({ reasoningEffort: "maximum" })).toThrow(HttpError);
  });

  test("maps the live Hermes catalog without treating moa as inference proof", () => {
    const catalog = runtimeModelCatalog(row, {
      provider: "openai-api",
      model: "gpt-5.6-luna",
      providers: [
        { slug: "moa", name: "Mixture", isCurrent: false, authenticated: true, authType: "virtual", warning: null, models: [] },
        { slug: "openai-api", name: "OpenAI API", isCurrent: true, authenticated: true, authType: null, warning: null, models: [{ id: "gpt-5.6-luna", fast: true, reasoning: true }] },
      ],
    });
    expect(catalog.hasUsableProvider).toBe(true);
    expect(catalog.providers[0]?.provesInference).toBe(false);
    expect(catalog.providers[1]?.models[0]?.isRuntimeDefault).toBe(true);
  });

  test("a keyless free tier never accepts an API key, whatever Hermes declares", () => {
    const catalog = runtimeModelCatalog(row, {
      provider: null,
      model: null,
      providers: [
        // Hermes only has `api_key` to say « not OAuth »: the relay rejects any bearer.
        { slug: "opencode-free", name: "OpenCode Free", isCurrent: false, authenticated: true, authType: "api_key", warning: null, models: [{ id: "hy3-free", fast: true, reasoning: false }] },
        { slug: "opencode-zen", name: "OpenCode Zen", isCurrent: false, authenticated: false, authType: "api_key", warning: null, models: [] },
      ],
    });
    expect(catalog.providers[0]?.acceptsApiKey).toBe(false);
    expect(catalog.providers[0]?.provesInference).toBe(true);
    expect(catalog.providers[1]?.acceptsApiKey).toBe(true);
  });

  test("detects a named Hermes profile before exposing credential writes", () => {
    expect(hermesProfileFromBaseUrl("https://hermes.example.com/p/obiwan/")).toBe("obiwan");
    expect(hermesProfileFromBaseUrl("https://hermes.example.com/")).toBeNull();
    expect(hermesProfileFromBaseUrl("not-a-url")).toBeNull();
  });
});

describe("catalog-validated model selection", () => {
  const catalog = () => runtimeModelCatalog(row, {
    provider: "openai-api",
    model: "gpt-5.6-luna",
    providers: [
      {
        slug: "openai-api",
        name: "OpenAI API",
        isCurrent: true,
        authenticated: true,
        authType: null,
        warning: null,
        models: [
          { id: "gpt-5.6-luna", fast: true, reasoning: true },
          { id: "gpt-5.6-eco", fast: true, reasoning: false },
        ],
      },
      {
        slug: "nous-api",
        name: "Nous Research",
        isCurrent: false,
        authenticated: false,
        authType: null,
        warning: null,
        models: [{ id: "hermes-4-405b", fast: false, reasoning: true }],
      },
    ],
  });

  test("refuses a provider that vanished from the live catalog", async () => {
    await expect(catalogValidatedSelection(
      { provider: "mistral-api", model: "mistral-large", reasoningEffort: null },
      async () => catalog(),
    )).rejects.toMatchObject({ status: 409, code: "RUNTIME_MODEL_PROVIDER_UNKNOWN" });
  });

  test("refuses a provider that is not authenticated in Hermes", async () => {
    await expect(catalogValidatedSelection(
      { provider: "nous-api", model: "hermes-4-405b", reasoningEffort: null },
      async () => catalog(),
    )).rejects.toMatchObject({
      status: 409,
      code: "RUNTIME_MODEL_PROVIDER_UNAUTHENTICATED",
      message: "Nous Research doit être connecté dans Hermes avant de pouvoir être sélectionné.",
    });
  });

  test("refuses a model absent from the provider, or no model at all", async () => {
    await expect(catalogValidatedSelection(
      { provider: "openai-api", model: "gpt-4o", reasoningEffort: null },
      async () => catalog(),
    )).rejects.toMatchObject({ status: 409, code: "RUNTIME_MODEL_UNAVAILABLE" });
    await expect(catalogValidatedSelection(
      { provider: "openai-api", model: null, reasoningEffort: null },
      async () => catalog(),
    )).rejects.toMatchObject({ status: 409, code: "RUNTIME_MODEL_UNAVAILABLE" });
  });

  test("accepts a selection confirmed by the live catalog", async () => {
    expect(await catalogValidatedSelection(
      { provider: "openai-api", model: "gpt-5.6-luna", reasoningEffort: "high" },
      async () => catalog(),
    )).toEqual({ provider: "openai-api", model: "gpt-5.6-luna", reasoningEffort: "high" });
  });

  test("never fetches the catalog when the runtime keeps the Hermes default", async () => {
    let fetched = 0;
    expect(await catalogValidatedSelection(
      { provider: null, model: null, reasoningEffort: null },
      async () => {
        fetched += 1;
        return catalog();
      },
    )).toEqual({ provider: null, model: null, reasoningEffort: null });
    expect(fetched).toBe(0);
  });

  test("drops the reasoning effort on a model that does not reason", async () => {
    expect(await catalogValidatedSelection(
      { provider: "openai-api", model: "gpt-5.6-eco", reasoningEffort: "high" },
      async () => catalog(),
    )).toEqual({ provider: "openai-api", model: "gpt-5.6-eco", reasoningEffort: null });
  });
});

describe("provider SDK presence on the host", () => {
  const options = {
    provider: "anthropic",
    model: "claude-sonnet-4",
    providers: [{
      slug: "anthropic", name: "Anthropic", isCurrent: true, authenticated: true, authType: null, warning: null,
      models: [{ id: "claude-sonnet-4", fast: false, reasoning: false }],
    }],
  };
  const sdk = (installed: boolean) => [{ provider: "anthropic", label: "Anthropic", extra: "anthropic", installed, installable: true }];

  test("a missing SDK marks the provider not usable and the selection is refused 409", async () => {
    const catalog = runtimeModelCatalog(row, options, sdk(false));
    expect(catalog.providers[0]).toMatchObject({ authenticated: true, sdkInstalled: false, sdkInstallable: true, provesInference: false });
    expect(catalog.hasUsableProvider).toBe(false);
    await expect(catalogValidatedSelection(
      { provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: null },
      async () => catalog,
    )).rejects.toMatchObject({ status: 409, code: "RUNTIME_MODEL_PROVIDER_SDK_MISSING", message: expect.stringContaining("edge-setup up") });
    const notInstallable = runtimeModelCatalog(row, options, [{ ...sdk(false)[0]!, installable: false }]);
    await expect(catalogValidatedSelection(
      { provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: null },
      async () => notInstallable,
    )).rejects.toMatchObject({ message: expect.not.stringContaining("edge-setup up") });
  });

  test("an installed SDK changes nothing, and a provider absent from the host list stays unknown", () => {
    expect(runtimeModelCatalog(row, options, sdk(true)).providers[0]).toMatchObject({ sdkInstalled: true, sdkInstallable: true, provesInference: true });
    const absent = runtimeModelCatalog(row, options, [{ provider: "bedrock", label: "AWS Bedrock", extra: "bedrock", installed: false, installable: false }]);
    expect(absent.providers[0]).toMatchObject({ sdkInstalled: null, sdkInstallable: null, provesInference: true });
  });

  test("without a host list sdkInstalled is null and behaviour is unchanged", () => {
    const catalog = runtimeModelCatalog(row, options);
    expect(catalog.providers[0]).toMatchObject({ sdkInstalled: null, sdkInstallable: null, provesInference: true });
    expect(catalog.hasUsableProvider).toBe(true);
  });

  test("readProviderSdks reads only when the feature is announced and falls back to null on failure", async () => {
    let reads = 0;
    const client = { hostProviderSdks: async () => { reads += 1; return sdk(false); } };
    expect(await readProviderSdks({ linkFeatures: [] }, client)).toBeNull();
    expect(reads).toBe(0);
    expect(await readProviderSdks({ linkFeatures: ["provider_sdks"] }, client)).toEqual(sdk(false));
    const failing = { hostProviderSdks: async () => { throw new HermesClientError("sonde", 503, "HERMES_UNREACHABLE"); } };
    expect(await readProviderSdks({ linkFeatures: ["provider_sdks"] }, failing)).toBeNull();
  });
});

describe("GET /:runtimeId/models : verdict de santé", () => {
  const owner: AuthContext = {
    sessionId: "session-1", organizationId: "org-1", userId: "user-1",
    role: "owner", kind: "web", credentialHash: "credential",
  };
  const config = { apiPublicUrl: "https://api.example.com", publicUrl: "https://app.example.com", environment: "test", linkPublicUrl: null, linkLegacyPublicUrls: [], connectorVersions: {} } as unknown as ApiConfig;
  const connector: RuntimeRow = {
    ...row,
    reachability: "connector",
    endpoint: null,
    tokenCiphertext: null,
    tokenNonce: null,
    tokenTag: null,
    linkLastSeenAt: new Date(),
    linkGeneration: "7",
  };
  const catalog = {
    provider: "anthropic",
    model: "claude-sonnet-4",
    providers: [{ slug: "anthropic", name: "Anthropic", models: ["claude-sonnet-4"], authenticated: true }],
  };

  type Call = { sql: string; values: unknown[] };

  type MountOptions = { failHealthWrite?: boolean; row?: RuntimeRow; storedProof?: unknown; provenModel?: boolean; effortRace?: boolean };

  function memorySnapshots(): SnapshotStore {
    const rows = new Map<string, { document: unknown; observedAt: Date }>();
    const key = (org: string, runtime: string, kind: RuntimeReadKind) => `${org}/${runtime}/${kind}`;
    return {
      async read(org, runtime, kind) { return rows.get(key(org, runtime, kind)) ?? null; },
      async write(org, runtime, kind, document, observedAt) { rows.set(key(org, runtime, kind), { document, observedAt }); },
      async invalidate(org, kind, _at) {
        for (const key of rows.keys()) if (key.startsWith(`${org}/`) && (!kind || key.endsWith(`/${kind}`))) rows.delete(key);
      },
    };
  }

  function fakeDb(options: MountOptions = {}): { db: SQL; calls: Call[] } {
    const calls: Call[] = [];
    const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = [...strings].join(" ? ").replace(/\s+/g, " ").trim();
      calls.push({ sql, values });
      if (options.failHealthWrite && sql.startsWith("update runtimes set last_health_status")) {
        throw new Error("postgres: connexion perdue");
      }
      if (sql.includes("insert into runtime_model_selection_proofs")) return [options.storedProof ?? {
        runtime_id: "runtime-1", organization_id: "org-1", provider: values[2], model: values[3],
        reasoning_effort: values[4], status: "queued", request_generation: 1, request_id: "request-new", attempts: 0,
        next_attempt_at: new Date(), error: null, lease_owner: null, lease_generation: 0,
        lease_token: null,
        lease_expires_at: null, requested_at: new Date(), updated_at: new Date(), finished_at: null,
      }];
      if (sql.includes("from runtime_model_proven")) return options.provenModel ? [{ organization_id: "org-1", runtime_id: "runtime-1", provider: "anthropic", model: "claude-sonnet-4", proven_at: new Date() }] : [];
      if (sql.startsWith("update runtimes set reasoning_effort")) return options.effortRace ? [] : [{ reasoningEffort: values[0], updatedAt: new Date() }];
      if (sql.startsWith("update runtimes set selected_provider")) return [{
        ...(options.row ?? connector), selectedProvider: values[0], selectedModel: values[1], reasoningEffort: values[2],
      }];
      return sql.includes("from runtimes") ? [options.row ?? connector] : [];
    }) as unknown as SQL;
    (tx as unknown as { begin(callback: (inner: Bun.TransactionSQL) => Promise<unknown>): Promise<unknown> }).begin =
      async (callback) => callback(tx as unknown as Bun.TransactionSQL);
    return { db: tx, calls };
  }

  function mount(respond: (path: string) => Response, options: MountOptions = {}, includeAdmin = false) {
    const links: RuntimeLinks = {
      ...NO_RUNTIME_LINKS,
      connected: () => true,
      dial: () => async (request) => respond(request.path),
    };
    installRuntimeLinks(links);
    const fake = fakeDb(options);
    const snapshots = memorySnapshots();
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => {
      context.set("auth", owner);
      await next();
    });
    app.onError((error, context) => error instanceof HttpError
      ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
      : context.json({ error: { code: "UNEXPECTED", message: String(error) } }, 500));
    app.route("/", runtimeModelRoutes(fake.db, config, { snapshotStore: snapshots }));
    if (includeAdmin) app.route("/", runtimeAdminRoutes(fake.db, config, { snapshotStore: snapshots }));
    return { app, calls: fake.calls, snapshots };
  }

  const healthWrites = (calls: Call[]) => calls.filter((call) => call.sql.startsWith("update runtimes set last_health_status"));

  afterEach(() => installRuntimeLinks(NO_RUNTIME_LINKS));
  test("le GET suivant sert le snapshot et ?fresh=1 relit l'hôte", async () => {
    let hostReads = 0;
    const { app } = mount(() => {
      hostReads += 1;
      return Response.json(catalog);
    });
    expect((await app.request("/runtime-1/models")).status).toBe(200);
    expect((await app.request("/runtime-1/models")).status).toBe(200);
    expect(hostReads).toBe(1);
    expect((await app.request("/runtime-1/models?fresh=1")).status).toBe(200);
    expect(hostReads).toBe(2);
  });

  test("une écriture OHB invalide le snapshot", async () => {
    let hostReads = 0;
    const { app, snapshots } = mount(() => {
      hostReads += 1;
      return Response.json(catalog);
    });
    await app.request("/runtime-1/models");
    await snapshots.invalidate("org-1", "models", new Date());
    await app.request("/runtime-1/models");
    expect(hostReads).toBe(2);
  });

  test("un échec n'est jamais gardé", async () => {
    let hostReads = 0;
    const { app } = mount(() => {
      hostReads += 1;
      return hostReads === 1 ? new Response("{}", { status: 502 }) : Response.json(catalog);
    });
    expect((await app.request("/runtime-1/models")).status).not.toBe(200);
    expect((await app.request("/runtime-1/models")).status).toBe(200);
  });

  test("catalogue reçu : healthy, sans erreur, link_features intact", async () => {
    const { app, calls } = mount(() => Response.json(catalog));
    const response = await app.request("/runtime-1/models");
    expect(response.status).toBe(200);
    expect((await response.json() as { providers: unknown[] }).providers).toHaveLength(1);
    const writes = healthWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values.slice(0, 2)).toEqual(["healthy", null]);
    expect(writes[0]!.sql).not.toContain("link_features");
  });

  // L'observation est vraie pour UN lien : la même requête fence la génération
  // lue avant l'appel et ne repasse jamais par-dessus un `disconnected`, que
  // seule la couche lien écrit (broker, worker) en sachant la socket partie.
  test("l’écriture d’observation est fencée par la génération du lien et ne recouvre pas disconnected", async () => {
    const { app, calls } = mount(() => Response.json(catalog));
    await app.request("/runtime-1/models");
    const write = healthWrites(calls)[0]!;
    expect(write.sql).toContain("link_generation = ? ::bigint");
    expect(write.sql).toContain("last_health_status <> 'disconnected'");
    expect(write.values).toContain("7");
  });

  // Une projection sans génération (ancienne, ou fixture) n'a rien pour
  // fencer : plutôt qu'une écriture qui pourrait écraser un verdict plus
  // récent de la couche lien, aucune écriture.
  test("sans génération de lien en main : catalogue rendu, aucun verdict écrit", async () => {
    const { linkGeneration: _omitted, ...withoutGeneration } = connector;
    const { app, calls } = mount(() => Response.json(catalog), { row: withoutGeneration });
    const response = await app.request("/runtime-1/models");
    expect(response.status).toBe(200);
    expect(healthWrites(calls)).toHaveLength(0);
  });

  // Relais saturé : la requête n'est jamais partie, le runtime n'a rien
  // montré. Écrire `unreachable` ici serait un mensonge que rien ne relève.
  test("requête jamais partie (relais saturé) : 503 conservé, aucun verdict écrit", async () => {
    const { app, calls } = mount(() => {
      throw new RelayDialError("Le lien est saturé.", "before_dispatch", "LINK_BUSY");
    });
    const response = await app.request("/runtime-1/models");
    expect(response.status).toBe(503);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("HERMES_UNREACHABLE");
    expect(healthWrites(calls)).toHaveLength(0);
  });

  test("token refusé : unauthorized et le message, réponse HTTP inchangée", async () => {
    const { app, calls } = mount(() => new Response("unauthorized", { status: 401 }));
    const response = await app.request("/runtime-1/models");
    expect(response.status).toBe(401);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("HERMES_TOKEN_REJECTED");
    const writes = healthWrites(calls);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values[0]).toBe("unauthorized");
    expect(writes[0]!.values[1]).toStartWith("Le token Hermes a été refusé.");
  });

  test("sans la feature provider_sdks : sdkInstalled null, comportement inchangé, aucune lecture hôte", async () => {
    const paths: string[] = [];
    const { app } = mount((path) => {
      paths.push(path);
      return Response.json(catalog);
    });
    const dto = await (await app.request("/runtime-1/models")).json() as RuntimeModelCatalogDto;
    expect(dto.providers[0]).toMatchObject({ sdkInstalled: null, sdkInstallable: null, provesInference: true });
    expect(dto.hasUsableProvider).toBe(true);
    expect(paths).not.toContain("/hermes-setup/provider-sdks");
  });

  test("écriture de santé en panne : le catalogue est quand même rendu", async () => {
    const { app, calls } = mount(() => Response.json(catalog), { failHealthWrite: true });
    const response = await app.request("/runtime-1/models");
    expect(response.status).toBe(200);
    expect(healthWrites(calls)).toHaveLength(1);
  });

  test("PUT queues a new selection after parallel catalog reads and performs no host write", async () => {
    const paths: string[] = [];
    const options = { provider: "anthropic", model: "claude-sonnet-4", providers: [{
      slug: "anthropic", name: "Anthropic", is_current: true, authenticated: true, auth_type: "api_key",
      models: ["claude-sonnet-4"], capabilities: { "claude-sonnet-4": { fast: false, reasoning: true } },
    }] };
    const { app } = mount((path) => { paths.push(path); return Response.json(options); });
    const response = await app.request("/runtime-1/model-selection", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: "low" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ modelSelection: { status: "queued", provider: "anthropic", model: "claude-sonnet-4", attempts: 0 } });
    expect(paths).toEqual(["/api/model/options"]);
    expect(paths.some((path) => /runs|profiles|model/.test(path) && path !== "/api/model/options")).toBe(false);
  });

  test("a model proven recently is promoted synchronously without a worker proof", async () => {
    const paths: string[] = [];
    const options = { provider: "anthropic", model: "claude-sonnet-4", providers: [{
      slug: "anthropic", name: "Anthropic", is_current: false, authenticated: true, auth_type: "api_key",
      models: ["claude-sonnet-4"], capabilities: { "claude-sonnet-4": { fast: false, reasoning: true } },
    }] };
    const { app, calls } = mount((path) => { paths.push(path); return Response.json(options); }, { provenModel: true });
    const response = await app.request("/runtime-1/model-selection", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: "high" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ modelSelection: null, selectedProvider: "anthropic", selectedModel: "claude-sonnet-4", reasoningEffort: "high" });
    expect(calls.some((call) => call.sql.startsWith("update runtimes set selected_provider"))).toBe(true);
    expect(calls.some((call) => call.sql.startsWith("insert into runtime_model_selection_proofs"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("for update"))).toBe(true);
    expect(paths.some((path) => path.includes("/runs"))).toBe(false);
  });

  test("a 25 hour old proof follows the queued 202 path", async () => {
    const options = { provider: "anthropic", model: "claude-sonnet-4", providers: [{
      slug: "anthropic", name: "Anthropic", is_current: false, authenticated: true, auth_type: "api_key",
      models: ["claude-sonnet-4"], capabilities: { "claude-sonnet-4": { fast: false, reasoning: true } },
    }] };
    const { app, calls } = mount(() => Response.json(options), { provenModel: false });
    const response = await app.request("/runtime-1/model-selection", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: "low" }),
    });
    expect(response.status).toBe(202);
    expect(calls.find((call) => call.sql.includes("from runtime_model_proven"))?.sql).toContain("interval '24 hours'");
    expect(calls.some((call) => call.sql.startsWith("insert into runtime_model_selection_proofs"))).toBe(true);
  });

  test("provider credential write invalidates proven models for that provider", async () => {
    const runtime = { ...connector, linkFeatures: ["provider_management"] };
    const { app, calls } = mount((path) => path.includes("/credentials")
      ? Response.json({ provider: "anthropic", label: "ohb-test", verification: "confirmed", detail: null })
      : Response.json(catalog), { row: runtime }, true);
    const response = await app.request("/runtime-1/providers/anthropic/credentials", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test-long-key-value" }),
    });
    expect(response.status).toBe(200);
    const invalidation = calls.find((call) => call.sql.includes("delete from runtime_model_proven"));
    expect(invalidation?.sql).toContain("provider =");
    expect(invalidation?.values).toContain("anthropic");
  });

  test("effort-only PUT remains synchronous and clears pending state", async () => {
    const existing = { ...connector, selectedProvider: "anthropic", selectedModel: "claude-sonnet-4" };
    const options = { provider: "anthropic", model: "claude-sonnet-4", providers: [{
      slug: "anthropic", name: "Anthropic", is_current: true, authenticated: true, auth_type: "api_key",
      models: ["claude-sonnet-4"], capabilities: { "claude-sonnet-4": { fast: false, reasoning: true } },
    }] };
    const { app, calls } = mount(() => Response.json(options), { row: existing });
    const response = await app.request("/runtime-1/model-selection", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: "high" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ modelSelection: null });
    expect(calls.some((call) => call.sql.startsWith("update runtimes set reasoning_effort"))).toBe(true);
  });

  test("effort-only PUT after a concurrent model promotion enqueues a proof", async () => {
    const existing = { ...connector, selectedProvider: "anthropic", selectedModel: "claude-sonnet-4" };
    const options = { provider: "anthropic", model: "claude-sonnet-4", providers: [{
      slug: "anthropic", name: "Anthropic", is_current: true, authenticated: true, auth_type: "api_key",
      models: ["claude-sonnet-4"], capabilities: { "claude-sonnet-4": { fast: false, reasoning: true } },
    }] };
    const { app, calls } = mount(() => Response.json(options), { row: existing, effortRace: true });
    const response = await app.request("/runtime-1/model-selection", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4", reasoningEffort: "high" }),
    });
    expect(response.status).toBe(202);
    expect(calls.some((call) => call.sql.includes("selected_provider = ? and selected_model = ?"))).toBe(true);
    expect(calls.some((call) => call.sql.startsWith("insert into runtime_model_selection_proofs"))).toBe(true);
    expect(calls.some((call) => call.sql.startsWith("delete from runtime_model_selection_proofs"))).toBe(false);
  });

  test("DELETE pending selection removes the proof and returns the runtime without pending state", async () => {
    const { app, calls } = mount(() => new Response(null, { status: 404 }));
    const response = await app.request("/runtime-1/model-selection/pending", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ modelSelection: null, id: "runtime-1" });
    expect(calls.some((call) => call.sql.startsWith("delete from runtime_model_selection_proofs"))).toBe(true);
  });
});
