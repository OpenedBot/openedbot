/**
 * In-memory stand-in for the `edge-setup` host operator (`/hermes-setup/*`)
 * and for the gateway reads that depend on its state (`/v1/toolsets`,
 * `/v1/skills`, root or `/p/<slug>`). Wire shapes, refusal codes and HTTP
 * statuses follow `edge-setup/internal/operator/` (mcp.go, gateway.go,
 * mcp_oauth.go, toolsets.go, profile_capabilities.go, inventory_probe.py) so
 * every answer parses with `platform/hermes/src/parsers.ts`.
 *
 * What the Marketplace install flow re-reads is stateful and deterministic:
 *
 *   - every MCP write (add, catalogue install, remove, profile enable, OAuth
 *     approval) sets the restart-pending marker, like `markGatewayRestartPending`;
 *   - the gateway only "loads" MCP servers when a restart job completes, so
 *     `discoveredTools` stays absent from the inventory until then, and an
 *     `auth: oauth` server is only loaded once it holds a token;
 *   - a restart job advances one step per read of the job (poll or
 *     `GET /hermes-setup/gateway`), never on a timer: running/restart, then
 *     running/health, then ok/done after `restartReads` reads.
 *
 * Nothing here runs a command, reads a file or reaches a network: the fake
 * OAuth authorization URL points at a reserved `.invalid` host.
 */
import type { HermesHostProfile } from "../../platform/hermes/src/contracts";
import { validBlockedTools } from "../../platform/hermes/src/parsers/profiles";
import {
  ALWAYS_FORBIDDEN_TOOLSETS,
  PROFILE_RESTRICTED_TOOLSETS,
} from "../../modules/runtimes/src/domain/runtime-contract";
import catalogFixture from "./fixtures/mcp-catalog.json";
import skillsFixture from "./fixtures/skills.json";
import skillsHubFixture from "./fixtures/skills-hub.json";
import toolsetsFixture from "./fixtures/toolsets.json";

export type FakeToolsetFixture = {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  tools: string[];
};

export type FakeMcpCatalogFixture = {
  name: string;
  description: string | null;
  source: string | null;
  authType: string;
  authProvider: string | null;
  transport: "http" | "stdio";
  requiresInstall: boolean;
  envSpecs: Array<{ name: string; description: string | null; required: boolean; secret: boolean }>;
  /** Private to the fake: what the installed server points at and lists after a restart. */
  endpoint: string | null;
  command: string | null;
  tools: string[];
};

export type FakeSkillFixture = { name: string; description: string; category: string };
export type FakeSkillFinding = { severity: "critical" | "high" | "medium" | "low"; category: string; description: string; file: string | null; line: number | null };
export type FakeSkillsHubFixture = {
  name: string;
  identifier: string;
  source: string;
  trustLevel: "official" | "trusted" | "builtin" | "community";
  description: string;
  tags: string[];
  skillMdPreview: string | null;
};

export const FAKE_TOOLSETS: readonly FakeToolsetFixture[] = toolsetsFixture as FakeToolsetFixture[];
export const FAKE_MCP_CATALOG: readonly FakeMcpCatalogFixture[] = catalogFixture.entries as FakeMcpCatalogFixture[];
/** Tools a custom (non-catalogue) MCP server lists once the gateway loaded it. */
export const FAKE_CUSTOM_MCP_TOOLS: readonly string[] = catalogFixture.customServerTools;
export const FAKE_SKILLS: readonly FakeSkillFixture[] = skillsFixture as FakeSkillFixture[];
export const FAKE_SKILLS_HUB: readonly FakeSkillsHubFixture[] = skillsHubFixture as FakeSkillsHubFixture[];

/** Features the fake operator announces: only verbs it actually serves. */
export const FAKE_HOST_FEATURES = [
  "provider_management",
  "toolset_management",
  "mcp_management",
  "mcp_oauth",
  "gateway_restart",
  "profile_inventory",
  "profile_management",
  "profile_capabilities",
  "sessions_inventory",
  "skills_hub",
  "approval_policy",
] as const;

const PLATFORM = "api_server";
const RESTART_JOB_TTL_MS = 15 * 60_000;
const OAUTH_SESSION_TTL_MS = 10 * 60_000;
const FAKE_OAUTH_AUTHORIZE_URL = "https://oauth.fake-hermes.invalid/authorize";

const PROFILE_SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const TOOLSET_NAME = /^[a-z0-9][a-z0-9_]{0,63}$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SESSION_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const CONTROL = /[\u0000-\u001F\u007F]/u;
const SKILLS_HUB_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;

export type FakeHostOptions = {
  /** Reads of a running restart job before it settles to ok/done (minimum 1). */
  restartReads?: number;
  /** Clock, for tests that pin timestamps. */
  now?: () => Date;
};

type FakeMcpServer = {
  name: string;
  transport: "http" | "stdio";
  endpoint: string | null;
  command: string | null;
  auth: "none" | "header" | "oauth";
  envKeys: string[];
  tools: readonly string[];
  oauthToken: boolean;
};

type FakeProfile = {
  row: Omit<HermesHostProfile, "toolsets" | "skills" | "mcpServers">;
  toolsets: Map<string, boolean>;
  skills: Map<string, boolean>;
  mcpServers: Map<string, boolean>;
  /** `policy.json` plus `plugins.enabled`, as `approval_policy.go` re-reads them; null before the first write. */
  approvalPolicy: { mode: "ask_writes" | "block_writes" | "off"; pluginEnabled: boolean; blockedTools: string[] } | null;
};

type RestartJob = {
  jobId: string;
  status: "running" | "ok" | "failed";
  step: "restart" | "health" | "done";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  expiresAt: string;
  reads: number;
};

type OauthSession = {
  sessionId: string;
  server: string;
  status: "starting" | "pending" | "connected" | "failed" | "cancelled";
  authorizationUrl: string | null;
  error: string | null;
  errorCode: string | null;
  discoveredTools: string[];
  expiresAt: string;
  state: string;
};

export type FakeHost = {
  /** Answers a `/hermes-setup/*` route, or `null` when the path is not one. */
  handleHostRoute(request: Request, path: string): Promise<Response | null>;
  /** `/v1/toolsets` for the root (`profile` null) or a named profile. */
  toolsetsDocument(profile: string | null): unknown;
  /** `/v1/skills` for the root (`profile` null) or a named profile. */
  skillsDocument(profile: string | null): unknown;
  hasProfile(name: string): boolean;
};

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const restartReads = Math.max(1, options.restartReads ?? 2);
  const clock = options.now ?? (() => new Date());
  let sequence = 0;
  const nextId = () => (++sequence).toString(16).padStart(32, "0");
  const stamp = (offsetMs = 0) => rfc3339(new Date(clock().getTime() + offsetMs));

  const rootToolsets = new Map(FAKE_TOOLSETS.map((toolset) => [toolset.name, toolset.enabled]));
  const servers = new Map<string, FakeMcpServer>();
  const profiles = new Map<string, FakeProfile>();
  const oauthSessions = new Map<string, OauthSession>();
  const skillOperations = new Map<string, { profile: string; identifier: string; reads: number; state: "queued" | "running" | "succeeded" | "failed"; error: { code: string; detail: string } | null }>();
  let pendingSince: string | null = null;
  let activeSince = stamp();
  let restart: RestartJob | null = null;
  /** What the running gateway loaded at its last start: server name to tools. */
  let loaded = new Map<string, readonly string[]>();

  const markRestartPending = () => {
    pendingSince ??= stamp();
  };

  const settleRestart = (job: RestartJob) => {
    job.status = "ok";
    job.step = "done";
    job.finishedAt = stamp();
    job.expiresAt = stamp(RESTART_JOB_TTL_MS);
    activeSince = job.finishedAt;
    pendingSince = null;
    loaded = new Map([...servers.values()]
      .filter((server) => server.auth !== "oauth" || server.oauthToken)
      .map((server) => [server.name, [...server.tools]]));
  };

  /** One read of the current job: it advances, then is viewed. */
  const readRestart = (): RestartJob | null => {
    if (restart && restart.status !== "running" && clock().getTime() > Date.parse(restart.expiresAt)) restart = null;
    if (restart?.status === "running") {
      restart.reads += 1;
      if (restart.reads >= restartReads) settleRestart(restart);
      else restart.step = "health";
    }
    return restart;
  };

  const serverView = (server: FakeMcpServer) => ({
    name: server.name,
    transport: server.transport,
    endpoint: server.endpoint,
    command: server.command,
    auth: server.auth,
    configEnabled: true,
    platformEnabled: true,
    toolsIncluded: null,
    toolsExcluded: null,
    envKeys: [...server.envKeys].sort(),
    // `omitempty` on the host: absent until the gateway loaded the server.
    ...(loaded.has(server.name) ? { discoveredTools: [...loaded.get(server.name)!] } : {}),
    oauthTokenPresent: server.auth === "oauth" ? server.oauthToken : null,
  });

  const catalogView = (entry: FakeMcpCatalogFixture) => ({
    name: entry.name,
    description: entry.description,
    source: entry.source,
    authType: entry.authType,
    authProvider: entry.authProvider,
    transport: entry.transport,
    requiresInstall: entry.requiresInstall,
    envSpecs: entry.envSpecs.map((spec) => ({ ...spec })),
  });

  const profileView = (profile: FakeProfile): HermesHostProfile => ({
    ...profile.row,
    toolsets: flags(profile.toolsets),
    skills: flags(profile.skills),
    mcpServers: flags(profile.mcpServers),
  });

  const oauthView = (session: OauthSession) => ({
    sessionId: session.sessionId,
    server: session.server,
    status: session.status,
    authorizationUrl: session.authorizationUrl,
    error: session.error,
    errorCode: session.errorCode,
    discoveredTools: [...session.discoveredTools],
    expiresAt: session.expiresAt,
  });

  const toolsetState = (name: string, enabled: boolean, requested: boolean, profile?: string) => ({
    name,
    ...(profile ? { profile } : {}),
    platform: PLATFORM,
    enabled,
    requested,
    applied: enabled === requested,
  });

  async function handleToolsets(request: Request, rest: string): Promise<Response | null> {
    if (rest === "" && request.method === "GET") {
      const names = FAKE_TOOLSETS.map((toolset) => toolset.name).sort();
      return json({
        platform: PLATFORM,
        settable: names,
        availability: names.map((name) => ({ name, available: true, reason: null })),
      });
    }
    const name = /^\/([^/]+)$/.exec(rest)?.[1];
    if (name === undefined || request.method !== "POST") return null;
    if (!TOOLSET_NAME.test(name)) return refuse(400, "TOOLSET_INVALID", "the toolset name is invalid");
    const body = await readBody(request);
    if (!body || typeof body.enabled !== "boolean") return refuse(400, "BODY_INVALID", "the body must be {\"enabled\": true|false}");
    if (body.enabled && (ALWAYS_FORBIDDEN_TOOLSETS.has(name) || PROFILE_RESTRICTED_TOOLSETS.has(name))) {
      return refuse(403, "TOOLSET_FORBIDDEN", `${name} runs work outside the run openedbot leases and journals; it stays off on this host`);
    }
    if (!rootToolsets.has(name)) return refuse(404, "TOOLSET_NOT_SETTABLE", `this host does not offer ${name} on the ${PLATFORM} platform`);
    rootToolsets.set(name, body.enabled);
    return json(toolsetState(name, rootToolsets.get(name)!, body.enabled));
  }

  async function handleMcp(request: Request, rest: string): Promise<Response | null> {
    const method = request.method;
    if (rest === "/servers" && method === "GET") {
      return json({
        platform: PLATFORM,
        servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)).map(serverView),
        catalog: FAKE_MCP_CATALOG.map(catalogView),
      });
    }
    if (rest === "/servers" && method === "POST") return addServer(request);
    const install = /^\/catalog\/([^/]+)$/.exec(rest);
    if (install && method === "POST") return installCatalogEntry(request, decodeURIComponent(install[1]!));
    const oauth = /^\/servers\/([^/]+)\/oauth(?:\/([^/]+))?$/.exec(rest);
    if (oauth) return handleOauth(request, decodeURIComponent(oauth[1]!), oauth[2] === undefined ? null : decodeURIComponent(oauth[2]));
    const remove = /^\/servers\/([^/]+)$/.exec(rest);
    if (remove && method === "DELETE") {
      const name = decodeURIComponent(remove[1]!);
      if (!MCP_NAME.test(name)) return refuse(400, "NAME_INVALID", "the server name is invalid");
      if (!servers.delete(name)) return refuse(404, "SERVER_UNKNOWN", `no MCP server named ${name} is configured`);
      markRestartPending();
      return new Response(null, { status: 204 });
    }
    return null;
  }

  async function addServer(request: Request): Promise<Response> {
    const body = await readBody(request);
    if (!body) return refuse(400, "BODY_INVALID", "request body is not JSON");
    if (body.command !== undefined && body.command !== null) {
      return refuse(400, "STDIO_REFUSED", "the link carries no executable toward the host; add an https endpoint, or install a catalogue entry");
    }
    const name = typeof body.name === "string" ? body.name : "";
    if (!MCP_NAME.test(name)) return refuse(400, "NAME_INVALID", "the server name must be 1-64 characters of [A-Za-z0-9_-]");
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url || url.length > 2_048) return refuse(400, "URL_INVALID", "the endpoint URL is missing or too long");
    if (!url.startsWith("https://")) return refuse(400, "URL_INVALID", "the endpoint URL must be https://");
    if (CONTROL.test(url)) return refuse(400, "URL_INVALID", "the endpoint URL contains control characters");
    const auth = body.auth === undefined || body.auth === "" ? "none" : body.auth;
    if (auth !== "none" && auth !== "header" && auth !== "oauth") return refuse(400, "AUTH_INVALID", "auth must be none, header or oauth");
    if (servers.has(name) && body.replace !== true) {
      return refuse(409, "SERVER_EXISTS", `a server named ${name} already exists; pass replace to overwrite it`);
    }
    if (auth === "header" && !validSecret(body.token)) return refuse(400, "SECRET_INVALID", "the bearer token is missing or invalid");
    const server: FakeMcpServer = {
      name, transport: "http", endpoint: url, command: null, auth, envKeys: [], tools: FAKE_CUSTOM_MCP_TOOLS, oauthToken: false,
    };
    servers.set(name, server);
    markRestartPending();
    return json(serverView(server));
  }

  async function installCatalogEntry(request: Request, pathName: string): Promise<Response> {
    const body = await readBody(request);
    if (!body) return refuse(400, "BODY_INVALID", "request body is not JSON");
    const name = typeof body.name === "string" ? body.name : pathName;
    if (!MCP_NAME.test(name)) return refuse(400, "NAME_INVALID", "the server name must be 1-64 characters of [A-Za-z0-9_-]");
    const entry = FAKE_MCP_CATALOG.find((candidate) => candidate.name === name);
    if (!entry) return refuse(404, "CATALOG_ENTRY_UNKNOWN", `${name} is not an entry of this host's MCP catalogue`);
    const supplied = body.env && typeof body.env === "object" && !Array.isArray(body.env)
      ? body.env as Record<string, unknown>
      : {};
    const declared = new Map(entry.envSpecs.map((spec) => [spec.name, spec.required]));
    const unknown = Object.keys(supplied).filter((key) => !declared.has(key)).sort();
    if (unknown.length) return refuse(400, "ENV_UNKNOWN", `this catalogue entry declares no variable named ${unknown[0]}`);
    const missing = [...declared].filter(([key, required]) => required && !supplied[key]).map(([key]) => key).sort();
    if (missing.length) return refuse(400, "ENV_REQUIRED", `this catalogue entry requires a value for ${missing[0]}`);
    for (const [key, value] of Object.entries(supplied)) {
      if (!validSecret(value)) return refuse(400, "SECRET_INVALID", `the value of ${key} is missing or invalid`);
    }
    const auth = entry.authType === "oauth" ? "oauth" : entry.authType === "api_key" && entry.transport === "http" ? "header" : "none";
    const previous = servers.get(name);
    const server: FakeMcpServer = {
      name,
      transport: entry.transport,
      endpoint: entry.endpoint,
      command: entry.command,
      auth,
      envKeys: Object.keys(supplied),
      tools: entry.tools,
      oauthToken: auth === "oauth" && previous?.oauthToken === true,
    };
    servers.set(name, server);
    markRestartPending();
    return json(serverView(server));
  }

  async function handleOauth(request: Request, server: string, tail: string | null): Promise<Response | null> {
    if (!MCP_NAME.test(server)) return refuse(400, "NAME_INVALID", "the server name is invalid");
    const method = request.method;
    const now = clock().getTime();
    for (const [id, session] of oauthSessions) {
      if (now > Date.parse(session.expiresAt)) oauthSessions.delete(id);
    }
    if (tail === null && method === "POST") {
      const body = await readBody(request);
      if (!body) return refuse(400, "BODY_INVALID", "request body is not JSON");
      if (!validRedirectUri(body.redirectUri)) {
        return refuse(400, "REDIRECT_INVALID", "the redirect URI must be https:// (or a loopback http:// origin)");
      }
      const open = [...oauthSessions.values()].find((session) =>
        session.server === server && (session.status === "starting" || session.status === "pending"));
      if (open) {
        return json({
          error: { code: "MCP_OAUTH_IN_PROGRESS", message: `an authorization is already pending for ${server}` },
          session: oauthView(open),
        }, 409);
      }
      const sessionId = nextId();
      const session: OauthSession = {
        sessionId, server, status: "pending", authorizationUrl: null, error: null, errorCode: null,
        discoveredTools: [], expiresAt: stamp(OAUTH_SESSION_TTL_MS), state: `fake-state-${sessionId}`,
      };
      const target = servers.get(server);
      if (!target) {
        Object.assign(session, { status: "failed", errorCode: "SERVER_UNKNOWN", error: `no MCP server named ${server} is configured` });
      } else if (target.auth !== "oauth") {
        Object.assign(session, { status: "failed", errorCode: "OAUTH_UNSUPPORTED", error: `${server} is not an auth: oauth server` });
      } else {
        const url = new URL(FAKE_OAUTH_AUTHORIZE_URL);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", "fake-hermes");
        url.searchParams.set("redirect_uri", body.redirectUri as string);
        url.searchParams.set("state", session.state);
        session.authorizationUrl = url.toString();
      }
      oauthSessions.set(sessionId, session);
      return json(oauthView(session));
    }
    if (tail === "callback" && method === "POST") {
      const body = await readBody(request);
      if (!body) return refuse(400, "BODY_INVALID", "request body is not JSON");
      const code = typeof body.code === "string" ? body.code : "";
      const state = typeof body.state === "string" ? body.state : "";
      const error = typeof body.error === "string" ? body.error : "";
      if (code.length > 4_096 || state.length > 4_096 || error.length > 200
        || CONTROL.test(code) || CONTROL.test(state) || CONTROL.test(error) || (!code && !error)) {
        return refuse(400, "BODY_INVALID", "the callback must carry a code and a state, or an error");
      }
      const session = [...oauthSessions.values()].find((candidate) => candidate.server === server && candidate.status === "pending");
      if (!session) return refuse(404, "OAUTH_SESSION_NOT_FOUND", `no authorization is waiting for a callback for ${server}`);
      if (error) {
        Object.assign(session, { status: "failed", errorCode: "OAUTH_FAILED", error: "the provider refused the authorization" });
      } else if (state === session.state) {
        // A state from another attempt is ignored and the session keeps
        // waiting, like the host's program on a mismatch.
        const target = servers.get(server);
        if (target) target.oauthToken = true;
        session.status = "connected";
        session.discoveredTools = [...(target?.tools ?? [])];
        markRestartPending();
      }
      return json(oauthView(session));
    }
    if (tail !== null && tail !== "callback" && (method === "GET" || method === "DELETE")) {
      const session = SESSION_ID.test(tail) ? oauthSessions.get(tail) : undefined;
      if (!session || session.server !== server) return refuse(404, "OAUTH_SESSION_NOT_FOUND", "this authorization no longer exists");
      if (method === "GET") return json(oauthView(session));
      if (session.status === "starting" || session.status === "pending") session.status = "cancelled";
      return new Response(null, { status: 204 });
    }
    return null;
  }

  async function handleGateway(request: Request, rest: string): Promise<Response | null> {
    if (rest === "" && request.method === "GET") {
      const job = readRestart();
      return json({ restartPending: pendingSince !== null, pendingSince, activeSince, job: job ? restartView(job) : null });
    }
    if (rest === "/restart" && request.method === "POST") {
      if (restart?.status === "running") {
        return json({
          error: { code: "GATEWAY_RESTART_IN_PROGRESS", message: "a gateway restart is already running" },
          job: restartView(restart),
        }, 409);
      }
      restart = {
        jobId: nextId(), status: "running", step: "restart", startedAt: stamp(), finishedAt: null,
        error: null, expiresAt: stamp(RESTART_JOB_TTL_MS), reads: 0,
      };
      return json(restartView(restart), 202);
    }
    const poll = /^\/restart\/([^/]+)$/.exec(rest);
    if (poll && request.method === "GET") {
      const id = decodeURIComponent(poll[1]!);
      const job = SESSION_ID.test(id) && restart?.jobId === id ? readRestart() : null;
      if (!job || job.jobId !== id) return refuse(404, "GATEWAY_RESTART_NOT_FOUND", "this restart no longer exists");
      return json(restartView(job));
    }
    return null;
  }

  async function handleProviders(request: Request, rest: string): Promise<Response | null> {
    const route = /^\/([^/]+)\/(credentials|oauth)(?:\/([^/]+))?$/.exec(rest);
    if (!route) return null;
    const provider = decodeURIComponent(route[1]!);
    if (!PROVIDER_SLUG.test(provider)) return refuse(400, "PROVIDER_INVALID", "provider slug is invalid");
    if (route[2] === "credentials" && route[3] === undefined && request.method === "POST") {
      const body = await readBody(request);
      if (!body || !validSecret(body.apiKey)) return refuse(400, "API_KEY_INVALID", "the API key is missing or invalid");
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : provider;
      // The fake proves nothing it cannot re-read: only its own provider is confirmed.
      return json({
        provider, label, verification: provider === "fake" ? "confirmed" : "unverified",
        detail: provider === "fake" ? null : "the fake host cannot verify this provider",
      });
    }
    if (route[2] === "oauth" && route[3] === undefined && request.method === "POST") {
      return json({
        sessionId: nextId(), provider, status: "failed", verificationUri: null, userCode: null,
        error: "device-code login is not available on the fake host", expiresAt: stamp(OAUTH_SESSION_TTL_MS),
      });
    }
    if (route[2] === "oauth" && route[3] !== undefined && (request.method === "GET" || request.method === "DELETE")) {
      return refuse(404, "OAUTH_SESSION_NOT_FOUND", "this authorization no longer exists");
    }
    return null;
  }

  async function handleSkillsHub(request: Request, rest: string): Promise<Response | null> {
    if (rest === "/hub/search" && request.method === "POST") {
      const body = await readBody(request);
      const query = typeof body?.query === "string" ? body.query : "";
      const source = body?.source === undefined ? null : typeof body.source === "string" ? body.source : "";
      const limit = body?.limit === undefined ? 25 : body.limit;
      if (!query.trim() || query.length > 100 || CONTROL.test(query)) return refuse(400, "SKILL_QUERY_INVALID", "the skill query is invalid");
      if (source !== null && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(source)) return refuse(400, "SKILL_SOURCE_INVALID", "the skill source is invalid");
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 25) return refuse(400, "SKILL_QUERY_INVALID", "the skill limit is invalid");
      const needle = query.toLowerCase();
      return json(FAKE_SKILLS_HUB.filter((skill) =>
        (!source || skill.source === source) && [skill.name, skill.identifier, skill.description].some((value) => value.toLowerCase().includes(needle)),
      ).slice(0, limit as number).map(({ tags: _tags, skillMdPreview: _preview, ...result }) => result));
    }
    if (rest === "/hub/inspect" && request.method === "POST") {
      const body = await readBody(request);
      const identifier = typeof body?.identifier === "string" ? body.identifier : "";
      const skill = FAKE_SKILLS_HUB.find((candidate) => candidate.identifier === identifier);
      if (!SKILLS_HUB_IDENTIFIER.test(identifier) || identifier.includes("..") || identifier.includes("//") || identifier.includes(":") || /\s/u.test(identifier)) return refuse(400, "SKILL_IDENTIFIER_INVALID", "the skill identifier is invalid");
      if (!skill) return refuse(404, "SKILL_IDENTIFIER_INVALID", "the skill identifier is unknown");
      return json(skill);
    }
    return null;
  }

  async function handleProfiles(request: Request, rest: string): Promise<Response | null> {
    const method = request.method;
    if (rest === "" && method === "GET") return json({ profiles: [...profiles.values()].map(profileView) });
    if (rest === "" && method === "POST") {
      const body = await readBody(request) ?? {};
      const name = String(body.name ?? "");
      if (!PROFILE_SLUG.test(name) || name === "default") return refuse(400, "PROFILE_INVALID", "Invalid profile");
      if (profiles.has(name)) return refuse(409, "PROFILE_EXISTS", "Existing profile");
      // A profile clones the root config (toolsets) and the bundled skills;
      // `memory` is on, as on a profile `edge-setup` isolates.
      const profile: FakeProfile = {
        row: {
          name,
          displayName: typeof body.displayName === "string" ? body.displayName : name,
          title: null,
          description: null,
          soul: null,
          model: {
            provider: typeof body.provider === "string" ? body.provider : "fake",
            default: typeof body.model === "string" ? body.model : "fake/hermes",
          },
          uiMeta: null,
          hasAvatar: false,
          routines: [],
        },
        toolsets: new Map([...rootToolsets, ["memory", true]]),
        skills: new Map(FAKE_SKILLS.map((skill) => [skill.name, true])),
        mcpServers: new Map(),
        approvalPolicy: null,
      };
      profiles.set(name, profile);
      return json({ profile: profileView(profile) }, 201);
    }
    const scoped = /^\/([^/]+)(?:\/(.*))?$/.exec(rest);
    if (!scoped) return null;
    const profile = profiles.get(decodeURIComponent(scoped[1]!));
    if (!profile) return refuse(404, "PROFILE_NOT_FOUND", "Unknown profile");
    const sub = scoped[2];
    if (sub === undefined && method === "DELETE") {
      profiles.delete(profile.row.name);
      return new Response(null, { status: 204 });
    }
    const scan = /^skills\/hub\/(scan|install)$/.exec(sub ?? "");
    if (scan && method === "POST") {
      const body = await readBody(request);
      const identifier = typeof body?.identifier === "string" ? body.identifier : "";
      const skill = FAKE_SKILLS_HUB.find((candidate) => candidate.identifier === identifier);
      if (!SKILLS_HUB_IDENTIFIER.test(identifier) || identifier.includes("..") || identifier.includes("//") || identifier.includes(":") || /\s/u.test(identifier)) return refuse(400, "SKILL_IDENTIFIER_INVALID", "the skill identifier is invalid");
      if (!skill) return refuse(404, "SKILL_IDENTIFIER_INVALID", "the skill identifier is unknown");
      if (scan[1] === "scan") return json({ trustLevel: skill.trustLevel, source: skill.source, verdict: "safe", policy: "allow", findings: [] satisfies FakeSkillFinding[] });
      if (skill.source === "community") return refuse(409, "SKILL_TRUST_REFUSED", "the community skill is not trusted for installation");
      const operationId = crypto.randomUUID();
      skillOperations.set(operationId, { profile: profile.row.name, identifier, reads: 0, state: "queued", error: null });
      return json({ operationId }, 202);
    }
    const operation = /^skills\/hub\/operations\/([^/]+)$/.exec(sub ?? "");
    if (operation && method === "GET") {
      const operationId = decodeURIComponent(operation[1]!);
      const current = skillOperations.get(operationId);
      if (!current || current.profile !== profile.row.name) return refuse(404, "OPERATION_INTERRUPTED", "the skill operation no longer exists");
      current.reads += 1;
      if (current.reads >= 2) {
        current.state = "succeeded";
        if (!profile.skills.has(current.identifier)) profile.skills.set(current.identifier, true);
      } else {
        current.state = "running";
      }
      return json({ operationId, profile: current.profile, identifier: current.identifier, state: current.state, error: current.error, skills: current.state === "succeeded" ? flags(profile.skills).map((flag) => flag.name) : null });
    }
    const remove = /^skills\/([^/]+)$/.exec(sub ?? "");
    if (remove && method === "DELETE") {
      const skill = decodeURIComponent(remove[1]!);
      if (!skill || skill.includes("..") || skill.includes("//") || skill.includes(":") || /\s/u.test(skill)) return refuse(400, "SKILL_IDENTIFIER_INVALID", "the skill name is invalid");
      if (!profile.skills.delete(skill)) return refuse(404, "SKILL_NOT_FOUND", "no skill with that name is installed on the profile");
      return json({ profile: profile.row.name, skill, skills: flags(profile.skills).map((flag) => flag.name) });
    }
    if (sub === "approval-policy" && (method === "GET" || method === "PUT")) {
      // `approvalPolicyHandler`: a first activation of the plugin marks the
      // restart pending (plugins load at gateway start), and the policy is
      // effective only once enabled with no restart pending.
      // A PUT without `blockedTools` keeps the list on file; the fake host
      // always installs the current plugin, so `gateIdentity` is true.
      if (method === "PUT") {
        const policyBody = await readBody(request);
        const mode = policyBody?.mode;
        const blocked = policyBody?.blockedTools;
        const keysValid = !policyBody || Object.keys(policyBody).every((key) => key === "mode" || key === "blockedTools");
        if (!policyBody || !keysValid || (mode !== "ask_writes" && mode !== "block_writes" && mode !== "off")
          || (blocked !== undefined && !(Array.isArray(blocked) && validBlockedTools(blocked)))) {
          return refuse(400, "BODY_INVALID", "the approval policy mode is invalid");
        }
        if (!profile.approvalPolicy?.pluginEnabled) markRestartPending();
        profile.approvalPolicy = { mode, pluginEnabled: true, blockedTools: blocked !== undefined ? [...blocked] : profile.approvalPolicy?.blockedTools ?? [] };
      }
      if (!profile.approvalPolicy) return refuse(502, "APPROVAL_POLICY_UNAVAILABLE", "the profile approval policy could not be read safely");
      return json({ ...profile.approvalPolicy, effective: profile.approvalPolicy.pluginEnabled && pendingSince === null, gateIdentity: true });
    }
    if (method !== "POST" || sub === undefined) return null;
    const body = await readBody(request);
    if (sub === "model") {
      if (!body) return refuse(400, "BODY_INVALID", "request body is not JSON");
      profile.row.model = { provider: String(body.provider), default: String(body.model) };
      return json({ profile: profile.row.name, provider: body.provider, model: body.model });
    }
    const capability = /^(toolsets|skills|mcp\/servers)\/([^/]+)$/.exec(sub);
    if (!capability) return null;
    const name = decodeURIComponent(capability[2]!);
    const kind = capability[1]!;
    if (kind === "toolsets" && !TOOLSET_NAME.test(name)) return refuse(400, "TOOLSET_INVALID", "the toolset name is invalid");
    if (kind === "skills" && !SKILL_NAME.test(name)) return refuse(400, "SKILL_INVALID", "the skill name is invalid");
    if (kind === "mcp/servers" && !MCP_NAME.test(name)) return refuse(400, "NAME_INVALID", "the server name is invalid");
    if (!body || typeof body.enabled !== "boolean") return refuse(400, "BODY_INVALID", "the body must be {\"enabled\": true|false}");
    const wanted = body.enabled;
    const slug = profile.row.name;
    if (kind === "toolsets") {
      if (wanted && ALWAYS_FORBIDDEN_TOOLSETS.has(name)) {
        return refuse(403, "TOOLSET_FORBIDDEN", `${name} runs work outside the run openedbot leases and journals; it stays off on this host`);
      }
      if (!rootToolsets.has(name)) return refuse(404, "TOOLSET_NOT_SETTABLE", `this host does not offer ${name} on the ${PLATFORM} platform`);
      profile.toolsets.set(name, wanted);
      return json(toolsetState(name, profile.toolsets.get(name)!, wanted, slug));
    }
    if (kind === "skills") {
      if (!profile.skills.has(name)) return refuse(404, "SKILL_NOT_FOUND", `no skill named ${name} is installed on the profile`);
      profile.skills.set(name, wanted);
      return json(toolsetState(name, profile.skills.get(name)!, wanted, slug));
    }
    // The profile copies the root entry on first enable; without one there
    // is nothing to copy.
    if (!servers.has(name) && !profile.mcpServers.has(name)) {
      return refuse(404, "MCP_SERVER_NOT_FOUND", `no MCP server named ${name} is configured at the runtime root`);
    }
    profile.mcpServers.set(name, wanted);
    markRestartPending();
    return json(toolsetState(name, profile.mcpServers.get(name)!, wanted, slug));
  }

  return {
    async handleHostRoute(request, path) {
      const route = /^\/hermes-setup(\/[a-z-]+)(.*)$/.exec(path);
      if (!route) return null;
      const [, family, rest = ""] = route;
      switch (family) {
        case "/capabilities":
          return rest === "" && request.method === "GET" ? json({ features: [...FAKE_HOST_FEATURES] }) : null;
        case "/toolsets":
          return handleToolsets(request, rest);
        case "/mcp":
          return handleMcp(request, rest);
        case "/gateway":
          return handleGateway(request, rest);
        case "/providers":
          return handleProviders(request, rest);
        case "/skills":
          return handleSkillsHub(request, rest);
        case "/profiles":
          return handleProfiles(request, rest);
        default:
          return null;
      }
    },

    toolsetsDocument(profile) {
      const state = profile === null ? rootToolsets : profiles.get(profile)?.toolsets ?? rootToolsets;
      return {
        object: "list",
        platform: PLATFORM,
        data: FAKE_TOOLSETS.map((toolset) => ({ ...toolset, tools: [...toolset.tools], enabled: state.get(toolset.name) === true })),
      };
    },

    skillsDocument(profile) {
      // Upstream lists every installed skill, disabled ones included
      // (`skip_disabled=False`); the enabled flag lives in the host inventory.
      const installed = profile === null ? null : profiles.get(profile)?.skills;
      const allSkills = [
        ...FAKE_SKILLS,
        ...FAKE_SKILLS_HUB.map((skill) => ({ name: skill.identifier, description: skill.description, category: skill.source })),
      ];
      const data = installed ? allSkills.filter((skill) => installed.has(skill.name)).map((skill) => ({ ...skill })) : [];
      return { object: "list", data };
    },

    hasProfile(name) {
      return profiles.has(name);
    },
  };
}

function restartView(job: RestartJob) {
  return {
    jobId: job.jobId,
    status: job.status,
    step: job.step,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    expiresAt: job.expiresAt,
  };
}

function flags(state: Map<string, boolean>) {
  return [...state].map(([name, enabled]) => ({ name, enabled }));
}

function validSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_000 && !CONTROL.test(value);
}

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2_048 || CONTROL.test(value) || /[ \t]/.test(value)) return false;
  return value.startsWith("https://")
    || ["http://localhost:", "http://localhost/", "http://127.0.0.1:", "http://127.0.0.1/"].some((prefix) => value.startsWith(prefix));
}

/** Seconds precision, like the host's `time.RFC3339`. */
function rfc3339(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function refuse(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
