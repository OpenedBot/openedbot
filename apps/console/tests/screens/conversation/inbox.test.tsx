import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { SidebarProvider } from "@openedbot/browser-ui-kit";
import { I18nProvider } from "../../../src/lib/i18n";
import { InboxScreen } from "../../../src/screens/conversation/inbox";

const realFetch = globalThis.fetch;

function href(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const APPROVAL_ITEM = {
  kind: "approval" as const,
  id: "approval-1",
  occurredAt: "2026-08-31T09:00:00.000Z",
  threadId: "t2",
  isDefaultThread: false,
  botId: "bot-atlas",
  botSlug: "atlas",
  botName: "Atlas",
  botFace: null,
  groupId: null,
  groupName: null,
  approvalId: "approval-1",
  runId: "run-1",
  summary: "Envoyer l’e-mail de relance au client.",
  expiresAt: "2026-08-31T10:00:00.000Z",
};

const NEEDS_REVIEW_ITEM = {
  kind: "needs_review" as const,
  id: "workflow-1",
  occurredAt: "2026-08-31T08:00:00.000Z",
  threadId: "t1-default",
  isDefaultThread: true,
  botId: "bot-atlas",
  botSlug: "atlas",
  botName: "Atlas",
  botFace: null,
  groupId: null,
  groupName: null,
  workflowId: "workflow-1",
  status: "unknown" as const,
  recoveryState: "needs_review" as const,
  errorCode: "LEASE_EXPIRED",
  errorMessage: "Le bail d’exécution a expiré avant la fin de l’étape.",
  createdAt: "2026-08-31T07:00:00.000Z",
  endedAt: null,
  initiatorName: "Élodie",
};

const NEEDS_YOU_ITEM = {
  kind: "needs_you" as const,
  id: "group-1",
  occurredAt: "2026-08-31T06:00:00.000Z",
  threadId: "t-group",
  isDefaultThread: true,
  botId: null,
  botSlug: null,
  botName: null,
  botFace: null,
  groupId: "g1",
  groupName: "Salon support",
};

function inboxResponse(items: unknown[]) {
  return {
    items,
    counts: {
      approval: items.filter((item) => (item as { kind: string }).kind === "approval").length,
      needsReview: items.filter((item) => (item as { kind: string }).kind === "needs_review").length,
      needsYou: items.filter((item) => (item as { kind: string }).kind === "needs_you").length,
      total: items.length,
    },
  };
}

function renderInbox(initialPath = "/inbox") {
  const rootRoute = createRootRoute({ component: Outlet });
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/inbox",
    validateSearch: (search: Record<string, unknown>): { kind?: "approval" | "needs_review" | "needs_you" } => ({
      kind: search.kind === "approval" || search.kind === "needs_review" || search.kind === "needs_you" ? search.kind : undefined,
    }),
    component: InboxScreen,
  });
  const botRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot/$botId",
    validateSearch: (search: Record<string, unknown>): { task?: string } => ({
      task: typeof search.task === "string" ? search.task : undefined,
    }),
    component: () => null,
  });
  const groupRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/g/$groupId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([inboxRoute, botRoute, groupRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SidebarProvider>
          <RouterProvider router={router as never} />
        </SidebarProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return router;
}

function stubFetch(items: unknown[], calls: string[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = href(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.includes("/api/inbox")) return Response.json(inboxResponse(items));
    if (url.includes("/api/auth/me")) {
      return Response.json({
        user: { id: "u1", email: "elodie@example.test", displayName: "Élodie" },
        organization: { id: "org-1", slug: "org", name: "Org" },
        role: "owner",
      });
    }
    if (url.includes("/api/approvals/") && url.endsWith("/respond")) {
      return Response.json({ choice: "once", approved: true });
    }
    if (url.includes("/api/workflows/") && url.endsWith("/abandon")) {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/api/workflows/") && url.endsWith("/reconcile")) {
      return Response.json({ ok: true });
    }
    if (url.includes("/api/workflows/") && url.endsWith("/retry")) {
      return Response.json({ ok: true });
    }
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("InboxScreen", () => {
  test("le lien des approbations filtre la boîte et suit un changement de destination", async () => {
    stubFetch([APPROVAL_ITEM, NEEDS_REVIEW_ITEM, NEEDS_YOU_ITEM]);
    const router = renderInbox("/inbox?kind=approval");

    expect(await screen.findByText(APPROVAL_ITEM.summary)).toBeTruthy();
    expect(document.querySelector('[data-inbox-item="needs_review"]')).toBeNull();
    expect(document.querySelector('[data-inbox-item="needs_you"]')).toBeNull();

    await act(async () => router.navigate({ to: "/inbox", search: { kind: "needs_review" } }));
    await waitFor(() => {
      expect(document.querySelector('[data-inbox-item="approval"]')).toBeNull();
      expect(document.querySelector('[data-inbox-item="needs_review"]')).toBeTruthy();
      expect(document.querySelector('[data-inbox-item="needs_you"]')).toBeNull();
    });
  });

  test("liste les trois genres ; needs_you navigue, le reste ouvre un alertdialog", async () => {
    stubFetch([APPROVAL_ITEM, NEEDS_REVIEW_ITEM, NEEDS_YOU_ITEM]);
    const router = renderInbox();

    expect(await screen.findByText("Envoyer l’e-mail de relance au client.")).toBeTruthy();
    expect(screen.getByText("Exécution à vérifier")).toBeTruthy();
    expect(document.querySelector('[data-inbox-item="needs_you"]')).toBeTruthy();

    fireEvent.click(document.querySelector('[data-inbox-item="approval"]')!);
    expect(await screen.findByRole("alertdialog", { name: "Approbation requise" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/inbox");
    expect(screen.getByRole("button", { name: "Autoriser une fois" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refuser" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Ouvrir la conversation" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/bot/bot-atlas");
      expect((router.state.location.search as { task?: string }).task).toBe("t2");
    });

    await act(async () => router.navigate({ to: "/inbox" }));
    fireEvent.click(document.querySelector('[data-inbox-item="needs_review"]')!);
    expect(await screen.findByRole("alertdialog", { name: "Exécution à vérifier" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/inbox");

    fireEvent.click(screen.getAllByRole("button", { name: "Ouvrir la conversation" })[0]!);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/bot/bot-atlas");
      expect((router.state.location.search as { task?: string }).task).toBeUndefined();
    });

    await act(async () => router.navigate({ to: "/inbox" }));
    fireEvent.click(document.querySelector('[data-inbox-item="needs_you"]')!);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/g/g1");
    });
  });

  test("l’approbation se tranche dans l’alertdialog, sans window.confirm", async () => {
    const calls: string[] = [];
    stubFetch([APPROVAL_ITEM], calls);
    renderInbox();

    expect(await screen.findByText("Envoyer l’e-mail de relance au client.")).toBeTruthy();
    fireEvent.click(document.querySelector('[data-inbox-item="approval"]')!);
    fireEvent.click(await screen.findByRole("button", { name: "Autoriser une fois" }));
    await waitFor(() => {
      expect(calls.some((call) => call.includes("POST") && call.includes("/api/approvals/approval-1/respond"))).toBe(true);
    });
  });

  test("abandonner une revue : alertdialog de confirmation, pas window.confirm", async () => {
    const calls: string[] = [];
    const nativeConfirm = window.confirm;
    window.confirm = () => {
      throw new Error("window.confirm ne doit plus être appelé");
    };
    stubFetch([NEEDS_REVIEW_ITEM], calls);
    renderInbox();

    expect(await screen.findByText("Le bail d’exécution a expiré avant la fin de l’étape.")).toBeTruthy();
    fireEvent.click(document.querySelector('[data-inbox-item="needs_review"]')!);
    expect(await screen.findByRole("alertdialog", { name: "Exécution à vérifier" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Abandonner" }));
    const confirmDialog = await screen.findByRole("alertdialog", { name: "Abandonner" });
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Confirmer" }));
    await waitFor(() => {
      expect(calls.some((call) => call.includes("POST") && call.includes("/api/workflows/workflow-1/abandon"))).toBe(true);
    });
    window.confirm = nativeConfirm;
  });

  test("état vide : décrit le périmètre de la boîte", async () => {
    stubFetch([]);
    renderInbox();

    expect(await screen.findByText(/ne liste que/)).toBeTruthy();
  });
});
