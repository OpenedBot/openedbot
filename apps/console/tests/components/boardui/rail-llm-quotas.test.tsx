import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ProviderUsageSnapshotDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { TooltipProvider } from "@openedbot/browser-ui-kit";
import { I18nProvider } from "../../../src/lib/i18n";
import { openSecondaryReads } from "../../../src/lib/shell/after-first-paint";
import { RailModelsPill, bindingWindow, railQuotaFamilies, remainingTone } from "../../../src/components/boardui/rail-llm-quotas";
import type { RuntimeHealthReading } from "../../../src/lib/runtime/use-runtime-health";

const realFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let role = "owner";
let usageStatus = "ok";
let providers: Array<{ slug: string; name: string }> = [];
let snapshots: ProviderUsageSnapshotDto[] = [];
let opened: string[] = [];
// The runtime row is covered by `rail-runtime-health.test.tsx`: a configured, healthy one here.
const runtimeReading = {
  runtime: { configured: true, name: "VPS", management: { kind: "host" }, link: null },
  error: null,
  status: "healthy",
  pending: false,
} as unknown as RuntimeHealthReading;

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
  const rootRoute = createRootRoute({ component: () => <TooltipProvider><RailModelsPill runtime={runtimeReading} onOpenSettings={(to) => opened.push(to)} /></TooltipProvider> });
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
  opened = [];
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

const pill = () => screen.findByRole("button", { name: /^Modèles/ });
const marks = () => document.querySelector("[data-rail-llm-quotas='']");

async function openPopover() {
  await waitFor(() => expect(marks() !== null).toBe(true));
  fireEvent.click(await pill());
  return screen.getByRole("group", { name: "Quota LLM restant" });
}

describe("RailModelsPill", () => {
  test("une pilule « Modèles » : trois vrais logos, GPT puis Anthropic puis Grok, puis le point du runtime", async () => {
    renderRail();
    await waitFor(() => expect(marks() !== null).toBe(true));
    const states = [...marks()!.querySelectorAll("[data-rail-quota]")];
    expect(states.map((node) => `${node.getAttribute("data-rail-quota")}:${node.getAttribute("data-rail-quota-state")}`))
      .toEqual(["gpt:measured", "anthropic:measured", "grok:off"]);
    // Each mark carries a real logo (brand path), not an abstract gauge.
    for (const node of states) expect(node.querySelectorAll("svg path").length).toBe(1);
    const gpt = states[0]!.querySelector("circle[stroke-dasharray]")!;
    // The ring follows the remainder: 58 out of 100. GPT stays green; Anthropic at 15% turns to warning.
    expect(gpt.getAttribute("stroke-dasharray")).toBe("58 100");
    expect(gpt.getAttribute("class")).toContain("text-pos-700");
    expect(states[1]!.querySelector("circle[stroke-dasharray]")?.getAttribute("class")).toContain("text-warn-700");
    const button = await pill();
    // No label on the row: « Modèles » is the tooltip and the start of the accessible name.
    expect(button.textContent).toBe("");
    expect(button.querySelector("[data-rail-runtime-badge='connected']")).toBeTruthy();
    // The pill's name says every reading: touch and screen readers lose nothing.
    expect(button.getAttribute("aria-label")).toContain("GPT : 58 % restant");
    expect(button.getAttribute("aria-label")).toContain("VPS");
  });

  test("un clic ouvre le détail : une ligne par famille, puis le runtime", async () => {
    renderRail();
    const group = await openPopover();
    const gpt = screen.getByRole("button", { name: /^GPT : 58 % restant · réinit\. dans 3 h/ });
    expect(group.contains(gpt)).toBe(true);
    expect(gpt.getAttribute("aria-label")).toContain("Lu il y a 1 min");
    expect(screen.getByRole("button", { name: /^Anthropic : 15 % restant/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Runtime.*VPS.*connecté/ })).toBeTruthy();

    fireEvent.click(gpt);
    expect(await screen.findByText("Limites")).toBeTruthy();
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
    release();
    await waitFor(() => expect(marks()?.querySelectorAll("[data-rail-quota]").length).toBe(3));
    expect(container.querySelector("[data-rail-llm-quotas='loading']") === null).toBe(true);
  });

  test("une famille sans compte efface son logo, sans anneau ni modale, et mène aux réglages des modèles", async () => {
    renderRail();
    await openPopover();
    const grok = screen.getByRole("button", { name: /^Grok : non branché/ });
    expect(grok.querySelector("circle")).toBeNull();
    expect(grok.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(grok);
    expect(opened).toEqual(["/settings/models"]);
  });

  test("la ligne du runtime mène à ses réglages", async () => {
    renderRail();
    await openPopover();
    fireEvent.click(screen.getByRole("button", { name: /^Runtime.*VPS/ }));
    expect(opened).toEqual(["/settings/runtime"]);
  });

  test("un membre ne voit que le runtime", async () => {
    role = "member";
    renderRail();
    await waitFor(() => expect(document.querySelector("[data-rail-models-pill='']") !== null).toBe(true));
    expect(document.querySelector("[data-rail-llm-quotas]") === null).toBe(true);
    fireEvent.click(await pill());
    expect(screen.queryByRole("group", { name: "Quota LLM restant" }) === null).toBe(true);
    expect(screen.getByRole("button", { name: /^Runtime.*VPS/ })).toBeTruthy();
  });

  test("aucune des trois familles branchée : la pilule garde le runtime, sans logo", async () => {
    providers = [{ slug: "openrouter", name: "OpenRouter" }];
    snapshots = [snapshot("openrouter", [["Credits", 10]])];
    const { container } = renderRail();
    // The loading placeholder, then no mark once the catalog has been read.
    await waitFor(() => expect(container.querySelector("[data-rail-llm-quotas='loading']") !== null).toBe(true));
    await waitFor(() => expect(container.querySelector("[data-rail-llm-quotas]") === null).toBe(true));
    // No mark: the runtime's own icon stands before its dot.
    expect((await pill()).querySelector("[data-rail-quota]")).toBeNull();
    expect(clients[0]!.isFetching()).toBe(0);
  });

  test("lien fermé : les logos restent, en pointillés, et disent pourquoi", async () => {
    usageStatus = "disconnected";
    renderRail();
    await openPopover();
    const gpt = screen.getByRole("button", { name: /^GPT : relevé indisponible/ });
    expect(gpt.getAttribute("aria-label")).toContain("Reconnectez le lien Hermes pour lire les limites.");
    expect(gpt.getAttribute("data-rail-quota-state")).toBe("unmeasured");
  });
});
