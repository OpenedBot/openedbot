import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "../../../../src/lib/i18n";
import { CloudRuntimeSettings } from "../../../../src/screens/settings/installation/cloud";

const realFetch = globalThis.fetch;

const runtime = {
  id: "runtime-1",
  configured: true,
  baseUrl: "http://127.0.0.1:8642",
  transport: "direct",
  reachability: "direct",
  link: null,
  management: { kind: "manual", credentialsWritable: false, oauthWritable: false },
  name: "Gateway direct",
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

const connectorRuntime = {
  ...runtime,
  id: "runtime-2",
  baseUrl: null,
  transport: "connector",
  reachability: "connector",
  link: { connected: false, lastSeenAt: "2026-08-30T10:00:00.000Z" },
  name: "Boîtier atelier",
  lastHealthStatus: "disconnected",
};

/** Une organisation n'a qu'un runtime : un second n'existe qu'en attente du remplacement. */
const pendingConnector = {
  ...connectorRuntime,
  id: "runtime-3",
  name: "Boîtier relais",
  isDefault: false,
  isActive: false,
};

function stubFetch(
  runtimeMode: "external",
  adminMode: "disabled" | "local",
  declared: unknown[] = [runtime],
) {
  const active = declared[0] ?? null;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/runtime/list")) return Response.json({ runtimes: declared });
    if (url.includes("/api/runtime")) {
      return Response.json({ runtime: active, runtimeMode, adminMode, devDefaults: null });
    }
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/**
 * Le remplacement est la section « Remplacer » du rail, pas une modal. Le
 * libellé du rail et le titre de la carte se ressemblent : on vise le titre.
 */
async function openReplacementSection() {
  fireEvent.click(await screen.findByRole("tab", { name: /^Remplacer/ }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Remplacer le runtime" })).toBeTruthy());
}

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // L'écran porte des liens de routeur : il lui faut un RouterProvider.
  const router = createRouter({
    routeTree: createRootRoute({ component: CloudRuntimeSettings }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
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
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("écran runtime en mode externe", () => {
  // L'écran s'ouvre sur l'état du runtime actif ; le remplacement est une
  // section du rail, un onglet plus loin : jamais empilé sous la carte. Avec un
  // runtime qui sert, le geste n'est plus « ajouter » mais « remplacer ».
  test("ouvre le remplacement dans la section Remplacer, pas sur l’état", async () => {
    stubFetch("external", "disabled");
    renderSettings();

    await waitFor(() => expect(screen.getByRole("tab", { name: "État" })).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Remplacer le runtime" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remplacer le runtime" })).toBeNull();
    await openReplacementSection();
    expect(screen.getByRole("button", { name: "Remplacer le runtime" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ajouter un runtime" })).toBeNull();
    expect(screen.queryByText(/Token géré côté serveur/)).toBeNull();
  });

  // Le compteur ne compte plus un parc : il signale le remplaçant qui attend,
  // visible sans ouvrir la section. Sans remplaçant, pas de compteur.
  test("le rail annonce le remplaçant en attente, et lui seul", async () => {
    stubFetch("external", "disabled", [runtime, pendingConnector]);
    renderSettings();

    await waitFor(() => expect(screen.getByRole("tab", { name: /^Remplacer/ }).textContent).toBe("Remplacer1"));
    cleanup();

    stubFetch("external", "disabled", [runtime]);
    renderSettings();
    await waitFor(() => expect(screen.getByRole("tab", { name: "État" })).toBeTruthy());
    expect(screen.getByRole("tab", { name: /^Remplacer/ }).textContent).toBe("Remplacer");
  });

  test("présente l’accès direct et ses limites en mode external", async () => {
    stubFetch("external", "disabled"); renderSettings();
    expect(await screen.findByText("Profil par défaut partagé")).toBeTruthy();
    expect(screen.getByText("Capacités gérées sur l’hôte")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Modifier les accès" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Mode" })).toBeNull();
    await openReplacementSection();
  });

  // Sans runtime, l'écran s'ouvre sur l'ajout et n'offre QU'UN chemin de
  // création : le bouton « Ajouter un runtime », une fois (l'onglet du rail
  // porte le même nom mais n'est qu'une navigation). La carte de tête le dit,
  // elle ne le double pas d'un second bouton ni d'un formulaire.
  test("n’ouvre qu’un seul chemin de création quand aucun runtime n’existe", async () => {
    stubFetch("external", "disabled", []);
    renderSettings();

    await waitFor(() => expect(screen.getByRole("button", { name: "Ajouter un runtime" })).toBeTruthy());
    expect(screen.getAllByRole("button", { name: "Ajouter un runtime" })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Ajouter un runtime" }).getAttribute("aria-selected")).toBe("true");
    // Sans runtime, « État » n'a aucun fait à montrer : le rail ne l'offre pas.
    expect(screen.queryByRole("tab", { name: "État" })).toBeNull();
    expect(screen.getAllByText("Aucune machine reliée").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Nom")).toBeNull();
    expect(screen.queryByLabelText("URL Hermes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Enregistrer et vérifier" })).toBeNull();
    expect(screen.queryByText("Runtime actif")).toBeNull();
  });
});

describe("écran runtime en mode externe, runtime connector", () => {
  // Un runtime connector n'a pas d'URL côté cloud, et PUT /api/runtime la
  // refuse (409 RUNTIME_REACHABILITY_IMMUTABLE) : la carte du remplaçant doit
  // dire la joignabilité et l'état du lien, jamais promettre une édition.
  test("montre « Connexion sortante » et l'état du lien, jamais une URL", async () => {
    stubFetch("external", "disabled", [connectorRuntime, pendingConnector]);
    renderSettings();

    await openReplacementSection();
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-pending-runtime="runtime-3"]');
      expect(found).toBeTruthy();
      return found!;
    });
    expect(within(card).getByText("Boîtier relais")).toBeTruthy();
    expect(card.textContent).toContain("Connexion sortante");
    // runtimeHealth.disconnected (fr) : le lien fermé se lit, il ne se devine pas.
    expect(within(card).getByText("lien connecteur fermé")).toBeTruthy();
    // Le dernier signe de vie du lien se dit sur la carte, en mots.
    expect(card.textContent).toMatch(/· vu /);
    expect(card.textContent).not.toContain("jamais vu");
    expect(screen.queryByText("http://127.0.0.1:8642")).toBeNull();
    expect(screen.queryByLabelText("URL Hermes")).toBeNull();
  });

  test("n'offre ni édition d'URL ni remplacement de token pour un connector", async () => {
    stubFetch("external", "disabled", [connectorRuntime]);
    renderSettings();

    await openReplacementSection();
    expect(screen.queryByRole("button", { name: "Ouvrir le runtime actif" })).toBeNull();
    expect(screen.queryByLabelText("URL Hermes")).toBeNull();
    expect(screen.queryByLabelText("Nom")).toBeNull();
    expect(screen.queryByRole("button", { name: "Enregistrer et vérifier" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remplacer le token" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Où trouver le token ?" })).toBeNull();
    // Le connector a son action dans l'état du lien, pas une seconde sonde dans le hero.
    expect(screen.queryByRole("button", { name: "Tester la connexion" })).toBeNull();
  });
});

describe("aide au token, placement", () => {
  // La voie manuelle et l'aide token ont quitté le registre : l'appairage
  // connector-only n'expose plus de bearer à aller lire sur l'hôte. Sans
  // runtime, l'écran s'ouvre directement sur l'ajout.
  test("n’offre plus d’aide token depuis le registre ni depuis l’ajout", async () => {
    stubFetch("external", "disabled", []);
    renderSettings();

    await screen.findByRole("button", { name: "Ajouter un runtime" });
    expect(screen.queryByRole("button", { name: "Où trouver le token ?" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter un runtime" }));
    await waitFor(() => expect(screen.getByLabelText("Nom")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "J’ai déjà le token" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Où trouver le token ?" })).toBeNull();
  });

  test("n’apparaît pas pour un accès direct", async () => {
    stubFetch("external", "disabled");
    renderSettings();

    await waitFor(() => expect(screen.getByText("URL Hermes")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Où trouver le token ?" })).toBeNull();
  });
});

describe("carte de tête", () => {
  test("les champs d’ajout restent dans la section Runtimes, pas sur l’état", async () => {
    stubFetch("external", "disabled");
    renderSettings();

    await waitFor(() => expect(screen.getByRole("tab", { name: "État" })).toBeTruthy());
    expect(screen.queryByLabelText("Nom")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Remplacer le runtime" })).toBeNull();
  });

  // Le fil du lien porte l'état : il se lit sans ouvrir de section.
  test("dit l’état du lien sur la carte de tête", async () => {
    stubFetch("external", "disabled", [connectorRuntime]);
    renderSettings();

    expect(await screen.findByText("Runtime actif")).toBeTruthy();
    expect(screen.getByText("Boîtier atelier")).toBeTruthy();
    expect(screen.getByText("lien connecteur fermé")).toBeTruthy();
    expect(screen.getByText(/dernier signe de vie/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
    expect(screen.getByText(/vérifiez la machine avec/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByText(/Recherche du lien en cours/)).toBeTruthy();
    expect(screen.getByText("votre hôte")).toBeTruthy();
  });

  // Il n'existe plus de carte d'administration à côté du runtime, et
  // aucune saisie d'hôte ou d'utilisateur SSH ne doit réapparaître.
  test("aucune carte n’ouvre un canal vers l’hôte du client", async () => {
    stubFetch("external", "disabled");
    renderSettings();
    await screen.findByText("Profil par défaut partagé");
    expect(screen.queryByRole("button", { name: /canal d’administration/i })).toBeNull();
    expect(screen.queryByLabelText("Hôte")).toBeNull();
    expect(screen.queryByLabelText("Utilisateur")).toBeNull();
    expect(screen.getByText("Capacités gérées sur l’hôte")).toBeTruthy();
  });
});
