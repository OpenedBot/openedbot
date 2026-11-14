import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "../../../src/lib/i18n";
import { ProviderLimitsCard } from "../../../src/components/dashboard/provider-limits-card";
import { queryKeys } from "../../../src/lib/api";
import { openSecondaryReads } from "../../../src/lib/shell/after-first-paint";

const realFetch = globalThis.fetch;
let role = "owner";
let usageStatus = "ok";
let includeUnavailableProvider = false;
let includeUnsupportedProvider = false;
let promoteAfterManualRefresh = false;
let noAuthenticatedProvider = false;
let restingQuota = false;
let noBots = false;
let quotaHttpFailure = false;
let catalogHttpFailure = false;
const clients: QueryClient[] = [];
let includeIntegratedProvider = false;
const seen: string[] = [];

function renderCard() {
  // The modal renders `Link` elements to settings: it needs a router, even an in-memory one.
  const rootRoute = createRootRoute({ component: () => <ProviderLimitsCard /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const queryClient = new QueryClient();
  clients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
    </QueryClientProvider>,
  );
}

async function openLimitsDialog() {
  fireEvent.click(await screen.findByRole("button", { name: /Voir les limites des fournisseurs/ }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
}

beforeEach(() => {
  // No thread is painted here: open the secondary reads the frame would open.
  openSecondaryReads();
  role = "owner";
  usageStatus = "ok";
  includeUnavailableProvider = false;
  includeUnsupportedProvider = false;
  promoteAfterManualRefresh = false;
  noAuthenticatedProvider = false;
  restingQuota = false;
  noBots = false;
  quotaHttpFailure = false;
  catalogHttpFailure = false;
  includeIntegratedProvider = false;
  seen.length = 0;
  window.localStorage.setItem("openedbot:locale", "fr");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    if ((quotaHttpFailure && url.includes("/provider-usage")) || (catalogHttpFailure && url.includes("/models"))) {
      return Response.json({ error: { code: "SERVICE_UNAVAILABLE" } }, { status: 503 });
    }
    if (url.includes("/api/auth/me")) return Response.json({ user: { email: "o@example.test", displayName: null }, organization: { id: "org", slug: "org", name: "Org" }, role });
    if (url.includes("/api/runtime") && !url.includes("/runtimes/")) {
      return Response.json({ runtime: { id: "runtime-1", selectedProvider: "anthropic", selectedModel: "claude-sonnet" }, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
    }
    if (url.includes("/provider-usage")) {
      // The API waits for the forced probe and returns the fresh reading as « ok »; without
      // a reachable host it returns its failure, never the old reading as « stale ».
      const manual = url.includes("refresh=1");
      if (manual && promoteAfterManualRefresh) usageStatus = "ok";
      const responseStatus = manual && usageStatus === "stale" ? "error" : usageStatus;
      const usedPercent = restingQuota || (manual && promoteAfterManualRefresh) ? 42 : 97;
      return Response.json({
      runtimeId: "runtime-1", status: responseStatus, reason: responseStatus === "unsupported" ? "feature_absent" : null,
      fetchedAt: responseStatus === "ok" ? new Date(Date.now() - (manual ? 0 : 60_000)).toISOString() : null,
      freshUntil: null,
      providers: responseStatus === "ok" || responseStatus === "stale" ? [
        { provider: "anthropic", source: "oauth_usage_api", plan: null, windows: [{ label: "Current week", usedPercent, resetAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), detail: null }], details: [], unavailableReason: null },
        // The host files an anonymous tier under `unsupported`: no account to query, ever.
        ...(includeUnsupportedProvider ? [{ provider: "opencode-free", source: "unsupported" as const, plan: null, windows: [], details: [], unavailableReason: "no account-usage endpoint for this provider" }] : []),
      ] : [],
      error: responseStatus === "error" ? "Les limites fournisseur sont momentanément indisponibles." : null,
    });
    }
    if (url.includes("/api/runtimes/runtime-1/models")) return Response.json({ runtimeId: "runtime-1", runtimeName: "VPS", hermesProfile: null, currentProvider: "anthropic", runtimeDefaultModel: "claude-sonnet", hasUsableProvider: true, runtimeConfigWritable: false, providers: [
      { slug: "anthropic", name: "Anthropic", isCurrent: true, authenticated: !noAuthenticatedProvider, alwaysAuthenticated: false, provesInference: !noAuthenticatedProvider, authType: "oauth", warning: null, authCommand: null, models: [{ id: "claude-sonnet", fast: false, reasoning: true, isRuntimeDefault: true, freeTier: null }] },
      ...(includeIntegratedProvider ? [{ slug: "moa", name: "Mixture of Agents", isCurrent: false, authenticated: true, alwaysAuthenticated: true, provesInference: false, authType: "cli", warning: null, authCommand: null, models: [{ id: "moa-1", fast: false, reasoning: true, isRuntimeDefault: false, freeTier: null }] }] : []),
      ...(includeUnsupportedProvider ? [{ slug: "opencode-free", name: "OpenCode Free", isCurrent: false, authenticated: true, alwaysAuthenticated: false, provesInference: true, authType: "api_key", warning: null, authCommand: null, models: [{ id: "hy3-free", fast: true, reasoning: false, isRuntimeDefault: false, freeTier: null }] }] : []),
      ...(includeUnavailableProvider ? [{ slug: "gemini", name: "Gemini", isCurrent: false, authenticated: true, alwaysAuthenticated: false, provesInference: true, authType: "api_key", warning: null, authCommand: null, models: [{ id: "gemini-2.5", fast: false, reasoning: true, isRuntimeDefault: false, freeTier: null }] }] : []),
    ] });
    if (url.includes("/api/bots")) return Response.json({ bots: noBots ? [] : [{ id: "bot-1", threadId: "thread-1", name: "Atlas", slug: "atlas", description: null, instructions: "", model: "claude-sonnet", reasoningEffort: null, sectionId: "s", position: 0, pinned: false, face: null, voiceId: null, hermesProfile: null, isolation: "profile", hasOwnRuntime: false, runtimeName: null, awaitingApproval: false, preview: null, lastActivityAt: new Date().toISOString(), archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastRunAt: null }], sections: [], groups: [], operator: null });
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

test("a first HTTP quota failure remains visible with an action to retry", async () => {
  quotaHttpFailure = true;
  renderCard();
  await openLimitsDialog();
  expect(await screen.findByText("Les données des fournisseurs ne sont pas disponibles pour le moment. Réessayez.")).toBeTruthy();
  expect(screen.queryByText("97 % max")).toBeNull();
  quotaHttpFailure = false;
  fireEvent.click(screen.getByRole("button", { name: "Actualiser les limites" }));
  await screen.findByText("97 % max");
  await waitFor(() => expect(screen.queryByText("Les données des fournisseurs ne sont pas disponibles pour le moment. Réessayez.")).toBeNull());
});

test("a failed catalog read cannot hide the provider error as an empty catalogue", async () => {
  catalogHttpFailure = true;
  renderCard();
  await openLimitsDialog();
  expect(await screen.findByText("Les données des fournisseurs ne sont pas disponibles pour le moment. Réessayez.")).toBeTruthy();
  catalogHttpFailure = false;
  fireEvent.click(screen.getByRole("button", { name: "Actualiser les limites" }));
  await screen.findByText("97 % max");
  await waitFor(() => expect(screen.queryByText("Les données des fournisseurs ne sont pas disponibles pour le moment. Réessayez.")).toBeNull());
});

test("a quota read failure preserves the last value with a stale response date", async () => {
  renderCard();
  await openLimitsDialog();
  quotaHttpFailure = true;
  await act(async () => {
    await clients[0]!.refetchQueries({ queryKey: queryKeys.runtimeProviderUsage("runtime-1") });
  });
  expect(await screen.findByText(/Ces valeurs sont périmées/)).toBeTruthy();
  expect(screen.getByText("97 % max")).toBeTruthy();
});

test("affiche la fenêtre hebdomadaire, puis les bots du fournisseur au dépli", async () => {
  renderCard();
  const trigger = await screen.findByRole("button", { name: /Voir les limites des fournisseurs/ });
  expect(trigger.className).toContain("bg-warn-soft");
  expect(screen.getByText("97 % max")).toBeTruthy();
  // The peak is part of the accessible name: without it, the card announces no figure.
  expect(trigger.getAttribute("aria-label")).toBe("Voir les limites des fournisseurs · 97 % max");
  // The brand pills are decorative inside a button that is already named.
  expect(trigger.querySelectorAll("[aria-hidden='true']").length).toBeGreaterThan(0);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByRole("button", { name: "Actualiser les limites" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Bots sur ce fournisseur/ })).toBeNull();
  // The roster is fetched on mount: the bar's alert needs to know
  // which providers are IN SERVICE. No token reading is fetched: the
  // panel now speaks only of quotas and of who runs where.
  expect(seen.some((url) => url.includes("/api/usage/bots"))).toBe(false);

  fireEvent.click(trigger);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(await screen.findByText("97 %")).toBeTruthy();
  expect(screen.getByText("Réinit. dans 2 j")).toBeTruthy();
  // The composite stays the accessible name: a screen reader hears one sentence.
  expect(screen.getByRole("progressbar", { name: "97 % · 2 j" })).toBeTruthy();
  // The header says when the reading happened; the reread button stays active.
  expect(screen.getByText("Lu il y a 1 min")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Actualiser les limites" }) as HTMLButtonElement).disabled).toBe(false);
  // Readable limits: the row stays folded until the tap.
  const expand = screen.getByRole("button", { name: "Anthropic · Bots sur ce fournisseur" });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(expand);
  expect(await screen.findByText("Atlas")).toBeTruthy();
  expect(screen.getByText("Fournisseur actuellement résolu, pas une preuve de facturation.")).toBeTruthy();

  const dialog = screen.getByRole("dialog");
  const closeButtons = within(dialog).getAllByRole("button", { name: "Fermer" });
  fireEvent.click(closeButtons[closeButtons.length - 1]!);
  // `expect(node).toBeNull()` serializes the happy-dom node it receives: in a
  // `waitFor` that retries during the animated exit, that message weighs
  // tens of MB and freezes the test. Compare a boolean instead.
  await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
});

test("un membre ne monte ni quota, ni catalogue, ni consommation bot", async () => {
  role = "member";
  renderCard();
  await waitFor(() => expect(seen.some((url) => url.includes("/api/auth/me"))).toBe(true));
  expect(screen.queryByRole("button", { name: /Voir les limites des fournisseurs/ })).toBeNull();
  expect(screen.queryByLabelText("Limites")).toBeNull();
  expect(seen.some((url) => /provider-usage|\/models|usage\/bots/.test(url))).toBe(false);
});

// A set of accounts that is entirely unmeasurable has no alert to give: the bar stays
// silent, and one reads it in the composer's tab, which always carries it.
test("sans quota lisible, la barre latérale ne monte aucune alerte", async () => {
  usageStatus = "unsupported";
  renderCard();
  await waitFor(() => expect(seen.some((url) => url.includes("provider-usage"))).toBe(true));
  expect(screen.queryByRole("button", { name: /Voir les limites des fournisseurs/ })).toBeNull();
});

// The threshold is the one that already colors the figure: below it, a quota at rest
// has nothing to say, and occupying the bar six days out of seven teaches one to ignore it.
test("un quota au repos ne monte pas d’alerte", async () => {
  restingQuota = true;
  renderCard();
  await waitFor(() => expect(seen.some((url) => url.includes("provider-usage"))).toBe(true));
  expect(screen.queryByRole("button", { name: /Voir les limites des fournisseurs/ })).toBeNull();
});

test("un fournisseur authentifié sans sonde dit pourquoi dans son bloc, sans « n/d »", async () => {
  includeUnavailableProvider = true;
  renderCard();
  await openLimitsDialog();
  const notice = await screen.findByText("Le runtime ne lit pas encore les limites de ce fournisseur.");
  // The sentence is in the block of the provider concerned (model the reference app), not in a shared note.
  expect(within(notice.closest("section[data-provider-row]") as HTMLElement).getByText("Gemini")).toBeTruthy();
  expect(screen.queryByText("n/d")).toBeNull();
});

test("un tier anonyme se range sous « Sans relevé », sans n/d à réessayer", async () => {
  includeUnsupportedProvider = true;
  renderCard();
  await openLimitsDialog();
  // The section title carries the absence; the row does not repeat it.
  expect(await screen.findByText("Sans relevé")).toBeTruthy();
  expect(screen.queryByText("Non mesurable")).toBeNull();
  // The exact reason, named: anonymous, quota per IP, nothing to read.
  expect(screen.getByText(/OpenCode Free est servi anonymement, sans compte ni clé/)).toBeTruthy();
  expect(screen.queryByText(/n’expose aucune API de relevé/)).toBeNull();
  // Definitive ≠ transient: neither « n/d », nor the copy « ne lit pas encore ».
  expect(screen.queryByText("n/d")).toBeNull();
  expect(screen.queryByText("Le runtime ne lit pas encore les limites de ce fournisseur.")).toBeNull();
});

test("« Actualiser » affiche le relevé rendu par la sonde forcée, pas l'ancien", async () => {
  usageStatus = "stale";
  promoteAfterManualRefresh = true;
  renderCard();
  await openLimitsDialog();
  const refresh = await screen.findByRole("button", { name: "Actualiser les limites" });
  fireEvent.click(refresh);
  await waitFor(() => expect(seen.some((url) => url.includes("provider-usage?refresh=1"))).toBe(true));
  expect(await screen.findByText("42 %")).toBeTruthy();
  expect(screen.queryByText("97 %")).toBeNull();
});

test("lien fermé : affiche chaque fournisseur authentifié, ses bots dépliés, et le bouton vers les réglages du lien", async () => {
  usageStatus = "disconnected";
  includeUnavailableProvider = true;
  renderCard();
  await openLimitsDialog();
  const dialog = screen.getByRole("dialog");
  expect(await within(dialog).findByText("Reconnectez le lien Hermes pour lire les limites.")).toBeTruthy();
  const openLink = within(dialog).getByRole("link", { name: "Ouvrir les réglages du lien" });
  expect(openLink.getAttribute("href")).toBe("/settings/runtime");
  expect(openLink.className).toContain("openedbot-settings-action");
  expect(openLink.className).toContain("justify-center");
  // One block per authenticated provider, each expanded by default.
  // No gauge: a provider with no reading has no value to represent,
  // and an empty `progressbar` would announce « zéro consommé ».
  expect(within(dialog).queryByRole("progressbar")).toBeNull();
  expect(within(dialog).getByText("Anthropic")).toBeTruthy();
  expect(within(dialog).getByText("Gemini")).toBeTruthy();
  expect(within(dialog).queryByText("n/d")).toBeNull();
  const rows = within(dialog).getAllByRole("button", { name: /Bots sur ce fournisseur/ });
  expect(rows.length).toBe(2);
  expect(rows.every((row) => row.getAttribute("aria-expanded") === "true")).toBe(true);
  expect(await within(dialog).findByText("Atlas")).toBeTruthy();
  expect(within(dialog).getByText("Aucun bot n’utilise ce fournisseur.")).toBeTruthy();
  // The message is not repeated row by row: the banner explains it once.
  expect(within(dialog).queryByText("Le runtime ne lit pas encore les limites de ce fournisseur.")).toBeNull();

  fireEvent.click(openLink);
  await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
});

test("lien fermé : actualiser reste possible", async () => {
  usageStatus = "disconnected";
  renderCard();
  await openLimitsDialog();
  const refresh = await screen.findByRole("button", { name: "Actualiser les limites" });
  expect((refresh as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(refresh);
  await waitFor(() => expect(seen.some((url) => url.includes("provider-usage?refresh=1"))).toBe(true));
});

test("sans fournisseur authentifié : la carte ne se monte pas du tout", async () => {
  noAuthenticatedProvider = true;
  noBots = true;
  renderCard();
  // The catalog has been read (the skeleton gives way), then nothing remains:
  // no trigger above `NavUser`, so no modal to open.
  await waitFor(() => expect(seen.some((url) => url.includes("/models"))).toBe(true));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /Voir les limites des fournisseurs/ })).toBeNull(),
  );
  expect(document.querySelector("[data-provider-limits]")).toBeNull();
});

test("un fournisseur intégré n'est pas un accès posé : il ne compte dans aucune limite", async () => {
  includeIntegratedProvider = true;
  renderCard();
  const trigger = await screen.findByRole("button", { name: /Voir les limites des fournisseurs/ });
  // The card announces only real access: a single brand pill.
  expect(trigger.querySelectorAll("svg").length).toBe(2); // 1 brand + the chevron
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText("97 %")).toBeTruthy();
  expect(within(dialog).queryByText("Mixture of Agents")).toBeNull();
  // And no « Sans relevé » group mounted for it alone.
  expect(within(dialog).queryByText("Sans relevé")).toBeNull();
});
