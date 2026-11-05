import { afterEach, beforeEach, expect, test } from "bun:test";
import { Profiler, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "../../../src/lib/i18n";
import { BotsTable } from "../../../src/components/dashboard/bots-table";
import { queryKeys } from "../../../src/lib/api";
import type { RosterDto } from "@openedbot/contracts-api";

const realFetch = globalThis.fetch;
const clients: QueryClient[] = [];

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/bots")) return Response.json({ bots: [], sections: [], groups: [], operator: null });
    if (url.includes("/api/runtime")) return Response.json({ runtime: null });
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

function mountTable(client = new QueryClient()) {
  clients.push(client);
  const root = createRootRoute({ component: () => <BotsTable flush /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  render(<QueryClientProvider client={client}><I18nProvider><RouterProvider router={router as never} /></I18nProvider></QueryClientProvider>);
}

test("a first 500 shows an unavailable list and retry rather than no bots", async () => {
  let unreadable = true;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/runtime")) return Response.json({ runtime: null });
    return unreadable ? Response.json({ error: { code: "INTERNAL_ERROR", message: "Unreadable" } }, { status: 500 })
      : Response.json({ bots: [], groups: [], sections: [], operator: null });
  }) as typeof fetch;
  mountTable();
  await screen.findByRole("alert");
  expect(screen.queryByText(/aucun bot/i)).toBeNull();
  unreadable = false;
  fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
  await screen.findByText(/aucun bot/i);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a failed refresh keeps the measured empty list with its original response date", async () => {
  const observedAt = Date.now() - 5 * 60_000;
  const empty: RosterDto = { bots: [], groups: [], sections: [], operator: null };
  const client = new QueryClient();
  client.setQueryData(queryKeys.roster, empty, { updatedAt: observedAt });
  globalThis.fetch = (async (input: RequestInfo | URL) => String(input).includes("/api/runtime")
    ? Response.json({ runtime: null }) : Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 })) as typeof fetch;
  mountTable(client);
  const stale = await screen.findByText(/Cette liste des bots est périmée/);
  expect(stale.textContent).toContain(new Date(observedAt).toLocaleString("fr"));
  expect(screen.getByText(/aucun bot/i)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

// Regression: `useReactTable` received a new `data` array on every render, so
// TanStack Table reset its page index in a microtask after each render and
// the table re-rendered forever once the roster had loaded and any parent
// re-render recreated the element. Chrome reported the tab as unresponsive.
test("a parent re-render after the roster loaded does not start a render loop", async () => {
  let commits = 0;
  let rerenderParent: () => void = () => {};
  function Parent() {
    const [tick, setTick] = useState(0);
    rerenderParent = () => setTick((value) => value + 1);
    return (
      <Profiler id="bots-table" onRender={() => { commits += 1; }}>
        <div data-tick={tick}><BotsTable flush /></div>
      </Profiler>
    );
  }
  const rootRoute = createRootRoute({ component: Parent });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
    </QueryClientProvider>,
  );
  await screen.findByText(/aucun bot/i);
  const before = commits;
  await act(async () => {
    rerenderParent();
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(commits - before).toBeLessThan(10);
});
