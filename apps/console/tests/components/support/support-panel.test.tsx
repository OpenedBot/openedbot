import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@openedbot/browser-ui-kit/theme";
import { I18nProvider } from "../../../src/lib/i18n";
import { SupportPanel } from "../../../src/components/support/support-panel";

const realFetch = globalThis.fetch;

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };

let calls: Call[] = [];
/** Réponse de `POST /api/support/conversations`, réglée par chaque test. */
let openReply: { status: number; body: unknown } = { status: 201, body: null };
/** Réponse de `GET /api/support/conversations` : l'historique du visiteur. */
let historyReply: { conversations: unknown[] } = { conversations: [] };
/** Les fils que `GET /api/support/conversations/:id` sait rendre. */
let threads: Record<string, unknown> = {};

function href(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function snapshot(messages: unknown[] = [], conversationId = "11111111-1111-4111-8111-111111111111") {
  return {
    conversationId,
    email: "visiteur@example.test",
    status: "open",
    messages,
    cursor: 5,
    unreadCount: 0,
    createdAt: "2026-09-12T08:00:00.000Z",
    updatedAt: "2026-09-12T08:00:00.000Z",
  };
}

/** Une ligne d'historique, telle que la rend `GET /api/support/conversations`. */
function summary(conversationId: string, over: Record<string, unknown> = {}) {
  return {
    conversationId,
    status: "open",
    unreadCount: 0,
    cursor: 5,
    messageCount: 1,
    lastMessageAuthor: "guest",
    lastMessagePreview: "un fil précédent",
    lastMessageAt: "2026-09-12T08:00:00.000Z",
    createdAt: "2026-09-12T08:00:00.000Z",
    updatedAt: "2026-09-12T08:00:00.000Z",
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Un flux qui reste ouvert : la boucle de reconnexion s'y installe. */
function idleStream(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": connected\n\n"));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
  calls = [];
  historyReply = { conversations: [] };
  threads = {};
  openReply = { status: 201, body: { conversationId: snapshot().conversationId, token: "jeton-de-test-assez-long-0123456789", snapshot: snapshot() } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = href(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (url.includes("/events")) return idleStream();
    if (url.endsWith("/api/support/conversations") && method === "GET") {
      return json(historyReply);
    }
    const thread = /\/api\/support\/conversations\/([0-9a-f-]{36})$/.exec(url);
    if (thread && method === "GET") {
      const found = threads[thread[1] as string];
      return found ? json(found) : new Response(null, { status: 404 });
    }
    if (url.endsWith("/api/support/conversations") && method === "POST") {
      // Un corps accompagne l'ouverture : le fil rendu porte donc déjà ce
      // message, comme le fait la route.
      const sent = init?.body ? (JSON.parse(String(init.body)) as { body?: string }) : {};
      const body = openReply.status === 201 && sent.body
        ? {
            ...(openReply.body as Record<string, unknown>),
            snapshot: snapshot([
              { id: "m-1", author: "guest", staffName: null, body: sent.body, attachments: [], createdAt: "2026-09-12T08:01:00.000Z" },
            ]),
          }
        : openReply.body;
      return new Response(JSON.stringify(body), {
        status: openReply.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/messages")) {
      return new Response(
        JSON.stringify(snapshot([
          { id: "m-1", author: "guest", staffName: null, body: "mon runtime ne se connecte pas", attachments: [], createdAt: "2026-09-12T08:01:00.000Z" },
        ])),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

/**
 * Un routeur minimal est OBLIGATOIRE : le panneau lit le chemin courant pour
 * savoir si la coque mobile compense déjà le clavier
 * (`isMobileShellPath`), et `useRouterState` jette hors d'un
 * `RouterProvider`.
 */
/** Le miroir local de session, celui que lit `readCloudSession`. */
function signIn(): void {
  window.localStorage.setItem(
    "ohb:cloud-session",
    JSON.stringify({ organizationId: "99999999-9999-4999-8999-999999999999", csrfToken: "csrf-de-test" }),
  );
}

async function renderPanel(
  initialPath = "/",
  options: { identified?: boolean; panel?: ComponentProps<typeof SupportPanel> } = {},
) {
  // `DEFAULT_LOCALE` est l'anglais : sans ce réglage, l'écran se rend en
  // anglais et les libellés attendus ici ne s'y trouvent pas. Même préambule
  // que `tests/screens/public/waitlist.test.tsx`.
  window.localStorage.setItem("ohb:locale", "fr");
  if (options.identified) signIn();
  const panel = options.panel ?? { onClose: () => {} };
  const rootRoute = createRootRoute({
    component: () => <SupportPanel {...panel} />,
  });
  const anyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([anyRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <RouterProvider router={router as never} />
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  // Le routeur monte son arbre sur un tick : sans cette attente, le corps du
  // document est encore vide au premier `getBy…`.
  await waitFor(() => {
    expect(
      options.identified
        ? screen.getByPlaceholderText("Écrire un message")
        : screen.getByLabelText("Votre adresse e-mail"),
    ).toBeTruthy();
  });
}

describe("la porte e-mail du guichet", () => {
  test("l’adresse est demandée avant d’écrire, et le bouton reste inerte à vide", async () => {
    await renderPanel();
    expect(screen.getByText("Comment vous répondre ?")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Commencer" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    // Aucun composer tant que l'adresse n'est pas donnée : c'est la porte.
    expect(screen.queryByPlaceholderText("Écrire un message")).toBeNull();
  });

  test("le refus nommé de l’API s’affiche TEL QUEL, pas un message générique", async () => {
    // Le visiteur doit lire ce qu'il a à corriger. Remplacer « domaine
    // jetable » par « une erreur est survenue » lui retire cette information.
    openReply = {
      status: 400,
      body: {
        error: {
          code: "SUPPORT_EMAIL_DISPOSABLE",
          message: "Les adresses jetables ne sont pas acceptées : utilisez une adresse que vous relevez.",
        },
      },
    };
    await renderPanel();
    fireEvent.change(screen.getByLabelText("Votre adresse e-mail"), {
      target: { value: "jetable@mailinator.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commencer" }));
    await waitFor(() => {
      expect(
        screen.getByText("Les adresses jetables ne sont pas acceptées : utilisez une adresse que vous relevez."),
      ).toBeTruthy();
    });
    // La porte reste fermée : rien n'a été ouvert.
    expect(screen.queryByPlaceholderText("Écrire un message")).toBeNull();
  });

  test("une adresse acceptée ouvre le fil, son composer et son flux", async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText("Votre adresse e-mail"), {
      target: { value: "visiteur@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commencer" }));
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Écrire un message")).toBeTruthy();
    });
    expect(screen.getByText("Dites-nous tout")).toBeTruthy();

    const opened = calls.find((call) => call.url.endsWith("/api/support/conversations"));
    expect((opened?.body as { email?: string } | undefined)?.email).toBe("visiteur@example.test");
    // Le flux part avec le jeton en EN-TÊTE et le curseur de l'instantané.
    await waitFor(() => {
      const stream = calls.find((call) => call.url.includes("/events"));
      expect(stream).toBeTruthy();
      expect(stream?.url).toContain("cursor=5");
      expect(stream?.headers["X-OHB-Support-Token"]).toBe("jeton-de-test-assez-long-0123456789");
      expect(stream?.url).not.toContain("jeton-de-test");
    });
  });
});

describe("l’envoi d’un message", () => {
  test("la bulle apparaît AVANT la réponse du serveur, et porte une clé d’idempotence", async () => {
    await renderPanel();
    fireEvent.change(screen.getByLabelText("Votre adresse e-mail"), {
      target: { value: "visiteur@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commencer" }));
    const field = await waitFor(() => screen.getByPlaceholderText("Écrire un message"));

    fireEvent.change(field, { target: { value: "mon runtime ne se connecte pas" } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));

    // Le texte est rendu tout de suite : c'est le geste natif, la bulle ne doit
    // pas attendre l'aller-retour.
    expect(screen.getByText("mon runtime ne se connecte pas")).toBeTruthy();
    // Et il a quitté le composer, sans quoi un second envoi le doublerait.
    expect((field as HTMLTextAreaElement).value).toBe("");

    await waitFor(() => {
      const sent = calls.find((call) => call.url.includes("/messages"));
      expect(sent).toBeTruthy();
      expect((sent?.body as { body?: string } | undefined)?.body).toBe("mon runtime ne se connecte pas");
      expect(sent?.headers["Idempotency-Key"]?.length).toBe(36);
    });
    // Le serveur a confirmé : une seule bulle, pas deux.
    await waitFor(() => {
      expect(screen.getAllByText("mon runtime ne se connecte pas")).toHaveLength(1);
    });
  });
});

describe("l’historique du visiteur", () => {
  test("un opérateur connecté RETROUVE le fil de son compte, sans jeton local", async () => {
    // Le cas qui manquait : aucune session de support dans ce navigateur, et
    // pourtant un fil existe, ouvert depuis une autre machine. C'est la porte
    // COMPTE qui le rend (migration 0078) ; le client n'a donc aucun jeton à
    // poser.
    const id = "22222222-2222-4222-8222-222222222222";
    historyReply = { conversations: [summary(id, { unreadCount: 1 })] };
    threads = {
      [id]: snapshot(
        [{ id: "m-9", author: "staff", staffName: "Elodie", body: "on a trouvé", attachments: [], createdAt: "2026-09-12T08:05:00.000Z" }],
        id,
      ),
    };
    await renderPanel("/", { identified: true });

    await waitFor(() => {
      expect(screen.getByText("on a trouvé")).toBeTruthy();
    });
    const read = calls.find((call) => call.method === "GET" && call.url.endsWith(id));
    expect(read).toBeTruthy();
    expect(read?.headers["X-OHB-Support-Token"]).toBeUndefined();
  });

  test("deux fils : la liste s’ouvre, et un clic ouvre l’ancien", async () => {
    const recent = "22222222-2222-4222-8222-222222222222";
    const older = "33333333-3333-4333-8333-333333333333";
    historyReply = {
      conversations: [
        summary(recent, { lastMessagePreview: "le fil du jour" }),
        summary(older, { status: "closed", lastMessagePreview: "un fil de la semaine dernière" }),
      ],
    };
    threads = {
      [recent]: snapshot([{ id: "m-1", author: "guest", staffName: null, body: "le fil du jour", attachments: [], createdAt: "2026-09-12T08:00:00.000Z" }], recent),
      [older]: snapshot([{ id: "m-2", author: "guest", staffName: null, body: "un fil de la semaine dernière", attachments: [], createdAt: "2026-09-05T08:00:00.000Z" }], older),
    };
    await renderPanel("/", { identified: true });
    await waitFor(() => {
      expect(screen.getByText("le fil du jour")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Mes conversations" }));
    expect(screen.getByText("Vos conversations")).toBeTruthy();
    fireEvent.click(screen.getByText("un fil de la semaine dernière"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Écrire un message")).toBeTruthy();
    });
    expect(calls.some((call) => call.method === "GET" && call.url.endsWith(older))).toBe(true);
  });

  test("un visiteur SANS rien ne demande aucun historique", async () => {
    // La doctrine de la bulle : elle ne doit rien coûter à la page qui la
    // porte. Sans jeton ni session, il n'y a rien à lire.
    await renderPanel();
    expect(calls.filter((call) => call.url.endsWith("/api/support/conversations"))).toHaveLength(0);
  });
});

describe("la page `/support`", () => {
  const recent = "22222222-2222-4222-8222-222222222222";
  const older = "33333333-3333-4333-8333-333333333333";
  const twoThreads = () => {
    historyReply = {
      conversations: [
        summary(recent, { lastMessagePreview: "le fil du jour" }),
        summary(older, { lastMessagePreview: "un fil de la semaine dernière" }),
      ],
    };
    threads = {
      [recent]: snapshot([{ id: "m-1", author: "guest", staffName: null, body: "le fil du jour", attachments: [], createdAt: "2026-09-12T08:00:00.000Z" }], recent),
      [older]: snapshot([{ id: "m-2", author: "guest", staffName: null, body: "un fil de la semaine dernière", attachments: [], createdAt: "2026-09-05T08:00:00.000Z" }], older),
    };
  };

  test("l’URL désigne le fil : c’est lui qui s’ouvre, pas le plus récent", async () => {
    twoThreads();
    await renderPanel("/", { identified: true, panel: { variant: "page", conversationId: older } });
    await waitFor(() => {
      expect(screen.getByText("un fil de la semaine dernière")).toBeTruthy();
    });
    expect(calls.some((call) => call.method === "GET" && call.url.endsWith(recent))).toBe(false);
    // Une page ne se ferme pas : on la quitte en naviguant.
    expect(screen.queryByRole("button", { name: "Fermer le support" })).toBeNull();
  });

  test("sans fil dans l’URL, le plus récent s’ouvre et l’URL le rejoint SANS entrée d’historique", async () => {
    twoThreads();
    const changes: Array<[string | null, boolean]> = [];
    await renderPanel("/", {
      identified: true,
      panel: { variant: "page", onConversationChange: (id, { replace }) => changes.push([id, replace]) },
    });
    await waitFor(() => {
      expect(changes).toContainEqual([recent, true]);
    });
  });

  test("un clic dans la liste est une NAVIGATION : le panneau ne relit pas le fil lui-même", async () => {
    twoThreads();
    const changes: Array<[string | null, boolean]> = [];
    await renderPanel("/", {
      identified: true,
      panel: { variant: "page", conversationId: recent, onConversationChange: (id, { replace }) => changes.push([id, replace]) },
    });
    await waitFor(() => {
      expect(screen.getByText("le fil du jour")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Mes conversations" }));
    fireEvent.click(screen.getByText("un fil de la semaine dernière"));
    expect(changes).toContainEqual([older, false]);
    expect(calls.some((call) => call.method === "GET" && call.url.endsWith(older))).toBe(false);
  });
});

describe("un opérateur déjà connecté", () => {
  test("n’a AUCUNE porte e-mail : le composer est là tout de suite", async () => {
    await renderPanel("/bot/abc", { identified: true });
    expect(screen.queryByText("Comment vous répondre ?")).toBeNull();
    expect(screen.queryByLabelText("Votre adresse e-mail")).toBeNull();
    expect(screen.getByPlaceholderText("Écrire un message")).toBeTruthy();
    // Rien n'est créé à l'ouverture : un clic de curiosité n'avertit pas
    // l'équipe.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("son premier message ouvre le fil, SANS adresse dans le corps", async () => {
    await renderPanel("/bot/abc", { identified: true });
    fireEvent.change(screen.getByPlaceholderText("Écrire un message"), {
      target: { value: "mon runtime ne se connecte pas" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));

    await waitFor(() => {
      const opened = calls.find(
        (call) => call.method === "POST" && call.url.endsWith("/api/support/conversations"),
      );
      expect(opened).toBeTruthy();
      const body = opened?.body as { body?: string; email?: string };
      expect(body.body).toBe("mon runtime ne se connecte pas");
      // L'adresse n'est JAMAIS annoncée par le client : le serveur prend celle
      // du compte, sinon n'importe qui se ferait passer pour un autre.
      expect(body.email).toBeUndefined();
    });
    await waitFor(() => {
      expect(screen.getByText("mon runtime ne se connecte pas")).toBeTruthy();
    });
  });

  test("une session périmée rend la porte e-mail, avec le refus du serveur", async () => {
    // Le miroir local disait « connecté », le serveur dit le contraire. Sans
    // ce repli, l'opérateur verrait une erreur qu'aucun geste ne corrige.
    openReply = {
      status: 400,
      body: {
        error: {
          code: "SUPPORT_EMAIL_REQUIRED",
          message: "Laissez votre adresse e-mail pour qu’on puisse vous répondre.",
        },
      },
    };
    await renderPanel("/bot/abc", { identified: true });
    fireEvent.change(screen.getByPlaceholderText("Écrire un message"), {
      target: { value: "bonjour" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Votre adresse e-mail")).toBeTruthy();
    });
    expect(screen.getByText("Laissez votre adresse e-mail pour qu’on puisse vous répondre.")).toBeTruthy();
  });
});
