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

/** An organization has only one runtime: a second exists only while waiting to replace it. */
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
 * Replacement is the « Remplacer » section of the rail, not a modal. The
 * rail label and the card title look alike: aim for the title.
 */
async function openReplacementSection() {
  fireEvent.click(await screen.findByRole("tab", { name: /^Remplacer/ }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Remplacer le runtime" })).toBeTruthy());
}

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // The screen carries router links: it needs a RouterProvider.
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
  // The screen opens on the active runtime's state; replacement is a
  // rail section, one tab further: never stacked under the card. With a
  // runtime that is serving, the action is no longer « ajouter » but « remplacer ».
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

  // The counter no longer counts runtimes: it signals the replacement that is waiting,
  // visible without opening the section. With no replacement, no counter.
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

  // With no runtime, the screen opens on adding and offers ONLY ONE path of
  // creation: the « Ajouter un runtime » button, once (the rail tab
  // carries the same name but is only navigation). The lead card says it,
  // it does not double it with a second button or a form.
  test("n’ouvre qu’un seul chemin de création quand aucun runtime n’existe", async () => {
    stubFetch("external", "disabled", []);
    renderSettings();

    await waitFor(() => expect(screen.getByRole("button", { name: "Ajouter un runtime" })).toBeTruthy());
    expect(screen.getAllByRole("button", { name: "Ajouter un runtime" })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Ajouter un runtime" }).getAttribute("aria-selected")).toBe("true");
    // With no runtime, « État » has no fact to show: the rail does not offer it.
    expect(screen.queryByRole("tab", { name: "État" })).toBeNull();
    expect(screen.getAllByText("Aucune machine reliée").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Nom")).toBeNull();
    expect(screen.queryByLabelText("URL Hermes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Enregistrer et vérifier" })).toBeNull();
    expect(screen.queryByText("Runtime actif")).toBeNull();
  });
});

describe("écran runtime en mode externe, runtime connector", () => {
  // A connector runtime has no URL on the cloud side, and PUT /api/runtime
  // refuses it (409 RUNTIME_REACHABILITY_IMMUTABLE): the replacement's card must
  // state reachability and the link state, never promise an edit.
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
    // runtimeHealth.disconnected (fr): the closed link is read, it is not guessed.
    expect(within(card).getByText("lien connecteur fermé")).toBeTruthy();
    // The link's last sign of life is stated on the card, in words.
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
    // The connector has its action in the link state, not a second probe in the hero.
    expect(screen.queryByRole("button", { name: "Tester la connexion" })).toBeNull();
  });
});

describe("aide au token, placement", () => {
  // The manual path and the token help have left the registry: connector-only
  // pairing no longer exposes a bearer to go read on the host. With no
  // runtime, the screen opens directly on adding.
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

  // The link's thread carries the state: it is read without opening a section.
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

  // There is no longer an administration card beside the runtime, and
  // no host or SSH user field must reappear.
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
