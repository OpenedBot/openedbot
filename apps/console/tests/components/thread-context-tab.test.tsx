import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RunDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../src/lib/i18n";
import { ThreadContextTab, lastContextReading } from "../../src/components/thread-context-tab";
import { openSecondaryReads } from "../../src/lib/shell/after-first-paint";

/**
 * The composer's context tab. Its rule fits in one sentence: it
 * shows only what has been measured. Tokens come from runs, the window from
 * the host when it serves one, from the local table otherwise, and from nowhere if the
 * model is unknown.
 */

const realFetch = globalThis.fetch;

function run(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: "run-1",
    status: "completed",
    input: "salut",
    output: "bonjour",
    usage: { inputTokens: 90_000, outputTokens: 10_000, totalTokens: 100_000 },
    error: null,
    hermesResponseId: null,
    runtimeSession: { id: "s-1", model: "claude-sonnet-5", reasoningTokens: null, toolCallCount: null },
    createdAt: "2026-09-09T10:00:00.000Z",
    ...overrides,
  } as RunDto;
}

function stubFetch(options: {
  contextWindow?: number | null;
  usageWindows?: unknown[];
  unsupportedProvider?: boolean;
  preamble?: unknown;
  selectedProvider?: string;
  /** `false`: the Anthropic subscription has no reading API either. */
  measured?: boolean;
} = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/auth/me")) {
      return Response.json({
        user: { id: "u-1", email: "elodie@example.test", displayName: "Élodie" },
        organization: { id: "org-1", slug: "acme", name: "Acme" },
        role: "owner",
      });
    }
    if (url.includes("/model-context")) {
      const window = options.contextWindow;
      if (window == null) {
        return Response.json({
          runtimeId: "rt-1", status: "unsupported", reason: "feature_absent",
          model: null, provider: null, contextWindow: 0, autoContextWindow: 0,
          maxOutputTokens: 0, fetchedAt: null, error: null,
        });
      }
      return Response.json({
        runtimeId: "rt-1", status: "ok", reason: null,
        model: "claude-sonnet-5", provider: "anthropic",
        contextWindow: window, autoContextWindow: window,
        maxOutputTokens: 64_000, preamble: options.preamble ?? null,
        fetchedAt: "2026-09-09T10:00:00.000Z", error: null,
      });
    }
    if (url.includes("/provider-usage")) {
      return Response.json({
        runtimeId: "rt-1", status: "ok", reason: null,
        fetchedAt: "2026-09-09T10:00:00.000Z", freshUntil: null, error: null,
        providers: [
          {
            provider: "anthropic",
            source: options.measured === false ? "unsupported" : "oauth_usage_api",
            plan: options.measured === false ? null : "Max (5x)",
            windows: options.measured === false ? [] : options.usageWindows ?? [
              { label: "5-hour limit", usedPercent: 38, resetAt: "2026-09-09T15:00:00.000Z", detail: null },
            ],
            details: [],
            unavailableReason: null,
          },
          // An anonymous tier: never a reading, and a named reason.
          ...(options.unsupportedProvider ? [{
            provider: "opencode-free", source: "unsupported", plan: null, windows: [], details: [],
            unavailableReason: "no account-usage endpoint for this provider",
          }] : []),
        ],
      });
    }
    if (url.includes("/models")) {
      return Response.json({
        runtimeId: "rt-1", runtimeName: "VPS", hermesProfile: null, currentProvider: "anthropic",
        runtimeDefaultModel: "claude-sonnet-5", hasUsableProvider: true, runtimeConfigWritable: false,
        providers: [
          { slug: "anthropic", name: "Anthropic", isCurrent: true, authenticated: true, alwaysAuthenticated: false, provesInference: true, authType: "oauth", warning: null, authCommand: null, models: [{ id: "claude-sonnet-5", fast: false, reasoning: true, isRuntimeDefault: true, freeTier: null }] },
          ...(options.unsupportedProvider ? [{ slug: "opencode-free", name: "OpenCode Free", isCurrent: false, authenticated: true, alwaysAuthenticated: false, provesInference: true, authType: "api_key", warning: null, authCommand: null, models: [{ id: "hy3-free", fast: true, reasoning: false, isRuntimeDefault: false, freeTier: null }] }] : []),
        ],
      });
    }
    if (url.includes("/api/bots")) {
      return Response.json({ bots: [], sections: [], groups: [], operator: null });
    }
    if (url.includes("/api/usage/bots")) {
      return Response.json({ windowDays: 7, bots: [] });
    }
    // `api.runtimes` goes through `GET /api/runtime` (singular): the stub must
    // answer THIS route, otherwise the component has no runtime and only
    // tests its local fallback.
    if (url.includes("/api/runtime") && !url.includes("/model-context") && !url.includes("/provider-usage")) {
      return Response.json({
        runtime: { id: "rt-1", name: "VPS", selectedProvider: options.selectedProvider ?? null },
        mode: "external",
      });
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as unknown as typeof fetch;
}

function renderTab(
  runs: RunDto[],
  botModel: string | null = "claude-sonnet-5",
  events: Parameters<typeof ThreadContextTab>[0]["events"] = [],
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThreadContextTab runs={runs} events={events} botModel={botModel} hermesProfile={null} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // No thread is painted here: open the secondary reads the frame would open.
  openSecondaryReads();
  window.localStorage.setItem("openedbot:locale", "fr");
  window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: "csrf" }));
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

// A thread that has never run has occupied nothing. A bar at zero would say
// « il reste tout », when in fact one simply knows nothing.
test("aucun onglet tant qu'aucun tour n'a rendu d'usage", () => {
  stubFetch();
  renderTab([run({ status: "running", usage: null })]);
  expect(screen.queryByRole("button", { name: "Voir le contexte et les quotas" })).toBeNull();
});

test("l'onglet lit la fenêtre que le runtime publie", async () => {
  stubFetch({ contextWindow: 200_000 });
  renderTab([run()]);
  const tab = await screen.findByRole("button", { name: "Voir le contexte et les quotas" });
  await waitFor(() => expect(tab.textContent).toContain("50 % du contexte"));
});

// The model already lives in the composer picker, two lines below:
// writing it in the bar too says it twice without teaching anything.
test("la barre ne répète pas le modèle du sélecteur", async () => {
  stubFetch({ contextWindow: 200_000 });
  renderTab([run()]);
  const tab = await screen.findByRole("button", { name: "Voir le contexte et les quotas" });
  await waitFor(() => expect(tab.textContent).toContain("50 % du contexte"));
  expect(tab.textContent).not.toContain("claude-sonnet-5");
});

// A runtime with no `edge-setup` operator cannot publish this figure:
// the gateway carries it nowhere. The upstream table takes over, and
// it gives 1 000 000 for claude-sonnet-5, not the 200 000 of a previous
// generation.
test("sans capacité hôte, la table de l’amont fournit le plafond", async () => {
  stubFetch({ contextWindow: null });
  renderTab([run()]);
  const tab = await screen.findByRole("button", { name: "Voir le contexte et les quotas" });
  await waitFor(() => expect(tab.textContent).toContain("10 % du contexte"));
});

// Model absent from the table: the upstream hard cap is what applies,
// the one the agent itself uses for lack of better. 100 000 out of 256 000.
test("un modèle hors table suit le plafond par défaut de l’amont", async () => {
  stubFetch({ contextWindow: null });
  renderTab([run({ runtimeSession: { id: "s", model: "modele-maison", reasoningTokens: null, toolCallCount: null } })], null);
  const tab = await screen.findByRole("button", { name: "Voir le contexte et les quotas" });
  await waitFor(() => expect(tab.textContent).toContain("39,1 % du contexte"));
});

// The runtime always wins: it alone knows its host's configuration override,
// which the table ignores by construction.
test("la fenêtre du runtime prime sur celle de la table", async () => {
  stubFetch({ contextWindow: 200_000 });
  renderTab([run()]);
  const tab = await screen.findByRole("button", { name: "Voir le contexte et les quotas" });
  await waitFor(() => expect(tab.textContent).toContain("50 % du contexte"));
});

test("le détail ouvre la ventilation et le relevé fournisseur complet", async () => {
  stubFetch({ contextWindow: 200_000 });
  renderTab([run()]);
  fireEvent.click(await screen.findByRole("button", { name: "Voir le contexte et les quotas" }));
  // « Contexte » tab: the turn's breakdown, and nothing else.
  expect(await screen.findByText("Conversation envoyée")).toBeTruthy();
  expect(screen.getByText("Réponse")).toBeTruthy();
  // The provider reading lives in its own tab, with its gauge and its reread.
  // Radix switches on pointer, not on a synthetic `click` alone.
  fireEvent.mouseDown(await screen.findByRole("tab", { name: /Quotas/ }));
  expect(await screen.findByText("Anthropic")).toBeTruthy();
  expect(screen.getByText("38 %")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Actualiser les limites" })).toBeTruthy();
});

// What the sidebar no longer says, the tab still says: an anonymous
// tier has no reading, and the reason is named rather than categorized.
test("le détail explique un fournisseur sans relevé", async () => {
  stubFetch({ contextWindow: 200_000, unsupportedProvider: true });
  renderTab([run()]);
  fireEvent.click(await screen.findByRole("button", { name: "Voir le contexte et les quotas" }));
  // Radix switches on pointer, not on a synthetic `click` alone.
  fireEvent.mouseDown(await screen.findByRole("tab", { name: /Quotas/ }));
  expect(await screen.findByText("Sans relevé")).toBeTruthy();
  expect(screen.queryByText("Non mesurable")).toBeNull();
  expect(screen.getByText(/OpenCode Free est servi anonymement, sans compte ni clé/)).toBeTruthy();
});

// The last finished run is what counts: a run in flight has no usage yet, and
// a failed run sometimes carries a partial that no longer describes the session.
// No account measured: the Quotas tab would list only « sans relevé »
// and an Actualiser that will never bring anything back. The dialog is the context.
test("sans compte mesuré, le dialogue n'a pas d'onglet Quotas", async () => {
  stubFetch({ contextWindow: 200_000, unsupportedProvider: true, measured: false });
  // The reading and the catalog must have answered before absence is judged:
  // while they load, the tab is absent too.
  const stub = globalThis.fetch;
  const answered = new Set<string>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const response = await stub(input);
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/provider-usage")) answered.add("usage");
    else if (url.includes("/models")) answered.add("models");
    return response;
  }) as typeof fetch;
  renderTab([run()]);
  fireEvent.click(await screen.findByRole("button", { name: "Voir le contexte et les quotas" }));
  expect(await screen.findByText("Conversation envoyée")).toBeTruthy();
  await waitFor(() => expect(answered.size).toBe(2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText("Contexte et quotas")).toBeNull();
  expect(screen.queryByRole("tab", { name: /Quotas/ })).toBeNull();
  expect(screen.queryByText("Sans relevé")).toBeNull();
  expect(screen.queryByRole("button", { name: "Voir le détail des quotas" })).toBeNull();
});

test("la lecture ignore les runs sans usage exploitable", () => {
  const reading = lastContextReading([
    run({ id: "a", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    run({ id: "b", status: "failed", usage: { inputTokens: 999, outputTokens: 0, totalTokens: 999 } }),
    run({ id: "c", status: "running", usage: null }),
  ]);
  expect(reading).toEqual({ inputTokens: 10, outputTokens: 5, model: "claude-sonnet-5" });
});

test("un usage nul ne compte pas comme une mesure", () => {
  expect(lastContextReading([run({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })])).toBeNull();
});

// The TURN's model wins over the thread's: after a provider
// change, the window shown stays the one under which the measured turn
// actually ran.
test("la lecture prend le modèle du run avant celui de la session", () => {
  const reading = lastContextReading([
    run({ model: "grok-4.6", runtimeSession: null }),
  ]);
  expect(reading?.model).toBe("grok-4.6");
});

// Measured on 2026-09-11: the host answers `status: ok` with `model: ""` and
// `contextWindow: 0`, and a bot that inherits the runtime has an empty `bots.model`. The
// window then fell to « inconnue » even though grok-4.6 is worth 500 000 in the
// upstream table, and the composer showed only a raw token count.
test("un modèle vide côté hôte ne masque plus la fenêtre du modèle du fil", async () => {
  stubFetch({ contextWindow: null });
  renderTab([run({ model: "grok-4.6", runtimeSession: null, usage: { inputTokens: 142_456, outputTokens: 767, totalTokens: 143_223 } })], "grok-4.6");
  const tab = await screen.findByRole("button", { name: "Voir le contexte et les quotas" });
  // 143 223 out of 500 000: the pill writes a percentage, no longer a bare total.
  await waitFor(() => expect(tab.textContent).toContain("28,6 % du contexte"));
});

// Measured on 2026-09-11: a turn at 143 223 billed tokens on a session that
// occupies only ~49 000. The gauge must show the OCCUPATION, and the turn's cost
// be read apart, otherwise a talkative turn makes a full window look true.
test("la jauge suit l'occupation de la session, pas le coût du tour", async () => {
  stubFetch({ contextWindow: 200_000 });
  renderTab(
    [run({ usage: { inputTokens: 143_000, outputTokens: 223, totalTokens: 143_223 } })],
    "claude-sonnet-5",
    [{
      cursor: 1,
      sequence: 1,
      runId: "run-1",
      type: "run.completed",
      payload: {
        contextUsage: { tokens: 48_856, toolTokens: 45_993, sentTokens: 2_863, source: "estimated" },
      },
      occurredAt: new Date("2026-09-11T00:00:00.000Z"),
    }] as unknown as Parameters<typeof ThreadContextTab>[0]["events"],
  );

  const tab = await screen.findByRole("button", { name: "Voir le contexte et les quotas" });
  // 48 856 out of 200 000, and not 143 223 which would exceed the window.
  await waitFor(() => expect(tab.textContent).toContain("24,4 % du contexte"));

  fireEvent.click(tab);
  expect(await screen.findByText("Résultats d’outils")).toBeTruthy();
  expect(screen.getByText(/143 223 jetons facturés/)).toBeTruthy();
  // The method note (model, window provenance, estimate) has been removed.
  expect(screen.queryByText(/estimé à quatre caractères par jeton/)).toBeNull();
});

function completedWith(contextUsage: unknown) {
  return [{
    cursor: 1,
    sequence: 1,
    runId: "run-1",
    type: "run.completed",
    payload: { contextUsage },
    occurredAt: new Date("2026-10-12T00:00:00.000Z"),
  }] as unknown as Parameters<typeof ThreadContextTab>[0]["events"];
}

// The full card: the turn post by post, the preamble the host
// measured, what it could not measure listed with a dash, and groups that
// name their members.
test("la carte ventile le tour et le préambule de l'hôte, MCP listé sans être compté", async () => {
  stubFetch({
    contextWindow: 200_000,
    preamble: {
      buckets: [
        { key: "identity", tokens: 1_000, items: [] },
        { key: "skills", tokens: 2_000, items: [{ name: "daily-brief", tokens: 2_000 }] },
        { key: "tools", tokens: 7_000, items: [{ name: "terminal", tokens: 4_000 }, { name: "web_search", tokens: 3_000 }] },
        { key: "mcp", tokens: null, items: [{ name: "linear", tokens: null }] },
      ],
    },
  });
  renderTab([run()], "claude-sonnet-5", completedWith({
    tokens: 30_000,
    toolTokens: 20_000,
    sentTokens: 10_000,
    breakdown: { instructions: 0, history: 8_000, input: 1_000, toolCalls: 1_000, toolResults: 19_000, reasoning: 0, reply: 1_000 },
    tools: [{ name: "web_search", tokens: 20_000, calls: 3 }],
    source: "estimated",
  }));

  const tab = await screen.findByRole("button", { name: "Voir le contexte et les quotas" });
  // 10 000 + 19 000 + 1 000 of the turn, 10 000 of the preamble: 40 000 out of 200 000.
  await waitFor(() => expect(tab.textContent).toContain("20 % du contexte"));

  fireEvent.click(tab);
  expect(await screen.findByText("Messages")).toBeTruthy();
  expect(screen.getByText("Appels d’outils")).toBeTruthy();
  expect(screen.getAllByText("Outils système").length).toBeGreaterThan(0);
  expect(screen.getByText("Identité (SOUL.md)")).toBeTruthy();
  expect(screen.getByText("Outils MCP (non mesurés)")).toBeTruthy();
  // Nothing measured at zero: neither reasoning, nor empty instructions.
  expect(screen.queryByText("Raisonnement")).toBeNull();
  // The turn's tool group opens on its own and names its calls.
  fireEvent.click(screen.getByRole("button", { name: /Outils du tour/ }));
  expect(await screen.findByText("3 appels")).toBeTruthy();
  // The method note (model, window provenance, estimate) has been removed.
  expect(screen.queryByText(/mesuré sur l’hôte/)).toBeNull();
});

// A host that does not publish its preamble yet: it exists anyway, the
// card says so, and the bar does not invent its size.
test("sans préambule publié, la carte le liste comme non mesuré", async () => {
  stubFetch({ contextWindow: 200_000 });
  renderTab([run()], "claude-sonnet-5", completedWith({
    tokens: 30_000,
    toolTokens: 0,
    sentTokens: 30_000,
    source: "estimated",
  }));
  fireEvent.click(await screen.findByRole("button", { name: "Voir le contexte et les quotas" }));
  expect(await screen.findByText("Préambule Hermes (non mesuré)")).toBeTruthy();
  // The method note (model, window provenance, estimate) has been removed.
  expect(screen.queryByText(/c’est un plancher/)).toBeNull();
});

// The bottom of the BoardUI card: the windows of the plan in service, and an
// arrow to the full reading.
test("les limites du forfait en service ferment la carte, la flèche ouvre les quotas", async () => {
  stubFetch({
    contextWindow: 200_000,
    selectedProvider: "anthropic",
    usageWindows: [
      { label: "5-hour limit", usedPercent: 38, resetAt: null, detail: null },
      { label: "Weekly · all models", usedPercent: 3, resetAt: null, detail: null },
    ],
  });
  renderTab([run()]);
  fireEvent.click(await screen.findByRole("button", { name: "Voir le contexte et les quotas" }));
  expect(await screen.findByText("Limites du forfait · Max (5x)")).toBeTruthy();
  expect(screen.getByText("5-hour limit")).toBeTruthy();
  expect(screen.getByText("Weekly · all models")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Voir le détail des quotas" }));
  expect(await screen.findByRole("button", { name: "Actualiser les limites" })).toBeTruthy();
});
