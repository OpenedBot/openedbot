import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { RunDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../src/lib/i18n";
import { GroupContextTab, busiestMember, isFallbackModel } from "../../src/components/group-context-tab";
import { botContextReading } from "../../src/components/thread-context-tab";

/**
 * La pastille d'un crew. Chaque membre a sa session : la pastille montre le
 * plus chargé, le dialogue les liste tous, avec le modèle qui a RÉELLEMENT
 * répondu et la même règle de fenêtre que le fil d'un bot seul.
 */

const realFetch = globalThis.fetch;

const MEMBERS = [
  { id: "bot-a", name: "Alice", face: null },
  { id: "bot-b", name: "Bruno", face: null },
  { id: "bot-c", name: "Chloé", face: null },
];
const BOTS = [
  { id: "bot-a", model: "claude-sonnet-5", hermesProfile: "alice" },
  { id: "bot-b", model: "claude-sonnet-5", hermesProfile: "bruno" },
  { id: "bot-c", model: "claude-sonnet-5", hermesProfile: "chloe" },
];

function run(botId: string, overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: `run-${botId}`,
    botId,
    status: "completed",
    input: "salut",
    output: "bonjour",
    usage: { inputTokens: 18_000, outputTokens: 2_000, totalTokens: 20_000 },
    error: null,
    hermesResponseId: null,
    model: "claude-sonnet-5",
    runtimeSession: null,
    createdAt: "2026-09-09T10:00:00.000Z",
    ...overrides,
  } as RunDto;
}

/** `windows` : la fenêtre servie par l'hôte, par profil Hermes. Absent : table locale. */
function stubFetch(windows: Record<string, number> = {}) {
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
      const profile = new URL(url, "http://x.test").searchParams.get("profile") ?? "";
      const window = windows[profile];
      if (window === undefined) {
        return Response.json({
          runtimeId: "rt-1", status: "unsupported", reason: "feature_absent",
          model: null, provider: null, contextWindow: 0, autoContextWindow: 0,
          maxOutputTokens: 0, fetchedAt: null, error: null,
        });
      }
      return Response.json({
        runtimeId: "rt-1", status: "ok", reason: null, model: "claude-sonnet-5", provider: "anthropic",
        contextWindow: window, autoContextWindow: window, maxOutputTokens: 64_000, preamble: null,
        fetchedAt: "2026-09-09T10:00:00.000Z", error: null,
      });
    }
    if (url.includes("/api/runtime") && !url.includes("/model-context")) {
      return Response.json({ runtime: { id: "rt-1", name: "VPS", selectedProvider: null }, mode: "external" });
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as unknown as typeof fetch;
}

function renderTab(runs: RunDto[], variant: "header" | "inline" = "header") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => <GroupContextTab members={MEMBERS} bots={BOTS} runs={runs} variant={variant} />,
  });
  const bot = createRoute({ getParentRoute: () => root, path: "/bot/$botId", component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([bot]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
  window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: "csrf" }));
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

const PILL = "Voir le contexte et le modèle de chaque membre";

test("la pastille montre le membre le plus proche de sa limite", async () => {
  // Alice 20 000 / 200 000 = 10 %, Bruno 20 000 / 40 000 = 50 %.
  stubFetch({ alice: 200_000, bruno: 40_000, chloe: 200_000 });
  renderTab([run("bot-a"), run("bot-b")]);
  const pill = await screen.findByRole("button", { name: PILL });
  await waitFor(() => expect(pill.textContent).toContain("50 %"));
  expect(pill.getAttribute("title")).toContain("Bruno");
});

test("sur téléphone la même pastille tient en une ligne de texte", async () => {
  stubFetch({ alice: 200_000, bruno: 40_000, chloe: 200_000 });
  renderTab([run("bot-a"), run("bot-b")], "inline");
  const pill = await screen.findByRole("button", { name: PILL });
  await waitFor(() => expect(pill.textContent).toContain("50 %"));
  expect(pill.hasAttribute("data-group-context-inline")).toBe(true);
});

test("aucune pastille tant qu'aucun membre n'a de tour mesuré", async () => {
  stubFetch();
  renderTab([run("bot-a", { status: "running", usage: null })]);
  await waitFor(() => expect(globalThis.fetch).toBeDefined());
  expect(screen.queryByRole("button", { name: PILL })).toBeNull();
});

test("le dialogue liste chaque membre, le repli et celui qui n'a pas de mesure", async () => {
  stubFetch({ alice: 200_000, bruno: 40_000, chloe: 200_000 });
  renderTab([run("bot-a"), run("bot-b", { model: "opencode-free/x-preview" })]);
  fireEvent.click(await screen.findByRole("button", { name: PILL }));

  const rows = await screen.findAllByRole("listitem");
  expect(rows).toHaveLength(3);
  const [alice, bruno, chloe] = rows as [HTMLElement, HTMLElement, HTMLElement];

  expect(alice.textContent).toContain("Alice");
  expect(alice.textContent).toContain("claude-sonnet-5");
  expect(alice.textContent).not.toContain("repli");

  // Bruno a tourné sur un autre modèle que celui du bot : on le dit.
  expect(bruno.textContent).toContain("opencode-free/x-preview");
  expect(within(bruno).getByText("repli")).toBeTruthy();

  // Chloé n'a aucun run : son modèle réglé, pas de jauge.
  expect(chloe.textContent).toContain("pas encore de mesure");
  expect(chloe.textContent).toContain("claude-sonnet-5");
  expect(within(chloe).queryByRole("progressbar")).toBeNull();
  expect(within(alice).getByRole("progressbar")).toBeTruthy();
});

test("« Changer le modèle » mène au bot de la ligne", async () => {
  stubFetch({ alice: 200_000, bruno: 40_000, chloe: 200_000 });
  const router = renderTab([run("bot-a"), run("bot-b")]);
  fireEvent.click(await screen.findByRole("button", { name: PILL }));
  const links = await screen.findAllByRole("link", { name: "Changer le modèle" });
  expect(links).toHaveLength(3);
  fireEvent.click(links[1]!);
  await waitFor(() => expect(router.state.location.pathname).toBe("/bot/bot-b"));
});

// Fonctions pures : le choix du plus chargé et la lecture par membre.
const t = ((key: string) => key) as Parameters<typeof botContextReading>[0]["t"];

test("busiestMember : pourcentage le plus haut, sinon le plus de jetons", () => {
  const reading = (percent: number | null, used: number) => ({
    reading: { inputTokens: used, outputTokens: 0, model: "m" },
    model: "m",
    window: percent === null ? 0 : 1000,
    used,
    percent,
  });
  const entry = (id: string, r: ReturnType<typeof reading> | null) => ({
    member: { id, name: id, face: null },
    configuredModel: "m",
    reading: r,
  });
  expect(busiestMember([entry("a", null)])).toBeNull();
  expect(busiestMember([entry("a", reading(10, 100)), entry("b", reading(60, 50))])?.member.id).toBe("b");
  // Un pourcentage connu l'emporte sur un compte brut, qui ne se compare à rien.
  expect(busiestMember([entry("a", reading(null, 9_999)), entry("b", reading(5, 5))])?.member.id).toBe("b");
  expect(busiestMember([entry("a", reading(null, 10)), entry("b", reading(null, 90))])?.member.id).toBe("b");
});

test("botContextReading ne lit que les runs du bot demandé", () => {
  const runs = [run("bot-a"), run("bot-b", { usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } })];
  const a = botContextReading({ botId: "bot-a", runs, configuredModel: "claude-sonnet-5", runtimeWindow: 200_000, t });
  const c = botContextReading({ botId: "bot-c", runs, configuredModel: "claude-sonnet-5", runtimeWindow: 200_000, t });
  expect(a?.used).toBe(20_000);
  expect(a?.percent).toBe(10);
  expect(c).toBeNull();
});

test("isFallbackModel : seulement quand les deux modèles sont connus et diffèrent", () => {
  const reading = (model: string | null) => ({
    reading: { inputTokens: 1, outputTokens: 1, model },
    model,
    window: 0,
    used: 2,
    percent: null,
  });
  expect(isFallbackModel(reading("b"), "a")).toBe(true);
  expect(isFallbackModel(reading("a"), "a")).toBe(false);
  expect(isFallbackModel(reading("a"), null)).toBe(false);
  expect(isFallbackModel(null, "a")).toBe(false);
});

test("fenêtre inconnue : les jetons restent, sans pourcentage", () => {
  // Ni le run ni le bot ne nomment de modèle, et l'hôte ne sert pas de fenêtre.
  const runs = [run("bot-a", { model: null, runtimeSession: null })];
  const a = botContextReading({ botId: "bot-a", runs, configuredModel: null, runtimeWindow: 0, t });
  expect(a?.used).toBe(20_000);
  expect(a?.window).toBe(0);
  expect(a?.percent).toBeNull();
});

test("fenêtre inconnue : la ligne écrit les jetons sans pourcentage", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/auth/me")) {
      return Response.json({
        user: { id: "u-1", email: "elodie@example.test", displayName: "Élodie" },
        organization: { id: "org-1", slug: "acme", name: "Acme" },
        role: "viewer",
      });
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as unknown as typeof fetch;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute({
    component: () => (
      <GroupContextTab
        members={[MEMBERS[0]!]}
        bots={[{ id: "bot-a", model: "", hermesProfile: null }]}
        runs={[run("bot-a", { model: null, runtimeSession: null })]}
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/bot/$botId", component: () => null })]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  const pill = await screen.findByRole("button", { name: PILL });
  expect(pill.textContent).toContain("20");
  expect(pill.textContent).toContain("jetons");
  expect(pill.textContent).not.toContain("%");
  fireEvent.click(pill);
  const row = (await screen.findAllByRole("listitem"))[0]!;
  expect(within(row).queryByRole("progressbar")).toBeNull();
});

// DEV-329 : un membre dont le modèle est refusé passe avant toute jauge.

const REFUSED = {
  status: "failed", output: null, usage: null, error: "HTTP 400", errorCode: "MODEL_UNAVAILABLE", model: "gpt-9",
} as Partial<RunDto>;

test("modèle indisponible : la pastille montre ce membre en alerte, même sans aucune mesure", async () => {
  stubFetch();
  renderTab([run("bot-b", REFUSED)]);
  const pill = await screen.findByRole("button", { name: PILL });
  expect(pill.getAttribute("data-alert")).toBe("model-unavailable");
  expect(pill.textContent).toContain("Modèle indisponible : gpt-9");
  expect(pill.getAttribute("title")).toContain("Bruno");
});

test("modèle indisponible : l'alerte passe avant le membre le plus chargé", async () => {
  stubFetch({ alice: 40_000, bruno: 200_000 });
  renderTab([run("bot-a"), run("bot-b", REFUSED)]);
  const pill = await screen.findByRole("button", { name: PILL });
  expect(pill.getAttribute("title")).toContain("Bruno");
  expect(pill.textContent).not.toContain("%");
});

test("modèle indisponible : la ligne du membre porte l'état et « Changer le modèle »", async () => {
  stubFetch({ alice: 200_000 });
  const router = renderTab([run("bot-a"), run("bot-b", REFUSED)]);
  fireEvent.click(await screen.findByRole("button", { name: PILL }));
  const rows = await screen.findAllByRole("listitem");
  const bruno = rows.find((row) => row.getAttribute("data-group-member-context") === "bot-b")!;
  expect(within(bruno).getByRole("alert").textContent).toContain("Modèle indisponible : gpt-9");
  const alice = rows.find((row) => row.getAttribute("data-group-member-context") === "bot-a")!;
  expect(within(alice).queryByRole("alert")).toBeNull();
  fireEvent.click(within(bruno).getByRole("link", { name: "Changer le modèle" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/bot/bot-b"));
});

test("modèle indisponible : un tour réussi après correction efface l'alerte", async () => {
  stubFetch({ alice: 200_000, bruno: 200_000 });
  renderTab([
    run("bot-b", { ...REFUSED, id: "run-b1", createdAt: "2026-10-14T10:00:00.000Z" }),
    run("bot-b", { id: "run-b2", createdAt: "2026-10-14T10:05:00.000Z" }),
  ]);
  const pill = await screen.findByRole("button", { name: PILL });
  await waitFor(() => expect(pill.textContent).toContain("%"));
  expect(pill.getAttribute("data-alert")).toBeNull();
});
