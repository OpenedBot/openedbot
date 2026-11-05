/**
 * Le registre des runtimes a trois silences à ne pas confondre : la lecture en
 * cours, la lecture en échec, et le parc réellement vide. Ils rendaient tous
 * la même carte sans rien dedans, donc une panne de l'API se lisait comme une
 * organisation neuve, et une requête en vol démentait le rendu suivant.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "../../../../src/lib/i18n";
import { CloudRuntimeSettings } from "../../../../src/screens/settings/installation/cloud";

const realFetch = globalThis.fetch;

const NEVER_SEEN_RUNTIME = {
  id: "6f0a1b2c-3d4e-4f50-9a1b-2c3d4e5f6071",
  name: "VPS production",
  configured: true,
  baseUrl: "",
  reachability: "connector",
  transport: "connector",
  isActive: false,
  lastHealthStatus: "unknown",
  lastCheckedAt: null,
  lastHealthError: null,
  link: { connected: false, lastSeenAt: null, rotatedAt: null, hijackSuspectedAt: null },
  management: { kind: "host", credentialsWritable: false, oauthWritable: false },
};

/** `listStatus` décide de ce que rend `/api/runtime/list` : 200 ou panne. */
function stubFetch(options: { runtimes?: unknown[]; listStatus?: number }) {
  const runtimes = options.runtimes ?? [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/runtime/list")) {
      if (options.listStatus && options.listStatus >= 400) {
        // L'enveloppe d'erreur réelle de l'API : `{ error: { code, message } }`.
        return Response.json(
          { error: { code: "RUNTIME_LIST_UNAVAILABLE", message: "Le registre est indisponible." } },
          { status: options.listStatus },
        );
      }
      return Response.json({ runtimes });
    }
    if (url.includes("/api/runtime")) {
      return Response.json({ runtime: null, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
    }
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
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

describe("registre des runtimes : lecture, échec, vide", () => {
  test("annonce la lecture en cours au lieu de rendre une carte vide", async () => {
    // La requête ne se règle jamais : c'est exactement l'état « en vol ».
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/runtime/list")) return new Promise<Response>(() => {});
      if (url.includes("/api/runtime")) {
        return Response.json({ runtime: null, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
      }
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    renderSettings();

    await waitFor(() => expect(screen.getByRole("status", { name: "Lecture du runtime" })).toBeTruthy());
    // Le mensonge à éviter : affirmer le parc vide avant la réponse de l'API.
    expect(screen.queryByText("Aucun runtime déclaré")).toBeNull();
    // Tant que la lecture n'a pas dit s'il existe un remplaçant en attente,
    // l'écran n'offre pas d'en appairer un (l'API le refuserait).
    expect(screen.queryByRole("button", { name: "Ajouter un runtime" })).toBeNull();
  });

  test("dit qu’il n’a pas su lire le parc, et n’offre pas d’en déclarer un par-dessus", async () => {
    stubFetch({ listStatus: 503 });
    renderSettings();

    const alert = await screen.findByRole("alert");
    // La panne nommée par l'API, puis ce qu'elle implique pour l'écran.
    expect(alert.textContent).toContain("Le registre est indisponible.");
    expect(alert.textContent).toContain("cet écran ne montre donc pas son état réel.");
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
    // Le mensonge à éviter : « vous n'avez aucun runtime » alors qu'on ignore.
    expect(screen.queryByText("Aucun runtime déclaré")).toBeNull();
    // Une organisation n'a qu'un runtime : sans la liste, l'écran ne sait ni
    // si un remplaçant attend déjà (l'API refuserait le second,
    // RUNTIME_REPLACEMENT_PENDING) ni s'il s'agit d'ajouter ou de remplacer.
    // Il n'offre donc aucun appairage par-dessus ; « Réessayer » est la sortie.
    expect(screen.queryByRole("button", { name: "Ajouter un runtime" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remplacer le runtime" })).toBeNull();
  });

  test("un parc réellement vide porte son état et un seul geste", async () => {
    stubFetch({ runtimes: [] });
    renderSettings();

    await waitFor(() => expect(screen.getByText("Aucun runtime déclaré")).toBeTruthy());
    expect(screen.getAllByRole("button", { name: "Ajouter un runtime" })).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("une valeur absente se dit en mots, jamais par un tiret cadratin", async () => {
    stubFetch({ runtimes: [NEVER_SEEN_RUNTIME] });
    renderSettings();

    await waitFor(() => expect(screen.getByText("VPS production")).toBeTruthy());
    // La carte du runtime en attente dit « jamais vu » là où une date manque.
    // Le jeton de lien n'y figure plus : il vit dans la section État.
    const card = document.querySelector<HTMLElement>(`[data-pending-runtime="${NEVER_SEEN_RUNTIME.id}"]`);
    expect(card?.textContent).toContain("jamais vu");
    // Le caractère est écrit en échappement : le dépôt interdit sa présence
    // littérale, y compris dans le test qui prouve qu'il ne s'affiche pas.
    expect(document.body.textContent ?? "").not.toContain("\u2014");
    expect(screen.queryByText("Aucun runtime déclaré")).toBeNull();
  });
});

describe("l’écran runtime relit ses faits", () => {
  /**
   * Le lien s'ouvre et se ferme sans geste de l'opérateur. Sans relecture,
   * l'écran gardait l'instantané de son chargement : « lien connecteur fermé »
   * restait affiché sur un lien rouvert depuis, ce qui est pire que le silence.
   */
  test("un lien rouvert cesse d’être annoncé fermé, sans recharger la page", async () => {
    let connected = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const runtime = {
        id: "6f0a1b2c-3d4e-4f50-9a1b-2c3d4e5f6071",
        name: "mac (poste)",
        configured: true,
        baseUrl: "",
        reachability: "connector",
        transport: "connector",
        isActive: true,
        lastHealthStatus: connected ? "healthy" : "disconnected",
        lastCheckedAt: null,
        lastHealthError: null,
        link: { connected, lastSeenAt: "2026-09-09T10:47:00.000Z", rotatedAt: null, hijackSuspectedAt: null },
        management: { kind: "host", credentialsWritable: connected, oauthWritable: connected },
      };
      if (url.includes("/api/runtime/list")) return Response.json({ runtimes: [runtime] });
      if (url.includes("/api/runtime")) {
        return Response.json({ runtime, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
      }
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    renderSettings();

    await waitFor(() => expect(screen.getAllByText("lien connecteur fermé").length).toBeGreaterThan(0));

    // Le lien se rouvre côté serveur ; personne ne touche à l'écran.
    connected = true;

    // `queryAllByText`, jamais `queryByText` : tant que le texte figure à
    // plusieurs endroits, `queryByText` lève « plusieurs éléments » et joint à
    // l'erreur le DOM entier, mis en forme. Cette mise en forme prend 10 à 12 s
    // par essai sous happy-dom, bloque la boucle d'événements et empêche le
    // `refetchInterval` (1 s) de tirer : le test attendait ses propres relectures.
    await waitFor(
      () => expect(screen.queryAllByText("lien connecteur fermé")).toHaveLength(0),
      { timeout: 20_000 },
    );
    expect(screen.getAllByText("runtime prêt").length).toBeGreaterThan(0);
  }, 30_000);
});
