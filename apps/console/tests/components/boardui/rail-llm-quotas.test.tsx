import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ProviderUsageSnapshotDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { TooltipProvider } from "@openedbot/browser-ui-kit";
import { I18nProvider } from "../../../src/lib/i18n";
import { openSecondaryReads } from "../../../src/lib/shell/after-first-paint";
import { RailLlmQuotas, bindingWindow, railQuotaFamilies } from "../../../src/components/boardui/rail-llm-quotas";

const realFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let role = "owner";
let usageStatus = "ok";
let providers: Array<{ slug: string; name: string }> = [];
let snapshots: ProviderUsageSnapshotDto[] = [];

function provider(slug: string): RuntimeModelProviderDto {
  return { slug, name: slug, isCurrent: false, authenticated: true, alwaysAuthenticated: false, provesInference: true, authType: "oauth", acceptsApiKey: false, acceptsOauth: true, sdkInstalled: true, sdkInstallable: false, warning: null, authCommand: null, models: [{ id: `${slug}-m`, fast: false, reasoning: false, isRuntimeDefault: false, freeTier: null }] } as RuntimeModelProviderDto;
}

function snapshot(slug: string, windows: Array<[string, number | null]>, source: ProviderUsageSnapshotDto["source"] = "usage_api"): ProviderUsageSnapshotDto {
  return {
    provider: slug,
    source,
    plan: null,
    windows: windows.map(([label, usedPercent]) => ({ label, usedPercent, resetAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), detail: null })),
    details: [],
    unavailableReason: source === "unavailable" || source === "unsupported" ? "x" : null,
  };
}

function families(slugs: string[], snaps: ProviderUsageSnapshotDto[], inService: string[] = []) {
  return railQuotaFamilies({
    providers: slugs.map(provider),
    snapshots: new Map(snaps.map((item) => [item.provider, item])),
    inService: new Set(inService),
  });
}

describe("railQuotaFamilies", () => {
  test("GPT, Anthropic et Grok, toujours dans cet ordre, en restant", () => {
    const result = families(
      ["xai-oauth", "anthropic", "openai-codex"],
      [
        snapshot("openai-codex", [["Session", 30], ["Weekly", 55]]),
        snapshot("anthropic", [["Current session", 10], ["Current week", 20], ["Opus week", 100]]),
        snapshot("xai-oauth", [["Weekly", 96.4]]),
      ],
    );
    expect(result.map((family) => family.key)).toEqual(["gpt", "anthropic", "grok"]);
    // La fenêtre la plus entamée fait le mur ; « Opus week » ne plafonne qu'un modèle.
    expect(result.map((family) => family.reading.state === "measured" ? Math.round(family.reading.remaining) : null)).toEqual([45, 80, 4]);
  });

  test("une famille sans compte est « off », une clé API n'a pas de restant, un échec se dit", () => {
    const result = families(
      ["openai-api", "xai-oauth"],
      [snapshot("openai-api", [], "api_key"), snapshot("xai-oauth", [], "unavailable")],
    );
    expect(result[0]!.reading).toEqual({ state: "apiKey", provider: "openai-api" });
    expect(result[1]!.reading).toEqual({ state: "off" });
    expect(result[2]!.reading).toEqual({ state: "unmeasured", provider: "xai-oauth", failed: true });
    // Un hôte d'avant la sonde Grok la range en `unsupported` : pas de relevé, pas un échec.
    expect(families(["xai-oauth"], [snapshot("xai-oauth", [], "unsupported")])[2]!.reading)
      .toEqual({ state: "unmeasured", provider: "xai-oauth", failed: false });
  });

  test("deux comptes GPT : celui en service l'emporte, même moins entamé", () => {
    const snaps = [snapshot("openai-codex", [["Weekly", 90]]), snapshot("openai-api", [["Monthly", 10]])];
    const served = families(["openai-codex", "openai-api"], snaps, ["openai-api"])[0]!.reading;
    expect(served.state === "measured" && served.provider).toBe("openai-api");
    const idle = families(["openai-codex", "openai-api"], snaps)[0]!.reading;
    expect(idle.state === "measured" && idle.provider).toBe("openai-codex");
  });

  test("une fenêtre sans pourcentage ne fait pas de mur", () => {
    expect(bindingWindow(snapshot("anthropic", [["Current week", null]]))).toBeNull();
  });
});

function renderRail() {
  const rootRoute = createRootRoute({ component: () => <TooltipProvider><RailLlmQuotas buttonClassName="rail" /></TooltipProvider> });
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
  role = "owner";
  usageStatus = "ok";
  providers = [{ slug: "openai-codex", name: "OpenAI Codex" }, { slug: "anthropic", name: "Anthropic" }];
  snapshots = [snapshot("openai-codex", [["Weekly", 42]]), snapshot("anthropic", [["Current week", 85]])];
  window.localStorage.setItem("ohb:locale", "fr");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/auth/me")) return Response.json({ user: { email: "o@example.test", displayName: null }, organization: { id: "org", slug: "org", name: "Org" }, role });
    if (url.includes("/api/runtime") && !url.includes("/runtimes/")) {
      return Response.json({ runtime: { id: "runtime-1", selectedProvider: "anthropic", selectedModel: "anthropic-m" }, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
    }
    if (url.includes("/provider-usage")) {
      return Response.json({
        runtimeId: "runtime-1", status: usageStatus, reason: null,
        fetchedAt: usageStatus === "ok" ? new Date(Date.now() - 60_000).toISOString() : null, freshUntil: null,
        providers: usageStatus === "ok" ? snapshots : [],
        error: null,
      });
    }
    if (url.includes("/api/runtimes/runtime-1/models")) {
      return Response.json({ runtimeId: "runtime-1", runtimeName: "VPS", hermesProfile: null, currentProvider: "anthropic", runtimeDefaultModel: "anthropic-m", hasUsableProvider: true, runtimeConfigWritable: false, providers: providers.map(({ slug, name }) => ({ ...provider(slug), name })) });
    }
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

describe("RailLlmQuotas", () => {
  test("trois vrais logos empilés, GPT puis Anthropic puis Grok, chacun nommé par sa phrase", async () => {
    renderRail();
    const group = await screen.findByRole("group", { name: "Quota LLM restant" });
    const buttons = [...group.querySelectorAll("button[data-rail-quota]")];
    expect(buttons.map((node) => `${node.getAttribute("data-rail-quota")}:${node.getAttribute("data-rail-quota-state")}`))
      .toEqual(["gpt:measured", "anthropic:measured", "grok:off"]);
    // Chaque bouton porte un vrai logo (tracé de marque), pas une jauge abstraite.
    for (const button of buttons) expect(button.querySelectorAll("svg path").length).toBe(1);
    const gpt = screen.getByRole("button", { name: /^GPT : 58 % restant · réinit\. dans 3 h/ });
    expect(gpt.getAttribute("aria-label")).toContain("Lu il y a 1 min");
    expect(screen.getByRole("button", { name: /^Anthropic : 15 % restant/ })).toBeTruthy();
    // L'anneau suit le restant : 58 sur 100.
    expect(gpt.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray")).toBe("58 100");
    // Anthropic à 85 % consommé : l'anneau passe à l'ambre.
    expect(screen.getByRole("button", { name: /^Anthropic/ }).querySelector("circle[stroke-dasharray]")?.getAttribute("class")).toContain("text-amber-500");

    fireEvent.click(gpt);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("fermer la modale rend le focus au logo sans rouvrir son infobulle", async () => {
    renderRail();
    const gpt = await screen.findByRole("button", { name: /^GPT : 58 % restant/ });
    // Un vrai clic focalise le bouton : c'est ce focus que la modale restaure.
    gpt.focus();
    fireEvent.click(gpt);
    const dialog = await screen.findByRole("dialog");
    // La modale prend le focus à l'image suivante : le logo l'a bien quitté.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.activeElement === dialog).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Fermer" }).at(-1)!);
    // La modale rend le focus en se démontant, après son fondu de sortie (150 ms).
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement === gpt).toBe(true);
    expect(screen.queryByRole("tooltip")).toBeNull();
    // Le focus suivant (clavier) montre de nouveau l'infobulle.
    fireEvent.blur(gpt);
    fireEvent.focus(gpt);
    expect(await screen.findByRole("tooltip")).toBeTruthy();
  });

  test("une famille sans compte efface son logo, sans anneau ni modale", async () => {
    renderRail();
    const grok = await screen.findByRole("button", { name: /^Grok : non branché/ });
    expect(grok.querySelector("circle")).toBeNull();
    expect(grok.getAttribute("aria-haspopup")).toBeNull();
  });

  test("un membre ne voit rien", async () => {
    role = "member";
    const { container } = renderRail();
    await waitFor(() => expect(container.querySelector("[data-rail-llm-quotas]") === null).toBe(true));
    expect(screen.queryByRole("group", { name: "Quota LLM restant" }) === null).toBe(true);
  });

  test("aucune des trois familles branchée : le rail ne montre rien", async () => {
    providers = [{ slug: "openrouter", name: "OpenRouter" }];
    snapshots = [snapshot("openrouter", [["Credits", 10]])];
    const { container } = renderRail();
    await waitFor(() => expect(clients[0]!.isFetching()).toBe(0));
    expect(container.querySelector("[data-rail-llm-quotas]") === null).toBe(true);
  });

  test("lien fermé : les logos restent, en pointillés, et disent pourquoi", async () => {
    usageStatus = "disconnected";
    renderRail();
    const gpt = await screen.findByRole("button", { name: /^GPT : relevé indisponible/ });
    expect(gpt.getAttribute("aria-label")).toContain("Reconnectez le lien Hermes pour lire les limites.");
    expect(gpt.getAttribute("data-rail-quota-state")).toBe("unmeasured");
  });
});
