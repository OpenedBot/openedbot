import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { BotDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../src/lib/i18n";
import { useAgentEditor } from "../../../src/lib/bots/agent-editor";
import { useBotDialogs, type BotManagePage } from "../../../src/lib/bots/bot-dialogs";
import { BotDialogsHost } from "../../../src/components/bot-manage/bot-dialogs-host";
import {
  BotManageDialog,
  BOT_MANAGE_GROUPS,
  isBotManagePageParked,
  usableBotManagePage,
} from "../../../src/components/bot-manage/bot-manage-dialog";

const realFetch = globalThis.fetch;

const bot: BotDto = {
  id: "bot-1",
  threadId: "thread-1",
  name: "Cahier2",
  slug: "cahier2",
  description: null,
  instructions: "# Cahier2\n\nTu tiens le cahier.",
  model: null,
  reasoningEffort: null,
  sectionId: "s",
  position: 0,
  pinned: false,
  face: null,
  voiceId: null,
  hermesProfile: null,
  isolation: "profile",
  hasOwnRuntime: false,
  runtimeName: null,
  awaitingApproval: false,
  preview: null,
  lastActivityAt: new Date().toISOString(),
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastRunAt: null,
  label: "Carnet de bord",
  permissionMode: "auto",
};

let deleted = false;
let closed = 0;

async function renderDialog(initialPage: BotManagePage | null = null, subject: BotDto = bot) {
  if (initialPage === "runtime") {
    // Await the cold module import outside Testing Library's one-second DOM wait.
    await import("../../../src/screens/settings/installation/cloud");
  }
  const rootRoute = createRootRoute({
    component: () => (
      <BotManageDialog bot={subject} open onClose={() => { closed += 1; }} initialPage={initialPage} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <RouterProvider router={router as never} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

function baseFetch(url: string, method: string): Response | null {
  if (url.endsWith("/api/bots/bot-1/settings-tool") && method === "GET") {
    return Response.json({ available: true, reason: null, enabled: false, restartPending: false });
  }
  if (url.endsWith("/api/bots/bot-1/persona-drafts/latest") && method === "GET") {
    return Response.json({ status: "completed", runId: "run-1", draft: "# Persona", hash: "h1" });
  }
  if (url.endsWith("/api/bots/bot-1/persona-drafts") && method === "POST") {
    return Response.json({ error: { code: "RATE_LIMITED", message: "rate limited" } }, { status: 429 });
  }
  if (url.endsWith("/api/bots/bot-1") && method === "DELETE") {
    deleted = true;
    return Response.json({ ...bot, archivedAt: new Date().toISOString() });
  }
  if (url.endsWith("/api/runtime/exposures")) return Response.json({ exposures: [] });
  if (url.includes("/api/runtime/list")) return Response.json({ runtimes: [] });
  if (url.includes("/api/runtimes")) return Response.json({ runtimes: [] });
  if (url.includes("/api/runtime")) {
    return Response.json({ runtime: null, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
  }
  if (url.includes("/api/auth/me")) return Response.json({ error: { code: "UNAUTHENTICATED", message: "no" } }, { status: 401 });
  if (url.endsWith("/api/bots") && method === "GET") return Response.json({ bots: [bot], groups: [], sections: [] });
  return null;
}

function serve(extra: (url: string, method: string) => Response | null = () => null) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const answered = extra(url, method) ?? baseFetch(url, method);
    if (answered) return answered;
    throw new Error(`Route inattendue : ${method} ${url}`);
  }) as typeof fetch;
}

beforeEach(() => {
  deleted = false;
  closed = 0;
  window.localStorage.setItem("ohb:locale", "fr");
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  serve();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
  useBotDialogs.setState({ createOpen: false, createSource: null, manageBotId: null, managePage: null, manageThreadId: null });
  useAgentEditor.setState({ open: false, botId: null });
});

const row = (page: BotManagePage) => document.querySelector<HTMLButtonElement>(`[data-bot-manage-row="${page}"]`);

describe("la page du bot : des rangées qui disent leur réponse", () => {
  test("chaque rangée affiche sa valeur actuelle", async () => {
    await renderDialog();
    await screen.findByRole("dialog", { name: "Gérer « Cahier2 »" });
    expect(screen.getByText("Carnet de bord")).toBeTruthy();
    expect(row("persona")!.textContent).toContain("Cahier2");
    expect(row("model")!.textContent).toContain("Modèle du serveur");
    expect(row("approvals")!.textContent).toContain("Revue auto");
    expect(row("coordination")!.textContent).toContain("Désactivée");
    expect(row("webhooks")!.textContent).toContain("Plus tard");
  });

  test("la rangée Serveur dit le profil Hermes du bot et qui le gère", async () => {
    await renderDialog();
    await screen.findByRole("dialog", { name: "Gérer « Cahier2 »" });
    expect(row("runtime")!.textContent).toContain("Aucun profil Hermes attribué.");
    cleanup();
    await renderDialog(null, { ...bot, hermesProfile: "cahier2", hermesProfileManaged: true });
    await screen.findByRole("dialog", { name: "Gérer « Cahier2 »" });
    expect(row("runtime")!.textContent).toContain("Profil Hermes « cahier2 » · géré par openedbot");
    cleanup();
    await renderDialog(null, { ...bot, hermesProfile: "legacy", hermesProfileManaged: false });
    await screen.findByRole("dialog", { name: "Gérer « Cahier2 »" });
    expect(row("runtime")!.textContent).toContain("Profil Hermes « legacy » · importé");
  });

  test("les groupes couvrent chaque page une seule fois", () => {
    const pages = BOT_MANAGE_GROUPS.flatMap((group) => group.pages);
    expect(new Set(pages).size).toBe(pages.length);
    expect(pages).toContain("mcp");
    expect(pages).toContain("skills");
  });

  test("Webhooks est parquée : grisée, ne s'ouvre pas, et un lien direct retombe sur l'index", async () => {
    expect(isBotManagePageParked("webhooks")).toBe(true);
    expect(usableBotManagePage("webhooks")).toBeNull();
    expect(usableBotManagePage("persona")).toBe("persona");
    await renderDialog("webhooks");
    const webhooks = row("webhooks")!;
    expect(webhooks).toHaveProperty("disabled", true);
    expect(webhooks.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(webhooks);
    expect(screen.queryByLabelText("Nom du webhook")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retour au bot" })).toBeNull();
  });

  test("une rangée ouvre sa page, Retour revient à l'index", async () => {
    await renderDialog();
    fireEvent.click(row("approvals")!);
    expect(await screen.findByRole("heading", { name: "Règles d’approbation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retour au bot" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Règles d’approbation" })).toBeNull());
  });

  test("Modifier le profil ferme la page et ouvre l'éditeur d'agent sur ce bot", async () => {
    await renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Modifier le profil" }));
    expect(closed).toBe(1);
    expect(useAgentEditor.getState().botId).toBe("bot-1");
  });

  test("Dupliquer ferme la page et ouvre la feuille de création sur ce bot", async () => {
    await renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Dupliquer…" }));
    expect(closed).toBe(1);
    expect(useBotDialogs.getState().createOpen).toBe(true);
    expect(useBotDialogs.getState().createSource?.id).toBe("bot-1");
  });

  test("Supprimer demande confirmation avant l'appel, puis ferme la page", async () => {
    await renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Supprimer" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Supprimer « Cahier2 » ?" });
    expect(deleted).toBe(false);
    expect(confirm.textContent).toContain("son profil est effacé sur votre machine");
    fireEvent.click(within(confirm).getByRole("button", { name: "Supprimer" }));
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(closed).toBeGreaterThan(0));
  });
});

describe("les pages du bot", () => {
  test("Persona : Appliquer ce brouillon est sous le brouillon proposé, Enregistrer dans le pied", async () => {
    await renderDialog("persona");
    const apply = await screen.findByRole("button", { name: "Appliquer ce brouillon" });
    const pre = screen.getByText("# Persona", { selector: "pre" });
    expect(pre.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const save = screen.getByRole("button", { name: "Enregistrer" });
    expect(save).toHaveProperty("disabled", true);
    expect(save.closest("footer")).not.toBeNull();
  });

  // The bot_settings_propose switch lives with the persona it proposes to
  // change; enabling it can require a gateway restart before runs see it.
  test("Persona : l'interrupteur des propositions du bot s'écrit et annonce le redémarrage", async () => {
    let put: unknown = null;
    const served = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/bots/bot-1/settings-tool") && init?.method === "PUT") {
        put = JSON.parse(String(init.body));
        return Response.json({ available: true, reason: null, enabled: true, restartPending: true });
      }
      return served(input, init);
    }) as typeof fetch;
    await renderDialog("persona");
    const toggle = await screen.findByRole("switch", { name: "Autoriser Cahier2 à proposer des modifications de ses réglages" });
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
    fireEvent.click(toggle);
    expect(await screen.findByText("Redémarrez le gateway pour que les prochains runs voient l’outil.")).toBeTruthy();
    expect(put).toEqual({ enabled: true });
  });

  test("Persona : une erreur de brouillon ouvre une boîte d'alerte modale", async () => {
    await renderDialog("persona");
    fireEvent.click(await screen.findByRole("button", { name: "Proposer un brouillon" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/Trop de demandes de brouillon/);
  });

  test("le corps d'une page utilise la scrollbar fine du produit", async () => {
    await renderDialog("approvals");
    await screen.findByRole("heading", { name: "Règles d’approbation" });
    const scroller = document.querySelector<HTMLElement>("[data-bot-manage-scroll]");
    expect(scroller).not.toBeNull();
    expect(scroller!.className).toContain("scrollbar-subtle");
  });

  test("Serveur monte l'écran /settings/runtime, sans pied propre au bot", async () => {
    await renderDialog("runtime");
    expect(await screen.findByRole("tablist", { name: "Sections du runtime" })).toBeTruthy();
    // Sans runtime déclaré (bouchon), le rail de l'écran s'ouvre sur l'ajout.
    expect(screen.getByRole("tab", { name: "Ajouter un runtime" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("[data-bot-manage-scroll]")).toBeNull();
  });

  test("Skills et Connecteurs MCP sont deux pages distinctes", async () => {
    serve((url) => {
      if (url.includes("/capabilities")) {
        return Response.json({
          botId: "bot-1",
          hermesProfile: "scout",
          scope: "profile",
          writable: true,
          profileManagement: true,
          runtimeName: "Hermes",
          toolsets: [],
          skills: [{ name: "research", description: "Find sources.", category: "work", enabled: true, writable: true }],
          mcpServers: [{ name: "linear", enabled: false, transport: "http", tools: ["issues"], unreachable: false }],
          usage: [],
          usageWindowDays: 30,
          inventoryError: null,
        });
      }
      if (url.includes("/tool-errors")) return Response.json({ errors: [], nextCursor: null });
      return null;
    });
    await renderDialog("skills");
    expect(await screen.findByRole("switch", { name: "Activer research" })).toBeTruthy();
    expect(screen.queryByText("linear")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retour au bot" }));
    fireEvent.click(await waitFor(() => row("mcp")!));
    expect(await screen.findByText("linear")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Activer research" })).toBeNull();
  });

  test("Activité lit le fil affiché par la conversation (une branche ?task=), pas le fil d'origine", async () => {
    const threadReads: string[] = [];
    serve((url) => {
      if (url.includes("/api/bots?includeHidden=true")) return Response.json({ bots: [bot], groups: [], sections: [] });
      const match = /\/api\/threads\/([^/]+)\/history/.exec(url);
      if (!match) return null;
      threadReads.push(match[1]!);
      return Response.json({ id: match[1], messages: [], runs: [], events: [], approvals: [], workflows: [] });
    });
    const rootRoute = createRootRoute({ component: () => <BotDialogsHost /> });
    const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <RouterProvider router={router as never} />
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    act(() => useBotDialogs.getState().openManage("bot-1", "activity", "branch-1"));
    await screen.findByRole("dialog", { name: "Gérer « Cahier2 »" });
    await waitFor(() => expect(threadReads).toEqual(["branch-1"]));
    act(() => useBotDialogs.getState().closeManage());
    expect(useBotDialogs.getState().manageThreadId).toBeNull();
  });

  test("ouverte sans fil, la page Activité lit le fil du bot", async () => {
    const threadReads: string[] = [];
    serve((url) => {
      const match = /\/api\/threads\/([^/]+)\/history/.exec(url);
      if (!match) return null;
      threadReads.push(match[1]!);
      return Response.json({ id: match[1], messages: [], runs: [], events: [], approvals: [], workflows: [] });
    });
    await renderDialog("activity");
    await waitFor(() => expect(threadReads).toEqual(["thread-1"]));
  });
});
