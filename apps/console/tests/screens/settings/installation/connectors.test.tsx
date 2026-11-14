import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type {
  BotDto,
  RuntimeConfigurationDto,
  RuntimeIntegrationInventoryDto,
  RuntimeIntegrationMcpDto,
  RuntimeProfileMcpServerDto,
  RuntimePublicDto,
} from "@openedbot/contracts-api";
import { I18nProvider } from "../../../../src/lib/i18n";
import { ConnectorsSettings } from "../../../../src/screens/settings/installation/connectors";
import { filterCatalog } from "../../../../src/screens/settings/installation/connectors/connectors-mcp";

const realFetch = globalThis.fetch;

/**
 * What « Ajouter » reads: the session (role) and the roster. An owner
 * by default; one bot with a Hermes profile, one without, one archived.
 */
let sessionRole = "owner";
const rosterBots = [
  { id: "bot-dev", name: "Dev", slug: "dev", hermesProfile: "dev", archivedAt: null },
  { id: "bot-cto", name: "CTO", slug: "cto", hermesProfile: null, archivedAt: null },
  { id: "bot-old", name: "Ancien", slug: "old", hermesProfile: "old", archivedAt: "2026-10-01T00:00:00.000Z" },
] as BotDto[];

function sessionRoute(url: string): Response | null {
  if (url.includes("/api/auth/me")) {
    return Response.json({
      user: { id: "user-1", email: "owner@example.test", displayName: "Owner" },
      organization: { id: "org-1", slug: "acme", name: "Acme" },
      role: sessionRole,
      features: {},
    });
  }
  if (url.includes("/api/bots")) return Response.json({ bots: rosterBots, sections: [], groups: [] });
  return null;
}

const inventory: RuntimeIntegrationInventoryDto = {
  runtime: { id: "rt-1", name: "Hermes" },
  toolsets: [
    {
      name: "github",
      label: "GitHub",
      description: "Issues et PRs",
      status: "ready",
      enabled: true,
      configured: true,
      tools: ["search", "issues"],
      settable: false,
      forbidden: false,
    },
    {
      name: "browser",
      label: "Browser",
      description: "Navigation",
      status: "ready",
      enabled: true,
      configured: true,
      tools: ["open", "snapshot"],
      settable: false,
      forbidden: false,
    },
    {
      name: "terminal",
      label: "Terminal",
      description: null,
      status: "configuration_required",
      enabled: true,
      configured: false,
      tools: ["exec"],
      settable: false,
      forbidden: false,
    },
  ],
  skills: [
    { name: "research", description: "Briefing", category: "writing", enabled: true, writable: false },
  ],
  skillsError: null,
  support: "available",
  totals: {
    ready: 2,
    configurationRequired: 1,
    disabled: 0,
    tools: 5,
    skills: 1,
  },
  inventoryError: null,
  management: {
    writable: false,
    capabilities: { toolsets: false, mcp: false },
    owner: "hermes",
    canConfigure: false,
    settingsPath: "/settings/runtime",
    status: "not_exposed",
    serverCount: null,
  },
  observedAt: "2026-08-31T12:00:00.000Z",
};

/**
 * The inventory as the route returns it when the organization has no
 * runtime: no toolsets, no skills, and the cause named by the API.
 */
const emptyInventory: RuntimeIntegrationInventoryDto = {
  runtime: null,
  toolsets: null,
  skills: null,
  skillsError: null,
  support: "unavailable",
  totals: { ready: null, configurationRequired: null, disabled: null, tools: null, skills: null },
  inventoryError: {
    code: "RUNTIME_REQUIRED",
    message: "Aucun runtime Hermes actif : l’inventaire ne peut pas être lu.",
  },
  management: {
    writable: false,
    capabilities: { toolsets: false, mcp: false },
    owner: "hermes",
    canConfigure: true,
    settingsPath: "/settings/runtime",
    status: "runtime_missing",
    serverCount: null,
  },
  observedAt: "2026-08-31T12:00:00.000Z",
};

const declaredRuntime: RuntimePublicDto = {
  id: "rt-1",
  name: "Hermes",
  configured: true,
  baseUrl: "https://hermes.example.test",
  transport: "connector",
  reachability: "connector",
  link: null,
  management: { kind: "manual", credentialsWritable: false, oauthWritable: false },
  isDefault: true,
  isActive: true,
  tokenConfigured: true,
  botCount: 0,
  selectedProvider: null,
  selectedModel: null,
  reasoningEffort: null,
  detectedVersion: null,
  capabilities: null,
  capacity: 4,
  lastHealthStatus: "healthy",
  lastHealthError: null,
  lastCheckedAt: null,
  createdAt: null,
  updatedAt: null,
};

/** What `/api/runtime` declares: for this screen, only `runtime` decides. */
const configuration: RuntimeConfigurationDto = {
  runtime: declaredRuntime,
  runtimeMode: "external",
  adminMode: "disabled",
  devDefaults: null,
};

function stubFetch(
  payload: RuntimeIntegrationInventoryDto | "error" = inventory,
  runtimeConfiguration: RuntimeConfigurationDto = configuration,
) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const session = sessionRoute(url);
    if (session) return session;
    if (url.includes("/api/runtime/integrations/mcp")) return Response.json(mcpInventory);
    if (url.includes("/api/runtime/integrations")) {
      if (payload === "error") {
        return new Response(JSON.stringify({ error: { code: "HERMES_UNREACHABLE", message: "down" } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json(payload);
    }
    if (url.includes("/api/runtime")) return Response.json(runtimeConfiguration);
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
}

/** No runtime declared: both routes state the same absence. */
function stubWithoutRuntime(runtimeMode: RuntimeConfigurationDto["runtimeMode"] = "external") {
  stubFetch(emptyInventory, { ...configuration, runtime: null, runtimeMode });
}

/** The whole API is unreachable: neither route answers. */
function stubApiDown() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: "INTERNAL", message: "down" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function setViewport(width: number, height = 800) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function renderConnectors() {
  const rootRoute = createRootRoute({ component: Outlet });
  const connectorsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/connectors",
    component: ConnectorsSettings,
  });
  const runtimeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/runtime",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([connectorsRoute, runtimeRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/connectors"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router as never} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
  setViewport(1280);
  stubFetch();
});

afterEach(() => {
  cleanup();
  sessionRole = "owner";
  globalThis.fetch = realFetch;
  window.localStorage.clear();
  setViewport(1024);
});

describe("connecteurs : bureau, catalogue en lignes", () => {
  test("trois rubriques, le catalogue d'openedbot à la une puis par catégorie", async () => {
    renderConnectors();
    await waitFor(() => expect(document.querySelector("[data-connectors-layout='desktop-catalog']")).toBeTruthy());
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["Connecteurs", "Compétences", "Outils"]);
    expect(screen.getByRole("tab", { name: "Connecteurs" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("searchbox", { name: "Rechercher dans cette rubrique" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Nouveau connecteur/ })).toBeTruthy();

    // Featured first, in the chosen order; an entry appears only once.
    const featured = screen.getByRole("region", { name: "À la une" });
    expect(within(featured).getAllByRole("button", { name: /^Ajouter .* à un bot$/ }).map((button) => button.getAttribute("aria-label")))
      .toEqual(["Notion", "Linear", "Cloudflare"].map((name) => `Ajouter ${name} à un bot`));
    // The whole catalog is featured: no empty category section.
    expect(screen.queryByRole("region", { name: "Développement" })).toBeNull();
    expect(screen.getByText("Pages, bases et recherche dans l’espace Notion.")).toBeTruthy();
    expect(document.querySelector("[data-connector-logo='notion'] svg path")).toBeTruthy();

    // The detail of the toolsets and skills stays in its section.
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.queryByText("research")).toBeNull();
    expect(screen.queryByText("hermes mcp list")).toBeNull();
    expect(document.querySelector("[data-mobile-action-footer]")).toBeNull();
  });

  // The skeleton announced three large empty cards: a different page from
  // the one that arrives. It now takes up the catalog's frame.
  test("pendant la première lecture, le squelette a la charpente du catalogue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const loaded = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/runtime/integrations")) await gate;
      return loaded(input, init);
    }) as typeof fetch;
    renderConnectors();
    const skeleton = await waitFor(() => {
      const node = document.querySelector("[data-connectors-layout='desktop-skeleton']");
      expect(node).toBeTruthy();
      return node!;
    });
    expect(skeleton.getAttribute("role")).toBe("status");
    expect(skeleton.querySelectorAll("ul").length).toBeGreaterThan(0);
    expect(skeleton.querySelectorAll("li").length).toBeGreaterThan(0);
    release();
    await waitFor(() => expect(document.querySelector("[data-connectors-layout='desktop-catalog']")).toBeTruthy());
    expect(document.querySelector("[data-connectors-layout='desktop-skeleton']")).toBeNull();
  });

  test("la recherche filtre les lignes de toutes les sections, et dit quand rien ne reste", async () => {
    renderConnectors();
    const search = await screen.findByRole("searchbox", { name: "Rechercher dans cette rubrique" });
    fireEvent.change(search, { target: { value: "  DNS " } });
    expect(screen.getByText("Cloudflare")).toBeTruthy();
    expect(screen.queryByText("Notion")).toBeNull();
    // A section the search empties disappears, not only its content.
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.queryByRole("region", { name: "À la une" })).toBeNull();
    expect(screen.getByText("Aucun résultat pour « zzz »."));
  });

  test("le catalogue de l'hôte ouvre la surface des serveurs, entière", async () => {
    stubFetch(writableInventory);
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: "Ouvrir le catalogue de l’hôte" }));
    const dialog = screen.getByRole("dialog", { name: "Serveurs MCP" });
    expect(await within(dialog).findByText("linear")).toBeTruthy();
    expect(dialog.textContent).toContain("https://mcp.linear.app/mcp");
    expect(dialog.textContent).not.toContain("GitHub");
  });

  test("un toolset reste dans sa rubrique Outils, une skill dans Compétences", async () => {
    renderConnectors();
    fireEvent.click(await screen.findByRole("tab", { name: "Outils" }));
    expect(screen.queryByText("Notion")).toBeNull();
    // An « Actifs » group with its count; « Configuration requise » stays the only pill.
    expect(screen.getByRole("heading", { name: "Actifs 3" })).toBeTruthy();
    expect(screen.queryByText("Prêt")).toBeNull();
    expect(screen.getByText("Configuration requise")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /GitHub/i }));
    expect(screen.getByRole("dialog", { name: "GitHub" })).toBeTruthy();
    expect(screen.getAllByText("Issues et PRs").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: /Fermer/i })[0]!);

    fireEvent.click(screen.getByRole("tab", { name: "Compétences" }));
    expect(screen.queryByText("GitHub")).toBeNull();
    // An unknown category slug reads as a title, followed by the skill count.
    expect(screen.getByRole("heading", { name: "Writing 1" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /research/ }));
    expect(screen.getByRole("dialog", { name: "research" })).toBeTruthy();
  });

  test("Outils : l'interrupteur d'une ligne bascule le toolset sur la racine, seulement s'il est réglable", async () => {
    stubFetch(writableInventory);
    const base = globalThis.fetch;
    const writes: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/runtime/integrations/toolsets/") && init?.method === "POST") {
        writes.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ name: "browser", platform: "api_server", enabled: false, requested: false, applied: true });
      }
      return base(input, init);
    }) as typeof fetch;
    renderConnectors();
    fireEvent.click(await screen.findByRole("tab", { name: "Outils" }));
    // GitHub is not settable on api_server: no switch.
    expect(screen.queryByRole("switch", { name: /GitHub/ })).toBeNull();
    fireEvent.click(await screen.findByRole("switch", { name: "Désactiver Browser" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.url).toContain("/api/runtime/integrations/toolsets/browser");
    expect(writes[0]!.body).toEqual({ enabled: false });
  });

  test("« Nouveau connecteur » ouvre la boîte d'ajout, grisé sans administration MCP", async () => {
    renderConnectors();
    const button = (await screen.findByRole("button", { name: /Nouveau connecteur/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/les connecteurs s’ajoutent depuis sa console/)).toBeTruthy();
    cleanup();

    stubFetch(writableInventory);
    renderConnectors();
    const enabled = (await screen.findByRole("button", { name: /Nouveau connecteur/ })) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    expect(await screen.findByRole("dialog", { name: /Ajouter un serveur/i })).toBeTruthy();
  });
});

/**
 * What this screen promises comes from the runtime. With no runtime declared, there is
 * nothing to open or to refresh: the actions must be removed, not
 * merely doomed to fail. Same verdict as Models (the `missing` state of
 * `models-readiness.ts`), same repair action.
 */
describe("connecteurs : aucun runtime déclaré", () => {
  test("bureau : cartes et rafraîchissement grisés, aucun dialogue ouvrable", async () => {
    stubWithoutRuntime();
    renderConnectors();
    expect(await screen.findByText("Aucun runtime")).toBeTruthy();
    expect(document.querySelector("[data-connectors-layout='desktop-catalog']")).toBeNull();
    expect(screen.queryAllByRole("button", { name: "Ouvrir les skills installées" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Ouvrir le catalogue de l’hôte" }).length).toBe(0);
    expect(screen.queryAllByRole("button", { name: "Actualiser" }).length).toBe(0);
    expect(screen.queryAllByRole("dialog").length).toBe(0);
    expect(screen.getByRole("link", { name: "Ouvrir les réglages du runtime" })).toBeTruthy();
  });

  test("bureau : une phrase, et le lien qui répare", async () => {
    stubWithoutRuntime();
    renderConnectors();
    expect(await screen.findByText("Aucun runtime")).toBeTruthy();
    expect(
      screen.getByText(/Les connecteurs viennent du runtime : connectez-en un/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ouvrir les réglages du runtime" })).toBeTruthy();
    // The cause is named only once: no duplicate of the inventory
    // error returned by the API for the same absence.
    expect(screen.queryAllByText(/l’inventaire ne peut pas être lu/).length).toBe(0);
  });

  test("PWA : rafraîchir et copier une commande sont retirés", async () => {
    setViewport(390, 844);
    stubWithoutRuntime();
    renderConnectors();
    expect(await screen.findByText("Aucun runtime")).toBeTruthy();
    expect(document.querySelector("[data-connectors-layout='pwa-segments']")).toBeNull();
    expect(screen.queryAllByRole("button", { name: "Actualiser" }).length).toBe(0);
    expect(screen.queryAllByText("hermes mcp picker").length).toBe(0);
    expect(screen.getByRole("link", { name: "Ouvrir les réglages du runtime" })).toBeTruthy();
    expect(document.querySelector("[data-mobile-action-footer]")).toBeTruthy();
  });

  // A failed read is not a fact: until something has answered, the screen
  // cannot assert that there is no runtime, and above all must not remove
  // the « Réessayer » that would observe the recovery.
  test("API injoignable : dit la panne, pas « aucun runtime », et laisse réessayer", async () => {
    stubApiDown();
    renderConnectors();
    const retry = (await screen.findByRole("button", { name: "Réessayer" })) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(retry.getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryAllByText(/Aucun runtime/).length).toBe(0);
  });

});

describe("connecteurs : PWA segments", () => {
  beforeEach(() => {
    setViewport(390, 844);
  });

  test("un catalogue à la fois, footer Actualiser | Runtime", async () => {
    renderConnectors();
    await waitFor(() => expect(document.querySelector("[data-connectors-layout='pwa-segments']")).toBeTruthy());
    expect(document.querySelector("[data-connectors-rail]")).toBeNull();
    expect(document.querySelector("[data-mobile-action-footer]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actualiser" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ouvrir les réglages du runtime" })).toBeTruthy();

    const tabs = screen.getByRole("tablist", { name: "Catalogue" });
    expect(tabs).toBeTruthy();
    expect(screen.getByRole("tab", { name: "MCP" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Toolsets 3" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Skills 1" })).toBeTruthy();

    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.queryByText("research")).toBeNull();
  });

  test("changer de segment remplace le catalogue", async () => {
    renderConnectors();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Toolsets 3" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Toolsets 3" }));
    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Skills 1" }));
    expect(screen.getByText("research")).toBeTruthy();
    expect(screen.queryByText("Browser")).toBeNull();
  });

  test("les commandes restent dans la catégorie qu’elles configurent", async () => {
    renderConnectors();
    await waitFor(() => expect(screen.getByText("Non exposée par la gateway")).toBeTruthy());
    expect(screen.getByText("Toolsets prêts")).toBeTruthy();
    expect(screen.getByText("hermes tools")).toBeTruthy();
    expect(screen.queryByText("hermes mcp list")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(await screen.findByText("hermes mcp list")).toBeTruthy();
    expect(screen.queryByText("hermes tools")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Skills 1" }));
    expect(screen.queryByText("hermes tools")).toBeNull();
    expect(screen.queryByText("hermes mcp list")).toBeNull();
    expect(screen.getByText("Non exposée par la gateway")).toBeTruthy();
  });
});

/**
 * A capable host: `edge-setup` announces both writes, and the page
 * offers them. It offers them ONLY there: a toolset the host did not name keeps
 * its state with no switch.
 */
const writableInventory: RuntimeIntegrationInventoryDto = {
  ...inventory,
  toolsets: inventory.toolsets!.map((toolset) => ({
    ...toolset,
    settable: toolset.name !== "github",
  })),
  management: {
    ...inventory.management,
    writable: true,
    capabilities: { toolsets: true, mcp: true },
  },
};

/** What the dedicated route `GET /api/runtime/integrations/mcp` returns. */
const mcpInventory: RuntimeIntegrationMcpDto = {
  available: true,
  capabilities: { oauth: false, gatewayRestart: false },
  servers: [{
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
    discoveredTools: null,
    unreachable: false,
    oauthTokenPresent: null,
  }],
  catalog: [{
    name: "n8n",
    description: "Automatisations n8n",
    source: null,
    authType: "api_key",
    authProvider: null,
    transport: "stdio",
    requiresInstall: true,
    envSpecs: [{ name: "N8N_API_KEY", description: null, required: true, secret: true }],
  }],
  error: null,
};

describe("l'écriture n'apparaît que si l'hôte l'expose", () => {
  test("un hôte muet garde la page en lecture : commandes à la console, pas d'interrupteur", async () => {
    setViewport(1280);
    stubFetch();
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));
    const hostDialog = screen.getByRole("dialog", { name: "Serveurs MCP" });
    expect(await within(hostDialog).findByText(/n’expose pas l’administration MCP/i)).toBeTruthy();
    expect(screen.getByText("hermes mcp picker")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Ajouter$/ })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: /Fermer/i })[0]!);
    fireEvent.click(await screen.findByRole("tab", { name: "Outils" }));
    fireEvent.click(await screen.findByRole("button", { name: /Browser/i }));
    // Neither « Activer » nor « Désactiver »: the promise would be false.
    expect(screen.queryByRole("button", { name: /^Activer$|^Désactiver$/ })).toBeNull();
    expect(screen.getByText(/ne porte pas ce toolset/i)).toBeTruthy();
  });

  test("un hôte capable ouvre la bascule, et n'annonce plus l'absence du bouton", async () => {
    setViewport(1280);
    const writes: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const session = sessionRoute(url);
    if (session) return session;
      if (url.includes("/api/runtime/integrations/mcp")) return Response.json(mcpInventory);
      if (url.includes("/api/runtime/integrations/toolsets/")) {
        writes.push(`${init?.method} ${url} ${String(init?.body)}`);
        return Response.json({ name: "browser", enabled: false, requested: true, applied: true });
      }
      if (url.includes("/api/runtime/integrations")) return Response.json(writableInventory);
      if (url.includes("/api/runtime")) return Response.json(configuration);
      throw new Error(`Route inattendue : ${url}`);
    }) as typeof fetch;
    renderConnectors();

    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));
    expect((await screen.findAllByText(/Piloté depuis openedbot/i)).length).toBeGreaterThan(0);
    // The sentence « le bouton connecter reste volontairement absent » does not survive
    // the regime where the button is there.
    expect(screen.queryByText(/volontairement absent/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^Ajouter un serveur$/ })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Fermer/i })[0]!);

    fireEvent.click(await screen.findByRole("tab", { name: "Outils" }));
    fireEvent.click(await screen.findByRole("button", { name: /Browser/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Désactiver$/ }));
    await waitFor(() => expect(writes.length).toBe(1));
    expect(writes[0]).toContain("POST");
    expect(writes[0]).toContain('{"enabled":false}');
  });

  test("un toolset que l'hôte n'a pas nommé reste sans interrupteur, même sur un hôte capable", async () => {
    setViewport(1280);
    stubFetch(writableInventory);
    renderConnectors();
    fireEvent.click(await screen.findByRole("tab", { name: "Outils" }));
    fireEvent.click(await screen.findByRole("button", { name: /GitHub/i }));
    expect(screen.queryByRole("button", { name: /^Activer$|^Désactiver$/ })).toBeNull();
    expect(screen.getByText(/ne porte pas ce toolset/i)).toBeTruthy();
  });

  test("une écriture qui n'a pas pris se dit comme telle, jamais comme un succès", async () => {
    setViewport(1280);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const session = sessionRoute(url);
    if (session) return session;
      if (url.includes("/api/runtime/integrations/mcp")) return Response.json(mcpInventory);
      if (url.includes("/api/runtime/integrations/toolsets/")) {
        // The call succeeds AND the host inventory still says the opposite.
        return Response.json({ name: "browser", enabled: true, requested: false, applied: false });
      }
      if (url.includes("/api/runtime/integrations")) return Response.json(writableInventory);
      if (url.includes("/api/runtime")) return Response.json(configuration);
      throw new Error(`Route inattendue : ${url}`);
    }) as typeof fetch;
    renderConnectors();
    fireEvent.click(await screen.findByRole("tab", { name: "Outils" }));
    fireEvent.click(await screen.findByRole("button", { name: /Browser/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Désactiver$/ }));
    expect(await screen.findByText(/inventaire dit toujours l’inverse/i)).toBeTruthy();
  });

  test("le formulaire MCP n'offre aucune commande locale et exige une adresse https", async () => {
    setViewport(1280);
    const posted: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const session = sessionRoute(url);
    if (session) return session;
      if (url.includes("/api/runtime/integrations/mcp") && init?.method !== "POST") return Response.json(mcpInventory);
      if (url.includes("/api/runtime/integrations/mcp/servers") && init?.method === "POST") {
        posted.push(String(init.body));
        return Response.json(mcpInventory.servers[0]);
      }
      if (url.includes("/api/runtime/integrations")) return Response.json(writableInventory);
      if (url.includes("/api/runtime")) return Response.json(configuration);
      throw new Error(`Route inattendue : ${url}`);
    }) as typeof fetch;
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));

    // The server already there is listed, and its env appears only by its KEY.
    const hostDialog = screen.getByRole("dialog", { name: "Serveurs MCP" });
    expect(await within(hostDialog).findByText("linear")).toBeTruthy();
    expect(screen.getByText(/MCP_LINEAR_API_KEY/)).toBeTruthy();

    // The form is no longer in the list: it has its own box.
    fireEvent.click(screen.getByRole("button", { name: /^Ajouter un serveur$/ }));
    const form = await screen.findByRole("dialog", { name: /Ajouter un serveur/i });
    const name = within(form).getByLabelText(/^Nom$/) as HTMLInputElement;
    const url = within(form).getByLabelText(/Adresse https/) as HTMLInputElement;
    const submit = within(form).getByRole("button", { name: /^Ajouter$/ }) as HTMLButtonElement;
    // Nothing to send until the address is https: the refusal arrives
    // before the network trip, it does not replace it.
    fireEvent.change(name, { target: { value: "notion" } });
    fireEvent.change(url, { target: { value: "http://mcp.notion.com/mcp" } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(url, { target: { value: "https://mcp.notion.com/mcp" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(posted.length).toBe(1));
    expect(JSON.parse(posted[0]!)).toEqual({ name: "notion", url: "https://mcp.notion.com/mcp", auth: "none" });
  });

  test("une entrée de catalogue ne s'installe pas tant que ses variables requises manquent", async () => {
    setViewport(1280);
    const installs: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const session = sessionRoute(url);
    if (session) return session;
      if (url.includes("/api/runtime/integrations/mcp") && init?.method !== "POST") return Response.json(mcpInventory);
      if (url.includes("/api/runtime/integrations/mcp/catalog/")) {
        installs.push(String(init?.body));
        return Response.json(mcpInventory.servers[0]);
      }
      if (url.includes("/api/runtime/integrations")) return Response.json(writableInventory);
      if (url.includes("/api/runtime")) return Response.json(configuration);
      throw new Error(`Route inattendue : ${url}`);
    }) as typeof fetch;
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));

    // The catalog row does not install by itself: it opens the box
    // where the variables are entered, and it is THERE that the refusal shows.
    fireEvent.click(await screen.findByRole("button", { name: /^Installer$/ }));
    const box = await screen.findByRole("dialog", { name: /Brancher/i });
    const install = within(box).getByRole("button", { name: /^Installer$/ }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    const secret = within(box).getByLabelText(/N8N_API_KEY/) as HTMLInputElement;
    // A variable declared secret is not shown in the clear while typing.
    expect(secret.type).toBe("password");
    fireEvent.change(secret, { target: { value: "n8n-key" } });
    expect(install.disabled).toBe(false);
    fireEvent.click(install);
    await waitFor(() => expect(installs.length).toBe(1));
    expect(JSON.parse(installs[0]!)).toEqual({ env: { N8N_API_KEY: "n8n-key" } });
  });

  test("brancher une entrée ouvre une boîte par-dessus, et la refermer rend la liste", async () => {
    setViewport(1280);
    stubFetch(writableInventory);
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));

    // Variable entry happens in ITS box, over the list, and
    // the list stays mounted underneath: one returns to it without reopening the page.
    fireEvent.click(await screen.findByRole("button", { name: /^Installer$/ }));
    const box = await screen.findByRole("dialog", { name: /Brancher/i });
    expect(within(box).getByLabelText(/N8N_API_KEY/)).toBeTruthy();

    fireEvent.click(within(box).getByRole("button", { name: /^Annuler$/ }));
    // The content stays painted during the 150 ms exit; closing is
    // proved by the sheet's visual state, not by an immediate unmount.
    await waitFor(() => expect(box.parentElement?.classList.contains("opacity-0")).toBe(true));
    const parent = screen.getByRole("dialog", { name: /Serveurs MCP/i });
    expect(
      Array.from(parent.querySelectorAll("button")).some((button) => button.textContent === "Installer"),
    ).toBe(true);
  });

  test("un hôte capable des toolsets mais pas du MCP dit ce qui manque", async () => {
    setViewport(1280);
    stubFetch({
      ...writableInventory,
      management: { ...writableInventory.management, capabilities: { toolsets: true, mcp: false } },
    });
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));
    // No MCP panel: the console commands take their place back.
    expect(await screen.findByText("hermes mcp picker")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Ajouter$/ })).toBeNull();
  });
});

/** A host that knows how to authorize an OAuth server and restart its gateway. */
const oauthInventory: RuntimeIntegrationMcpDto = {
  ...mcpInventory,
  capabilities: { oauth: true, gatewayRestart: true },
  servers: [
    mcpInventory.servers[0]!,
    {
      // Added by hand: only this kind of server keeps « Autoriser » at the root.
      name: "acme",
      transport: "http",
      endpoint: "https://mcp.acme.test/mcp",
      command: null,
      auth: "oauth",
      configEnabled: true,
      platformEnabled: true,
      toolsIncluded: null,
      toolsExcluded: null,
      envKeys: [],
      discoveredTools: null,
      unreachable: false,
      oauthTokenPresent: false,
    },
  ],
};

function stubOauthHost(options: {
  gateway?: { restartPending: boolean; job?: Record<string, unknown> | null };
  oauthSession?: (poll: number) => Record<string, unknown>;
  restartJob?: (poll: number) => Record<string, unknown>;
  capabilities?: RuntimeIntegrationMcpDto["capabilities"];
  servers?: RuntimeIntegrationMcpDto["servers"];
  linkFeatures?: string[];
} = {}) {
  const calls: string[] = [];
  let oauthPolls = 0;
  let restartPolls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const session = sessionRoute(url);
    if (session) return session;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${new URL(url, "http://test").pathname}`);
    if (url.includes("/api/runtime/integrations/gateway/restart/")) {
      restartPolls += 1;
      return Response.json(options.restartJob?.(restartPolls) ?? { jobId: "job-1", status: "ok", step: "done" });
    }
    if (url.includes("/api/runtime/integrations/gateway/restart")) {
      return Response.json({ jobId: "job-1", status: "running", step: "restart", startedAt: "2026-09-04T10:00:00Z", finishedAt: null, error: null, expiresAt: "2026-09-04T10:15:00Z" }, { status: 202 });
    }
    if (url.includes("/api/runtime/integrations/gateway")) {
      return Response.json({
        restartPending: options.gateway?.restartPending ?? false,
        pendingSince: options.gateway?.restartPending ? "2026-09-04T09:58:00Z" : null,
        activeSince: "2026-09-04T08:00:00Z",
        job: options.gateway?.job ?? null,
      });
    }
    if (/\/mcp\/servers\/(acme|notion)\/oauth\/[^/]+$/.test(url) && method === "GET") {
      oauthPolls += 1;
      return Response.json(options.oauthSession?.(oauthPolls) ?? { sessionId: "sess-1", server: "acme", status: "connected", authorizationUrl: null, error: null, errorCode: null, discoveredTools: ["search", "fetch"], expiresAt: "x" });
    }
    if (url.includes("/mcp/servers/acme/oauth") && method === "POST") {
      return Response.json({ sessionId: "sess-1", server: "acme", status: "pending", authorizationUrl: "https://mcp.acme.test/authorize?state=abc", error: null, errorCode: null, discoveredTools: [], expiresAt: "x" });
    }
    if (url.includes("/api/runtime/integrations/mcp")) {
      return Response.json({
        ...oauthInventory,
        capabilities: options.capabilities ?? oauthInventory.capabilities,
        servers: options.servers ?? oauthInventory.servers,
      });
    }
    if (url.includes("/api/runtime/integrations")) return Response.json(writableInventory);
    if (url.includes("/api/runtime")) {
      return Response.json(options.linkFeatures
        ? { ...configuration, runtime: { ...declaredRuntime, linkFeatures: options.linkFeatures } }
        : configuration);
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
  return calls;
}

describe("OAuth MCP et redémarrage du gateway depuis openedbot", () => {
  beforeEach(() => {
    globalThis.confirm = () => true;
  });

  test("un serveur OAuth sans jeton se dit « jamais autorisé », et l'autorisation s'ouvre d'ici", async () => {
    setViewport(1280);
    const calls = stubOauthHost();
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));
    const hostDialog = screen.getByRole("dialog", { name: "Serveurs MCP" });
    // The green badge no longer lies: a registered server with no token is inert.
    expect(await within(hostDialog).findByText(/jamais autorisé/i)).toBeTruthy();
    fireEvent.click(within(hostDialog).getByRole("button", { name: /^Autoriser$/ }));
    // The host returned the provider URL: that is the browser's only action.
    const link = await screen.findByRole("link", { name: /Ouvrir la page d’autorisation/i });
    expect(link.getAttribute("href")).toBe("https://mcp.acme.test/authorize?state=abc");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(calls).toContain("POST /api/runtime/integrations/mcp/servers/acme/oauth");
    // The host reread a token and listed the tools: the box says so, and points back to the restart.
    expect(await screen.findByText(/Autorisé : 2 outil\(s\)/i)).toBeTruthy();
    expect(screen.getByText(/redémarrer le gateway pour que les runs/i)).toBeTruthy();
  });

  test("« Connectés » : un serveur ajouté à la main garde « Autoriser » avec sa raison", async () => {
    setViewport(1280);
    stubOauthHost();
    renderConnectors();
    const connected = await screen.findByRole("region", { name: "Connectés" });
    expect(await within(connected).findByText("acme")).toBeTruthy();
    expect(within(connected).getByText(/Ajouté à la main : autorisé à la racine/)).toBeTruthy();
    expect(within(connected).getByRole("button", { name: /^Autoriser$/ })).toBeTruthy();
    // The linear server (header, not OAuth) is not the catalog's: its name stays its own.
    expect(within(connected).getByText("linear")).toBeTruthy();
    expect(within(connected).getAllByText("Configuré sur l’hôte").length).toBe(1);
  });

  test("une autorisation expirée se dit en français, par son code, jamais par le texte de l'hôte", async () => {
    setViewport(1280);
    stubOauthHost({
      oauthSession: () => ({ sessionId: "sess-1", server: "acme", status: "failed", authorizationUrl: null, error: "the authorization was not completed in time", errorCode: "OAUTH_TIMEOUT", discoveredTools: [], expiresAt: "x" }),
    });
    renderConnectors();
    const connected = await screen.findByRole("region", { name: "Connectés" });
    fireEvent.click(await within(connected).findByRole("button", { name: /^Autoriser$/ }));
    expect(await screen.findByText(/n’a pas été terminée à temps/)).toBeTruthy();
    expect(screen.queryByText(/not completed in time/)).toBeNull();
    expect(screen.getByRole("button", { name: "Recommencer" })).toBeTruthy();
  });

  test("un serveur du catalogue ne s'autorise plus à la racine : il se connecte bot par bot", async () => {
    setViewport(1280);
    stubOauthHost({
      servers: [{ ...oauthInventory.servers[1]!, name: "notion", endpoint: "https://mcp.notion.com/mcp/" }],
    });
    renderConnectors();
    // With neither a token nor a bot, the root server is only a template: not a
    // connection. Notion stays in « À la une », once only.
    const featured = await screen.findByRole("region", { name: "À la une" });
    expect(within(featured).getByText("Notion")).toBeTruthy();
    const connected = await screen.findByRole("region", { name: "Connectés" });
    await waitFor(() => expect(within(connected).queryByText("Notion")).toBeNull());
    expect(within(connected).queryByRole("button", { name: /^Autoriser$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));
    const hostDialog = screen.getByRole("dialog", { name: "Serveurs MCP" });
    expect(await within(hostDialog).findByText(/jamais autorisé/i)).toBeTruthy();
    expect(within(hostDialog).queryByRole("button", { name: /^Autoriser$/ })).toBeNull();
  });

  test("sans mcp_oauth annoncé, l'état se dit mais aucun bouton n'est offert", async () => {
    setViewport(1280);
    stubOauthHost({ capabilities: { oauth: false, gatewayRestart: false } });
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));
    const hostDialog = screen.getByRole("dialog", { name: "Serveurs MCP" });
    expect(await within(hostDialog).findByText(/jamais autorisé/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Autoriser$/ })).toBeNull();
    expect(screen.queryByText(/Gateway Hermes/i)).toBeNull();
  });

  test("un serveur OAuth avec jeton est « Autorisé », pas « jamais autorisé »", async () => {
    setViewport(1280);
    stubOauthHost({ servers: [{ ...oauthInventory.servers[1]!, oauthTokenPresent: true }] });
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));
    expect(await within(screen.getByRole("dialog", { name: "Serveurs MCP" })).findByText(/^Autorisé$/)).toBeTruthy();
    expect(screen.queryByText(/jamais autorisé/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Autoriser$/ })).toBeNull();
  });

  test("le redémarrage en attente se dit depuis l'hôte, se lance d'un bouton, et n'est « OK » que sur /health", async () => {
    setViewport(1280);
    let polls = 0;
    const calls = stubOauthHost({
      gateway: { restartPending: true },
      restartJob: (poll) => {
        polls = poll;
        return poll < 2
          ? { jobId: "job-1", status: "running", step: "health", startedAt: "2026-09-04T10:00:00Z", finishedAt: null, error: null, expiresAt: "x" }
          : { jobId: "job-1", status: "ok", step: "done", startedAt: "2026-09-04T10:00:00Z", finishedAt: "2026-09-04T10:00:40Z", error: null, expiresAt: "x" };
      },
    });
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));
    expect(await screen.findByText(/Redémarrage en attente/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Redémarrer le gateway$/ }));
    await waitFor(() => expect(calls).toContain("POST /api/runtime/integrations/gateway/restart"));
    const bar = await screen.findByRole("progressbar");
    expect(Number(bar.getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    expect(await screen.findByText(/vérifié sur \/health/i, {}, { timeout: 4_000 })).toBeTruthy();
    expect(Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"))).toBe(100);
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  test("un hôte qui redémarre en douceur ne promet pas de coupure : les runs finissent d'abord", async () => {
    setViewport(1280);
    const questions: string[] = [];
    globalThis.confirm = (message?: string) => {
      questions.push(String(message));
      return true;
    };
    const calls = stubOauthHost({
      gateway: { restartPending: true },
      linkFeatures: [...(declaredRuntime.linkFeatures ?? []), "gateway_restart", "gateway_graceful_restart"],
      restartJob: () => ({ jobId: "job-1", status: "running", step: "restart", startedAt: "2026-09-04T10:00:00Z", finishedAt: null, error: null, expiresAt: "x" }),
    });
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));
    await screen.findByText(/Redémarrage en attente/i);
    await waitFor(() => expect(calls).toContain("GET /api/runtime"));
    fireEvent.click(screen.getByRole("button", { name: /^Redémarrer le gateway$/ }));
    await waitFor(() => expect(calls).toContain("POST /api/runtime/integrations/gateway/restart"));
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/se terminent d’abord/);
    expect(questions[0]).not.toMatch(/interrompus/);
    expect((await screen.findAllByText(/Les runs en cours se terminent, puis le gateway redémarre/)).length).toBeGreaterThan(0);
  });

  test("un redémarrage que /health ne confirme pas reste un échec", async () => {
    setViewport(1280);
    stubOauthHost({
      gateway: { restartPending: true },
      restartJob: () => ({ jobId: "job-1", status: "failed", step: "health", startedAt: "2026-09-04T10:00:00Z", finishedAt: "2026-09-04T10:01:30Z", error: "the gateway restarted but did not answer /health in time", expiresAt: "x" }),
    });
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue de l’hôte/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^Redémarrer le gateway$/ }));
    expect(await screen.findByText(/did not answer \/health/i)).toBeTruthy();
    expect(screen.queryByText(/vérifié sur \/health/i)).toBeNull();
  });
});

/* ─── Phone: the iOS grouped list ──────────────────────────────────────── */

/** A catalog long enough that stacking everything stops being an option. */
const catalogEntry = (name: string, description: string) => ({
  name,
  description,
  source: null,
  authType: "none",
  authProvider: null,
  transport: "http" as const,
  requiresInstall: false,
  envSpecs: [],
});

const mobileMcpInventory: RuntimeIntegrationMcpDto = {
  ...mcpInventory,
  catalog: [
    catalogEntry("airtable", "Bases, tables et enregistrements Airtable."),
    catalogEntry("asana", "Tâches, projets et objectifs Asana."),
    catalogEntry("figma", "Contexte de design et Code Connect."),
    catalogEntry("stripe", "Paiements, clients et factures Stripe."),
  ],
};

function stubMobileHost(mcp: RuntimeIntegrationMcpDto = mobileMcpInventory) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const session = sessionRoute(url);
    if (session) return session;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${new URL(url, "http://test").pathname}`);
    if (url.includes("/api/runtime/integrations/mcp")) return Response.json(mcp);
    if (url.includes("/api/runtime/integrations")) return Response.json(writableInventory);
    if (url.includes("/api/runtime")) return Response.json(configuration);
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
  return calls;
}

/** The MCP segment is not the one that opens: no server is announced. */
async function openMcpSegment() {
  fireEvent.click(await screen.findByRole("tab", { name: /^MCP/ }));
}

describe("le filtre du catalogue", () => {
  test("porte sur le nom ET sur la description, sans casse ni espaces parasites", () => {
    const catalog = mobileMcpInventory.catalog;
    expect(filterCatalog(catalog, "  ").map((entry) => entry.name)).toEqual(catalog.map((entry) => entry.name));
    expect(filterCatalog(catalog, "FIG").map((entry) => entry.name)).toEqual(["figma"]);
    expect(filterCatalog(catalog, " factures ").map((entry) => entry.name)).toEqual(["stripe"]);
    expect(filterCatalog(catalog, "zzz")).toEqual([]);
  });
});

describe("MCP sur téléphone : deux listes groupées, le catalogue derrière une ligne", () => {
  beforeEach(() => {
    setViewport(430, 932);
  });

  test("le catalogue ne s'empile plus dans l'écran : une ligne l'ouvre, un champ le cherche", async () => {
    stubMobileHost();
    renderConnectors();
    await openMcpSegment();

    // The screen carries NO catalog entry: that was its whole defect.
    expect(await screen.findByRole("button", { name: /Ouvrir « linear »/ })).toBeTruthy();
    expect(screen.queryByText("airtable")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Installer$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Ouvrir le catalogue approuvé/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("airtable")).toBeTruthy();
    expect(within(sheet).getByText("stripe")).toBeTruthy();

    const search = within(sheet).getByLabelText(/Rechercher dans le catalogue/);
    fireEvent.change(search, { target: { value: "fig" } });
    expect(within(sheet).getByText("figma")).toBeTruthy();
    expect(within(sheet).queryByText("airtable")).toBeNull();

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(within(sheet).getByText(/Aucune entrée ne porte/)).toBeTruthy();
  });

  test("une entrée du catalogue ouvre la boîte de branchement, elle n'écrit pas au premier appui", async () => {
    const calls = stubMobileHost();
    renderConnectors();
    await openMcpSegment();
    fireEvent.click(await screen.findByRole("button", { name: /Ouvrir le catalogue approuvé/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByText("airtable"));

    // Nothing went to the host: the box first says what it is going to run.
    expect(await screen.findByText(/Brancher « airtable »/)).toBeTruthy();
    expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
  });

  test("le retrait a quitté la ligne : il vit dans le détail, derrière une alerte de l'app", async () => {
    const calls = stubMobileHost();
    // `confirm` would answer yes: the test would fail without seeing it. So it
    // is made to fail loudly if it is called.
    globalThis.confirm = () => {
      throw new Error("la PWA ne doit pas ouvrir la boîte du navigateur");
    };
    renderConnectors();
    await openMcpSegment();

    // The row does not carry the destructive action.
    const row = await screen.findByRole("button", { name: /Ouvrir « linear »/ });
    expect(within(row).queryByText(/Retirer/)).toBeNull();

    fireEvent.click(row);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("https://mcp.linear.app/mcp")).toBeTruthy();
    expect(within(sheet).getByText("MCP_LINEAR_API_KEY")).toBeTruthy();

    fireEvent.click(within(sheet).getByRole("button", { name: /^Retirer$/ }));
    const alert = await screen.findByRole("alertdialog");
    expect(within(alert).getByText(/Retirer « linear » \?/)).toBeTruthy();
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);

    fireEvent.click(within(alert).getByRole("button", { name: /^Retirer$/ }));
    await waitFor(() =>
      expect(calls).toContain("DELETE /api/runtime/integrations/mcp/servers/linear"),
    );
  });
});

test("accès direct : aucune bascule de capacité même si l’inventaire annonce l’opérateur", async () => {
  stubFetch(inventory, { ...configuration, runtime: { ...declaredRuntime, reachability: "direct", transport: "direct" } });
  renderConnectors();
  expect(await screen.findByText(/Capacités gérées sur l’hôte/)).toBeTruthy();
  expect(screen.queryAllByRole("switch")).toHaveLength(0);
  expect(screen.queryAllByRole("button", { name: "Ouvrir le catalogue de l’hôte" })).toHaveLength(0);
});

/**
 * « Ajouter »: an MCP token lives in a bot's profile, the host root
 * serves none. The box therefore asks « à quel bot ? », then runs the catalog
 * connect route for THAT bot. Same gates as the route.
 */
describe("Ajouter un connecteur du catalogue à un bot", () => {
  function stubConnectHost(
    linkFeatures: string[],
    options: {
      servers?: RuntimeIntegrationMcpDto["servers"];
      profiles?: Array<{ name: string; importedBotId: string | null; mcpServers: RuntimeProfileMcpServerDto[] }>;
      /** Notion's authorization succeeds on the first poll. */
      oauthConnects?: boolean;
      restartPending?: boolean;
      /** The first reads of the profiles fail (host unreachable). */
      profilesFailures?: number;
    } = {},
  ) {
    const calls: string[] = [];
    let profilesFailures = options.profilesFailures ?? 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${new URL(url, "http://test").pathname} ${init?.body ?? ""}`.trim());
      const session = sessionRoute(url);
      if (session) return session;
      if (url.includes("/mcp/connectors/notion/connect") && method === "POST") {
        return Response.json({ sessionId: "sess-9", server: "notion", status: "pending", authorizationUrl: "https://mcp.notion.com/authorize?state=bot", error: null, errorCode: null, discoveredTools: [], expiresAt: "x" });
      }
      if (url.includes("/api/runtime/integrations/gateway")) {
        return Response.json({
          restartPending: options.restartPending ?? false,
          pendingSince: options.restartPending ? "2026-10-31T10:00:00Z" : null,
          activeSince: "2026-10-31T09:00:00Z",
          job: null,
        });
      }
      if (/\/mcp\/servers\/notion\/oauth\/[^/]+$/.test(url) && options.oauthConnects) {
        return Response.json({ sessionId: "sess-9", server: "notion", status: "connected", authorizationUrl: null, error: null, errorCode: null, discoveredTools: ["search"], expiresAt: "x" });
      }
      if (/\/mcp\/servers\/notion\/oauth\/[^/]+$/.test(url)) {
        return Response.json({ sessionId: "sess-9", server: "notion", status: "pending", authorizationUrl: "https://mcp.notion.com/authorize?state=bot", error: null, errorCode: null, discoveredTools: [], expiresAt: "x" });
      }
      const connection = /\/mcp\/connectors\/([^/]+)\/connections\/([^/]+)$/.exec(url);
      if (connection && method === "DELETE") {
        return Response.json({ connector: connection[1], botId: connection[2], removed: true, tokensRemoved: true });
      }
      if (/\/mcp\/servers\/[^/]+$/.test(url) && method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("/api/runtime/profiles")) {
        if (profilesFailures > 0) {
          profilesFailures -= 1;
          return Response.json({ error: { code: "RUNTIME_ADMIN_UNAVAILABLE", message: "hôte injoignable" } }, { status: 502 });
        }
        return Response.json({
          canDelete: false,
          profiles: (options.profiles ?? []).map((profile) => ({
            displayName: profile.name, title: null, description: null, model: { default: null, provider: null },
            hasAvatar: false, routineCount: 0, routines: [], pinned: false,
            alreadyImported: profile.importedBotId !== null, ...profile,
          })),
        });
      }
      if (url.includes("/api/runtime/integrations/mcp")) return Response.json({ ...mcpInventory, servers: options.servers ?? [] });
      if (url.includes("/api/runtime/integrations")) return Response.json(writableInventory);
      if (url.includes("/api/runtime")) {
        return Response.json({ ...configuration, runtime: { ...declaredRuntime, linkFeatures } });
      }
      throw new Error(`Route inattendue : ${url}`);
    }) as typeof fetch;
    return calls;
  }

  test("la boîte liste les bots, grise ceux sans profil, puis connecte pour le bot choisi", async () => {
    const calls = stubConnectHost(["mcp_management", "mcp_oauth", "mcp_oauth_profile"]);
    renderConnectors();
    const add = (await screen.findByRole("button", { name: "Ajouter Notion à un bot" })) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);

    const picker = await screen.findByRole("dialog", { name: "Connecter Notion à quel bot ?" });
    // The publisher's caveat is stated before choosing.
    expect(within(picker).getByText(/l’administrateur de l’espace peut devoir l’autoriser/)).toBeTruthy();
    const dev = (await within(picker).findByRole("button", { name: /Dev/ })) as HTMLButtonElement;
    const cto = within(picker).getByRole("button", { name: /CTO/ }) as HTMLButtonElement;
    expect(dev.disabled).toBe(false);
    expect(dev.textContent).toContain("Profil dev");
    expect(cto.disabled).toBe(true);
    expect(cto.textContent).toContain("Pas de profil Hermes");
    // An archived bot is not a target.
    expect(within(picker).queryByRole("button", { name: /Ancien/ })).toBeNull();

    fireEvent.click(dev);
    // The action carries its destination's name, and the box shows what links to what.
    const link = await screen.findByRole("link", { name: "Ouvrir Notion" });
    expect(link.getAttribute("href")).toBe("https://mcp.notion.com/authorize?state=bot");
    const dialog = screen.getByRole("dialog", { name: "Connecter Notion à Dev" });
    expect(dialog.querySelector('[data-oauth-pairing="waiting"]')).not.toBeNull();
    expect(dialog.querySelector('[data-connector-logo="notion"]')).not.toBeNull();
    expect(within(dialog).queryByText(/Autoriser «/)).toBeNull();
    expect(calls).toContain('POST /api/runtime/integrations/mcp/connectors/notion/connect {"botId":"bot-dev"}');
    // Never the root authorization for a catalog entry.
    expect(calls.some((call) => call.startsWith("POST /api/runtime/integrations/mcp/servers/notion/oauth"))).toBe(false);
  });

  test("des connexions illisibles ne se lisent pas « rien de connecté » : le catalogue reste, la relecture se propose", async () => {
    stubConnectHost(["mcp_management", "mcp_oauth", "mcp_oauth_profile"], {
      profilesFailures: 1,
      profiles: [{ name: "dev", importedBotId: "bot-dev", mcpServers: [{ name: "notion", enabled: true }] }],
    });
    renderConnectors();
    expect(await screen.findByText(/Impossible de lire les connexions des bots/)).toBeTruthy();
    expect(screen.queryByText(/Aucun connecteur n’est encore connecté/)).toBeNull();
    // The catalog and the host's own section stay usable.
    const addNotion = (await screen.findByRole("button", { name: "Ajouter Notion à un bot" })) as HTMLButtonElement;
    await waitFor(() => expect(addNotion.disabled).toBe(false));
    expect(screen.getByRole("button", { name: "Ouvrir le catalogue de l’hôte" })).toBeTruthy();
    const connected = screen.getByRole("heading", { name: "Connectés" }).closest("section")!;
    fireEvent.click(within(connected as HTMLElement).getByRole("button", { name: "Réessayer" }));
    // Read again: Notion is connected to Dev, and is not offered a second time.
    expect(await screen.findByText("Connecté à Dev")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ajouter Notion à un bot" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ajouter Linear à un bot" })).toBeTruthy();
  });

  test("un hôte sans mcp_oauth_profile : « Ajouter » grisé, et la raison", async () => {
    stubConnectHost(["mcp_management", "mcp_oauth"]);
    renderConnectors();
    expect(await screen.findByText(/annonce mcp_oauth_profile/)).toBeTruthy();
    const add = screen.getByRole("button", { name: "Ajouter Linear à un bot" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });

  test("un membre ne connecte rien : « Ajouter » grisé, et la raison", async () => {
    sessionRole = "member";
    stubConnectHost(["mcp_management", "mcp_oauth", "mcp_oauth_profile"]);
    renderConnectors();
    expect(await screen.findByText(/Seul un opérateur de l’espace peut connecter/)).toBeTruthy();
    const add = screen.getByRole("button", { name: "Ajouter Notion à un bot" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(screen.queryByRole("dialog", { name: /à quel bot/ })).toBeNull();
  });

  const FULL = ["mcp_management", "mcp_oauth", "mcp_oauth_profile", "mcp_profile_disconnect"];
  const linearRoot = {
    name: "linear", transport: "http", endpoint: "https://mcp.linear.app/mcp", command: null, auth: "oauth",
    configEnabled: true, platformEnabled: true, toolsIncluded: null, toolsExcluded: null, envKeys: [],
    discoveredTools: null, unreachable: false, oauthTokenPresent: false,
  } satisfies RuntimeIntegrationMcpDto["servers"][number];

  test("« Connectés » : le bot qui porte Linear, avec son logo, et Linear ne revient pas dans « À la une »", async () => {
    stubConnectHost(FULL, {
      servers: [linearRoot],
      profiles: [{ name: "dev", importedBotId: "bot-dev", mcpServers: [{ name: "linear", enabled: true }] }],
    });
    renderConnectors();
    const connected = await screen.findByRole("region", { name: "Connectés" });
    expect(await within(connected).findByText("Connecté à Dev")).toBeTruthy();
    expect(connected.querySelector('[data-connector-logo="linear"]')).not.toBeNull();
    const featured = screen.getByRole("region", { name: "À la une" });
    expect(within(featured).queryByText("Linear")).toBeNull();
    expect(screen.getAllByText("Linear")).toHaveLength(1);
  });

  test("« Gérer » puis « Déconnecter » retire Linear du profil du bot, après confirmation", async () => {
    const calls = stubConnectHost(FULL, {
      servers: [linearRoot],
      profiles: [{ name: "dev", importedBotId: "bot-dev", mcpServers: [{ name: "linear", enabled: true }] }],
    });
    renderConnectors();
    const manage = await screen.findByRole("button", { name: "Gérer Linear" });
    fireEvent.click(manage);
    const dialog = await screen.findByRole("dialog", { name: "Linear" });
    const disconnect = within(dialog).getByRole("button", { name: "Déconnecter Linear de Dev" }) as HTMLButtonElement;
    await waitFor(() => expect(disconnect.disabled).toBe(false));
    fireEvent.click(disconnect);
    // A first click asks; nothing has left yet.
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmer" }));
    expect(await within(dialog).findByText(/est déconnecté de Dev/)).toBeTruthy();
    expect(calls).toContain("DELETE /api/runtime/integrations/mcp/connectors/linear/connections/bot-dev");
    // The root serves as a template for the profiles: never removed by this action.
    expect(calls.some((call) => call.startsWith("DELETE /api/runtime/integrations/mcp/servers/"))).toBe(false);
  });

  test("un jeton à la seule racine : « Autorisé à la racine », et « Retirer » l'efface", async () => {
    const calls = stubConnectHost(FULL, { servers: [{ ...linearRoot, oauthTokenPresent: true }], profiles: [] });
    renderConnectors();
    const connected = await screen.findByRole("region", { name: "Connectés" });
    expect(await within(connected).findByText(/Autorisé à la racine de l’hôte : aucun bot/)).toBeTruthy();
    fireEvent.click(within(connected).getByRole("button", { name: "Gérer Linear" }));
    const dialog = await screen.findByRole("dialog", { name: "Linear" });
    expect(within(dialog).getByText("Aucun bot n’est connecté.")).toBeTruthy();
    const remove = within(dialog).getByRole("button", { name: "Retirer Linear de la racine de l’hôte" }) as HTMLButtonElement;
    await waitFor(() => expect(remove.disabled).toBe(false));
    fireEvent.click(remove);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmer" }));
    expect(await within(dialog).findByText(/retirés de la racine de l’hôte/)).toBeTruthy();
    expect(calls).toContain("DELETE /api/runtime/integrations/mcp/servers/linear");
  });

  const devLinear = { name: "dev", importedBotId: "bot-dev", mcpServers: [{ name: "linear", enabled: true }] };

  async function disconnectDevFromLinear() {
    fireEvent.click(await screen.findByRole("button", { name: "Gérer Linear" }));
    const dialog = await screen.findByRole("dialog", { name: "Linear" });
    const disconnect = within(dialog).getByRole("button", { name: "Déconnecter Linear de Dev" }) as HTMLButtonElement;
    await waitFor(() => expect(disconnect.disabled).toBe(false));
    fireEvent.click(disconnect);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmer" }));
    return dialog;
  }

  test("un hôte qui recharge MCP tout seul : la déconnexion ne demande aucun redémarrage", async () => {
    stubConnectHost([...FULL, "gateway_restart", "mcp_live_reload"], { servers: [linearRoot], profiles: [devLinear] });
    renderConnectors();
    const dialog = await disconnectDevFromLinear();
    expect(await within(dialog).findByText(/Les runs ne le verront plus d’ici une minute environ, sans redémarrage/)).toBeTruthy();
    expect(within(dialog).queryByText(/Redémarrez le gateway/)).toBeNull();
    // The host does not say a restart is pending: no gateway card.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(dialog).queryByText("Gateway Hermes")).toBeNull();
  });

  test("un hôte plus ancien : la déconnexion demande toujours le redémarrage, avec sa carte", async () => {
    stubConnectHost([...FULL, "gateway_restart"], { servers: [linearRoot], profiles: [devLinear], restartPending: true });
    renderConnectors();
    const dialog = await disconnectDevFromLinear();
    expect(await within(dialog).findByText(/Redémarrez le gateway pour que les runs ne le voient plus/)).toBeTruthy();
    expect(await within(dialog).findByText("Gateway Hermes")).toBeTruthy();
  });

  test("après une autorisation, la boîte dit « sans redémarrage » quand l'hôte recharge MCP tout seul", async () => {
    stubConnectHost([...FULL, "mcp_live_reload"], { oauthConnects: true });
    renderConnectors();
    const add = (await screen.findByRole("button", { name: "Ajouter Notion à un bot" })) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    const picker = await screen.findByRole("dialog", { name: "Connecter Notion à quel bot ?" });
    fireEvent.click(await within(picker).findByRole("button", { name: /Dev/ }));
    expect(await screen.findByText(/Ses outils seront disponibles pour les runs d’ici une minute environ, sans redémarrage/)).toBeTruthy();
    expect(screen.queryByText(/redémarrer le gateway pour que les runs/i)).toBeNull();
  });

  const linearFacts = (token: boolean): RuntimeProfileMcpServerDto =>
    ({ name: "linear", enabled: true, endpoint: "https://mcp.linear.app/mcp", auth: "oauth", oauthTokenPresent: token });

  test("un bot qui porte Linear sans jeton n'est pas « Connecté » : Linear reste au catalogue", async () => {
    stubConnectHost(FULL, { servers: [linearRoot], profiles: [{ name: "dev", importedBotId: "bot-dev", mcpServers: [linearFacts(false)] }] });
    renderConnectors();
    const connected = await screen.findByRole("region", { name: "Connectés" });
    // Shown once the profiles are read: what follows is the read, not a loading state.
    await waitFor(() => expect(within(connected).getByText(/^Aucun connecteur n’est encore connecté/)).toBeTruthy());
    expect(within(connected).queryByText(/Connecté à/)).toBeNull();
    const featured = screen.getByRole("region", { name: "À la une" });
    const add = within(featured).getByRole("button", { name: "Ajouter Linear à un bot" }) as HTMLButtonElement;
    // The state shows where the entry is: on its catalog row, and in the choice.
    expect(within(featured).getByText("À autoriser pour Dev")).toBeTruthy();
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    const picker = await screen.findByRole("dialog", { name: "Connecter Linear à quel bot ?" });
    const dev = (await within(picker).findByRole("button", { name: /Dev/ })) as HTMLButtonElement;
    expect(dev.disabled).toBe(false);
    expect(dev.textContent).toContain("À autoriser : l’hôte n’a pas de jeton pour ce bot");
    expect(dev.textContent).not.toContain("Connecté");
  });

  test("un bot dont le profil porte un autre « linear » est grisé au choix, avec la raison", async () => {
    stubConnectHost(FULL, {
      servers: [linearRoot],
      profiles: [{ name: "dev", importedBotId: "bot-dev", mcpServers: [{ name: "linear", enabled: true, endpoint: "https://linear.internal.example/...", auth: "oauth", oauthTokenPresent: true }] }],
    });
    renderConnectors();
    const add = (await screen.findByRole("button", { name: "Ajouter Linear à un bot" })) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    const picker = await screen.findByRole("dialog", { name: "Connecter Linear à quel bot ?" });
    await waitFor(() => expect((within(picker).getByRole("button", { name: /Dev/ }) as HTMLButtonElement).disabled).toBe(true));
    expect(within(picker).getByRole("button", { name: /Dev/ }).textContent).toContain("porte déjà un autre serveur nommé « linear »");
  });

  test("« Gérer » : le bot prouvé est connecté, celui sans jeton est « à autoriser » et s'autorise d'ici", async () => {
    const calls = stubConnectHost(FULL, {
      servers: [linearRoot],
      profiles: [
        { name: "dev", importedBotId: "bot-dev", mcpServers: [linearFacts(false)] },
        { name: "old", importedBotId: "bot-old", mcpServers: [linearFacts(true)] },
      ],
    });
    renderConnectors();
    const connected = await screen.findByRole("region", { name: "Connectés" });
    expect(await within(connected).findByText("Connecté à Ancien")).toBeTruthy();
    expect(within(connected).getByText("À autoriser pour Dev")).toBeTruthy();
    fireEvent.click(within(connected).getByRole("button", { name: "Gérer Linear" }));
    const dialog = await screen.findByRole("dialog", { name: "Linear" });
    expect(within(dialog).getByText(/^Profil dev · à autoriser/)).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Bots qui portent ce connecteur" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Autoriser Linear pour Ancien" })).toBeNull();
    const authorize = within(dialog).getByRole("button", { name: "Autoriser Linear pour Dev" }) as HTMLButtonElement;
    await waitFor(() => expect(authorize.disabled).toBe(false));
    fireEvent.click(authorize);
    await waitFor(() => expect(calls.some((call) => call.startsWith("POST /api/runtime/integrations/mcp/connectors/linear/connect") && call.includes('"botId":"bot-dev"'))).toBe(true));
  });

  test("un bot désactivé ET sans jeton garde la mention « désactivé »", async () => {
    stubConnectHost(FULL, {
      servers: [linearRoot],
      profiles: [
        { name: "dev", importedBotId: "bot-dev", mcpServers: [{ ...linearFacts(false), enabled: false }] },
        { name: "old", importedBotId: "bot-old", mcpServers: [linearFacts(true)] },
      ],
    });
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: "Gérer Linear" }));
    const dialog = await screen.findByRole("dialog", { name: "Linear" });
    expect(within(dialog).getByText(/^Profil dev · désactivé · à autoriser/)).toBeTruthy();
  });

  test("un hôte sans mcp_profile_disconnect : « Déconnecter » grisé, et la raison", async () => {
    stubConnectHost(["mcp_management", "mcp_oauth", "mcp_oauth_profile"], {
      servers: [linearRoot],
      profiles: [{ name: "dev", importedBotId: "bot-dev", mcpServers: [{ name: "linear", enabled: true }] }],
    });
    renderConnectors();
    fireEvent.click(await screen.findByRole("button", { name: "Gérer Linear" }));
    const dialog = await screen.findByRole("dialog", { name: "Linear" });
    expect(await within(dialog).findByText(/Mettez à jour edge-setup/)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Déconnecter Linear de Dev" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
