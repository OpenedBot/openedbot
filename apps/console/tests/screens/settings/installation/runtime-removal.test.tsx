import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "../../../../src/lib/i18n";
import { CloudRuntimeSettings } from "../../../../src/screens/settings/installation/cloud";

const realFetch = globalThis.fetch;
let deletes: Array<{ url: string; body: unknown }> = [];
let active: Record<string, unknown> | null = null;
let declared: unknown[] = [];

function runtime(overrides: Record<string, unknown>) {
  return {
    id: "runtime-1",
    configured: true,
    baseUrl: null,
    reachability: "connector",
    transport: "connector",
    link: { connected: true, lastSeenAt: null, lastReplacedAt: null, hijackSuspectedAt: null, rotatedAt: null, features: [] },
    management: { kind: "manual", credentialsWritable: false, oauthWritable: false },
    name: "VPS production",
    isDefault: false,
    isActive: false,
    tokenConfigured: true,
    botCount: 0,
    selectedProvider: null,
    selectedModel: null,
    reasoningEffort: null,
    detectedVersion: null,
    capabilities: null,
    capacity: 1,
    lastHealthStatus: "healthy",
    lastHealthError: null,
    lastCheckedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if ((init?.method ?? "GET").toUpperCase() === "DELETE") {
      deletes.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
      return Response.json({ ok: true });
    }
    if (url.includes("/api/runtime/list")) return Response.json({ runtimes: declared });
    if (url.includes("/api/runtime")) {
      return Response.json({ runtime: active, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
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

/** La section « Remplacer » du rail, où attend le remplaçant déclaré. */
async function openReplacement() {
  fireEvent.click(await screen.findByRole("tab", { name: /^Remplacer/ }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Remplacer le runtime" })).toBeTruthy());
}

beforeEach(() => {
  deletes = [];
  active = null;
  declared = [];
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("retrait d’un runtime", () => {
  // La carte « Runtime actif » est ce qu'on lit en arrivant sur l'écran :
  // reléguer le retrait dans la modal « Hermes externe » revenait à le cacher.
  test("le runtime actif offre « Retirer » sur l’écran, sans ouvrir le registre", async () => {
    active = runtime({ id: "runtime-9", name: "Boîtier atelier", isActive: true });
    stubFetch();
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: "Retirer Boîtier atelier" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    expect(deletes).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Retirer quand même" }));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]?.url).toContain("/api/runtime/runtime-9");
    expect(deletes[0]?.body).toEqual({ confirm: true });
  });

  test("annuler la confirmation laisse le runtime en place", async () => {
    active = runtime({ id: "runtime-9", name: "Boîtier atelier", isActive: true });
    stubFetch();
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: "Retirer Boîtier atelier" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));

    await waitFor(() => expect(screen.queryAllByRole("alertdialog")).toHaveLength(0));
    expect(deletes).toHaveLength(0);
  });

  // Un runtime qui ne sert rien ne coupe rien : le second geste serait du
  // bruit. Une organisation n'a qu'un runtime ; l'inactif est le remplaçant
  // qui attend, et sa carte offre le retrait.
  test("un runtime inactif du registre part sans confirmation", async () => {
    active = runtime({ id: "runtime-9", name: "Boîtier atelier", isActive: true });
    declared = [active, runtime({ id: "runtime-1", name: "VPS production", isActive: false })];
    stubFetch();
    renderSettings();
    await openReplacement();

    fireEvent.click(await screen.findByRole("button", { name: "Retirer VPS production" }));
    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(screen.queryAllByRole("alertdialog")).toHaveLength(0);
    expect(deletes[0]?.url).toContain("/api/runtime/runtime-1");
    expect(deletes[0]?.body).toEqual({ confirm: false });
  });
});
