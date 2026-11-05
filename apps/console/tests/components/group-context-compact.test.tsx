import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { RunDto, ThreadCompactionDto, ThreadMessageDto } from "@openedbot/contracts-api";
import { toast } from "@openedbot/browser-ui-kit";
import { I18nProvider } from "../../src/lib/i18n";
import { GroupContextTab, pendingCompactionChars } from "../../src/components/group-context-tab";

/**
 * « Compacter l'historique du salon » (DEV-332) : un geste sur le fil entier,
 * dans le dialogue de la pastille de contexte. Il suit la route : réservé à
 * ceux qui opèrent le workspace, refusé tant qu'un run vit, désactivé avec sa
 * raison sous le seuil.
 */

const realFetch = globalThis.fetch;
const THREAD = "thread-1";

const MEMBERS = [{ id: "bot-a", name: "Alice", face: null }];
const BOTS = [{ id: "bot-a", model: "claude-sonnet-5", hermesProfile: "alice" }];

function run(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: "run-a",
    botId: "bot-a",
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

function message(sequence: number, chars: number): ThreadMessageDto {
  return {
    id: `m-${sequence}`,
    sequence: String(sequence),
    role: "assistant",
    content: [{ type: "text", text: "x".repeat(chars) }],
    runId: null,
    createdAt: "2026-09-09T10:00:00.000Z",
  } as ThreadMessageDto;
}

const LONG = [message(1, 10_000), message(2, 10_000)];
const COMPACTION: ThreadCompactionDto = { compactedThroughSequence: 1, compactedAt: "2026-10-14T10:00:00.000Z" };

type Calls = { compact: number };

function stubFetch(options: { role?: string; compact?: () => Response } = {}): Calls {
  const calls: Calls = { compact: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/auth/me")) {
      return Response.json({
        user: { id: "u-1", email: "elodie@example.test", displayName: "Élodie" },
        organization: { id: "org-1", slug: "acme", name: "Acme" },
        role: options.role ?? "owner",
      });
    }
    if (url.includes(`/api/threads/${THREAD}/compact`)) {
      expect(init?.method).toBe("POST");
      calls.compact += 1;
      return options.compact?.() ?? Response.json({
        compacted: true, summarizedCount: 12, compactedThroughSequence: 40, compactedAt: "2026-10-14T11:00:00.000Z",
      });
    }
    if (url.includes("/model-context")) {
      return Response.json({
        runtimeId: "rt-1", status: "unsupported", reason: "feature_absent",
        model: null, provider: null, contextWindow: 0, autoContextWindow: 0,
        maxOutputTokens: 0, fetchedAt: null, error: null,
      });
    }
    if (url.includes("/api/runtime") && !url.includes("/model-context")) {
      return Response.json({ runtime: { id: "rt-1", name: "VPS", selectedProvider: null }, mode: "external" });
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as unknown as typeof fetch;
  return calls;
}

function renderTab(props: {
  runs?: RunDto[];
  messages?: ThreadMessageDto[];
  compaction?: ThreadCompactionDto | null;
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = spyOn(queryClient, "invalidateQueries");
  const root = createRootRoute({
    component: () => (
      <GroupContextTab
        members={MEMBERS}
        bots={BOTS}
        runs={props.runs ?? [run()]}
        threadId={THREAD}
        messages={props.messages ?? LONG}
        compaction={props.compaction}
      />
    ),
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
  return { invalidate };
}

async function openDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Voir le contexte et le modèle de chaque membre" }));
}

const BUTTON = "Compacter l’historique du salon";

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
  window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: "csrf" }));
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

test("pendingCompactionChars ne compte que ce que le résumé n'a pas couvert", () => {
  expect(pendingCompactionChars(LONG, null)).toBe(20_000);
  expect(pendingCompactionChars(LONG, COMPACTION)).toBe(10_000);
  expect(pendingCompactionChars([], null)).toBe(0);
});

test("au-dessus du seuil le bouton est actif et le clic lance le résumé", async () => {
  const success = spyOn(toast, "success").mockImplementation(() => "test-toast");
  const calls = stubFetch();
  const { invalidate } = renderTab();
  await openDialog();

  const button = await screen.findByRole("button", { name: BUTTON }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);

  await waitFor(() => expect(calls.compact).toBe(1));
  await waitFor(() => expect(success).toHaveBeenCalledWith("Historique compacté : 12 messages résumés."));
  // Le fil est relu : le « résumé jusqu'au » vient de l'API, pas du client.
  expect(invalidate).toHaveBeenCalledWith({ queryKey: expect.arrayContaining(["thread", THREAD]) });
  success.mockRestore();
});

test("pendant l'opération le bouton est désactivé et le dit", async () => {
  let release: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  const success = spyOn(toast, "success").mockImplementation(() => "test-toast");
  stubFetch();
  const base = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return url.includes("/compact") ? pending : base(input, init);
  }) as typeof fetch;
  renderTab();
  await openDialog();

  const button = await screen.findByRole("button", { name: BUTTON }) as HTMLButtonElement;
  fireEvent.click(button);
  await waitFor(() => expect(button.disabled).toBe(true));
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByText("Résumé en cours…")).toBeTruthy();

  release(Response.json({
    compacted: true, summarizedCount: 1, compactedThroughSequence: 2, compactedAt: "2026-10-14T11:00:00.000Z",
  }));
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(success).toHaveBeenCalledWith("Historique compacté : 1 message résumé.");
  success.mockRestore();
});

test("sous le seuil le bouton est désactivé avec la raison", async () => {
  stubFetch();
  renderTab({ messages: [message(1, 500)] });
  await openDialog();

  const button = await screen.findByRole("button", { name: BUTTON }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByText("L’historique est encore trop court pour être résumé.")).toBeTruthy();
});

test("tant qu'un membre répond le bouton est désactivé avec la raison", async () => {
  stubFetch();
  renderTab({ runs: [run(), run({ id: "run-b", status: "running", usage: null })] });
  await openDialog();

  const button = await screen.findByRole("button", { name: BUTTON }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByText(/Un membre répond encore/)).toBeTruthy();
});

test("un échec s'affiche lisiblement et le bouton se réactive", async () => {
  const error = spyOn(toast, "error").mockImplementation(() => "test-toast");
  stubFetch({
    compact: () => Response.json(
      { error: { code: "COMPACTION_FAILED", message: "Le résumé n’a pas pu être produit par le runtime." } },
      { status: 502 },
    ),
  });
  renderTab();
  await openDialog();

  const button = await screen.findByRole("button", { name: BUTTON }) as HTMLButtonElement;
  fireEvent.click(button);
  await waitFor(() => expect(error).toHaveBeenCalledWith("Le résumé n’a pas pu être produit par le runtime."));
  await waitFor(() => expect(button.disabled).toBe(false));
  error.mockRestore();
});

test("indique jusqu'où l'historique est résumé quand une compaction existe", async () => {
  stubFetch();
  renderTab({ compaction: COMPACTION });
  await openDialog();

  const line = await screen.findByText(/Historique résumé jusqu’au/);
  expect(line.textContent).toContain("2026");
});

test("ne dit rien d'un résumé qui n'existe pas", async () => {
  stubFetch();
  renderTab({ compaction: null });
  await openDialog();
  await screen.findByRole("button", { name: BUTTON });
  expect(screen.queryByText(/Historique résumé jusqu’au/)).toBeNull();
});

test("un membre simple ne voit pas le bouton, seulement l'état du résumé", async () => {
  stubFetch({ role: "member" });
  renderTab({ compaction: COMPACTION });
  await openDialog();

  await screen.findByText(/Historique résumé jusqu’au/);
  expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
});
