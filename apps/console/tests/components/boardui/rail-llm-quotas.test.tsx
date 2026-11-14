import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ProviderUsageSnapshotDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { TooltipProvider } from "@openedbot/browser-ui-kit";
import { I18nProvider } from "../../../src/lib/i18n";
import { openSecondaryReads } from "../../../src/lib/shell/after-first-paint";
import { RailLlmQuotas, bindingWindow, railQuotaFamilies, remainingTone } from "../../../src/components/boardui/rail-llm-quotas";

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
    // The most depleted window sets the wall; « Opus week » caps only one model.
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
    // A host from before the Grok probe files it under `unsupported`: no reading, not a failure.
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
  window.localStorage.setItem("openedbot:locale", "fr");
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

describe("remainingTone", () => {
  test("vert au repos, warning à 35 % restants, rouge à 10 %", () => {
    expect(remainingTone(100)).toBe("text-pos-700");
    expect(remainingTone(36)).toBe("text-pos-700");
    expect(remainingTone(35)).toBe("text-warn-700");
    expect(remainingTone(11)).toBe("text-warn-700");
    expect(remainingTone(10)).toBe("text-destructive");
    expect(remainingTone(0)).toBe("text-destructive");
  });
});

describe("RailLlmQuotas", () => {
  test("trois vrais logos empilés, GPT puis Anthropic puis Grok, chacun nommé par sa phrase", async () => {
    renderRail();
    const group = await screen.findByRole("group", { name: "Quota LLM restant" });
    const buttons = [...group.querySelectorAll("button[data-rail-quota]")];
    expect(buttons.map((node) => `${node.getAttribute("data-rail-quota")}:${node.getAttribute("data-rail-quota-state")}`))
      .toEqual(["gpt:measured", "anthropic:measured", "grok:off"]);
    // Each button carries a real logo (brand path), not an abstract gauge.
    for (const button of buttons) expect(button.querySelectorAll("svg path").length).toBe(1);
    const gpt = screen.getByRole("button", { name: /^GPT : 58 % restant · réinit\. dans 3 h/ });
    expect(gpt.getAttribute("aria-label")).toContain("Lu il y a 1 min");
    expect(screen.getByRole("button", { name: /^Anthropic : 15 % restant/ })).toBeTruthy();
    // The ring follows the remainder: 58 out of 100.
    expect(gpt.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray")).toBe("58 100");
    // GPT at 58% remaining stays green; Anthropic at 15% turns to warning.
    expect(gpt.querySelector("circle[stroke-dasharray]")?.getAttribute("class")).toContain("text-pos-700");
    expect(screen.getByRole("button", { name: /^Anthropic/ }).querySelector("circle[stroke-dasharray]")?.getAttribute("class")).toContain("text-warn-700");

    fireEvent.click(gpt);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("au rechargement, les trois logos tiennent leur place pendant la lecture, puis s'y remplissent", async () => {
    const answered = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/provider-usage")) await gate;
      return answered(input, init);
    }) as typeof fetch;
    const { container } = renderRail();
    await waitFor(() => expect(container.querySelector("[data-rail-llm-quotas='loading']") !== null).toBe(true));
    const slots = [...container.querySelectorAll("[data-rail-llm-quotas='loading'] [data-rail-quota]")];
    expect(slots.map((node) => `${node.getAttribute("data-rail-quota")}:${node.getAttribute("data-rail-quota-state")}`))
      .toEqual(["gpt:loading", "anthropic:loading", "grok:loading"]);
    // Inert: neither a button nor an accessible name before the reading.
    expect(container.querySelector("[data-rail-llm-quotas='loading'] button") === null).toBe(true);
    release();
    const group = await screen.findByRole("group", { name: "Quota LLM restant" });
    expect(group.querySelectorAll("button[data-rail-quota]").length).toBe(3);
    expect(container.querySelector("[data-rail-llm-quotas='loading']") === null).toBe(true);
  });

  test("fermer la modale rend le focus au logo sans rouvrir son infobulle", async () => {
    renderRail();
    const gpt = await screen.findByRole("button", { name: /^GPT : 58 % restant/ });
    // A real click focuses the button: that is the focus the modal restores.
    gpt.focus();
    fireEvent.click(gpt);
    const dialog = await screen.findByRole("dialog");
    // The modal takes focus on the next frame: the logo has indeed left it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.activeElement === dialog).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Fermer" }).at(-1)!);
    // The modal returns focus as it unmounts, after its exit fade (150 ms).
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement === gpt).toBe(true);
    expect(screen.queryByRole("tooltip")).toBeNull();
    // The next focus (keyboard) shows the tooltip again.
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
    // The loading placeholder, then nothing once the catalog has been read.
    await waitFor(() => expect(container.querySelector("[data-rail-llm-quotas='loading']") !== null).toBe(true));
    await waitFor(() => expect(container.querySelector("[data-rail-llm-quotas]") === null).toBe(true));
    expect(clients[0]!.isFetching()).toBe(0);
  });

  test("lien fermé : les logos restent, en pointillés, et disent pourquoi", async () => {
    usageStatus = "disconnected";
    renderRail();
    const gpt = await screen.findByRole("button", { name: /^GPT : relevé indisponible/ });
    expect(gpt.getAttribute("aria-label")).toContain("Reconnectez le lien Hermes pour lire les limites.");
    expect(gpt.getAttribute("data-rail-quota-state")).toBe("unmeasured");
  });
});
