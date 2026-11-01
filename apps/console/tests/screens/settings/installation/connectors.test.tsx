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
  RuntimePublicDto,
} from "@openedbot/contracts-api";
import { I18nProvider } from "../../../../src/lib/i18n";
import { ConnectorsSettings } from "../../../../src/screens/settings/installation/connectors";
import { filterCatalog } from "../../../../src/screens/settings/installation/connectors-mcp";

const realFetch = globalThis.fetch;

/**
 * Ce que lit « Ajouter » : la session (rôle) et le roster. Un propriétaire
 * par défaut ; un bot avec profil Hermes, un sans, un archivé.
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
 * L'inventaire tel que la route le renvoie quand l'organisation n'a aucun
 * runtime : pas de toolsets, pas de skills, et la cause nommée par l'API.
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

/** Ce que `/api/runtime` déclare : pour cet écran, seul `runtime` décide. */
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

/** Aucun runtime déclaré : les deux routes disent le même manque. */
function stubWithoutRuntime(runtimeMode: RuntimeConfigurationDto["runtimeMode"] = "external") {
  stubFetch(emptyInventory, { ...configuration, runtime: null, runtimeMode });
}

/** L'API entière est injoignable : aucune des deux routes ne répond. */
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
  window.localStorage.setItem("ohb:locale", "fr");
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

    // À la une d'abord, dans l'ordre choisi ; une entrée n'apparaît qu'une fois.
    const featured = screen.getByRole("region", { name: "À la une" });
    expect(within(featured).getAllByRole("button", { name: /^Ajouter .* à un bot$/ }).map((button) => button.getAttribute("aria-label")))
      .toEqual(["Notion", "Linear", "GitLab", "Sentry", "Cloudflare", "Supabase"].map((name) => `Ajouter ${name} à un bot`));
    const dev = screen.getByRole("region", { name: "Développement" });
    expect(within(dev).getByText("Netlify")).toBeTruthy();
    expect(within(dev).queryByText("GitLab")).toBeNull();
    expect(screen.getByText("Pages, bases et recherche dans l’espace Notion.")).toBeTruthy();
    // Une marque connue se peint ; Attio, absente de simple-icons, prend son initiale.
    expect(document.querySelector("[data-connector-logo='notion'] svg path")).toBeTruthy();
    expect(document.querySelector("[data-connector-logo='letter']")?.textContent).toBe("A");

    // Le détail des toolsets et des skills reste dans sa rubrique.
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.queryByText("research")).toBeNull();
    expect(screen.queryByText("hermes mcp list")).toBeNull();
    expect(document.querySelector("[data-mobile-action-footer]")).toBeNull();
  });

  test("la recherche filtre les lignes de toutes les sections, et dit quand rien ne reste", async () => {
    renderConnectors();
    const search = await screen.findByRole("searchbox", { name: "Rechercher dans cette rubrique" });
    fireEvent.change(search, { target: { value: "merge requests" } });
    expect(screen.getByText("GitLab")).toBeTruthy();
    expect(screen.queryByText("Notion")).toBeNull();
    // Une section que la recherche vide disparaît, pas seulement son contenu.
    expect(screen.queryByRole("region", { name: "Développement" })).toBeNull();
    fireEvent.change(search, { target: { value: "  CALEND " } });
    expect(screen.getByText("Calendly")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "À la une" })).toBeNull();
    fireEvent.change(search, { target: { value: "zzz" } });
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
    fireEvent.click(await screen.findByRole("button", { name: /GitHub/i }));
    expect(screen.getByRole("dialog", { name: "GitHub" })).toBeTruthy();
    expect(screen.getAllByText("Issues et PRs").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: /Fermer/i })[0]!);

    fireEvent.click(screen.getByRole("tab", { name: "Compétences" }));
    expect(screen.queryByText("GitHub")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /research/ }));
    expect(screen.getByRole("dialog", { name: "research" })).toBeTruthy();
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
 * Ce que promet cet écran vient du runtime. Sans runtime déclaré, il n'y a
 * rien à ouvrir ni à rafraîchir : les gestes doivent être retirés, pas
 * seulement voués à échouer. Même verdict que Modèles (état `missing` de
 * `models-readiness.ts`), même geste de réparation.
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
    // La cause est nommée une seule fois : pas de doublon avec l'erreur
    // d'inventaire renvoyée par l'API pour le même manque.
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

  // Une lecture ratée n'est pas un fait : tant que rien n'a répondu, l'écran
  // ne peut pas affirmer qu'il n'y a pas de runtime, et surtout pas retirer
  // le « Réessayer » qui constaterait le rétablissement.
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
 * Un hôte capable : `edge-setup` annonce les deux écritures, la page les
 * offre. Elle ne les offre QUE là : un toolset que l'hôte n'a pas nommé garde
 * son état sans interrupteur.
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

/** Ce que rend la route dédiée `GET /api/runtime/integrations/mcp`. */
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
    // Ni « Activer » ni « Désactiver » : la promesse serait fausse.
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
    // La phrase « le bouton connecter reste volontairement absent » ne survit
    // pas au régime où il est là.
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
        // L'appel réussit ET l'inventaire de l'hôte dit toujours le contraire.
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

    // Le serveur déjà là est listé, et son env n'apparaît que par sa CLÉ.
    const hostDialog = screen.getByRole("dialog", { name: "Serveurs MCP" });
    expect(await within(hostDialog).findByText("linear")).toBeTruthy();
    expect(screen.getByText(/MCP_LINEAR_API_KEY/)).toBeTruthy();

    // Le formulaire n'est plus dans la liste : il a sa propre boîte.
    fireEvent.click(screen.getByRole("button", { name: /^Ajouter un serveur$/ }));
    const form = await screen.findByRole("dialog", { name: /Ajouter un serveur/i });
    const name = within(form).getByLabelText(/^Nom$/) as HTMLInputElement;
    const url = within(form).getByLabelText(/Adresse https/) as HTMLInputElement;
    const submit = within(form).getByRole("button", { name: /^Ajouter$/ }) as HTMLButtonElement;
    // Rien à envoyer tant que l'adresse n'est pas https : le refus arrive
    // avant l'aller réseau, il ne le remplace pas.
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

    // La ligne du catalogue n'installe pas d'elle-même : elle ouvre la boîte
    // où se saisissent les variables, et c'est LÀ que le refus se voit.
    fireEvent.click(await screen.findByRole("button", { name: /^Installer$/ }));
    const box = await screen.findByRole("dialog", { name: /Brancher/i });
    const install = within(box).getByRole("button", { name: /^Installer$/ }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    const secret = within(box).getByLabelText(/N8N_API_KEY/) as HTMLInputElement;
    // Une variable déclarée secrète ne s'affiche pas en clair pendant la frappe.
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

    // La saisie des variables se fait dans SA boîte, par-dessus la liste, et
    // la liste reste montée dessous : on y revient sans rouvrir la page.
    fireEvent.click(await screen.findByRole("button", { name: /^Installer$/ }));
    const box = await screen.findByRole("dialog", { name: /Brancher/i });
    expect(within(box).getByLabelText(/N8N_API_KEY/)).toBeTruthy();

    fireEvent.click(within(box).getByRole("button", { name: /^Annuler$/ }));
    // Le contenu reste peint pendant les 150 ms de sortie ; la fermeture est
    // prouvée par l'état visuel de la feuille, pas par un démontage immédiat.
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
    // Pas de panneau MCP : les commandes de console reprennent leur place.
    expect(await screen.findByText("hermes mcp picker")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Ajouter$/ })).toBeNull();
  });
});

/** Un hôte qui sait autoriser un serveur OAuth et redémarrer son gateway. */
const oauthInventory: RuntimeIntegrationMcpDto = {
  ...mcpInventory,
  capabilities: { oauth: true, gatewayRestart: true },
  servers: [
    mcpInventory.servers[0]!,
    {
      // Ajouté à la main : seul ce genre de serveur garde « Autoriser » à la racine.
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
    // Le badge vert ne ment plus : un serveur enregistré sans jeton est inerte.
    expect(await within(hostDialog).findByText(/jamais autorisé/i)).toBeTruthy();
    fireEvent.click(within(hostDialog).getByRole("button", { name: /^Autoriser$/ }));
    // L'hôte a rendu l'URL du fournisseur : c'est le seul geste du navigateur.
    const link = await screen.findByRole("link", { name: /Ouvrir la page d’autorisation/i });
    expect(link.getAttribute("href")).toBe("https://mcp.acme.test/authorize?state=abc");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(calls).toContain("POST /api/runtime/integrations/mcp/servers/acme/oauth");
    // L'hôte a relu un jeton et listé les outils : la boîte le dit, et renvoie au redémarrage.
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
    // Le serveur linear (en-tête, pas OAuth) n'est pas celui du catalogue : son nom reste le sien.
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
    // Sans jeton ni bot, le serveur de la racine n'est qu'un modèle : pas une
    // connexion. Notion reste dans « À la une », une seule fois.
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

/* ─── Téléphone : la liste groupée iOS ────────────────────────────────── */

/** Un catalogue assez long pour que « tout empiler » cesse d'être une option. */
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

/** Le segment MCP n'est pas celui qui s'ouvre : aucun serveur n'est annoncé. */
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

    // L'écran ne porte AUCUNE entrée du catalogue : c'était tout son défaut.
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

    // Rien n'est parti vers l'hôte : la boîte dit d'abord ce qu'elle va jouer.
    expect(await screen.findByText(/Brancher « airtable »/)).toBeTruthy();
    expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
  });

  test("le retrait a quitté la ligne : il vit dans le détail, derrière une alerte de l'app", async () => {
    const calls = stubMobileHost();
    // `confirm` répondrait « oui » : le test échouerait sans le voir. On le
    // fait donc échouer bruyamment s'il est appelé.
    globalThis.confirm = () => {
      throw new Error("la PWA ne doit pas ouvrir la boîte du navigateur");
    };
    renderConnectors();
    await openMcpSegment();

    // La ligne ne porte pas le geste destructeur.
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
 * « Ajouter » : un jeton MCP vit dans le profil d'un bot, la racine de l'hôte
 * n'en sert aucun. La boîte demande donc « à quel bot ? », puis joue la route
 * de connexion du catalogue pour CE bot. Mêmes portes que la route.
 */
describe("Ajouter un connecteur du catalogue à un bot", () => {
  function stubConnectHost(
    linkFeatures: string[],
    options: {
      servers?: RuntimeIntegrationMcpDto["servers"];
      profiles?: Array<{ name: string; importedBotId: string | null; mcpServers: Array<{ name: string; enabled: boolean }> }>;
      /** L'autorisation de Notion aboutit au premier relevé. */
      oauthConnects?: boolean;
      restartPending?: boolean;
    } = {},
  ) {
    const calls: string[] = [];
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
    // La réserve de l'éditeur se dit avant de choisir.
    expect(within(picker).getByText(/l’administrateur de l’espace peut devoir l’autoriser/)).toBeTruthy();
    const dev = (await within(picker).findByRole("button", { name: /Dev/ })) as HTMLButtonElement;
    const cto = within(picker).getByRole("button", { name: /CTO/ }) as HTMLButtonElement;
    expect(dev.disabled).toBe(false);
    expect(dev.textContent).toContain("Profil dev");
    expect(cto.disabled).toBe(true);
    expect(cto.textContent).toContain("Pas de profil Hermes");
    // Un bot archivé n'est pas une cible.
    expect(within(picker).queryByRole("button", { name: /Ancien/ })).toBeNull();

    fireEvent.click(dev);
    // Le geste porte le nom de sa destination, et la boîte montre ce qui se relie à quoi.
    const link = await screen.findByRole("link", { name: "Ouvrir Notion" });
    expect(link.getAttribute("href")).toBe("https://mcp.notion.com/authorize?state=bot");
    const dialog = screen.getByRole("dialog", { name: "Connecter Notion à Dev" });
    expect(dialog.querySelector('[data-oauth-pairing="waiting"]')).not.toBeNull();
    expect(dialog.querySelector('[data-connector-logo="notion"]')).not.toBeNull();
    expect(within(dialog).queryByText(/Autoriser «/)).toBeNull();
    expect(calls).toContain('POST /api/runtime/integrations/mcp/connectors/notion/connect {"botId":"bot-dev"}');
    // Jamais l'autorisation racine pour une entrée du catalogue.
    expect(calls.some((call) => call.startsWith("POST /api/runtime/integrations/mcp/servers/notion/oauth"))).toBe(false);
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
    // Un premier clic demande ; rien n'est encore parti.
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmer" }));
    expect(await within(dialog).findByText(/est déconnecté de Dev/)).toBeTruthy();
    expect(calls).toContain("DELETE /api/runtime/integrations/mcp/connectors/linear/connections/bot-dev");
    // La racine sert de modèle aux profils : jamais retirée par ce geste.
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
    // L'hôte ne dit pas qu'un redémarrage attend : pas de carte du gateway.
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
