/**
 * The runtime registry has three silences not to confuse: the read in
 * progress, the failed read, and the registry actually empty. They all rendered
 * the same card with nothing in it, so an API failure read as a
 * new organization, and an in-flight request contradicted the next render.
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

/** `listStatus` decides what `/api/runtime/list` returns: 200 or a failure. */
function stubFetch(options: { runtimes?: unknown[]; listStatus?: number }) {
  const runtimes = options.runtimes ?? [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/runtime/list")) {
      if (options.listStatus && options.listStatus >= 400) {
        // The API's real error envelope: `{ error: { code, message } }`.
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

describe("registre des runtimes : lecture, échec, vide", () => {
  test("annonce la lecture en cours au lieu de rendre une carte vide", async () => {
    // The request never settles: that is exactly the in-flight state.
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
    // The lie to avoid: asserting an empty registry before the API's response.
    expect(screen.queryByText("Aucun runtime déclaré")).toBeNull();
    // Until the read has said whether a replacement is waiting,
    // the screen does not offer to pair one (the API would refuse it).
    expect(screen.queryByRole("button", { name: "Ajouter un runtime" })).toBeNull();
  });

  test("dit qu’il n’a pas su lire le parc, et n’offre pas d’en déclarer un par-dessus", async () => {
    stubFetch({ listStatus: 503 });
    renderSettings();

    const alert = await screen.findByRole("alert");
    // The failure named by the API, then what it implies for the screen.
    expect(alert.textContent).toContain("Le registre est indisponible.");
    expect(alert.textContent).toContain("cet écran ne montre donc pas son état réel.");
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
    // The lie to avoid: « vous n'avez aucun runtime » when one does not know.
    expect(screen.queryByText("Aucun runtime déclaré")).toBeNull();
    // An organization has only one runtime: without the list, the screen knows neither
    // whether a replacement is already waiting (the API would refuse the second,
    // RUNTIME_REPLACEMENT_PENDING) nor whether this is adding or replacing.
    // It therefore offers no pairing on top; « Réessayer » is the way out.
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
    // The waiting runtime's card says « jamais vu » where a date is missing.
    // The link token is no longer on it: it lives in the État section.
    const card = document.querySelector<HTMLElement>(`[data-pending-runtime="${NEVER_SEEN_RUNTIME.id}"]`);
    expect(card?.textContent).toContain("jamais vu");
    // The character is written escaped: the repository forbids its
    // literal presence, including in the test that proves it is not displayed.
    expect(document.body.textContent ?? "").not.toContain("\u2014");
    expect(screen.queryByText("Aucun runtime déclaré")).toBeNull();
  });
});

describe("l’écran runtime relit ses faits", () => {
  /**
   * The link opens and closes with no operator action. Without a reread,
   * the screen kept the snapshot of its load: « lien connecteur fermé »
   * stayed displayed on a link reopened since, which is worse than silence.
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

    // The link reopens on the server side; nobody touches the screen.
    connected = true;

    // `queryAllByText`, never `queryByText`: while the text appears in
    // several places, `queryByText` throws "multiple elements" and attaches
    // the whole DOM, formatted, to the error. That formatting takes 10 to 12 s
    // per attempt under happy-dom, blocks the event loop and stops the
    // `refetchInterval` (1 s) from firing: the test was waiting on its own rereads.
    await waitFor(
      () => expect(screen.queryAllByText("lien connecteur fermé")).toHaveLength(0),
      { timeout: 20_000 },
    );
    expect(screen.getAllByText("runtime prêt").length).toBeGreaterThan(0);
  }, 30_000);
});
