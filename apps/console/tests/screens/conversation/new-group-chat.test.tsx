import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import type { BotDto, GroupDto, RosterDto } from "@openedbot/contracts-api";
import { api, queryKeys } from "../../../src/lib/api";
import { I18nProvider } from "../../../src/lib/i18n";
import { NewGroupChatScreen, groupNameFor, recipientOptions } from "../../../src/screens/conversation/new-group-chat";

const spies: Array<{ mockRestore: () => void }> = [];
beforeEach(() => window.localStorage.setItem("openedbot:locale", "fr"));
afterEach(() => {
  cleanup();
  for (const spy of spies.splice(0)) spy.mockRestore();
  window.localStorage.clear();
});

function bot(id: string, name: string): BotDto {
  return {
    id, name, slug: name.toLowerCase(), threadId: `thread-${id}`, description: null, instructions: "", model: null,
    reasoningEffort: null, sectionId: "s", position: 0, pinned: false, face: null, voiceId: null, hermesProfile: null,
    lastActivityAt: "2026-11-01T00:00:00.000Z",
  } as BotDto;
}
const designer = bot("b1", "Designer");
const dev = bot("b2", "Dev");
const research = bot("b3", "Recherche");

describe("nommer et proposer", () => {
  test("le groupe porte le nom de ses membres", () => {
    expect(groupNameFor(["Designer", "Dev", "Recherche"], "fr")).toBe("Designer, Dev et Recherche");
    expect(groupNameFor(["A".repeat(80), "B".repeat(80)], "fr")).toHaveLength(100);
  });

  test("« Créer » n'apparaît qu'à partir de deux bots, et les bots choisis sortent de la liste", () => {
    const all = [designer, dev, research];
    expect(recipientOptions(all, ["b1"], "").map((option) => option.kind === "bot" ? option.bot.name : "create"))
      .toEqual(["Dev", "Recherche"]);
    expect(recipientOptions(all, ["b1", "b2"], "")[0]).toEqual({ kind: "create" });
    expect(recipientOptions(all, ["b1", "b2"], "rech").map((option) => option.kind)).toEqual(["bot"]);
  });
});

function renderScreen(initialIds: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData<RosterDto>(queryKeys.roster, { bots: [designer, dev, research], groups: [], sections: [] } as unknown as RosterDto);
  const root = createRootRoute({ component: () => <Outlet /> });
  const screenRoute = createRoute({ getParentRoute: () => root, path: "/g/new", component: () => <NewGroupChatScreen initialIds={initialIds} /> });
  const groupRoute = createRoute({ getParentRoute: () => root, path: "/g/$groupId", component: () => <p>salon ouvert</p> });
  const botRoute = createRoute({ getParentRoute: () => root, path: "/bot/$botId", component: () => <p>fil ouvert</p> });
  const router = createRouter({
    routeTree: root.addChildren([screenRoute, groupRoute, botRoute]),
    history: createMemoryHistory({ initialEntries: ["/g/new"] }),
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe("nouvelle conversation de groupe", () => {
  test("des pastilles au clavier : Entrée ajoute, Retour arrière retire la dernière", async () => {
    renderScreen([]);
    const field = await screen.findByRole("combobox");
    fireEvent.change(field, { target: { value: "des" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Retirer Designer" })).toBeTruthy();
    fireEvent.keyDown(field, { key: "Backspace" });
    expect(screen.queryByRole("button", { name: "Retirer Designer" })).toBeNull();
  });

  test("deux bots : le groupe naît au premier message ; un envoi raté ne recrée pas le groupe", async () => {
    const group = { id: "g1", threadId: "thread-g1", name: "Designer et Dev" } as GroupDto;
    const createGroup = spyOn(api, "createGroup").mockResolvedValue(group);
    const sendMessage = spyOn(api, "sendMessage")
      .mockRejectedValueOnce(new Error("réseau"))
      .mockResolvedValue({} as never);
    spies.push(createGroup, sendMessage);
    const router = renderScreen(["b1", "b2"]);

    const composer = await screen.findByRole("textbox", { name: /Designer et Dev/ });
    fireEvent.change(composer, { target: { value: "Bonjour" } });
    await act(async () => { fireEvent.keyDown(composer, { key: "Enter" }); });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(createGroup).toHaveBeenCalledWith({ name: "Designer et Dev", memberIds: ["b1", "b2"] });
    expect(router.state.location.pathname).toBe("/g/new");

    await act(async () => { fireEvent.keyDown(composer, { key: "Enter" }); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/g/g1"));
    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[1]![0]).toBe("thread-g1");
    // Même clé d'idempotence : le serveur ne compte qu'un message.
    expect(sendMessage.mock.calls[1]![3]).toBe(sendMessage.mock.calls[0]![3]);
  });

  test("un seul bot : le message part dans son fil", async () => {
    const createGroup = spyOn(api, "createGroup");
    const sendMessage = spyOn(api, "sendMessage").mockResolvedValue({} as never);
    spies.push(createGroup, sendMessage);
    const router = renderScreen(["b3"]);
    const composer = await screen.findByRole("textbox", { name: /Recherche/ });
    fireEvent.change(composer, { target: { value: "Salut" } });
    await act(async () => { fireEvent.keyDown(composer, { key: "Enter" }); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/bot/b3"));
    expect(sendMessage.mock.calls[0]![0]).toBe("thread-b3");
    expect(createGroup).not.toHaveBeenCalled();
  });
});
