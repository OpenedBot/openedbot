import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { I18nProvider } from "../../../../src/lib/i18n";
import { queryKeys } from "../../../../src/lib/api";
import { McpOauthDialog } from "../../../../src/screens/settings/installation/connectors/connectors-mcp-oauth";
import { invalidateMcpConnectionReads } from "../../../../src/screens/settings/installation/connectors/connectors-mcp-shared";

const realFetch = globalThis.fetch;

const pending = {
  sessionId: "sess-1", server: "acme", status: "pending", callbackReceived: false, authorizationUrl: "https://auth.example/authorize?state=s",
  error: null, errorCode: null, discoveredTools: [], expiresAt: "x",
};

type Reply = Response | Promise<Response>;

/** The OAuth routes of the API, answered in order; every call is recorded. */
function stubOauth(handlers: { start?: (body: string) => Reply; poll?: (count: number) => Reply }) {
  const calls: string[] = [];
  let polls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://test").pathname;
    calls.push(`${method} ${path} ${typeof init?.body === "string" ? init.body : ""}`.trim());
    if (path === "/api/runtime/integrations/mcp/servers/acme/oauth" && method === "POST") {
      return handlers.start ? handlers.start(typeof init?.body === "string" ? init.body : "") : Response.json(pending);
    }
    if (/\/oauth\/[^/]+$/.test(path) && method === "GET") {
      polls += 1;
      return handlers.poll ? handlers.poll(polls) : Response.json(pending);
    }
    if (/\/oauth\/[^/]+$/.test(path) && method === "DELETE") return new Response(null, { status: 204 });
    // The live-reload hint reads the runtime's features.
    if (path.startsWith("/api/runtime")) return Response.json({ runtime: null, runtimes: [] });
    throw new Error(`Route inattendue : ${method} ${path}`);
  }) as typeof fetch;
  return calls;
}

const failure = (status: number, code: string) =>
  Response.json({ error: { code, message: `refus ${code}` } }, { status });

function Harness() {
  const [server, setServer] = useState<string | null>("acme");
  const [mounted, setMounted] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setServer("acme")}>Rouvrir</button>
      <button type="button" onClick={() => setMounted(false)}>Quitter la page</button>
      {mounted ? <McpOauthDialog server={server} onClose={() => setServer(null)} onConnected={() => undefined} /> : null}
    </>
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <Harness />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const cancelled = (calls: string[]) => calls.filter((call) => call.startsWith("DELETE /api/runtime/integrations/mcp/servers/acme/oauth/"));

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("boîte d'autorisation OAuth MCP", () => {
  test("la fermer par la croix annule l'autorisation en attente sur l'hôte", async () => {
    const calls = stubOauth({});
    renderDialog();
    await screen.findByRole("link", { name: /Ouvrir la page d’autorisation/ });
    expect(cancelled(calls)).toEqual([]);
    // The cross: the only « Fermer » while the foot offers « Annuler ».
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    await waitFor(() => expect(cancelled(calls)).toEqual(["DELETE /api/runtime/integrations/mcp/servers/acme/oauth/sess-1"]));
  });

  test("un hôte ancien, qui ne dit pas si le retour est arrivé : la fermeture n'annule rien d'elle-même", async () => {
    const calls = stubOauth({ start: () => Response.json({ ...pending, callbackReceived: undefined }), poll: () => Response.json({ ...pending, callbackReceived: undefined }) });
    renderDialog();
    await screen.findByRole("link", { name: /Ouvrir la page d’autorisation/ });
    // « Annuler » stays the explicit gesture.
    expect(screen.getByRole("button", { name: "Annuler" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    await settle();
    expect(cancelled(calls)).toEqual([]);
  });

  test("une fois le retour du fournisseur reçu par l'hôte, ni la fermeture ni « Annuler » ne défont l'approbation", async () => {
    const calls = stubOauth({ poll: () => Response.json({ ...pending, callbackReceived: true }) });
    renderDialog();
    expect((await screen.findAllByText(/Approbation reçue : l’hôte termine l’autorisation/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Annuler" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Fermer" })[0]!);
    await settle();
    expect(cancelled(calls)).toEqual([]);
  });

  test("fermée puis rouverte pendant le démarrage : la session reprise n'est pas annulée par l'ancien démarrage", async () => {
    const gates: Array<() => void> = [];
    const calls = stubOauth({
      start: () => new Promise<Response>((resolve) => { gates.push(() => resolve(Response.json(pending))); }),
    });
    renderDialog();
    await waitFor(() => expect(gates.length).toBe(1));
    fireEvent.click(screen.getAllByRole("button", { name: "Fermer" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Rouvrir" }));
    await waitFor(() => expect(gates.length).toBe(2));
    // The old start answers first, with the session the new one resumes.
    gates[0]!();
    await settle();
    gates[1]!();
    await screen.findByRole("link", { name: /Ouvrir la page d’autorisation/ });
    await settle();
    expect(cancelled(calls)).toEqual([]);
  });

  test("la page quittée sans fermer la boîte abandonne la session en attente, mais pas sur un hôte ancien", async () => {
    let calls = stubOauth({});
    renderDialog();
    await screen.findByRole("link", { name: /Ouvrir la page d’autorisation/ });
    fireEvent.click(screen.getByRole("button", { name: "Quitter la page" }));
    await waitFor(() => expect(cancelled(calls)).toEqual(["DELETE /api/runtime/integrations/mcp/servers/acme/oauth/sess-1"]));
    cleanup();

    calls = stubOauth({ start: () => Response.json({ ...pending, callbackReceived: undefined }), poll: () => Response.json({ ...pending, callbackReceived: undefined }) });
    renderDialog();
    await screen.findByRole("link", { name: /Ouvrir la page d’autorisation/ });
    fireEvent.click(screen.getByRole("button", { name: "Quitter la page" }));
    await settle();
    expect(cancelled(calls)).toEqual([]);
  });

  test("remplacer une autorisation qui vient d'être approuvée : refusé, dit comme tel, et « Recommencer »", async () => {
    let starts = 0;
    stubOauth({
      start: () => {
        starts += 1;
        if (starts === 1) return failure(409, "MCP_OAUTH_IN_PROGRESS");
        if (starts === 2) return failure(409, "OAUTH_CALLBACK_RECEIVED");
        return Response.json(pending);
      },
    });
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Annuler l’autre et recommencer" }));
    expect(await screen.findByText(/L’autre autorisation vient d’être approuvée/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recommencer" }));
    await screen.findByRole("link", { name: /Ouvrir la page d’autorisation/ });
  });

  test("fermée pendant le démarrage, la session qui arrive ensuite est annulée, pas laissée en attente", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls = stubOauth({ start: async () => { await gate; return Response.json(pending); } });
    renderDialog();
    await screen.findAllByText(/L’hôte prépare l’autorisation/);
    fireEvent.click(screen.getAllByRole("button", { name: "Fermer" })[0]!);
    release();
    await waitFor(() => expect(cancelled(calls)).toEqual(["DELETE /api/runtime/integrations/mcp/servers/acme/oauth/sess-1"]));
  });

  test("une autorisation déjà en cours (autre bot, autre onglet) se dit comme telle, et se remplace sur demande", async () => {
    let starts = 0;
    const calls = stubOauth({
      start: () => {
        starts += 1;
        return starts === 1 ? failure(409, "MCP_OAUTH_IN_PROGRESS") : Response.json({ ...pending, sessionId: "sess-2" });
      },
    });
    renderDialog();
    expect(await screen.findByText(/Une autorisation est déjà en cours pour ce connecteur/)).toBeTruthy();
    // Never a silent success: no provider link to open.
    expect(screen.queryByRole("link", { name: /Ouvrir la page d’autorisation/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Annuler l’autre et recommencer" }));
    await screen.findByRole("link", { name: /Ouvrir la page d’autorisation/ });
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([
      "POST /api/runtime/integrations/mcp/servers/acme/oauth {}",
      'POST /api/runtime/integrations/mcp/servers/acme/oauth {"replacePending":true}',
    ]);
  });

  test("un démarrage en échec sur le chemin (hôte injoignable) offre « Recommencer »", async () => {
    let starts = 0;
    stubOauth({ start: () => (++starts === 1 ? failure(502, "RUNTIME_ADMIN_UNAVAILABLE") : Response.json(pending)) });
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Recommencer" }));
    await screen.findByRole("link", { name: /Ouvrir la page d’autorisation/ });
  });

  test("un relevé en échec ne perd pas l'autorisation : le suivi reprend tout seul", async () => {
    stubOauth({ poll: (count) => (count === 1 ? failure(502, "RUNTIME_ADMIN_UNAVAILABLE") : Response.json({ ...pending, status: "connected", authorizationUrl: null, discoveredTools: ["search"] })) });
    renderDialog();
    expect(await screen.findByText(/Autorisé : 1 outil/, undefined, { timeout: 4_000 })).toBeTruthy();
    expect(screen.queryByText(/n’existe plus sur l’hôte/)).toBeNull();
  });

  test("des relevés en échec répétés : le suivi s'interrompt sans se dire perdu, et se reprend", async () => {
    let failing = true;
    stubOauth({ poll: () => (failing ? failure(502, "RUNTIME_ADMIN_UNAVAILABLE") : Response.json(pending)) });
    renderDialog();
    const resume = await screen.findByRole("button", { name: "Reprendre le suivi" }, { timeout: 8_000 });
    expect(screen.getByText(/L’hôte ne répond plus au suivi de cette autorisation/)).toBeTruthy();
    expect(screen.queryByText(/n’existe plus sur l’hôte/)).toBeNull();
    failing = false;
    fireEvent.click(resume);
    await screen.findAllByText(/En attente de votre approbation/);
  }, 12_000);

  test("une session que l'hôte ne connaît plus (404) est perdue pour de bon, et « Recommencer » en ouvre une neuve", async () => {
    let starts = 0;
    const calls = stubOauth({
      start: () => Response.json({ ...pending, sessionId: `sess-${++starts}` }),
      poll: () => failure(404, "OAUTH_SESSION_NOT_FOUND"),
    });
    renderDialog();
    expect(await screen.findByText(/Cette autorisation n’existe plus sur l’hôte/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recommencer" }));
    await waitFor(() => expect(calls.filter((call) => call.startsWith("POST")).length).toBe(2));
    // A lost session is not polled again in a loop.
    expect(calls.filter((call) => call.startsWith("GET /api/runtime/integrations/mcp/servers/acme/oauth/sess-1")).length).toBe(1);
  });
});

test("une connexion ou une déconnexion relit les mêmes lectures, profils compris", async () => {
  const queryClient = new QueryClient();
  const invalidated: unknown[] = [];
  queryClient.invalidateQueries = (async (filters?: { queryKey?: unknown }) => { invalidated.push(filters?.queryKey); }) as typeof queryClient.invalidateQueries;
  invalidateMcpConnectionReads(queryClient, "bot-1");
  expect(invalidated).toEqual([
    queryKeys.runtimeMcp,
    queryKeys.runtimeIntegrations,
    queryKeys.runtimeGateway,
    queryKeys.runtimeProfiles,
    queryKeys.botCapabilities("bot-1"),
  ]);
});
