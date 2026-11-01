import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "../../../../src/lib/i18n";
import { CloudRuntimeSettings } from "../../../../src/screens/settings/installation/cloud";

/**
 * Rotation du jeton de lien depuis l'écran Edge : le bandeau
 * « lien remplacé depuis une autre adresse » quand l'API le dit, le bouton
 * qui appelle la rotation d'urgence, et le jeton neuf montré UNE fois dans
 * une boîte copiable. Aucun navigateur : happy-dom et un `fetch` factice.
 */

const realFetch = globalThis.fetch;
const realInnerWidth = window.innerWidth;
const NEW_TOKEN = "Um90YXRlZFRva2VuMTIzNDU2Nzg5MA";

function connectorRuntime(link: Partial<NonNullable<{ hijackSuspectedAt: string | null; rotatedAt: string | null }>> = {}) {
  return {
    id: "runtime-2",
    configured: true,
    baseUrl: null,
    transport: "connector",
    reachability: "connector",
    link: {
      connected: true,
      lastSeenAt: "2026-09-02T09:58:00.000Z",
      lastReplacedAt: null,
      hijackSuspectedAt: null,
      rotatedAt: null,
      ...link,
    },
    management: { kind: "manual", credentialsWritable: false, oauthWritable: false },
    name: "Boîtier atelier",
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
}

function stubFetch(runtime: unknown): { rotations: string[] } {
  const rotations: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/link/rotate")) {
      const mode = (JSON.parse(String(init?.body ?? "{}")) as { mode?: string }).mode ?? "maintenance";
      rotations.push(`${init?.method ?? "GET"} ${new URL(url, "http://localhost").pathname} ${mode}`);
      return Response.json(
        {
          linkToken: NEW_TOKEN,
          runtimeId: "runtime-2",
          mode,
          pushed: mode === "maintenance",
          expiresPreviousAt: mode === "maintenance" ? "2026-09-02T10:10:00.000Z" : null,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (url.includes("/api/runtime/list")) return Response.json({ runtimes: [runtime] });
    if (url.includes("/api/runtime")) {
      return Response.json({ runtime, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { rotations };
}

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
  setViewportWidth(1280);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  setViewportWidth(realInnerWidth);
  window.localStorage.clear();
});

describe("rotation du jeton de lien", () => {
  test("sans soupçon : aucune rotation manuelle n'est proposée", async () => {
    stubFetch(connectorRuntime());
    renderSettings();
    expect(await screen.findByText("Runtime actif")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Faire tourner le jeton" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Faire tourner le jeton et couper le lien" })).toBeNull();
    expect(screen.queryByText("Lien remplacé depuis une autre adresse")).toBeNull();
  });

  test("un lien remplacé depuis une autre adresse est annoncé en bandeau, daté, et la rotation devient d'urgence", async () => {
    const { rotations } = stubFetch(connectorRuntime({ hijackSuspectedAt: "2026-09-02T08:30:00.000Z" }));
    renderSettings();
    expect(await screen.findByText("Lien remplacé depuis une autre adresse")).toBeTruthy();
    expect(screen.getByText(/Lien remplacé depuis une autre adresse le .+faites tourner le jeton/)).toBeTruthy();
    expect(screen.getByText(/Le lien actuel sera coupé immédiatement/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Faire tourner le jeton" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Faire tourner le jeton et couper le lien" }));
    await waitFor(() => expect(screen.getByText(NEW_TOKEN)).toBeTruthy());
    expect(rotations).toEqual(["POST /api/runtime/runtime-2/link/rotate emergency"]);
    expect(screen.getByText(/Le lien a été coupé/)).toBeTruthy();
  });

  test("la boîte du jeton d'urgence se ferme et le jeton disparaît de l'écran", async () => {
    stubFetch(connectorRuntime({ hijackSuspectedAt: "2026-09-02T08:30:00.000Z" }));
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Faire tourner le jeton et couper le lien" }));
    await waitFor(() => expect(screen.getByText(NEW_TOKEN)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "J’ai copié le jeton" }));
    await waitFor(() => expect(screen.queryByText(NEW_TOKEN)).toBeNull());
  });

  test("sur mobile, la rotation vit dans le pied d'actions et la vérification dans l'état", async () => {
    setViewportWidth(390);
    stubFetch(connectorRuntime({ hijackSuspectedAt: "2026-09-02T08:30:00.000Z" }));
    renderSettings();
    const button = await screen.findByRole("button", { name: "Faire tourner le jeton et couper le lien" });
    expect(button.closest("[data-mobile-action-footer]")).not.toBeNull();
    expect(button.className).toContain("min-h-11");
    expect(button.className).toContain("justify-center");
    expect(screen.getAllByRole("button", { name: "Faire tourner le jeton et couper le lien" })).toHaveLength(1);
    const tester = screen.getByRole("button", { name: "Vérifier le lien" });
    expect(tester.closest("[data-mobile-action-footer]")).toBeNull();
    expect(tester.closest("[role=tabpanel]")).not.toBeNull();
  });
});
