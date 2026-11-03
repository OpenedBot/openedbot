import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotDto, BotCapabilitiesDto, ToolErrorPageDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../src/lib/i18n";
import { BotCapabilitiesPanel, ToolErrorsSection } from "../../src/components/bot-capabilities-panel";

const realFetch = globalThis.fetch;

beforeEach(() => window.localStorage.setItem("ohb:locale", "fr"));
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

function mockToolErrors(page: ToolErrorPageDto, seen: string[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    if (url.includes("/tool-errors")) {
      return new Response(JSON.stringify(page), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ToolErrorsSection bot={{ id: "bot-1", threadId: "thread-1" }} open />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function renderCapabilities(dto: BotCapabilitiesDto, requests: string[], pane: "skills" | "mcp" = "skills") {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/capabilities/toolsets/") || url.includes("/capabilities/mcp/") || url.includes("/capabilities/skills/")) {
      return Response.json({ name: "web", profile: "scout", platform: "api_server", enabled: false, requested: false, applied: true });
    }
    if (url.includes("/capabilities")) return Response.json(dto);
    if (url.includes("/tool-errors")) return Response.json({ errors: [], nextCursor: null });
    return Response.json({});
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <BotCapabilitiesPanel bot={{ id: "bot-1", threadId: "thread-1", slug: "scout" } as BotDto} open pane={pane} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

test("liste les erreurs d'outils : message rédigé ou aveu d'absence, et lien vers le run dans le fil", async () => {
  const seen: string[] = [];
  mockToolErrors({
    errors: [
      {
        id: "e-1", botId: "bot-1", threadId: "thread-1", runId: "c48ad03c-d8bc-4afa-9d82-4328fe44f333", userId: "user-1",
        tool: "skill_manage", toolCallId: "tc_6", errorMessage: null, durationMs: 27, occurredAt: "2026-09-03T10:00:00.000Z",
      },
      {
        id: "e-2", botId: "bot-1", threadId: "thread-2", runId: "run-2", userId: null,
        tool: "terminal", toolCallId: "tc_0", errorMessage: "exit 2: no such file", durationMs: 5, occurredAt: "2026-09-03T09:00:00.000Z",
      },
    ],
    nextCursor: null,
  }, seen);
  const { container } = renderSection();

  await waitFor(() => expect(screen.getByText("skill_manage")).toBeTruthy());
  expect(seen.some((url) => url.includes("/api/bots/bot-1/tool-errors"))).toBe(true);
  expect(screen.getByText("Le runtime n’a transmis aucun message d’erreur.")).toBeTruthy();
  expect(screen.getByText("exit 2: no such file")).toBeTruthy();
  const links = [...container.querySelectorAll<HTMLAnchorElement>("a")].map((a) => a.getAttribute("href"));
  expect(links).toEqual([
    "/bot/bot-1?focus=run%3Ac48ad03c-d8bc-4afa-9d82-4328fe44f333",
    "/bot/bot-1?task=thread-2&focus=run%3Arun-2",
  ]);
  expect(screen.queryByText("Charger plus")).toBeNull();
});

test("sans erreur enregistrée, le dit", async () => {
  mockToolErrors({ errors: [], nextCursor: null }, []);
  renderSection();
  await waitFor(() => expect(screen.getByText("Aucun échec d’outil enregistré pour ce bot.")).toBeTruthy());
});

const profileCapabilities: BotCapabilitiesDto = {
  botId: "bot-1",
  hermesProfile: "scout",
  scope: "profile",
  writable: true,
  profileManagement: true,
  runtimeName: "Hermes",
  toolsets: [
    { name: "web", label: "Web", description: null, enabled: true, configured: true, tools: [], available: null, unavailableReason: null },
    { name: "memory", label: "Memory", description: null, enabled: true, configured: true, tools: [], available: null, unavailableReason: null },
    { name: "cronjob", label: "Cron", description: null, enabled: false, configured: true, tools: [], available: null, unavailableReason: null },
  ],
  skills: [{ name: "research", description: "Find sources.", category: "work", enabled: true, writable: true }],
  mcpServers: [{ name: "linear", enabled: false, transport: "http", tools: ["issues"], unreachable: false }],
  usage: [],
  usageWindowDays: 30,
  inventoryError: null,
};

test("Skills montre les outils du profil, pas les serveurs MCP", async () => {
  const requests: string[] = [];
  renderCapabilities(profileCapabilities, requests);

  await waitFor(() => expect(screen.getByText(/^Ces capacités valent seulement pour @scout\./)).toBeTruthy());
  // Profil inscriptible : la note dit qu'une bascule vaut dès le prochain message (0163).
  expect(screen.getByText(/vaut dès son prochain message, y compris dans une conversation déjà commencée/)).toBeTruthy();
  expect(screen.getByText("Mémoire propre à ce profil, sur le runtime.")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Activer research" })).toBeTruthy();
  expect(screen.queryByText("Serveurs MCP")).toBeNull();
  expect(screen.queryByText("linear")).toBeNull();
  const switches = screen.getAllByRole("switch");
  expect(switches).toHaveLength(4);
  expect(screen.getByRole("switch", { name: "Memory" })).toHaveProperty("disabled", false);
  expect(screen.getByRole("switch", { name: "Cron" })).toHaveProperty("disabled", true);
  expect(screen.getByText("Interdit par le contrat openedbot.")).toBeTruthy();
  fireEvent.click(screen.getByRole("switch", { name: "Web" }));
  await waitFor(() => expect(requests.some((entry) => entry.includes("POST /api/bots/bot-1/capabilities/toolsets/web"))).toBe(true));
});

test("MCP est une rubrique à part : serveurs du profil, sans skills", async () => {
  const requests: string[] = [];
  renderCapabilities(profileCapabilities, requests, "mcp");

  await waitFor(() => expect(screen.getByText("Serveurs MCP")).toBeTruthy());
  expect(screen.getByText("linear")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Memory" })).toBeNull();
  expect(screen.queryByRole("switch", { name: "Activer research" })).toBeNull();
  expect(screen.getAllByRole("switch")).toHaveLength(1);
  fireEvent.click(screen.getByRole("switch", { name: "linear" }));
  await waitFor(() => expect(requests.some((entry) => entry.includes("POST /api/bots/bot-1/capabilities/mcp/linear"))).toBe(true));
});

test("sans profil Hermes, MCP dit pourquoi la liste n'est pas là", async () => {
  renderCapabilities({
    ...profileCapabilities,
    hermesProfile: null,
    scope: "runtime",
    mcpServers: null,
  }, [], "mcp");

  await waitFor(() => expect(screen.getByText(/se règlent par profil Hermes/)).toBeTruthy());
  expect(screen.queryByText("linear")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});

test("bascule une skill du profil et relit l'état", async () => {
  const requests: string[] = [];
  renderCapabilities({
    botId: "bot-1",
    hermesProfile: "scout",
    scope: "profile",
    writable: true,
    profileManagement: true,
    runtimeName: "Hermes",
    toolsets: [],
    skills: [{ name: "research", description: "Find sources.", category: "work", enabled: true, writable: true }],
    mcpServers: [],
    usage: [],
    usageWindowDays: 30,
    inventoryError: null,
  }, requests);

  await waitFor(() => expect(screen.getByRole("switch", { name: "Activer research" })).toBeTruthy());
  fireEvent.click(screen.getByRole("switch", { name: "Activer research" }));
  await waitFor(() => expect(requests.some((entry) => entry.includes("POST /api/bots/bot-1/capabilities/skills/research"))).toBe(true));
});

function renderMcpCatalog(linkFeatures: string[], requests: string[], dto: BotCapabilitiesDto = profileCapabilities) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(`${init?.method ?? "GET"} ${url}${init?.body ? ` ${String(init.body)}` : ""}`);
    if (url.includes("/mcp/connectors/")) {
      return Response.json({
        sessionId: "s-1", server: "notion", status: "pending", authorizationUrl: "https://mcp.notion.com/authorize?state=p",
        error: null, errorCode: null, discoveredTools: [], expiresAt: "2026-10-31T12:00:00Z",
      });
    }
    if (url.includes("/mcp/servers/notion/oauth/s-1")) {
      return Response.json({
        sessionId: "s-1", server: "notion", status: "pending", authorizationUrl: "https://mcp.notion.com/authorize?state=p",
        error: null, errorCode: null, discoveredTools: [], expiresAt: "2026-10-31T12:00:00Z",
      });
    }
    if (url.endsWith("/api/runtime")) {
      return Response.json({ runtime: { id: "rt-1", name: "Hermes", linkFeatures }, runtimeMode: "external" });
    }
    if (url.includes("/capabilities")) return Response.json(dto);
    return Response.json({});
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <BotCapabilitiesPanel bot={{ id: "bot-1", threadId: "thread-1", slug: "scout", hermesProfile: "scout" } as BotDto} open pane="mcp" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

test("le catalogue propose ce que le profil ne porte pas, et « Connecter » autorise pour CE bot", async () => {
  const requests: string[] = [];
  renderMcpCatalog(["mcp_management", "mcp_oauth", "mcp_oauth_profile"], requests);

  await waitFor(() => expect(screen.getByText("Catalogue")).toBeTruthy());
  // Linear est déjà porté par le profil : une seule fois, dans la liste du bot.
  expect(screen.getByText("linear")).toBeTruthy();
  expect(screen.queryByText(/^Linear/)).toBeNull();
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Connecter" })[0]!.hasAttribute("disabled")).toBe(false));
  // Le serveur du catalogue déjà porté se réautorise d'ici.
  expect(screen.getByRole("button", { name: "Reconnecter" })).toBeTruthy();
  const notionRow = screen.getByText(/^Notion/).closest("li")!;
  fireEvent.click(notionRow.querySelector("button")!);
  await waitFor(() => expect(requests.some((entry) => entry.startsWith("POST") && entry.includes("/api/runtime/integrations/mcp/connectors/notion/connect") && entry.includes('"botId":"bot-1"'))).toBe(true));
  // Le fournisseur s'ouvre par un lien cliqué : pas de fenêtre qu'un navigateur bloquerait.
  await waitFor(() => expect(screen.getByRole("link", { name: /Ouvrir/ }).getAttribute("href")).toBe("https://mcp.notion.com/authorize?state=p"));
  // Une boîte ouverte : un second clic n'en démarre pas une autre.
  expect(screen.getAllByRole("button", { name: "Connecter" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
  // Pendant qu'une autorisation est ouverte, « Reconnecter » n'en ouvre pas une autre.
  expect(screen.queryByRole("button", { name: "Reconnecter" })).toBeNull();
});

test("sans mcp_oauth_profile, le catalogue dit pourquoi et ne connecte rien", async () => {
  const requests: string[] = [];
  renderMcpCatalog(["mcp_management", "mcp_oauth"], requests);

  await waitFor(() => expect(screen.getByText(/annonce mcp_oauth_profile/)).toBeTruthy());
  expect(screen.getAllByRole("button", { name: "Connecter" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
  expect(screen.queryByRole("button", { name: "Reconnecter" })).toBeNull();
  expect(requests.some((entry) => entry.includes("/connectors/"))).toBe(false);
});
