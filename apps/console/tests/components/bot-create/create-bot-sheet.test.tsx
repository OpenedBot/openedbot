import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { composePersona, resolveCreateInstructions } from "@openedbot/roster/domain/persona";
import type { BotDto } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../src/lib/i18n";
import { api, queryKeys } from "../../../src/lib/api";
import { CreateBotSheet } from "../../../src/components/bot-create/create-bot-sheet";
import { CreatePersonaSection } from "../../../src/components/bot-create/persona-sheet";
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

/** The job sheet lives in « Options avancées »: unfold it first. */
function openAdvanced() {
  const disclosure = screen.getByRole("button", { name: /Options avancées/ });
  if (disclosure.getAttribute("aria-expanded") === "false") fireEvent.click(disclosure);
}

function personaField(): HTMLTextAreaElement {
  openAdvanced();
  if (!screen.queryByRole("textbox", { name: "Persona" })) {
    const edit = screen.queryByRole("button", { name: "Modifier le texte" });
    if (edit) fireEvent.click(edit);
  }
  return screen.getByRole("textbox", { name: "Persona" }) as HTMLTextAreaElement;
}

function renderPersonaSection(props: { displayed: string; onEdit: (next: string) => void }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <CreatePersonaSection
          id="persona-standalone"
          displayed={props.displayed}
          onEdit={props.onEdit}
          runtimeConnected
          name="Bot de recherche"
        />
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
  openAdvanced();
  fireEvent.click(screen.getByRole("button", { name: "Modifier le texte" }));
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

describe("feuille « Nouveau bot » : identité seule, persona repliée", () => {
  test("à l'ouverture, le focus est dans le champ Nom", async () => {
    renderApp();
    const dialog = await screen.findByRole("dialog", { name: "Nouveau bot" });
    // The desktop header is the sheet's own: its lede still describes the dialog.
    const lede = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(lede?.textContent).toBe("Un nom suffit pour créer. Tout le reste se règle ensuite sur sa page.");
    const name = screen.getByLabelText("Nom");
    await waitFor(() => expect(document.activeElement).toBe(name));
  });

  test("la feuille ouvre directement l'identité, fiche repliée", async () => {
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    expect(screen.queryByRole("list", { name: "Étapes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retour" })).toBeNull();
    expect(screen.getByLabelText("Rôle")).toBeTruthy();
    expect(screen.getByLabelText("Mission")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Laisser le runtime proposer une fiche" })).toBeNull();
    openAdvanced();
    expect(screen.getByRole("button", { name: "Laisser le runtime proposer une fiche" })).toBeTruthy();
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

  test("affiche le gabarit composePersona et le champ reste éditable", async () => {
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    fillIdentity();
    const expected = composePersona({
      name: "Bot de recherche",
      role: "Research",
      mission: "Cite sources and refuse unsourced claims.",
    });
    expect(personaField().value).toBe(expected);
    fireEvent.change(personaField(), { target: { value: "You cite sources." } });
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Bot analyste" } });
    expect(personaField().value).toBe("You cite sources.");
  });

  test("une seule requête porte le bot ET ses réglages, avec un identifiant de demande", async () => {
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    fillIdentity();
    const displayed = personaField().value;
    fireEvent.click(createButton());
    await waitFor(() => expect(createdBodies).toHaveLength(1));
    const body = createdBodies[0]!;
    expect(body.instructions).toBe(displayed);
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
      notifyOnFinish: false,
      greet: true,
      locale: "fr",
    });
    expect(String(body.clientRequestId)).toMatch(UUID);
    expect(patched).toBe(false);
  });

  test("une persona éditée part telle qu'affichée, sans recomposition", async () => {
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    fillIdentity();
    fireEvent.change(personaField(), { target: { value: "You cite sources.\nStay terse." } });
    fireEvent.change(screen.getByLabelText("Mission"), { target: { value: "Ignore this." } });
    fireEvent.click(createButton());
    await waitFor(() => expect(createdBodies).toHaveLength(1));
    expect(createdBodies[0]!.instructions).toBe("You cite sources.\nStay terse.");
  });

  test("les options avancées sont repliées, résumées, et partent dans la même requête", async () => {
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    const disclosure = screen.getByRole("button", { name: /Options avancées/ });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.textContent).toContain("Demander · Se présente");
    expect(screen.queryByRole("radio", { name: /^Revue auto/ })).toBeNull();
    fireEvent.click(disclosure);
    fireEvent.click(screen.getByRole("radio", { name: /^Revue auto/ }));
    fireEvent.click(screen.getByLabelText("Me prévenir quand il a fini un tour"));
    fireEvent.click(screen.getByLabelText("Le laisser se présenter et poser une première question"));
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Atlas" } });
    fireEvent.click(createButton());
    await waitFor(() => expect(createdBodies).toHaveLength(1));
    expect(createdBodies[0]).toMatchObject({ permissionMode: "auto", notifyOnFinish: true, greet: false });
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

  test("Proposer une persona est désactivé sans runtime et n'est pas le CTA", async () => {
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    openAdvanced();
    const propose = screen.getByRole("button", { name: "Laisser le runtime proposer une fiche" });
    expect(propose).toHaveProperty("disabled", true);
    expect(screen.getByText(/Sans runtime connecté/)).toBeTruthy();
  });

  test("avec un runtime, la proposition pré-remplit après confirmation de l'alertdialog", async () => {
    let draftRequested = false;
    serve((url, method) => {
      if (url.includes("/api/runtime") && !url.includes("/api/runtime/profiles")) {
        return Response.json({
          runtime: { id: "rt-1", name: "Hermes", configured: true, lastHealthStatus: "healthy", reachability: "direct", linkFeatures: [] },
          runtimeMode: "external",
          adminMode: "disabled",
          devDefaults: null,
        });
      }
      if (url.includes("/api/persona-drafts") && method === "POST") {
        draftRequested = true;
        return Response.json({ runId: "draft-1" }, { status: 202 });
      }
      if (url.includes("/api/persona-drafts/draft-1")) {
        return Response.json({ status: "completed", draft: "# Bot de recherche\n**Role:** Research\n**Mission:** Cite sources." });
      }
      return null;
    });
    renderApp();
    await screen.findByRole("dialog", { name: "Nouveau bot" });
    fillIdentity();
    const propose = await screen.findByRole("button", { name: "Laisser le runtime proposer une fiche" });
    await waitFor(() => expect(propose).toHaveProperty("disabled", false));
    expect(screen.getByText(/Il travaillera sur votre serveur Hermes/)).toBeTruthy();
    fireEvent.click(propose);
    const alert = await screen.findByRole("alertdialog", { name: "Remplacer la persona ?" });
    expect(draftRequested).toBe(false);
    fireEvent.click(within(alert).getByRole("button", { name: "Remplacer" }));
    // La feuille se referme sur une transition de 150 ms (EXIT_MS, dialog.tsx).
    await new Promise((resolve) => setTimeout(resolve, 300));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(personaField().value).toContain("**Role:** Research"));
    expect(draftRequested).toBe(true);
  });

  test("champ vide : pas de dialogue, la proposition part directement", async () => {
    let draftRequested = false;
    let edited: string | null = null;
    serve((url, method) => {
      if (url.includes("/api/persona-drafts") && method === "POST") {
        draftRequested = true;
        return Response.json({ runId: "draft-1" }, { status: 202 });
      }
      if (url.includes("/api/persona-drafts/draft-1")) return Response.json({ status: "completed", draft: "# Bot de recherche" });
      return null;
    });
    renderPersonaSection({ displayed: "", onEdit: (next) => { edited = next; } });
    fireEvent.click(screen.getByRole("button", { name: "Laisser le runtime proposer une fiche" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(draftRequested).toBe(true));
    await waitFor(() => expect(edited).toBe("# Bot de recherche"));
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
    expect(personaField().value).toBe("# Atlas\n\nCite tes sources.");
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
    fireEvent.click(screen.getByRole("button", { name: /Options avancées/ }));
    const facts = document.querySelector(".ohb-new-bot-runtime-facts")!;
    expect(facts.textContent).toContain("claude-sonnet-4");
    expect(facts.textContent).not.toContain("gpt-runtime");
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

describe("home roster gate", () => {
  test("an empty roster keeps the salon with one call that opens the creation sheet", async () => {
    const original = globalThis.fetch;
    let resolveRoster!: (response: Response) => void;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/bots") && !init?.method) {
        return new Promise<Response>((resolve) => { resolveRoster = resolve; });
      }
      return original(input, init);
    }) as typeof fetch;
    // The call opens the sheet through the store; the app frame mounts its
    // host (`BotDialogsHost`), so the home is rendered with it.
    renderApp("host");
    await screen.findByRole("heading", { name: "Le salon est calme." });
    expect(screen.queryByRole("heading", { name: "Le salon attend son premier bot." })).toBeNull();
    await waitFor(() => expect(resolveRoster).toBeDefined());
    resolveRoster(Response.json({ bots: [], groups: [], sections: [] }));
    await screen.findByRole("heading", { name: "Le salon attend son premier bot." });
    expect(screen.queryByRole("link", { name: "Ouvrir l’inbox →" })).toBeNull();
    // No inline form on the home: the one call opens the same sheet as « + ».
    expect(screen.queryByLabelText("Nom")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Créer un bot" }));
    expect(await screen.findByRole("dialog", { name: "Nouveau bot" })).toBeTruthy();
  });

  test("keeps the existing home when a bot is hidden or the roster fails", async () => {
    const original = globalThis.fetch;
    let rosterRequest = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/bots") && !init?.method) {
        rosterRequest += 1;
        return Response.json({ bots: [{ ...createdBot, hidden: true }], groups: [], sections: [] });
      }
      return original(input, init);
    }) as typeof fetch;
    renderApp("home");
    await waitFor(() => expect(rosterRequest).toBe(1));
    await screen.findByRole("heading", { name: "Le salon est calme." });
    expect(screen.queryByRole("heading", { name: "Le salon attend son premier bot." })).toBeNull();
    cleanup();
    let failed = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/bots") && !init?.method) {
        failed = true;
        return Response.json({ error: "Unavailable" }, { status: 503 });
      }
      return original(input, init);
    }) as typeof fetch;
    renderApp("home");
    await waitFor(() => expect(failed).toBe(true));
    await screen.findByRole("heading", { name: "Le salon est calme." });
    expect(screen.queryByRole("heading", { name: "Le salon attend son premier bot." })).toBeNull();
  });
});
