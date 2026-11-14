import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "../../../src/lib/i18n";
import {
  consumptionByProvider,
  ProviderLimitsPanel,
  providerLimitsWorthShowing,
  useProviderLimits,
} from "../../../src/components/dashboard/provider-limits-panel";
import { openSecondaryReads } from "../../../src/lib/shell/after-first-paint";

const realFetch = globalThis.fetch;
const clients: QueryClient[] = [];
const seen: string[] = [];
let worth: boolean | null = null;

const usageModels = (days: number) => ({
  windowDays: days,
  models: days === 1
    ? [{ model: "claude-sonnet", runs: 3, inputTokens: 48_000, outputTokens: 1_200, tokens: 49_200, lastAt: new Date().toISOString() }]
    : [
      { model: "claude-sonnet", runs: 40, inputTokens: 1_200_000, outputTokens: 30_000, tokens: 1_230_000, lastAt: new Date().toISOString() },
      // A model no connected provider claims is counted for no one.
      { model: "mystery-model", runs: 9, inputTokens: 9_000, outputTokens: 900, tokens: 9_900, lastAt: new Date().toISOString() },
    ],
});

function Harness() {
  const limits = useProviderLimits(true);
  worth = providerLimitsWorthShowing(limits);
  return <ProviderLimitsPanel limits={limits} />;
}

function renderPanel() {
  const rootRoute = createRootRoute({ component: () => <Harness /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const queryClient = new QueryClient();
  clients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  openSecondaryReads();
  seen.length = 0;
  worth = null;
  window.localStorage.setItem("openedbot:locale", "fr");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    if (url.includes("/api/auth/me")) return Response.json({ user: { email: "o@example.test", displayName: null }, organization: { id: "org", slug: "org", name: "Org" }, role: "owner" });
    if (url.includes("/api/runtime") && !url.includes("/runtimes/")) {
      return Response.json({ runtime: { id: "runtime-1", selectedProvider: "anthropic", selectedModel: "claude-sonnet" }, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
    }
    if (url.includes("/provider-usage")) {
      return Response.json({
        runtimeId: "runtime-1", status: "ok", reason: null, fetchedAt: new Date().toISOString(), freshUntil: null,
        providers: [{ provider: "anthropic", source: "api_key", plan: null, windows: [], details: [], unavailableReason: null }],
        error: null,
      });
    }
    if (url.includes("/api/usage/models")) return Response.json(usageModels(Number(new URL(url, "http://x").searchParams.get("days"))));
    if (url.includes("/api/runtimes/runtime-1/models")) return Response.json({ runtimeId: "runtime-1", runtimeName: "VPS", hermesProfile: null, currentProvider: "anthropic", runtimeDefaultModel: "claude-sonnet", hasUsableProvider: true, runtimeConfigWritable: false, providers: [
      { slug: "anthropic", name: "Anthropic", isCurrent: true, authenticated: true, alwaysAuthenticated: false, provesInference: true, authType: "api_key", warning: null, authCommand: null, models: [{ id: "claude-sonnet", fast: false, reasoning: true, isRuntimeDefault: true, freeTier: null }] },
    ] });
    if (url.includes("/api/bots")) return Response.json({ bots: [], sections: [], groups: [], operator: null });
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

test("une clé API Anthropic montre ce qu'elle a consommé, pas un « n/d » ni « aucune API de relevé »", async () => {
  renderPanel();
  const section = await screen.findByText(/Clé API/).then((label) => label.closest("section[data-provider-row]") as HTMLElement);
  expect(within(section).getByText("Anthropic")).toBeTruthy();
  expect(within(section).getByText(/Facturé à l’usage/)).toBeTruthy();
  // 24 h then 30 days, counted on the runs of the model Anthropic serves.
  expect(await within(section).findByText(/49,2\s?k jetons/)).toBeTruthy();
  expect(within(section).getByText(/1,2\s?M jetons/)).toBeTruthy();
  // Input / output appears on hover: the row keeps a single height.
  expect(within(section).getByText(/1,2\s?M jetons/).closest("dd")?.getAttribute("title")).toMatch(/en entrée · .* en sortie/);
  expect(within(section).getByText(/3 runs/)).toBeTruthy();
  expect(within(section).getByText(/40 runs/)).toBeTruthy();
  expect(screen.queryByText("n/d")).toBeNull();
  expect(screen.queryByText(/n’expose aucune API de relevé/)).toBeNull();
  expect(screen.queryByText("Sans relevé")).toBeNull();
  expect(seen.some((url) => url.includes("/api/usage/models?days=1"))).toBe(true);
  expect(seen.some((url) => url.includes("/api/usage/models?days=30"))).toBe(true);
  // The composer keeps its Quotas tab: it has something to show.
  expect(worth).toBe(true);
});

test("la consommation par fournisseur additionne ses modèles et ignore ceux de personne", () => {
  const totals = consumptionByProvider(
    [
      { model: "a1", runs: 1, inputTokens: 10, outputTokens: 1, tokens: 11 },
      { model: "a2", runs: 2, inputTokens: 20, outputTokens: 2, tokens: 22 },
      { model: "x", runs: 5, inputTokens: 50, outputTokens: 5, tokens: 55 },
    ],
    (model) => (model?.startsWith("a") ? "anthropic" : null),
  );
  expect(totals.get("anthropic")).toEqual({ runs: 3, inputTokens: 30, outputTokens: 3, tokens: 33 });
  expect(totals.size).toBe(1);
});
