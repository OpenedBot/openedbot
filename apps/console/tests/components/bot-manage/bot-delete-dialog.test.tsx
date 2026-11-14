import { afterEach, beforeEach, expect, test } from "bun:test";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { BotDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../src/lib/i18n";
import { BotDeleteDialog, useBotActions } from "../../../src/components/bot-manage/bot-actions";

const realFetch = globalThis.fetch;

beforeEach(() => window.localStorage.setItem("openedbot:locale", "fr"));

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

const bot = { id: "bot-1", name: "Atlas", threadId: "thread-1", archivedAt: null, pinned: false, hidden: false } as unknown as BotDto;

type Call = { method: string; url: string };

/** The trash refuses (409 BOT_IN_GROUP); the forced purge succeeds. */
function stubServer(calls: Call[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (method === "DELETE" && url.includes("purge=1")) {
      return Response.json({ id: bot.id, hostCleanup: "none" });
    }
    if (method === "DELETE") {
      return Response.json(
        { error: { code: "BOT_IN_GROUP", message: "Retirez ce bot de ses salons ou choisissez un autre pilote avant de l’archiver ou de le supprimer." } },
        { status: 409 },
      );
    }
    return Response.json({});
  }) as typeof fetch;
}

function Harness({ onDeleted }: { onDeleted: () => void }) {
  const actions = useBotActions(bot);
  const [open, setOpen] = useState(true);
  return (
    <BotDeleteDialog
      bot={bot}
      open={open}
      onClose={() => setOpen(false)}
      remove={actions.remove}
      forcePurge={actions.forcePurge}
      onDeleted={onDeleted}
    />
  );
}

function renderDialog(onDeleted: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRootRoute({ component: () => <Harness onDeleted={onDeleted} /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

test("a bot kept in rooms: the refused trash turns into a permanent deletion confirmed by « Valider »", async () => {
  const calls: Call[] = [];
  stubServer(calls);
  let deleted = 0;
  renderDialog(() => { deleted += 1; });

  fireEvent.click(await screen.findByRole("button", { name: "Supprimer" }));

  // The refusal no longer leaves « Supprimer » to replay: the dialog says what
  // the permanent deletion does, and offers « Valider ».
  const confirm = await screen.findByRole("button", { name: "Valider" });
  expect(screen.queryByRole("button", { name: "Supprimer" })).toBeNull();
  expect(screen.getByText("Supprimer définitivement « Atlas » ?")).toBeTruthy();
  expect(screen.getByText(/Valider le retire de chaque salon/)).toBeTruthy();
  expect(screen.queryByText(/Retirez ce bot de ses salons/)).toBeNull();

  fireEvent.click(confirm);
  await waitFor(() => expect(deleted).toBe(1));
  const deletes = calls.filter((call) => call.method === "DELETE").map((call) => call.url);
  expect(deletes).toEqual(["/api/bots/bot-1", "/api/bots/bot-1?purge=1&force=1"]);
});

test("cancelling after the refusal sends nothing more", async () => {
  const calls: Call[] = [];
  stubServer(calls);
  renderDialog(() => {});

  fireEvent.click(await screen.findByRole("button", { name: "Supprimer" }));
  await screen.findByRole("button", { name: "Valider" });
  fireEvent.click(screen.getByRole("button", { name: "Annuler" }));

  await waitFor(() => expect(screen.queryByRole("button", { name: "Valider" })).toBeNull());
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
});
