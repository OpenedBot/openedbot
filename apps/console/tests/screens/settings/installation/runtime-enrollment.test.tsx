import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { I18nProvider } from "../../../../src/lib/i18n";
import { CloudRuntimeSettings } from "../../../../src/screens/settings/installation/cloud";

const realFetch = globalThis.fetch;
let opened = 0;
let openedBodies: Array<Record<string, unknown>> = [];
let statusCalls = 0;
let statusState = "claimed";
let declared: unknown[] = [];

const CONNECTOR_TICKET = {
  enrollmentId: "7d2f5a10-4242-4e2e-9c3a-52f2a5d0c001",
  reachability: "connector",
  endpoint: null,
  runtimeName: "Boîtier atelier",
  ticket: "7d2f5a10-4242-4e2e-9c3a-52f2a5d0c001.s3cr3t-lien",
  command: "edge-setup link --ohb https://api.example.com --yes",
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};

const DEV_CONNECTOR_TICKET = {
  ...CONNECTOR_TICKET,
  command: "edge-setup link --ohb http://127.0.0.1:8790 --yes --insecure-ohb",
};

function stubFetch(ticket = CONNECTOR_TICKET) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/runtime-enrollments/open")) {
      opened += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      openedBodies.push(body);
      return Response.json(ticket, { status: 201 });
    }
    if (url.includes("/api/runtime-enrollments/") && url.includes("/status")) {
      statusCalls += 1;
      return Response.json({
        enrollmentId: url.split("/").at(-2),
        reachability: "connector",
        state: statusState,
        runtimeId: null,
        expiresAt: CONNECTOR_TICKET.expiresAt,
      });
    }
    if (url.includes("/api/runtime/list")) return Response.json({ runtimes: declared });
    if (url.includes("/api/runtime")) {
      return Response.json({ runtime: null, runtimeMode: "external", adminMode: "disabled", devDefaults: null });
    }
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // L'écran porte des liens de routeur : il lui faut un RouterProvider.
  const router = createRouter({
    routeTree: createRootRoute({ component: CloudRuntimeSettings }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouterProvider router={router as never} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

async function openExternalDialog() {
  // Sans runtime déclaré, l'écran s'ouvre sur la section « Runtimes ».
  await waitFor(() => expect(screen.getByRole("button", { name: "Ajouter un runtime" })).toBeTruthy());
}

async function openDraft() {
  await openExternalDialog();
  fireEvent.click(screen.getByRole("button", { name: "Ajouter un runtime" }));
  await waitFor(() => expect(screen.getByLabelText("Nom")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "VPS production" } });
}

function commands(): string[] {
  return screen.getAllByText((_, element) => element?.tagName === "CODE")
    .map((element) => element.textContent ?? "");
}

beforeEach(() => {
  opened = 0;
  openedBodies = [];
  statusCalls = 0;
  statusState = "claimed";
  declared = [];
  window.localStorage.setItem("ohb:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

describe("appairage par lien openedbot d’un runtime", () => {
  test("sélectionne le lien openedbot par défaut sans demander d’accès direct", async () => {
    stubFetch();
    renderSettings();
    await openDraft();

    expect((screen.getByRole("radio", { name: "Lien openedbot (recommandé)" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("radio", { name: /Accès direct/ })).toBeTruthy();
    expect(screen.queryByLabelText("URL Hermes")).toBeNull();
    expect(screen.queryByLabelText("Token Hermes")).toBeNull();
    expect(screen.queryByRole("button", { name: "J’ai déjà le token" })).toBeNull();
  });

  test("n’ouvre pas d’appairage tant que le nom manque", async () => {
    stubFetch();
    renderSettings();
    await openExternalDialog();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter un runtime" }));

    await waitFor(() => expect(screen.getByLabelText("Nom")).toBeTruthy());
    const enrollButton = screen.getByRole("button", { name: "Appairer depuis le serveur" }) as HTMLButtonElement;
    expect(enrollButton.disabled).toBe(true);
    expect(opened).toBe(0);
  });
  // Une machine sans URL publique n'en aura jamais : la voie connector ne
  // réclame que le nom, et le ticket rend la commande de lien, pas un script
  // à télécharger ni une empreinte à comparer.
  test("n’exige pas d’URL et montre la commande de lien", async () => {
    stubFetch();
    renderSettings();
    await openExternalDialog();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter un runtime" }));
    await waitFor(() => expect(screen.getByLabelText("Nom")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Boîtier atelier" } });

    expect(screen.queryByLabelText("URL Hermes")).toBeNull();
    expect(screen.queryByRole("button", { name: "J’ai déjà le token" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Appairer depuis le serveur" }));
    await waitFor(() => expect(opened).toBe(1));
    expect(openedBodies[0]).toEqual({ name: "Boîtier atelier" });
    expect(openedBodies[0]?.url).toBeUndefined();

    await waitFor(() => {
      expect(commands().some((value) => value.includes("edge-setup link"))).toBe(true);
    });
    expect(CONNECTOR_TICKET.command).not.toContain(CONNECTOR_TICKET.ticket);
    expect(screen.getByText("Ticket à coller à l’invite masquée")).toBeTruthy();
    expect(commands().some((value) => value === CONNECTOR_TICKET.ticket)).toBe(true);
    expect(commands().some((value) => value.includes("sha256sum"))).toBe(false);
    expect(commands().some((value) => value.includes("connect.sh"))).toBe(false);
  });

  test("signale la passerelle séparée avant le tunnel de développement", async () => {
    stubFetch(DEV_CONNECTOR_TICKET);
    renderSettings();
    await openDraft();
    fireEvent.click(screen.getByRole("button", { name: "Appairer depuis le serveur" }));

    await waitFor(() => expect(screen.getByText("Ticket à coller à l’invite masquée")).toBeTruthy());
    const dialogText = screen.getByRole("dialog").textContent ?? "";
    expect(dialogText).toContain("make link-dev-up HOST=hermes-admin@<vps>");
    expect(dialogText).not.toContain("make link-gateway");
    expect(dialogText).not.toContain("make link-tunnel");
    expect(dialogText).toContain("démarre automatiquement la passerelle locale");
  });

  // Le ticket meurt en cinq minutes : ce qui sert à l'opérateur est le temps
  // qui reste, pas l'heure de péremption qu'il devait soustraire lui-même.
  test("décompte le temps restant au lieu d’afficher l’heure de péremption", async () => {
    stubFetch();
    renderSettings();
    await openExternalDialog();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter un runtime" }));
    await waitFor(() => expect(screen.getByLabelText("Nom")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Nom"), { target: { value: "Boîtier atelier" } });
    fireEvent.click(screen.getByRole("button", { name: "Appairer depuis le serveur" }));

    const timer = await waitFor(() => screen.getByRole("timer"));
    expect(timer.textContent).toMatch(/^0[45]:\d{2}$/);
    expect(timer.getAttribute("aria-label")).toContain("valable encore");
    const expiryClock = new Date(CONNECTOR_TICKET.expiresAt).toLocaleTimeString();
    expect(screen.queryByText(new RegExp(`jusqu.\\s*${expiryClock}`))).toBeNull();
  });
});

describe("l’appairage est une boîte modale", () => {
  /**
   * Rendu à plat dans la carte, le ticket cohabitait avec le registre : l'écran
   * annonçait un parc vide et, juste dessous, un appairage en cours. Le geste
   * est bloquant, donc il se joue par-dessus, dans la même fenêtre que celle
   * qui a demandé le nom.
   */
  test("le ticket s’ouvre par-dessus l’écran, pas dans la carte du registre", async () => {
    stubFetch();
    renderSettings();
    await openDraft();
    fireEvent.click(screen.getByRole("button", { name: "Appairer depuis le serveur" }));

    // Attendre le TITRE, pas `role="dialog"` : la fenêtre du nom en porte
    // déjà un, et l'assertion passerait avant même la bascule du contenu.
    await waitFor(() => expect(screen.getByText("Appairer Boîtier atelier")).toBeTruthy());
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("Ticket à coller à l’invite masquée");
    // Une seule fenêtre : la saisie du nom a cédé la place, elle ne double pas.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByLabelText("Nom")).toBeNull();
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));
    expect(screen.getByRole("status").textContent).toBe("En attente de la connexion de l’hôte…");
    expect(screen.getByRole("progressbar", { name: "Progression de l’appairage" }).getAttribute("aria-valuenow")).toBe("25");
    // Le décompte et le pied d'attente vivent dans la boîte, pas dans la carte.
    expect(dialog.contains(screen.getByRole("timer"))).toBe(true);
    expect(dialog.contains(screen.getByRole("button", { name: "Fermer" }))).toBe(true);
  });

  test("« Fermer » rend l’écran au registre sans laisser de ticket derrière", async () => {
    stubFetch();
    renderSettings();
    await openDraft();
    fireEvent.click(screen.getByRole("button", { name: "Appairer depuis le serveur" }));
    await waitFor(() => expect(screen.getByRole("timer")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.getByRole("button", { name: "Ajouter un runtime" })).toBeTruthy();
  });
});

describe("fin d’appairage", () => {
  // L'achèvement est l'état de l'enrôlement lui-même (GET /status), pas une
  // URL comparée dans le registre : un runtime connector n'a pas d'URL du tout.
  test("se ferme quand le statut de l’enrôlement passe à completed", async () => {
    statusState = "completed";
    stubFetch();
    renderSettings();
    await openDraft();
    fireEvent.click(screen.getByRole("button", { name: "Appairer depuis le serveur" }));

    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ajouter un runtime" })).toBeTruthy());
    expect(screen.queryByText("Commande d’appairage")).toBeNull();
  });
});
