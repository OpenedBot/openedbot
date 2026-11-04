import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { SQL } from "bun";
import {
  HermesClientError,
  type HermesCapabilityInventory,
  type HermesGatewayRestartJob,
  type HermesGatewayStatus,
  type HermesMcpInventory,
  type HermesMcpOauthSession,
  type HermesMcpServer,
  type HermesMcpServerRequest,
  type HermesProfileInventory,
  type HermesProfileMcpServerRemoval,
  type HermesToolsetState,
} from "@openedbot/hermes";
import type { AppVariables, AuthContext } from "../src/routes/identity/auth";
import type { ApiConfig } from "../src/infrastructure/config";
import type { Db } from "@openedbot/platform-db";
import { HttpError } from "../src/interfaces/http/http-error";
import { mcpOauthCallbackRoutes, publicEndpoint, runtimeIntegrationRoutes } from "../src/routes/runtimes/runtime-integration-routes";
import type { RuntimeReadKind, SnapshotStore } from "@openedbot/runtimes/application/runtime-read-snapshots";

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

const owner: AuthContext = {
  sessionId: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  role: "owner",
  kind: "web",
  credentialHash: "credential",
};

const inventory: HermesCapabilityInventory = {
  toolsets: [
    {
      name: "web",
      label: "Web",
      description: "Search and extraction",
      enabled: true,
      configured: true,
      tools: ["web_search", "web_extract"],
    },
    {
      name: "mcp-github",
      label: "GitHub",
      description: "MCP server 'github' tools",
      enabled: true,
      configured: false,
      tools: ["mcp_github_list_issues"],
    },
    {
      name: "terminal",
      label: "Terminal",
      description: null,
      enabled: false,
      configured: true,
      tools: ["terminal"],
    },
  ],
  skills: [{ name: "research", description: "Research workflow", category: "work" }],
};

function mount(options: {
  role?: AuthContext["role"];
  runtime?: boolean;
  readInventory?: () => Promise<HermesCapabilityInventory>;
  readManagement?: () => Promise<{
    status: "not_exposed" | "runtime_token_not_accepted" | "read_endpoint_available";
    serverCount: number | null;
  }>;
  hostFeatures?: string[] | null;
  /** The features the link persisted for a connector runtime. */
  linkFeatures?: string[];
  hostToolsets?: () => Promise<{ platform: string; settable: string[]; availability: null }>;
  hostSkills?: () => Promise<HermesCapabilityInventory["skills"]>;
  hostProfileInventory?: () => Promise<HermesProfileInventory>;
  hostDeleteProfile?: (slug: string) => Promise<void>;
  deleteSession?: (sessionId: string) => Promise<void>;
  db?: SQL;
  mcpInventory?: () => Promise<HermesMcpInventory>;
  toolsetSet?: (name: string, enabled: boolean) => Promise<HermesToolsetState>;
  mcpServerAdd?: (request: HermesMcpServerRequest) => Promise<HermesMcpServer>;
  mcpCatalogInstall?: (name: string, env: Record<string, string>) => Promise<HermesMcpServer>;
  mcpServerRemove?: (name: string) => Promise<void>;
  mcpOauthStart?: (name: string, redirectUri: string, profile?: string) => Promise<HermesMcpOauthSession>;
  mcpOauthPoll?: (name: string, sessionId: string) => Promise<HermesMcpOauthSession>;
  mcpOauthCallback?: (name: string, callback: { code: string; state: string } | { error: string }) => Promise<HermesMcpOauthSession>;
  gatewayStatus?: () => Promise<HermesGatewayStatus>;
  gatewayRestart?: () => Promise<HermesGatewayRestartJob>;
  gatewayRestartPoll?: (jobId: string) => Promise<HermesGatewayRestartJob>;
  hostRemoveProfileMcpServer?: (profile: string, name: string) => Promise<HermesProfileMcpServerRemoval>;
  timeoutMs?: number;
  publicUrl?: string;
} = {}) {
  let runtimeReads = 0;
  let hostCapabilityReads = 0;
  let inventoryReads = 0;
  let managementReads = 0;
  const writes: string[] = [];
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    context.set("auth", { ...owner, role: options.role ?? "owner" });
    await next();
  });
  app.onError((error, context) => error instanceof HttpError
    ? context.json({ error: { code: error.code, message: error.message } }, error.status as 400)
    : context.json({ error: { code: "UNEXPECTED" } }, 500));
  const config = { environment: "production", publicUrl: options.publicUrl ?? "https://ohb.example" } as ApiConfig;
  const clientFactory = () => ({
      capabilityInventory: async () => {
        inventoryReads += 1;
        return options.readInventory ? options.readInventory() : inventory;
      },
      connectorManagementProbe: async () => {
        managementReads += 1;
        return options.readManagement
          ? options.readManagement()
          : { status: "not_exposed" as const, serverCount: null };
      },
      hostCapabilities: async () => {
        hostCapabilityReads += 1;
        return options.hostFeatures === undefined ? null : options.hostFeatures;
      },
      hostToolsets: async () => {
        if (!options.hostToolsets) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.hostToolsets();
      },
      hostSkills: async () => {
        writes.push("host skills");
        if (!options.hostSkills) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.hostSkills();
      },
      hostProfileInventory: async () => {
        if (!options.hostProfileInventory) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.hostProfileInventory();
      },
      hostDeleteProfile: async (slug: string) => {
        writes.push(`hostDelete ${slug}`);
        if (!options.hostDeleteProfile) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.hostDeleteProfile(slug);
      },
      deleteSession: async (sessionId: string) => {
        writes.push(`deleteSession ${sessionId}`);
        if (!options.deleteSession) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.deleteSession(sessionId);
      },
      mcpInventory: async () => {
        if (!options.mcpInventory) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.mcpInventory();
      },
      toolsetSet: async (name: string, enabled: boolean) => {
        writes.push(`toolset ${name} ${enabled}`);
        if (!options.toolsetSet) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.toolsetSet(name, enabled);
      },
      mcpServerAdd: async (request: HermesMcpServerRequest) => {
        writes.push(`mcp add ${request.name}`);
        if (!options.mcpServerAdd) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.mcpServerAdd(request);
      },
      mcpCatalogInstall: async (name: string, env: Record<string, string>) => {
        writes.push(`mcp install ${name}`);
        if (!options.mcpCatalogInstall) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.mcpCatalogInstall(name, env);
      },
      mcpServerRemove: async (name: string) => {
        writes.push(`mcp remove ${name}`);
        if (!options.mcpServerRemove) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.mcpServerRemove(name);
      },
      hostRemoveProfileMcpServer: async (profile: string, name: string) => {
        writes.push(`mcp disconnect ${name} profile=${profile}`);
        if (!options.hostRemoveProfileMcpServer) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.hostRemoveProfileMcpServer(profile, name);
      },
      mcpOauthStart: async (name: string, redirectUri: string, profile?: string) => {
        writes.push(`mcp oauth ${name} ${redirectUri}${profile ? ` profile=${profile}` : ""}`);
        if (!options.mcpOauthStart) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.mcpOauthStart(name, redirectUri, profile);
      },
      mcpOauthPoll: async (name: string, sessionId: string) => {
        if (!options.mcpOauthPoll) throw new HermesClientError("absent", 404, "OAUTH_SESSION_NOT_FOUND");
        return options.mcpOauthPoll(name, sessionId);
      },
      mcpOauthCallback: async (name: string, callback: { code: string; state: string; iss?: string } | { error: string }) => {
        writes.push(`mcp oauth-callback ${name} ${JSON.stringify(callback)}`);
        if (!options.mcpOauthCallback) throw new HermesClientError("absent", 404, "OAUTH_SESSION_NOT_FOUND");
        return options.mcpOauthCallback(name, callback);
      },
      mcpOauthCancel: async (name: string, sessionId: string) => {
        writes.push(`mcp oauth-cancel ${name} ${sessionId}`);
      },
      gatewayStatus: async () => {
        if (!options.gatewayStatus) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.gatewayStatus();
      },
      gatewayRestart: async () => {
        writes.push("gateway restart");
        if (!options.gatewayRestart) throw new HermesClientError("absent", 404, "HERMES_OPERATOR_UNAVAILABLE");
        return options.gatewayRestart();
      },
      gatewayRestartPoll: async (jobId: string) => {
        if (!options.gatewayRestartPoll) throw new HermesClientError("absent", 404, "GATEWAY_RESTART_NOT_FOUND");
        return options.gatewayRestartPoll(jobId);
      },
    });
  const readRuntime = (async (_db: Db, _config: ApiConfig, organizationId: string) => {
      runtimeReads += 1;
      expect(["org-1", "00000000-0000-4000-8000-000000000001"]).toContain(organizationId);
      return options.runtime === false ? null : {
        id: "00000000-0000-4000-8000-000000000101",
        name: "Hermes privé",
        capacity: 4,
        ...(options.linkFeatures ? { linkFeatures: options.linkFeatures } : {}),
        client: {
          endpoint: "https://runtime.invalid",
          token: "server-secret-token",
          policy: { environment: "production" },
        },
      };
    }) as never;
  const snapshotStore = memorySnapshots();
  app.route("/", runtimeIntegrationRoutes((options.db ?? null) as unknown as SQL, config, {
    readRuntime,
    clientFactory,
    timeoutMs: options.timeoutMs,
    now: () => new Date("2026-08-26T12:00:00.000Z"),
    snapshotStore,
  }));
  const callbacks = new Hono();
  callbacks.route("/api/mcp-oauth", mcpOauthCallbackRoutes(null as unknown as SQL, config, { readRuntime, clientFactory, snapshotStore }));
  return {
    app,
    callbacks,
    runtimeReads: () => runtimeReads,
    hostCapabilityReads: () => hostCapabilityReads,
    inventoryReads: () => inventoryReads,
    managementReads: () => managementReads,
    writes: () => writes,
  };
}

describe("GET /runtime/integrations", () => {
  test("rend l'inventaire réel avec ses états de configuration sans renvoyer de secret", async () => {
    const response = await mount().app.request("/integrations");
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;

    expect(body).toMatchObject({
      runtime: { id: "00000000-0000-4000-8000-000000000101", name: "Hermes privé" },
      support: "available",
      totals: { ready: 1, configurationRequired: 1, disabled: 1, tools: 3, skills: 1 },
      management: {
        writable: false,
        owner: "hermes",
        canConfigure: true,
        settingsPath: "/settings/runtime",
        status: "not_exposed",
        serverCount: null,
      },
      observedAt: "2026-08-26T12:00:00.000Z",
    });
    expect(body.toolsets).toEqual([
      expect.objectContaining({ name: "mcp-github", status: "configuration_required" }),
      expect.objectContaining({ name: "web", status: "ready" }),
      expect.objectContaining({ name: "terminal", status: "disabled" }),
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("server-secret-token");
    expect(serialized).not.toContain("runtime.invalid");
  });

  test("RBAC refuse un membre avant toute lecture DB ou sonde Hermes", async () => {
    const mounted = mount({ role: "member" });
    const response = await mounted.app.request("/integrations");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "ROLE_REQUIRED" } });
    expect(mounted.runtimeReads()).toBe(0);
    expect(mounted.inventoryReads()).toBe(0);
    expect(mounted.managementReads()).toBe(0);
  });

  test("runtime absent et endpoint d'inventaire absent restent distincts d'une liste vide", async () => {
    const missing = await mount({ runtime: false }).app.request("/integrations");
    expect(await missing.json()).toMatchObject({
      runtime: null,
      toolsets: null,
      skills: null,
      support: "unavailable",
      totals: {
        ready: null,
        configurationRequired: null,
        disabled: null,
        tools: null,
        skills: null,
      },
      inventoryError: { code: "RUNTIME_REQUIRED" },
      management: { status: "runtime_missing", serverCount: null },
    });

    const legacy = await mount({ readInventory: async () => ({ toolsets: null, skills: null }) })
      .app.request("/integrations");
    expect(await legacy.json()).toMatchObject({
      runtime: { id: "00000000-0000-4000-8000-000000000101" },
      toolsets: null,
      skills: null,
      support: "unavailable",
      totals: {
        ready: null,
        configurationRequired: null,
        disabled: null,
        tools: null,
        skills: null,
      },
      inventoryError: null,
    });
  });

  test("/v1/skills en échec : les skills viennent de l'opérateur quand l'hôte annonce skills_inventory", async () => {
    const failedSkills = async () => ({ ...inventory, skills: null, skillsFailed: true });
    const hostSkills = [{ name: "plan", description: "Plan workflow", category: "software-development" }];
    const mounted = mount({ readInventory: failedSkills, hostFeatures: ["skills_inventory"], hostSkills: async () => hostSkills });
    const body = await (await mounted.app.request("/integrations")).json() as Record<string, unknown>;
    expect(body).toMatchObject({ skills: [expect.objectContaining({ name: "plan" })], skillsError: null, totals: { skills: 1 } });
    expect(mounted.writes()).toEqual(["host skills"]);
  });

  test("le repli des skills échoue ou n'est pas annoncé : l'erreur d'origine reste affichée, jamais une liste vide", async () => {
    const failedSkills = async () => ({ ...inventory, skills: null, skillsFailed: true });
    const failing = mount({
      readInventory: failedSkills,
      hostFeatures: ["skills_inventory"],
      hostSkills: async () => { throw new HermesClientError("boom", 502, "HERMES_UNREACHABLE"); },
    });
    expect(await (await failing.app.request("/integrations")).json()).toMatchObject({ skills: null, skillsError: { code: "HERMES_SKILLS_UNAVAILABLE" } });

    const unannounced = mount({ readInventory: failedSkills, hostFeatures: [], hostSkills: async () => [] });
    expect(await (await unannounced.app.request("/integrations")).json()).toMatchObject({ skills: null, skillsError: { code: "HERMES_SKILLS_UNAVAILABLE" } });
    expect(unannounced.writes()).toEqual([]);
  });

  test("publie seulement la preuve de frontière d'administration, jamais le corps Hermes", async () => {
    const separateAuth = await mount({
      readManagement: async () => ({
        status: "runtime_token_not_accepted",
        serverCount: null,
      }),
    }).app.request("/integrations");
    expect(await separateAuth.json()).toMatchObject({
      management: { writable: false, status: "runtime_token_not_accepted", serverCount: null },
    });

    const readable = await mount({
      readManagement: async () => ({ status: "read_endpoint_available", serverCount: 2 }),
    }).app.request("/integrations");
    expect(await readable.json()).toMatchObject({
      management: { writable: false, status: "read_endpoint_available", serverCount: 2 },
    });
  });

  test("une sonde d'administration bloquée n'efface pas l'inventaire disponible", async () => {
    const response = await mount({
      timeoutMs: 2,
      readManagement: () => new Promise(() => undefined),
    }).app.request("/integrations");
    expect(await response.json()).toMatchObject({
      support: "available",
      totals: { ready: 1, configurationRequired: 1 },
      inventoryError: null,
      management: { writable: false, status: "unavailable", serverCount: null },
    });
  });

  test("borne la sonde et ferme le diagnostic public même si Hermes contient un secret", async () => {
    const timedOut = await mount({
      timeoutMs: 2,
      readInventory: () => new Promise(() => undefined),
    }).app.request("/integrations");
    expect(await timedOut.json()).toMatchObject({
      toolsets: null,
      inventoryError: { code: "HERMES_INVENTORY_TIMEOUT" },
    });

    const rejected = await mount({
      readInventory: async () => {
        throw new HermesClientError(
          "Le token Hermes a été refusé (réf. deadbeef).",
          401,
          "HERMES_TOKEN_REJECTED",
          { diagnostic: "Authorization: Bearer ultra-secret", reference: "deadbeef" },
        );
      },
    }).app.request("/integrations");
    const body = await rejected.json();
    expect(body).toMatchObject({
      inventoryError: {
        code: "HERMES_TOKEN_REJECTED",
        message: "Hermes a refusé le token enregistré. Remplacez-le depuis les réglages du runtime.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("ultra-secret");
    expect(JSON.stringify(body)).not.toContain("deadbeef");
  });
});

const linear: HermesMcpServer = {
  name: "linear",
  transport: "http",
  endpoint: "https://mcp.linear.app/mcp",
  command: null,
  auth: "header",
  configEnabled: true,
  platformEnabled: true,
  toolsIncluded: null,
  toolsExcluded: null,
  envKeys: ["MCP_LINEAR_API_KEY"],
  discoveredTools: ["create_issue"],
  unreachable: false,
  oauthTokenPresent: null,
};

function post(app: Hono<{ Variables: AppVariables }>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("l'écriture n'existe que si l'hôte l'annonce", () => {
  test("un hôte sans opérateur laisse la page en lecture seule et n'est jamais sondé pour rien", async () => {
    const mounted = mount();
    const body = await (await mounted.app.request("/integrations")).json();
    expect(body.management).toMatchObject({ writable: false, capabilities: { toolsets: false, mcp: false } });
    // Aucun toolset ne porte d'interrupteur : offrir la bascule d'un toolset
    // que l'hôte ne sait pas écrire promettrait un succès impossible.
    expect(body.toolsets.every((toolset: { settable: boolean }) => !toolset.settable)).toBe(true);
    // Et rien n'a été demandé à l'hôte : la capacité absente suffit à décider.
    expect(mounted.writes()).toEqual([]);
    // L'inventaire MCP a sa propre route : il démarre un interpréteur sur
    // l'hôte et ne doit pas peser sur l'affichage de la page.
    const mcp = await (await mounted.app.request("/integrations/mcp")).json();
    expect(mcp).toMatchObject({ available: false, servers: [], catalog: [], error: null });
  });

  test("un hôte capable rend les toolsets qu'il NOMME réglables, et eux seuls", async () => {
    const body = await (await mount({
      hostFeatures: ["provider_management", "toolset_management", "mcp_management"],
      hostToolsets: async () => ({ platform: "api_server", settable: ["web", "terminal"], availability: null }),
      mcpInventory: async () => ({ platform: "api_server", servers: [linear], catalog: [] }),
    }).app.request("/integrations")).json();
    expect(body.management).toMatchObject({ writable: true, capabilities: { toolsets: true, mcp: true } });
    const settable = Object.fromEntries(
      body.toolsets.map((toolset: { name: string; settable: boolean }) => [toolset.name, toolset.settable]),
    );
    expect(settable).toEqual({ web: true, terminal: true, "mcp-github": false });
  });

  test("l'inventaire MCP vit sur sa propre route et ne rend que des clés d'environnement", async () => {
    const mounted = mount({
      hostFeatures: ["mcp_management"],
      mcpInventory: async () => ({ platform: "api_server", servers: [linear], catalog: [] }),
    });
    // La page ne le porte pas : elle n'attend donc jamais l'interpréteur.
    const page = await (await mounted.app.request("/integrations")).json();
    expect("mcp" in page).toBe(false);

    const mcp = await (await mounted.app.request("/integrations/mcp")).json();
    expect(mcp).toMatchObject({ available: true, servers: [{ name: "linear", auth: "header" }] });
    // La valeur d'un `env` MCP est couramment un jeton : seules les clés sortent.
    expect(JSON.stringify(mcp)).not.toContain("Bearer");
  });

  test("une lecture MCP en échec se DIT, au lieu d'une liste vide qu'on lirait « aucun connecteur »", async () => {
    const body = await (await mount({
      hostFeatures: ["mcp_management"],
      mcpInventory: async () => {
        throw new HermesClientError("boom", 502, "HERMES_RESPONSE_INVALID");
      },
    }).app.request("/integrations/mcp")).json();
    expect(body).toMatchObject({ available: true, servers: [], error: { code: "RUNTIME_ADMIN_UNAVAILABLE" } });
  });
});

describe("POST /runtime/integrations/toolsets/:name", () => {
  test("rend l'état RELU par l'hôte, pas celui demandé", async () => {
    const mounted = mount({
      hostFeatures: ["toolset_management"],
      // L'hôte a écrit et l'inventaire dit toujours le contraire : c'est un
      // échec, et l'écran doit pouvoir le dire.
      toolsetSet: async (name, enabled) => ({
        name, platform: "api_server", enabled: false, requested: enabled, applied: false,
      }),
    });
    const response = await post(mounted.app, "/integrations/toolsets/browser", { enabled: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "browser", enabled: false, requested: true, applied: false });
    expect(mounted.writes()).toEqual(["toolset browser true"]);
  });

  test("refuse un toolset interdit AVANT l'aller réseau, et laisse passer sa désactivation", async () => {
    const mounted = mount({
      hostFeatures: ["toolset_management"],
      toolsetSet: async (name, enabled) => ({
        name, platform: "api_server", enabled, requested: enabled, applied: true,
      }),
    });
    const refused = await post(mounted.app, "/integrations/toolsets/memory", { enabled: true });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("TOOLSET_FORBIDDEN");
    expect(mounted.writes()).toEqual([]);

    const allowed = await post(mounted.app, "/integrations/toolsets/memory", { enabled: false });
    expect(allowed.status).toBe(200);
    expect(mounted.writes()).toEqual(["toolset memory false"]);
  });

  test("refuse un nom hors grammaire, un corps sans `enabled`, et un rôle membre", async () => {
    const mounted = mount({ hostFeatures: ["toolset_management"] });
    expect((await post(mounted.app, "/integrations/toolsets/Web-Search", { enabled: true })).status).toBe(400);
    expect((await post(mounted.app, "/integrations/toolsets/web", {})).status).toBe(400);
    expect((await post(mount({ role: "member", hostFeatures: ["toolset_management"] }).app,
      "/integrations/toolsets/web", { enabled: true })).status).toBe(403);
    expect(mounted.writes()).toEqual([]);
  });

  test("un hôte qui n'annonce pas la capacité reçoit un refus qui dit quoi faire", async () => {
    const mounted = mount({ hostFeatures: ["provider_management"] });
    const response = await post(mounted.app, "/integrations/toolsets/web", { enabled: true });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("RUNTIME_ADMIN_UNAVAILABLE");
    expect(body.error.message).toContain("edge-setup");
    expect(mounted.writes()).toEqual([]);
  });
});

describe("MCP piloté depuis OHB", () => {
  test("ajoute un serveur https et ne renvoie jamais le jeton", async () => {
    let seen: HermesMcpServerRequest | null = null;
    const mounted = mount({
      hostFeatures: ["mcp_management"],
      mcpServerAdd: async (request) => {
        seen = request;
        return linear;
      },
    });
    const response = await post(mounted.app, "/integrations/mcp/servers", {
      name: "linear", url: "https://mcp.linear.app/mcp", auth: "header", token: "lin_secret",
    });
    expect(response.status).toBe(200);
    expect(seen).toMatchObject({ name: "linear", auth: "header", token: "lin_secret" });
    expect(JSON.stringify(await response.json())).not.toContain("lin_secret");
  });

  test("refuse une URL non https, un nom hors grammaire et un en-tête sans jeton", async () => {
    const mounted = mount({ hostFeatures: ["mcp_management"], mcpServerAdd: async () => linear });
    for (const body of [
      { name: "linear", url: "http://mcp.linear.app/mcp" },
      { name: "linear", url: "file:///etc/passwd" },
      { name: "bad name", url: "https://mcp.linear.app/mcp" },
      { name: "linear", url: "https://mcp.linear.app/mcp", auth: "header" },
      { name: "linear", url: "https://mcp.linear.app/mcp", auth: "shell" },
    ]) {
      expect((await post(mounted.app, "/integrations/mcp/servers", body)).status).toBe(400);
    }
    expect(mounted.writes()).toEqual([]);
  });

  test("installe une entrée de catalogue et borne ses variables", async () => {
    let seen: Record<string, string> | null = null;
    const mounted = mount({
      hostFeatures: ["mcp_management"],
      mcpCatalogInstall: async (_name, env) => {
        seen = env;
        return linear;
      },
    });
    expect((await post(mounted.app, "/integrations/mcp/catalog/n8n", { env: { N8N_API_KEY: "k" } })).status).toBe(200);
    expect(seen as Record<string, string> | null).toEqual({ N8N_API_KEY: "k" });
    // Une clé hors grammaire ne part pas : c'est le seul endroit où un nom
    // choisi par l'appelant atteindrait le fichier `.env` de l'hôte.
    expect((await post(mounted.app, "/integrations/mcp/catalog/n8n", { env: { "PATH; rm -rf /": "x" } })).status).toBe(400);
    expect((await post(mounted.app, "/integrations/mcp/catalog/n8n", { env: { N8N_API_KEY: "" } })).status).toBe(400);
  });

  test("retire un serveur, et traduit un refus de l'hôte sans texte upstream", async () => {
    const removed = mount({ hostFeatures: ["mcp_management"], mcpServerRemove: async () => undefined });
    expect((await removed.app.request("/integrations/mcp/servers/linear", { method: "DELETE" })).status).toBe(204);

    const missing = mount({
      hostFeatures: ["mcp_management"],
      mcpServerRemove: async () => {
        throw new HermesClientError("no MCP server named ghost is configured", 404, "SERVER_UNKNOWN");
      },
    });
    const response = await missing.app.request("/integrations/mcp/servers/ghost", { method: "DELETE" });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("SERVER_UNKNOWN");

    const broken = mount({
      hostFeatures: ["mcp_management"],
      mcpServerRemove: async () => {
        throw new HermesClientError(
          "Traceback (most recent call last): /srv/hermes/data/config.yaml",
          502,
          "HERMES_RESPONSE_INVALID",
        );
      },
    });
    const opaque = await broken.app.request("/integrations/mcp/servers/linear", { method: "DELETE" });
    expect(opaque.status).toBe(502);
    expect(JSON.stringify(await opaque.json())).not.toContain("Traceback");
  });
});

const notionOauth: HermesMcpOauthSession = {
  sessionId: "sess-1",
  server: "notion",
  status: "pending",
  authorizationUrl: "https://mcp.notion.com/authorize?state=abc",
  error: null,
  errorCode: null,
  discoveredTools: [],
  expiresAt: "2026-08-26T12:15:00.000Z",
};

describe("OAuth MCP piloté depuis OHB", () => {
  test("ouvre l'autorisation avec l'URL de retour de l'API, et seulement si l'hôte annonce mcp_oauth", async () => {
    const mounted = mount({
      hostFeatures: ["mcp_management", "mcp_oauth"],
      mcpOauthStart: async () => notionOauth,
    });
    const response = await post(mounted.app, "/integrations/mcp/servers/notion/oauth", {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "pending", authorizationUrl: "https://mcp.notion.com/authorize?state=abc" });
    expect(mounted.writes()).toEqual([
      "mcp oauth notion https://ohb.example/api/mcp-oauth/callback/org-1/00000000-0000-4000-8000-000000000101/notion",
    ]);

    const silent = mount({ hostFeatures: ["mcp_management"], mcpOauthStart: async () => notionOauth });
    const refused = await post(silent.app, "/integrations/mcp/servers/notion/oauth", {});
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("RUNTIME_ADMIN_UNAVAILABLE");
    expect(silent.writes()).toEqual([]);
    expect((await post(mounted.app, "/integrations/mcp/servers/bad%20name/oauth", {})).status).toBe(400);
  });

  test("relit et annule une autorisation, et traduit une session perdue en 404", async () => {
    const mounted = mount({
      hostFeatures: ["mcp_management", "mcp_oauth"],
      mcpOauthPoll: async (name, sessionId) => {
        if (sessionId !== "sess-1") throw new HermesClientError("gone", 404, "OAUTH_SESSION_NOT_FOUND");
        return { ...notionOauth, status: "connected", discoveredTools: ["search", "fetch"] };
      },
    });
    const read = await mounted.app.request("/integrations/mcp/servers/notion/oauth/sess-1");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ status: "connected", discoveredTools: ["search", "fetch"] });
    expect((await mounted.app.request("/integrations/mcp/servers/notion/oauth/other")).status).toBe(404);
    expect((await mounted.app.request("/integrations/mcp/servers/notion/oauth/sess-1", { method: "DELETE" })).status).toBe(204);
    expect(mounted.writes()).toEqual(["mcp oauth-cancel notion sess-1"]);
  });

  test("le retour du fournisseur est relayé tel quel à l'hôte, sans jamais être rendu dans la page", async () => {
    let seen: unknown = null;
    const mounted = mount({
      mcpOauthCallback: async (_name, callback) => {
        seen = callback;
        return notionOauth;
      },
    });
    const ok = await mounted.callbacks.request(
      "/api/mcp-oauth/callback/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/notion?code=auth-code-xyz&state=abc",
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/html");
    const page = await ok.text();
    expect(page).toContain("Autorisation reçue");
    expect(page).not.toContain("auth-code-xyz");
    expect(seen).toEqual({ code: "auth-code-xyz", state: "abc" });
    // L'émetteur RFC 9207 suit quand le fournisseur l'envoie (Linear) : sans
    // lui, le SDK MCP de l'hôte refuse l'autorisation.
    const withIssuer = await mounted.callbacks.request(
      "/api/mcp-oauth/callback/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/notion?code=c2&state=abc&iss=https%3A%2F%2Fmcp.linear.app",
    );
    expect(withIssuer.status).toBe(200);
    expect(seen).toEqual({ code: "c2", state: "abc", iss: "https://mcp.linear.app" });
    // Le refus du fournisseur voyage comme un refus, et la page le dit sans texte amont.
    const denied = mount({
      mcpOauthCallback: async () => ({ ...notionOauth, status: "failed", errorCode: "OAUTH_CALLBACK_INVALID", error: "state mismatch" }),
    });
    const refused = await denied.callbacks.request(
      "/api/mcp-oauth/callback/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/notion?error=access_denied",
    );
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("OAUTH_CALLBACK_INVALID");
    expect(denied.writes()).toEqual(['mcp oauth-callback notion {"error":"access_denied"}']);
  });

  test("le retour refuse un runtime qui n'est pas celui de l'organisation, un identifiant hors grammaire et un code sans state", async () => {
    const mounted = mount({ mcpOauthCallback: async () => notionOauth });
    for (const [path, status] of [
      ["/api/mcp-oauth/callback/not-a-uuid/00000000-0000-4000-8000-000000000101/notion?code=c&state=s", 404],
      ["/api/mcp-oauth/callback/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000999/notion?code=c&state=s", 404],
      ["/api/mcp-oauth/callback/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/bad%20name?code=c&state=s", 404],
      ["/api/mcp-oauth/callback/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/notion?code=c", 400],
      ["/api/mcp-oauth/callback/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/notion", 400],
    ] as const) {
      expect((await mounted.callbacks.request(path)).status).toBe(status);
    }
    expect(mounted.writes()).toEqual([]);
  });

  test("l'inventaire MCP dit ce que l'hôte annonce en plus : oauth et redémarrage", async () => {
    const withAll = mount({
      hostFeatures: ["mcp_management", "mcp_oauth", "gateway_restart"],
      mcpInventory: async () => ({ platform: "api_server", servers: [{ ...linear, auth: "oauth", oauthTokenPresent: false }], catalog: [] }),
    });
    const body = (await (await withAll.app.request("/integrations/mcp")).json()) as {
      capabilities: { oauth: boolean; gatewayRestart: boolean };
      servers: { oauthTokenPresent: boolean | null }[];
    };
    expect(body.capabilities).toEqual({ oauth: true, gatewayRestart: true });
    expect(body.servers[0]!.oauthTokenPresent).toBe(false);
    const bare = mount({ hostFeatures: ["mcp_management"], mcpInventory: async () => ({ platform: "api_server", servers: [], catalog: [] }) });
    expect(((await (await bare.app.request("/integrations/mcp?fresh=1")).json()) as { capabilities: unknown }).capabilities)
      .toEqual({ oauth: false, gatewayRestart: false });
  });
});

describe("redémarrage du gateway depuis OHB", () => {
  const job: HermesGatewayRestartJob = {
    jobId: "job-1",
    status: "running",
    step: "restart",
    startedAt: "2026-08-26T12:00:00Z",
    finishedAt: null,
    error: null,
    expiresAt: "2026-08-26T12:15:00Z",
  };

  test("lit l'état, lance le seul redémarrage que le lien porte, et le suit", async () => {
    const mounted = mount({
      hostFeatures: ["mcp_management", "gateway_restart"],
      gatewayStatus: async () => ({ restartPending: true, pendingSince: "2026-08-26T11:50:00Z", activeSince: "2026-08-26T10:00:00Z", job: null }),
      gatewayRestart: async () => job,
      gatewayRestartPoll: async (jobId) => {
        if (jobId !== "job-1") throw new HermesClientError("gone", 404, "GATEWAY_RESTART_NOT_FOUND");
        return { ...job, status: "ok", step: "done", finishedAt: "2026-08-26T12:00:40Z" };
      },
    });
    expect(await (await mounted.app.request("/integrations/gateway")).json()).toMatchObject({ restartPending: true, job: null });
    const started = await post(mounted.app, "/integrations/gateway/restart", {});
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ jobId: "job-1", status: "running", step: "restart" });
    expect(await (await mounted.app.request("/integrations/gateway/restart/job-1")).json()).toMatchObject({ status: "ok", step: "done" });
    expect((await mounted.app.request("/integrations/gateway/restart/other")).status).toBe(404);
    expect(mounted.writes()).toEqual(["gateway restart"]);
  });

  test("un hôte qui n'annonce pas gateway_restart ne reçoit ni lecture ni redémarrage, et un membre non plus", async () => {
    const silent = mount({ hostFeatures: ["mcp_management", "mcp_oauth"], gatewayRestart: async () => job });
    expect((await silent.app.request("/integrations/gateway")).status).toBe(409);
    expect((await post(silent.app, "/integrations/gateway/restart", {})).status).toBe(409);
    expect(silent.writes()).toEqual([]);
    const member = mount({ role: "member", hostFeatures: ["gateway_restart"], gatewayRestart: async () => job });
    expect((await post(member.app, "/integrations/gateway/restart", {})).status).toBe(403);
    expect(member.runtimeReads()).toBe(0);
  });
});

function fakeLinkedBots(rows: Array<{ id: string; hermesProfile: string }> = []): SQL {
  const tx = (async (strings: TemplateStringsArray) => {
    const statement = [...strings].join(" ");
    if (statement.includes("set_config")) return [];
    if (statement.includes("from bots")) return rows;
    return [];
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => Promise<unknown>) => Promise<unknown> }).begin = async (callback) =>
    callback(tx);
  return tx;
}

describe("GET /profiles : inventaire du runtime", () => {
  const inventory: HermesProfileInventory = {
    profiles: [{
      name: "scout",
      displayName: "Scout",
      title: "Scout",
      description: "Find sources.",
      soul: "# Scout",
      model: { default: "claude-sonnet-4", provider: "anthropic" },
      uiMeta: {
        title: "Scout", color: "#3b93f0", shape: "circle", imageKind: "generated",
        hidden: false, pinned: true, sectionId: null, groups: ["newsroom"], created: null,
      },
      hasAvatar: true,
      routines: [{ name: "Morning brief", schedule: "30 8 * * 1-5", prompt: "Go", enabled: true, deliver: true, model: null }],
      skills: [],
      toolsets: [],
      mcpServers: [{ name: "linear", enabled: true }],
    }],
  };

  // Each live capabilities read is a fresh Python probe on the host: a read
  // route of a connector runtime trusts what the link already persisted.
  test("un runtime relié lit les capacités enregistrées par le lien, sans aller vers l'hôte", async () => {
    const mounted = mount({
      linkFeatures: ["profile_inventory"],
      hostFeatures: [],
      hostProfileInventory: async () => inventory,
      db: fakeLinkedBots([]),
    });
    const response = await mounted.app.request("/profiles");
    expect(response.status).toBe(200);
    expect(mounted.hostCapabilityReads()).toBe(0);
  });

  test("rend l'inventaire et marque les profils déjà liés", async () => {
    const mounted = mount({
      hostFeatures: ["profile_inventory"],
      hostProfileInventory: async () => inventory,
      db: fakeLinkedBots([{ id: "bot-1", hermesProfile: "scout" }]),
    });
    const response = await mounted.app.request("/profiles");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      profiles: [{
        name: "scout",
        displayName: "Scout",
        title: "Scout",
        description: "Find sources.",
        model: { default: "claude-sonnet-4", provider: "anthropic" },
        hasAvatar: true,
        routineCount: 1,
        routines: [{ name: "Morning brief", schedule: "30 8 * * 1-5", prompt: "Go", enabled: true, deliver: true, model: null }],
        pinned: true,
        hidden: false,
        // Les connexions MCP du bot : ce que lit « Connectés ».
        mcpServers: [{ name: "linear", enabled: true }],
        alreadyImported: true,
        importedBotId: "bot-1",
      }],
      canDelete: false,
    });
  });

  test("canDelete est vrai seulement si l'hôte annonce aussi profile_management", async () => {
    const mounted = mount({
      hostFeatures: ["profile_inventory", "profile_management"],
      hostProfileInventory: async () => inventory,
      db: fakeLinkedBots(),
    });
    const body = await (await mounted.app.request("/profiles")).json() as { canDelete: boolean };
    expect(body.canDelete).toBe(true);
  });

  test("404 PROFILE_INVENTORY_UNAVAILABLE si l'hôte n'annonce pas la feature", async () => {
    const mounted = mount({ hostFeatures: ["mcp_management"], db: fakeLinkedBots() });
    const response = await mounted.app.request("/profiles");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "PROFILE_INVENTORY_UNAVAILABLE" } });
  });

  test("un membre ne sonde pas l'inventaire", async () => {
    const mounted = mount({
      role: "member",
      hostFeatures: ["profile_inventory"],
      hostProfileInventory: async () => inventory,
      db: fakeLinkedBots(),
    });
    expect((await mounted.app.request("/profiles")).status).toBe(403);
    expect(mounted.runtimeReads()).toBe(0);
  });
});

function fakeProfileBots(options: {
  botId?: string | null;
  busy?: boolean;
  inGroup?: boolean;
  calls?: string[];
  /** Un bot dont la suppression de profil a déjà été engagée (0171). */
  deleting?: boolean;
  reserved?: boolean;
} = {}): SQL {
  const calls = options.calls ?? [];
  const botId = options.botId ?? null;
  const tx = (async (strings: TemplateStringsArray) => {
    const statement = [...strings].join(" ");
    calls.push(statement);
    if (statement.includes("set_config")) return [];
    if (statement.includes("from profile_import_items")) return options.reserved ? [{ slug: "scout" }] : [];
    if (statement.includes("update bots b") && statement.includes("host_profile_deleting_at")) {
      return botId ? [{ alreadyDeleting: options.deleting === true, wasArchived: options.deleting === true }] : [];
    }
    if (statement.includes("host_profile_deleting_at is not null") && statement.includes("for update")) {
      return botId && options.deleting ? [{ id: botId }] : [];
    }
    if (statement.includes("delete from bots")) return botId ? [{ id: botId }] : [];
    if (statement.includes("from bots")) return botId ? [{ id: botId, hermesProfile: "scout" }] : [];
    if (statement.includes("from runs r")) {
      return options.busy ? [{ id: "run-1", stepKind: "root", threadId: "thread-1" }] : [];
    }
    if (statement.includes("from group_members")) {
      return options.inGroup ? [{ groupId: "group-1" }] : [];
    }
    return [];
  }) as unknown as SQL;
  (tx as unknown as { begin: (callback: (inner: SQL) => Promise<unknown>) => Promise<unknown> }).begin =
    async (callback) => callback(tx);
  // La route tient le verrou d'import sur une connexion réservée.
  Object.assign(tx, { reserve: async () => Object.assign(tx, { release: () => {}, close: async () => {} }) });
  return tx;
}

describe("DELETE /profiles/:slug", () => {
  const inventory: HermesProfileInventory = {
    profiles: [{
      name: "scout",
      displayName: "Scout",
      title: "Scout",
      description: "Find sources.",
      soul: "# Scout",
      model: { default: "claude-sonnet-4", provider: "anthropic" },
      uiMeta: {
        title: "Scout", color: "#3b93f0", shape: "circle", imageKind: "generated",
        hidden: false, pinned: true, sectionId: null, groups: ["newsroom"], created: null,
      },
      hasAvatar: true,
      routines: [],
      skills: [],
      toolsets: [],
      mcpServers: [],
    }],
  };

  test("400 PROFILE_INVALID pour default", async () => {
    const mounted = mount({
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => inventory,
      hostDeleteProfile: async () => undefined,
      db: fakeProfileBots(),
    });
    const response = await mounted.app.request("/profiles/default", { method: "DELETE" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "PROFILE_INVALID" } });
    expect(mounted.writes()).toEqual([]);
  });

  test("409 RUNTIME_ADMIN_UNAVAILABLE sans profile_management", async () => {
    const mounted = mount({
      hostFeatures: ["profile_inventory"],
      hostProfileInventory: async () => inventory,
      hostDeleteProfile: async () => undefined,
      db: fakeProfileBots(),
    });
    const response = await mounted.app.request("/profiles/scout", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "RUNTIME_ADMIN_UNAVAILABLE" } });
    expect(mounted.writes()).toEqual([]);
  });

  test("404 PROFILE_NOT_FOUND si le slug est absent de l'inventaire", async () => {
    const mounted = mount({
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => ({ profiles: [] }),
      hostDeleteProfile: async () => undefined,
      db: fakeProfileBots(),
    });
    const response = await mounted.app.request("/profiles/scout", { method: "DELETE" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "PROFILE_NOT_FOUND" } });
    expect(mounted.writes()).toEqual([]);
  });

  test("un membre ne supprime pas", async () => {
    const mounted = mount({
      role: "member",
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => inventory,
      hostDeleteProfile: async () => undefined,
      db: fakeProfileBots({ botId: "bot-1" }),
    });
    expect((await mounted.app.request("/profiles/scout", { method: "DELETE" })).status).toBe(403);
    expect(mounted.runtimeReads()).toBe(0);
    expect(mounted.writes()).toEqual([]);
  });

  test("un profil non lié : hostDelete, pas de SQL, botId null", async () => {
    const calls: string[] = [];
    let listed = inventory.profiles;
    const mounted = mount({
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => ({ profiles: listed }),
      hostDeleteProfile: async (slug) => {
        listed = listed.filter((profile) => profile.name !== slug);
      },
      db: fakeProfileBots({ calls }),
    });
    const response = await mounted.app.request("/profiles/scout", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: "scout",
      hostDeleted: true,
      botId: null,
      purgedSessions: 0,
      failedSessions: 0,
    });
    expect(mounted.writes()).toEqual(["hostDelete scout"]);
    expect(calls.some((sql) => sql.includes("delete from bots"))).toBe(false);
  });

  test("un bot lié : deleteSession puis hostDelete puis la ligne SQL", async () => {
    const calls: string[] = [];
    let listed = inventory.profiles;
    const mounted = mount({
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => ({ profiles: listed }),
      hostDeleteProfile: async (slug) => {
        listed = listed.filter((profile) => profile.name !== slug);
      },
      deleteSession: async () => undefined,
      db: fakeProfileBots({ botId: "bot-1", calls }),
    });
    const response = await mounted.app.request("/profiles/scout", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: "scout",
      hostDeleted: true,
      botId: "bot-1",
      purgedSessions: 1,
      failedSessions: 0,
    });
    expect(mounted.writes()[0]?.startsWith("deleteSession ")).toBe(true);
    expect(mounted.writes().at(-1)).toBe("hostDelete scout");
    expect(calls.some((sql) => sql.includes("delete from bots"))).toBe(true);
  });

  test("POST /profiles/delete-jobs 400 si la liste est invalide", async () => {
    const mounted = mount({
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => inventory,
      hostDeleteProfile: async () => undefined,
      db: fakeProfileBots(),
    });
    const response = await mounted.app.request("/profiles/delete-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slugs: ["default"] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "PROFILE_INVALID" } });
    expect(mounted.writes()).toEqual([]);
  });

  test("POST /profiles/delete-jobs 409 sans profile_management", async () => {
    const mounted = mount({
      hostFeatures: ["profile_inventory"],
      hostProfileInventory: async () => inventory,
      hostDeleteProfile: async () => undefined,
      db: fakeProfileBots(),
    });
    const response = await mounted.app.request("/profiles/delete-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slugs: ["scout", "atlas"] }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "RUNTIME_ADMIN_UNAVAILABLE" } });
  });

  test("POST /profiles/delete-jobs : un membre ne file pas", async () => {
    const mounted = mount({
      role: "member",
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => inventory,
      hostDeleteProfile: async () => undefined,
      db: fakeProfileBots(),
    });
    expect((await mounted.app.request("/profiles/delete-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slugs: ["scout", "atlas"] }),
    })).status).toBe(403);
    expect(mounted.runtimeReads()).toBe(0);
  });

  test("hostDelete qui laisse le slug : 502 PROFILE_UNVERIFIED, SQL intact", async () => {
    const calls: string[] = [];
    const mounted = mount({
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => inventory,
      hostDeleteProfile: async () => undefined,
      deleteSession: async () => undefined,
      db: fakeProfileBots({ botId: "bot-1", calls }),
    });
    const response = await mounted.app.request("/profiles/scout", { method: "DELETE" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "PROFILE_UNVERIFIED" } });
    expect(mounted.writes().at(-1)).toBe("hostDelete scout");
    expect(calls.some((sql) => sql.includes("delete from bots"))).toBe(false);
    // Le profil a pu partir : l'état « suppression engagée » reste pour la reprise.
    expect(calls.some((sql) => sql.includes("set host_profile_deleting_at = null"))).toBe(false);
  });

  test("un import qui réserve le slug : 409, ni appel hôte ni écriture", async () => {
    const calls: string[] = [];
    const mounted = mount({
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => inventory,
      hostDeleteProfile: async () => undefined,
      deleteSession: async () => undefined,
      db: fakeProfileBots({ botId: "bot-1", calls, reserved: true }),
    });
    const response = await mounted.app.request("/profiles/scout", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "PROFILE_IMPORT_IN_PROGRESS" } });
    expect(mounted.writes()).toEqual([]);
    expect(calls.some((sql) => sql.includes("pg_advisory_lock"))).toBe(true);
    expect(calls.some((sql) => sql.includes("host_profile_deleting_at"))).toBe(false);
  });

  test("le bot lié est marqué avant l'hôte, ses octets entrent en file avec sa suppression", async () => {
    const calls: string[] = [];
    let listed = inventory.profiles;
    const mounted = mount({
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => ({ profiles: listed }),
      hostDeleteProfile: async (slug) => {
        calls.push("HOST DELETE");
        listed = listed.filter((profile) => profile.name !== slug);
      },
      deleteSession: async () => undefined,
      db: fakeProfileBots({ botId: "bot-1", calls }),
    });
    expect((await mounted.app.request("/profiles/scout", { method: "DELETE" })).status).toBe(200);
    const marked = calls.findIndex((sql) => sql.includes("update bots b") && sql.includes("host_profile_deleting_at"));
    const guard = calls.findIndex((sql) => sql.includes("from runs r") && sql.includes("for update of r"));
    const host = calls.indexOf("HOST DELETE");
    const queued = calls.findIndex((sql) => sql.includes("insert into tenant_blob_deletions"));
    const deleted = calls.findIndex((sql) => sql.includes("delete from bots"));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(marked).toBeGreaterThan(guard);
    expect(host).toBeGreaterThan(marked);
    expect(queued).toBeGreaterThan(host);
    expect(deleted).toBeGreaterThan(queued);
    expect(calls[queued]).toContain("t.bot_id");
  });

  test("une purge de sessions en échec rend le bot tel qu'il était, sans toucher au profil", async () => {
    const calls: string[] = [];
    const mounted = mount({
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => inventory,
      hostDeleteProfile: async () => undefined,
      deleteSession: async () => { throw new HermesClientError("down", 503, "HERMES_OPERATOR_UNAVAILABLE"); },
      db: fakeProfileBots({ botId: "bot-1", calls }),
    });
    const response = await mounted.app.request("/profiles/scout", { method: "DELETE" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "RUNTIME_PURGE_FAILED" } });
    expect(mounted.writes().some((write) => write.startsWith("hostDelete"))).toBe(false);
    expect(calls.some((sql) => sql.includes("set host_profile_deleting_at = null"))).toBe(true);
  });

  test("reprise : profil déjà absent et bot marqué, le nettoyage local se termine", async () => {
    const calls: string[] = [];
    const mounted = mount({
      hostFeatures: ["profile_management"],
      hostProfileInventory: async () => ({ profiles: [] }),
      hostDeleteProfile: async () => undefined,
      db: fakeProfileBots({ botId: "bot-1", calls, deleting: true }),
    });
    const response = await mounted.app.request("/profiles/scout", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      slug: "scout", hostDeleted: true, botId: "bot-1", purgedSessions: 0, failedSessions: 0,
    });
    expect(mounted.writes()).toEqual([]);
    expect(calls.some((sql) => sql.includes("insert into tenant_blob_deletions"))).toBe(true);
    expect(calls.some((sql) => sql.includes("delete from bots"))).toBe(true);
  });
});

describe("snapshot de lecture MCP", () => {
  const empty = async () => ({ platform: "api_server", servers: [], catalog: [] }) as HermesMcpInventory;

  function countingMount(extra: Parameters<typeof mount>[0] = {}) {
    let reads = 0;
    const harness = mount({
      hostFeatures: ["mcp_management"],
      mcpInventory: async () => {
        reads += 1;
        return empty();
      },
      mcpServerRemove: async () => undefined,
      ...extra,
    });
    return { ...harness, reads: () => reads };
  }

  test("le second GET sert le snapshot, ?fresh=1 relit sur l'hôte", async () => {
    const { app, reads } = countingMount();
    await app.request("/integrations/mcp");
    await app.request("/integrations/mcp");
    expect(reads()).toBe(1);
    await app.request("/integrations/mcp?fresh=1");
    expect(reads()).toBe(2);
  });

  test("une écriture MCP invalide le snapshot", async () => {
    const { app, reads } = countingMount();
    await app.request("/integrations/mcp");
    const removed = await app.request("/integrations/mcp/servers/github", { method: "DELETE" });
    expect(removed.status).toBe(204);
    await app.request("/integrations/mcp");
    expect(reads()).toBe(2);
  });

  test("un échec de lecture n'est pas gardé", async () => {
    let calls = 0;
    const { app } = countingMount({
      mcpInventory: async () => {
        calls += 1;
        if (calls === 1) throw new HermesClientError("down", 502, "HERMES_UNREACHABLE");
        return empty();
      },
    });
    await app.request("/integrations/mcp");
    await app.request("/integrations/mcp");
    expect(calls).toBe(2);
  });
});

// The MCP URL reaches the console and the snapshot table: neither may carry a
// credential, whether in the userinfo, the path or a query value.
describe("adresse d'un serveur du catalogue", () => {
  test("le serveur du catalogue garde son adresse entière ; un homonyme vers ailleurs est réduit", async () => {
    const server = (endpoint: string, auth: "oauth" | "header") => ({
      name: "linear", transport: "http", endpoint, command: null, auth,
      configEnabled: true, platformEnabled: true, toolsIncluded: null, toolsExcluded: null, envKeys: [],
      discoveredTools: null, unreachable: false, oauthTokenPresent: true,
    }) as HermesMcpServer;
    const read = async (servers: HermesMcpServer[]) => {
      const mounted = mount({
        hostFeatures: ["mcp_management"],
        mcpInventory: async () => ({ platform: "api_server", servers, catalog: [] }) as unknown as HermesMcpInventory,
      });
      const body = (await (await mounted.app.request("/integrations/mcp")).json()) as { servers: Array<{ endpoint: string | null }> };
      return body.servers.map((entry) => entry.endpoint);
    };
    expect(await read([server("https://mcp.linear.app/mcp/", "oauth")])).toEqual(["https://mcp.linear.app/mcp"]);
    expect(await read([server("https://evil.example/mcp/secret", "oauth")])).toEqual(["https://evil.example/..."]);
    expect(await read([server("https://mcp.linear.app/mcp", "header")])).toEqual(["https://mcp.linear.app/..."]);
  });
});

describe("publicEndpoint", () => {
  test("keeps the origin only: no userinfo, path, query or fragment", () => {
    expect(publicEndpoint("https://user:pass@mcp.example.com/v1/sse?token=abc#frag")).toBe("https://mcp.example.com/...");
    expect(publicEndpoint("https://actions.example.com/mcp/sk-path-secret/sse")).toBe("https://actions.example.com/...");
    expect(publicEndpoint("https://mcp.example.com:8443/")).toBe("https://mcp.example.com:8443");
    expect(publicEndpoint("not a url")).toBeNull();
    expect(publicEndpoint(null)).toBeNull();
  });
});

describe("connecter une entrée du catalogue à un bot", () => {
  const botId = "00000000-0000-4000-8000-0000000000b1";
  function botDb(profile: string | null | undefined): SQL {
    const tx = ((strings: TemplateStringsArray) => {
      const sql = [...strings].join(" ");
      if (sql.includes('hermes_profile as "profile"')) return Promise.resolve(profile === undefined ? [] : [{ profile }]);
      return Promise.resolve([]);
    }) as unknown as SQL;
    (tx as unknown as { begin: (callback: (inner: SQL) => unknown) => Promise<unknown> }).begin =
      async (callback: (inner: SQL) => unknown) => callback(tx);
    return tx;
  }
  const linearOauth: HermesMcpOauthSession = { ...notionOauth, server: "linear", authorizationUrl: "https://mcp.linear.app/authorize?state=p" };
  const linearServer = {
    name: "linear", transport: "http", endpoint: "https://mcp.linear.app/mcp", command: null, auth: "oauth",
    configEnabled: false, platformEnabled: false, toolsIncluded: null, toolsExcluded: null, envKeys: [],
    discoveredTools: null, unreachable: true, oauthTokenPresent: false,
  } as HermesMcpServer;
  const features = ["mcp_management", "mcp_oauth", "mcp_oauth_profile"];

  test("ajoute le serveur du catalogue à la racine puis ouvre l'autorisation POUR LE PROFIL du bot", async () => {
    const added: HermesMcpServerRequest[] = [];
    const mounted = mount({
      hostFeatures: features,
      db: botDb("dev"),
      mcpInventory: async () => ({ platform: "api_server", servers: [], catalog: [] }) as unknown as HermesMcpInventory,
      mcpServerAdd: async (request) => { added.push(request); return linearServer; },
      mcpOauthStart: async () => linearOauth,
    });
    const response = await post(mounted.app, "/integrations/mcp/connectors/linear/connect", { botId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "pending", server: "linear", authorizationUrl: "https://mcp.linear.app/authorize?state=p" });
    // L'URL vient du catalogue, jamais de l'écran.
    expect(added).toEqual([{ name: "linear", url: "https://mcp.linear.app/mcp", auth: "oauth" }]);
    expect(mounted.writes()).toEqual([
      "mcp add linear",
      "mcp oauth linear https://ohb.example/api/mcp-oauth/callback/org-1/00000000-0000-4000-8000-000000000101/linear profile=dev",
    ]);
  });

  test("réutilise le serveur déjà présent, et refuse un homonyme vers une autre adresse sans le remplacer", async () => {
    const same = mount({
      hostFeatures: features,
      db: botDb("dev"),
      mcpInventory: async () => ({ platform: "api_server", servers: [{ ...linearServer, endpoint: "https://mcp.linear.app/mcp/" }], catalog: [] }) as unknown as HermesMcpInventory,
      mcpOauthStart: async () => linearOauth,
    });
    expect((await post(same.app, "/integrations/mcp/connectors/linear/connect", { botId })).status).toBe(200);
    expect(same.writes()).toEqual([expect.stringMatching(/^mcp oauth linear .* profile=dev$/)]);

    const other = mount({
      hostFeatures: features,
      db: botDb("dev"),
      mcpInventory: async () => ({ platform: "api_server", servers: [{ ...linearServer, endpoint: "https://evil.example/mcp" }], catalog: [] }) as unknown as HermesMcpInventory,
      mcpOauthStart: async () => linearOauth,
    });
    const refused = await post(other.app, "/integrations/mcp/connectors/linear/connect", { botId });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("MCP_SERVER_NAME_TAKEN");
    expect(other.writes()).toEqual([]);
  });

  test("un double clic qui perd la course à l'ajout repart sur le serveur gagnant", async () => {
    let reads = 0;
    const mounted = mount({
      hostFeatures: features,
      db: botDb("dev"),
      mcpInventory: async () => {
        reads += 1;
        return { platform: "api_server", servers: reads === 1 ? [] : [linearServer], catalog: [] } as unknown as HermesMcpInventory;
      },
      mcpServerAdd: async () => { throw new HermesClientError("exists", 409, "SERVER_EXISTS"); },
      mcpOauthStart: async () => linearOauth,
    });
    expect((await post(mounted.app, "/integrations/mcp/connectors/linear/connect", { botId })).status).toBe(200);
  });

  const disconnectFeatures = [...features, "mcp_profile_disconnect"];
  const del = (app: Hono<{ Variables: AppVariables }>, path: string) => app.request(path, { method: "DELETE" });

  test("déconnecte l'entrée du catalogue du PROFIL du bot, sans toucher la racine", async () => {
    const mounted = mount({
      hostFeatures: disconnectFeatures,
      db: botDb("dev"),
      hostRemoveProfileMcpServer: async (profile, name) => ({ profile, name, removed: true, tokensRemoved: true }),
    });
    const response = await del(mounted.app, `/integrations/mcp/connectors/linear/connections/${botId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connector: "linear", botId, removed: true, tokensRemoved: true });
    expect(mounted.writes()).toEqual(["mcp disconnect linear profile=dev"]);
  });

  test("déconnexion : sans la feature, sans profil, hors catalogue ou membre, rien ne part vers l'hôte", async () => {
    const remove = async (profile: string, name: string) => ({ profile, name, removed: true, tokensRemoved: true });
    const cases: Array<[Parameters<typeof mount>[0], string, string, number, string]> = [
      [{ hostFeatures: features, db: botDb("dev") }, "linear", botId, 409, "RUNTIME_ADMIN_UNAVAILABLE"],
      [{ hostFeatures: disconnectFeatures, db: botDb(null) }, "linear", botId, 409, "BOT_PROFILE_REQUIRED"],
      [{ hostFeatures: disconnectFeatures, db: botDb(undefined) }, "linear", botId, 404, "BOT_NOT_FOUND"],
      [{ hostFeatures: disconnectFeatures, db: botDb("dev") }, "linear", "nope", 400, "BOT_INVALID"],
      [{ hostFeatures: disconnectFeatures, db: botDb("dev") }, "github", botId, 404, "CONNECTOR_UNKNOWN"],
      [{ hostFeatures: disconnectFeatures, db: botDb("dev"), role: "member" }, "linear", botId, 403, ""],
    ];
    for (const [options, id, target, status, code] of cases) {
      const mounted = mount({ ...options, hostRemoveProfileMcpServer: remove });
      const response = await del(mounted.app, `/integrations/mcp/connectors/${id}/connections/${target}`);
      expect([id, target, response.status]).toEqual([id, target, status]);
      if (code) expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
      expect(mounted.writes()).toEqual([]);
    }
  });

  test("sans mcp_oauth_profile, sans profil ou hors catalogue : rien ne part vers l'hôte", async () => {
    const cases: Array<[Parameters<typeof mount>[0], string, unknown, number, string]> = [
      [{ hostFeatures: ["mcp_management", "mcp_oauth"], db: botDb("dev") }, "linear", { botId }, 409, "RUNTIME_ADMIN_UNAVAILABLE"],
      [{ hostFeatures: features, db: botDb(null) }, "linear", { botId }, 409, "BOT_PROFILE_REQUIRED"],
      [{ hostFeatures: features, db: botDb(undefined) }, "linear", { botId }, 404, "BOT_NOT_FOUND"],
      [{ hostFeatures: features, db: botDb("dev") }, "linear", { botId: "nope" }, 400, "BOT_INVALID"],
      [{ hostFeatures: features, db: botDb("dev") }, "github", { botId }, 404, "CONNECTOR_UNKNOWN"],
    ];
    for (const [options, id, body, status, code] of cases) {
      const mounted = mount({ ...options, mcpOauthStart: async () => linearOauth, mcpServerAdd: async () => linearServer });
      const response = await post(mounted.app, `/integrations/mcp/connectors/${id}/connect`, body);
      expect([id, response.status]).toEqual([id, status]);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
      expect(mounted.writes()).toEqual([]);
    }
  });
});
