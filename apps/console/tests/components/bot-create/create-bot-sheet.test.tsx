import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { resolveCreateInstructions } from "@openedbot/roster/domain/persona";
import type { BotDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../src/lib/i18n";
import { api, queryKeys } from "../../../src/lib/api";
import { CreateBotSheet } from "../../../src/components/bot-create/create-bot-sheet";
import { BotCreatingScreen } from "../../../src/components/bot-create/bot-creating-screen";
import { BotDialogsHost } from "../../../src/components/bot-manage/bot-dialogs-host";
import { isPendingBotId } from "../../../src/lib/bots/pending-bot-creations";
import { useBotDialogs } from "../../../src/lib/bots/bot-dialogs";
import { OverviewScreen } from "../../../src/screens/home/overview";

const realFetch = globalThis.fetch;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const createdBot: BotDto = {
  id: "bot-new",
  threadId: "thread-new",
  name: "Bot de recherche",
  slug: "bot-de-recherche",
  description: "Research",
  instructions: "",
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
};

let createdBodies: Array<Record<string, unknown>> = [];
let patched = false;

let currentPath = "/";

function renderApp(
  mode: "sheet" | "home" | "host" = "sheet",
  source: BotDto | null = null,
  options: { queryClient?: QueryClient; botScreen?: (botId: string) => ReactNode } = {},
) {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        {mode === "sheet" ? <CreateBotSheet open onClose={() => {}} source={source} /> : null}
        {mode === "host" ? <BotDialogsHost /> : null}
        <Outlet />
      </>
    ),
  });
  const botRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bot/$botId",
    component: function BotRoute() {
      const { botId } = botRoute.useParams();
      if (isPendingBotId(botId)) return <BotCreatingScreen botId={botId} />;
      return options.botScreen ? options.botScreen(botId) : <p>bot:{botId}</p>;
    },
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: mode === "home" || mode === "host" ? OverviewScreen : () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, botRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  router.subscribe("onResolved", () => { currentPath = router.state.location.pathname; });
  const queryClient = options.queryClient ?? new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router as never} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function fillIdentity() {
  fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Bot de recherche" } });
  fireEvent.change(screen.getByLabelText("Rôle"), { target: { value: "Research" } });
  fireEvent.change(screen.getByLabelText("Mission"), {
    target: { value: "Cite sources and refuse unsourced claims." },
  });
}

const createButton = () => screen.getByRole("button", { name: "Créer" });

type Route = (url: string, method: string, init?: RequestInit) => Response | Promise<Response | null> | null;

function serve(extra: Route = () => null) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const answered = await extra(url, method, init);
    if (answered) return answered;
    if (url.includes("/api/runtime/profiles")) return Response.json({ profiles: [] });
    if (url.includes("/api/runtime")) {
      return Response.json({ runtime: null, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
    }
    if (url.includes("/api/bots") && method === "POST") {
      createdBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json(createdBot, { status: 201 });
    }
    if (url.includes("/api/bots/") && method === "PATCH") {
      patched = true;
      return Response.json(createdBot);
    }
    if (url.endsWith("/api/bots") && method === "GET") return Response.json({ bots: [createdBot], groups: [], sections: [] });
    throw new Error(`Route inattendue : ${method} ${url}`);
  }) as typeof fetch;
}

beforeEach(() => {
  createdBodies = [];
  patched = false;
  currentPath = "/";
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
});

describe("feuille « Nouveau bot » : l'identité seule, sans options avancées", () => {
  test("à l'ouverture, le focus est dans le champ Nom", async () => {
    renderApp();
    const dialog = await screen.findByRole("dialog", { name: "Nouveau bot" });
    // The desktop header is the sheet's own: its lede still describes the dialog.
    const lede = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(lede?.textContent).toBe("Un nom suffit pour créer. Tout le reste se règle ensuite sur sa page.");
    const name = screen.getByLabelText("Nom");
    await waitFor(() => expect(document.activeElement).toBe(name));
  });

  test("la feuille ouvre directement l'identité, et rien d'autre à régler", async () => {
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    expect(screen.queryByRole("list", { name: "Étapes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retour" })).toBeNull();
    expect(screen.getByLabelText("Rôle")).toBeTruthy();
    expect(screen.getByLabelText("Mission")).toBeTruthy();
    // Persona, règles d'approbation, avis de fin : sur la page du bot, après.
    expect(screen.queryByRole("button", { name: /Options avancées/ })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Persona" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  test("le nom est obligatoire : Créer reste désactivé tant qu'il est vide", async () => {
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    expect(createButton()).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "   " } });
    expect(createButton()).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Atlas" } });
    expect(createButton()).toHaveProperty("disabled", false);
  });

  test("le rôle est borné à la taille du libellé (60)", async () => {
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    expect(screen.getByLabelText("Rôle").getAttribute("maxlength")).toBe("60");
  });

  test("une seule requête porte le bot ET ses réglages, avec un identifiant de demande", async () => {
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    fillIdentity();
    fireEvent.click(createButton());
    await waitFor(() => expect(createdBodies).toHaveLength(1));
    const body = createdBodies[0]!;
    expect(body.instructions).toBe(resolveCreateInstructions({
      name: "Bot de recherche",
      role: "Research",
      mission: "Cite sources and refuse unsourced claims.",
    }));
    expect(body).toMatchObject({
      name: "Bot de recherche",
      description: "Research",
      label: "Research",
      permissionMode: "manual",
      notifyOnFinish: true,
      greet: true,
      locale: "fr",
    });
    expect(String(body.clientRequestId)).toMatch(UUID);
    expect(patched).toBe(false);
  });

  test("sans options avancées, le mode par défaut de l'organisation part avec les défauts sûrs", async () => {
    let configServed = false;
    serve((url) => {
      if (!url.endsWith("/api/runtime")) return null;
      configServed = true;
      return Response.json({ runtime: null, runtimeMode: "external", adminMode: "disabled", devDefaults: null, defaultPermissionMode: "auto" });
    });
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Atlas" } });
    // The request is frozen at the click: let the configuration land first.
    await waitFor(() => expect(configServed).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.click(createButton());
    await waitFor(() => expect(createdBodies).toHaveLength(1));
    expect(createdBodies[0]).toMatchObject({ permissionMode: "auto", notifyOnFinish: true, greet: true });
    expect(createdBodies[0]!.hermesProfile).toBeUndefined();
  });

  test("Créer ouvre l'écran d'attente, et Réessayer rejoue la MÊME demande", async () => {
    let attempts = 0;
    serve((url, method, init) => {
      if (!(url.includes("/api/bots") && method === "POST")) return null;
      attempts += 1;
      createdBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return attempts === 1
        ? Response.json({ error: { code: "UPSTREAM", message: "Réponse perdue." } }, { status: 502 })
        : Response.json({ ...createdBot, creationReplayed: true }, { status: 200 });
    });
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Atlas" } });
    fireEvent.click(createButton());
    const retry = await screen.findByRole("button", { name: "Réessayer" });
    expect(screen.getByText(/sans doublon/)).toBeTruthy();
    fireEvent.click(retry);
    await waitFor(() => expect(createdBodies).toHaveLength(2));
    expect(createdBodies[1]!.clientRequestId).toBe(createdBodies[0]!.clientRequestId);
    await waitFor(() => expect(currentPath).toBe("/bot/bot-new"));
  });

  test("roster déjà en cache et relecture lente : l'écran du bot ne dit jamais « n'existe plus »", async () => {
    let releaseRoster!: () => void;
    const rosterHeld = new Promise<void>((resolve) => { releaseRoster = resolve; });
    let rosterReads = 0;
    serve(async (url, method, init) => {
      if (url.includes("/api/bots?includeHidden=true") && method === "GET") {
        rosterReads += 1;
        await rosterHeld;
        return Response.json({ bots: [createdBot], groups: [], sections: [] });
      }
      if (url.includes("/api/bots") && method === "POST") {
        createdBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return Response.json(createdBot, { status: 201 });
      }
      return null;
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    // The roster is already there (another bot), as it is in a live session.
    queryClient.setQueryData(queryKeys.roster, { bots: [], groups: [], sections: [] });
    const shown: string[] = [];
    function BotScreen({ botId }: { botId: string }) {
      // The conversation screen's own test: no bot and not pending is « gone ».
      const roster = useQuery({ queryKey: queryKeys.roster, queryFn: api.roster });
      const bot = roster.data?.bots.find((candidate) => candidate.id === botId);
      const state = bot ? `bot:${bot.id}` : roster.isPending ? "pending" : "gone";
      shown.push(state);
      return <p>{state}</p>;
    }
    renderApp("sheet", null, { queryClient, botScreen: (botId) => <BotScreen botId={botId} /> });
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Atlas" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(rosterReads).toBeGreaterThan(0));
    // The refetch is still held: the bot route must not open on a stale roster.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(shown).not.toContain("gone");
    releaseRoster();
    await waitFor(() => expect(currentPath).toBe("/bot/bot-new"));
    await screen.findByText("bot:bot-new");
    expect(shown).not.toContain("gone");
  });

});

describe("dupliquer un bot", () => {
  const source: BotDto = {
    ...createdBot,
    id: "bot-source",
    name: "Atlas",
    description: "Recherche longue et détaillée",
    instructions: "# Atlas\n\nCite tes sources.",
    model: "claude-sonnet-4",
    label: "Veille",
    replyLanguage: "fr",
    notifyOnFinish: true,
    permissionMode: "bypass",
    hermesProfile: "atlas",
    face: { palette: "bleu", shape: "galet", eyes: "curieux" },
  };

  /** A linked runtime announcing `linkFeatures`; the profile inventory fails so the field is a plain input. */
  function serveRuntime(
    linkFeatures: string[],
    modelAssignmentMode: "global" | "per_bot" = "per_bot",
    modelSelection: () => Record<string, unknown> | null = () => null,
  ) {
    serve((url) => {
      if (url.includes("/api/runtime/profiles")) return Response.json({ error: { code: "UNAVAILABLE", message: "no" } }, { status: 503 });
      if (url.includes("/api/runtime")) {
        return Response.json({
          runtime: {
            id: "rt-1",
            name: "Hermes",
            configured: true,
            lastHealthStatus: "healthy",
            reachability: "direct",
            selectedModel: "gpt-runtime",
            linkFeatures,
            modelSelection: modelSelection(),
          },
          runtimeMode: "external",
          modelAssignmentMode,
          adminMode: "disabled",
          devDefaults: null,
        });
      }
      return null;
    });
  }

  test("la feuille part de la copie sûre et ne reprend jamais le mode de permission", async () => {
    serveRuntime(["profile_management"]);
    renderApp("sheet", source);
    await screen.findByText(/Il travaillera sur votre serveur Hermes/);
    await screen.findByRole("dialog", { name: "Dupliquer « Atlas »" });
    expect((screen.getByLabelText("Nom") as HTMLInputElement).value).toBe("Atlas (copie)");
    expect((screen.getByLabelText("Rôle") as HTMLInputElement).value).toBe("Veille");
    // The source's persona goes out as is, without a field to edit it here.
    expect(screen.queryByRole("textbox", { name: "Persona" })).toBeNull();
    expect(screen.queryByLabelText("Mission")).toBeNull();
    fireEvent.click(createButton());
    await waitFor(() => expect(createdBodies).toHaveLength(1));
    expect(createdBodies[0]).toMatchObject({
      name: "Atlas (copie)",
      instructions: "# Atlas\n\nCite tes sources.",
      description: "Recherche longue et détaillée",
      label: "Veille",
      model: "claude-sonnet-4",
      replyLanguage: "fr",
      notifyOnFinish: true,
      permissionMode: "manual",
      greet: false,
    });
    expect(createdBodies[0]!.hermesProfile).toBeUndefined();
  });

  test("sans profile_management, un profil neuf et distinct de la source est exigé avant Créer", async () => {
    serveRuntime([]);
    renderApp("sheet", source);
    await screen.findByRole("dialog", { name: "Dupliquer « Atlas »" });
    const required = "Saisissez explicitement un nouveau profil Hermes pour ce clone.";
    expect(await screen.findByText(required)).toBeTruthy();
    expect((createButton() as HTMLButtonElement).disabled).toBe(true);
    const field = await screen.findByLabelText("Nouveau profil Hermes");

    fireEvent.change(field, { target: { value: " atlas " } });
    expect(await screen.findByText("Le nouveau profil doit être distinct du profil actuel.")).toBeTruthy();
    expect((createButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(createButton());
    fireEvent.keyDown(screen.getByLabelText("Nom"), { key: "Enter" });
    expect(createdBodies).toHaveLength(0);

    fireEvent.change(field, { target: { value: "atlas-2" } });
    await waitFor(() => expect((createButton() as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(required)).toBeNull();
    fireEvent.click(createButton());
    await waitFor(() => expect(createdBodies).toHaveLength(1));
    expect(createdBodies[0]).toMatchObject({ name: "Atlas (copie)", hermesProfile: "atlas-2" });
  });

  test("le modèle annoncé pour une copie est celui de la source, pas celui du runtime", async () => {
    serveRuntime(["profile_management"]);
    renderApp("sheet", source);
    await screen.findByRole("dialog", { name: "Dupliquer « Atlas »" });
    const promise = await screen.findByText(/Il travaillera sur votre serveur Hermes/);
    expect(promise.textContent).toContain("claude-sonnet-4");
    expect(promise.textContent).not.toContain("gpt-runtime");
  });

  // The runner ignores a bot's model under global assignment: the copy runs the runtime's.
  test("sous attribution globale, une copie annonce le modèle du runtime", async () => {
    serveRuntime(["profile_management"], "global");
    renderApp("sheet", source);
    await screen.findByRole("dialog", { name: "Dupliquer « Atlas »" });
    await waitFor(async () => {
      const promise = await screen.findByText(/Il travaillera sur votre serveur Hermes/);
      expect(promise.textContent).toContain("gpt-runtime");
      expect(promise.textContent).not.toContain("claude-sonnet-4");
    });
  });

  test("une source sans modèle propre annonce toujours le modèle du runtime", async () => {
    serveRuntime(["profile_management"]);
    renderApp("sheet", { ...source, model: null });
    await screen.findByRole("dialog", { name: "Dupliquer « Atlas »" });
    const promise = await screen.findByText(/Il travaillera sur votre serveur Hermes/);
    expect(promise.textContent).toContain("gpt-runtime");
  });

  test("un nouveau modèle encore en vérification est annoncé, puis l'avertissement s'en va", async () => {
    let proving = true;
    serveRuntime(["profile_management"], "per_bot", () => proving ? {
      status: "running", provider: "anthropic", model: "claude-fable-5.1", reasoningEffort: null,
      requestedAt: "2026-10-26T08:00:00.000Z", attempts: 1, nextAttemptAt: null, error: null,
    } : null);
    renderApp("sheet");
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    const promise = await screen.findByText(/Il travaillera sur votre serveur Hermes/);
    await waitFor(() => expect(promise.textContent).toContain("claude-fable-5.1 est encore en vérification"));
    expect(promise.textContent).toContain("il répondra avec gpt-runtime");
    proving = false;
    // La feuille relit la configuration toutes les 2 s tant que la preuve court.
    await waitFor(() => expect(promise.textContent).not.toContain("en vérification"), { timeout: 4_000 });
  });

  test("une copie qui garde son propre modèle ne parle pas de la vérification du runtime", async () => {
    serveRuntime(["profile_management"], "per_bot", () => ({
      status: "queued", provider: "anthropic", model: "claude-fable-5.1", reasoningEffort: null,
      requestedAt: "2026-10-26T08:00:00.000Z", attempts: 0, nextAttemptAt: null, error: null,
    }));
    renderApp("sheet", source);
    await screen.findByRole("dialog", { name: "Dupliquer « Atlas »" });
    const promise = await screen.findByText(/Il travaillera sur votre serveur Hermes/);
    expect(promise.textContent).toContain("claude-sonnet-4");
    expect(promise.textContent).not.toContain("en vérification");
  });

  test("le store ouvre la feuille de duplication depuis n'importe où", async () => {
    renderApp("host");
    useBotDialogs.getState().openCreate(source);
    expect(await screen.findByRole("dialog", { name: "Dupliquer « Atlas »" })).toBeTruthy();
  });
});

describe("the desktop home creates a bot on the page (OpenBot's home)", () => {
  test("an empty roster titles the form « first bot »; a loaded one does not", async () => {
    const original = globalThis.fetch;
    let resolveRoster!: (response: Response) => void;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/bots") && !init?.method) {
        return new Promise<Response>((resolve) => { resolveRoster = resolve; });
      }
      return original(input, init);
    }) as typeof fetch;
    renderApp("home");
    // Only a successful roster proves emptiness.
    expect(await screen.findByRole("form", { name: "Créez un bot" })).toBeTruthy();
    await waitFor(() => expect(resolveRoster).toBeDefined());
    resolveRoster(Response.json({ bots: [], groups: [], sections: [] }));
    expect(await screen.findByRole("form", { name: "Créez votre premier bot" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Le salon est calme." })).toBeNull();
  });

  test("a color tints every face; the name is required", async () => {
    renderApp("home");
    const red = await screen.findByRole("button", { name: "Couleur du bot : rouge" });
    expect(screen.getByRole("button", { name: "Couleur automatique du bot" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(red);
    expect(red.getAttribute("aria-pressed")).toBe("true");
    const create = screen.getByRole("button", { name: "Créer le bot" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/^Nom/), { target: { value: "   " } });
    expect(create.disabled).toBe(true);
  });

  test("a suggestion fills the form, and « Créer le bot » sends ONE request then opens the waiting screen", async () => {
    renderApp("home");
    fireEvent.click(await screen.findByRole("button", { name: /^Assistant e-mail\./ }));
    expect((screen.getByLabelText(/^Nom/) as HTMLInputElement).value).toBe("Assistant e-mail");
    expect((screen.getByLabelText("En quoi ce bot doit-il vous aider ?") as HTMLTextAreaElement).value)
      .toContain("Rédiger des réponses claires");
    expect(screen.getByRole("button", { name: "Couleur du bot : magenta" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Créer le bot" }));
    await waitFor(() => expect(createdBodies).toHaveLength(1));
    const body = createdBodies[0]!;
    expect(body.name).toBe("Assistant e-mail");
    expect(String(body.mission)).toContain("Rédiger des réponses claires");
    expect(body.face).toEqual({ shape: "triangle", eyes: "mefiant", palette: "rose" });
    expect(String(body.clientRequestId)).toMatch(UUID);
    expect(body.greet).toBe(true);
    // No model picked: the bot follows the runtime's model.
    expect("model" in body).toBe(false);
    await waitFor(() => expect(currentPath).toBe("/bot/bot-new"));
  });

  test("the home has no « Options avancées »: the safe defaults go out with the composed job sheet", async () => {
    renderApp("home");
    fireEvent.click(await screen.findByRole("button", { name: /^Assistant e-mail\./ }));
    expect(screen.queryByRole("button", { name: /Options avancées/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Créer le bot" }));
    await waitFor(() => expect(createdBodies).toHaveLength(1));
    const body = createdBodies[0]!;
    expect(body).toMatchObject({ permissionMode: "manual", notifyOnFinish: true, greet: true });
    expect(body.instructions).toBe(resolveCreateInstructions({ name: "Assistant e-mail", mission: String(body.mission) }));
    expect(body.hermesProfile).toBeUndefined();
    // No first routine to open once the bot exists.
    await waitFor(() => expect(currentPath).toBe("/bot/bot-new"));
    expect(useBotDialogs.getState().routineBot).toBeFalsy();
  });
});

describe("« + » on the desktop", () => {
  test("goes to the home, like the rail's home button, instead of opening the sheet", async () => {
    const { useNewBot } = await import("../../../src/lib/bots/use-new-bot");
    function Plus() {
      const openNew = useNewBot();
      return <button type="button" onClick={openNew}>plus</button>;
    }
    const rootRoute = createRootRoute({ component: () => <><Plus /><Outlet /></> });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <p>home</p> });
    const botRoute = createRoute({ getParentRoute: () => rootRoute, path: "/bot/$botId", component: () => <p>bot</p> });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, botRoute]),
      history: createMemoryHistory({ initialEntries: ["/bot/atlas"] }),
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "plus" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(useBotDialogs.getState().createOpen).toBe(false);
  });
});
