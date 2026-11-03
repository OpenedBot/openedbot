import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FunctionComponent } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { AccountWorkspace, OrganizationMemberDto, WorkspaceRole } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../../src/lib/i18n";
import {
  AccountProfileSettings,
  AccountSettings,
} from "../../../../src/screens/settings/account/account";
import { OrganizationTeamSettings } from "../../../../src/screens/settings/account/team";

const realFetch = globalThis.fetch;
let sessionSequence = 0;

const OWNER: OrganizationMemberDto = {
  userId: "u-owner",
  email: "elodie@example.test",
  displayName: "Élodie",
  role: "owner",
  createdAt: "2026-01-04T09:00:00.000Z",
};
const MEMBER: OrganizationMemberDto = {
  userId: "u-member",
  email: "sam@example.test",
  displayName: null,
  role: "member",
  createdAt: "2026-02-11T09:00:00.000Z",
};
const FLEET_ID = "agency-uuid";
const CLIENT_ID = "client-uuid";
const FLEET_WORKSPACE: AccountWorkspace = {
  id: FLEET_ID,
  name: "Agence",
  slug: "agence",
  role: "owner",
  kind: "agency",
};
const CLIENT_WORKSPACE: AccountWorkspace = {
  id: CLIENT_ID,
  name: "Client",
  slug: "client",
  role: "agency",
  kind: "personal",
  viaAgencyIds: [FLEET_ID],
};

type Options = {
  role?: WorkspaceRole;
  organizationId?: string;
  agencyAvailable?: boolean;
  workspaces?: AccountWorkspace[];
  members?: OrganizationMemberDto[];
  method?: { email: string; password: boolean; google: boolean };
  googleProvider?: { enabled: true } | { enabled: false; reason: "not_configured" | "origin_unsupported" };
  onRequest?: (method: string, url: string, body: unknown) => Response | null;
};

function stubFetch(options: Options = {}) {
  const calls: Array<{ method: string; url: string; body: unknown; organizationId: string | null }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const organizationId = new Headers(init?.headers).get("X-OpenedBot-Organization");
    calls.push({ method, url, body, organizationId });
    const custom = options.onRequest?.(method, url, body);
    if (custom) return custom;
    if (url.includes("/api/auth/me")) {
      return Response.json({
        user: { id: OWNER.userId, email: OWNER.email, displayName: OWNER.displayName },
        organization: { id: options.organizationId ?? "org-1", slug: "acme", name: "Acme" },
        role: options.role ?? "owner",
      });
    }
    if (url.includes("/api/account/workspaces")) {
      const organizationId = options.organizationId ?? "org-1";
      return Response.json({
        userId: OWNER.userId,
        agencyAvailable: options.agencyAvailable ?? false,
        workspaces: options.workspaces ?? [{
          id: organizationId,
          name: "Acme",
          slug: "acme",
          role: options.role ?? "owner",
          kind: "personal",
        }],
      });
    }
    if (url.includes("/api/auth/providers")) {
      return Response.json({
        google: options.googleProvider ?? { enabled: true },
        password: { enabled: true },
        waitlist: { required: false },
      });
    }
    if (url.includes("/api/account/security")) {
      if (method === "POST") return Response.json({ revokedOtherSessions: 2 });
      return Response.json({
        method: options.method ?? { email: OWNER.email, password: true, google: true },
        sessions: [],
      });
    }
    if (url.includes("/api/organization/members")) {
      if (method === "GET") return Response.json({ members: options.members ?? [OWNER, MEMBER] });
      if (method === "PATCH") return Response.json({ userId: MEMBER.userId, role: body?.role });
      if (method === "DELETE") return new Response(null, { status: 204 });
    }
    if (url.includes("/api/organization/invitations")) {
      return Response.json(
        { id: "inv-1", email: body?.email, role: body?.role, token: "ohbi_secret", expiresAt: "2026-09-12T09:00:00.000Z" },
        { status: 201 },
      );
    }
    if (url.includes("/api/operator")) return Response.json({ operator: { username: "elodie", updatedAt: "2026-03-01T09:00:00.000Z" } });
    throw new Error(`Route inattendue : ${method} ${url}`);
  }) as unknown as typeof fetch;
  return calls;
}

function renderSettings(component: FunctionComponent, path: string, organizationId = "org-1") {
  window.localStorage.setItem("ohb:cloud-session", JSON.stringify({ organizationId, csrfToken: "csrf", userId: `account-test-${++sessionSequence}` }));
  const rootRoute = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider><RouterProvider router={router as never} /></I18nProvider>
    </QueryClientProvider>,
  );
}

function renderAccount() {
  renderSettings(AccountSettings, "/settings/account");
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.setItem("ohb:locale", "fr");
  window.localStorage.setItem("ohb:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: "csrf" }));
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("Mon compte", () => {
  // `GET /api/auth/me` sert l'espace et le rôle depuis l'origine ; le client
  // les jetait, et aucun écran ne disait dans quelle organisation on écrit.
  test("dit l’identité de la session : adresse, espace et rôle", async () => {
    stubFetch();
    renderAccount();
    expect(await screen.findByText("elodie@example.test")).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText("acme")).toBeTruthy();
    expect(screen.getAllByText("Propriétaire").length).toBeGreaterThan(0);
  });

  test("profil, connexion, espace et membres vivent sur la même page", async () => {
    stubFetch();
    renderAccount();
    expect(await screen.findByRole("heading", { name: "Profil" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connexion" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Espace de travail" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Membres" })).toBeTruthy();
    expect(await screen.findByRole("textbox", { name: "Nom d’utilisateur" })).toBeTruthy();
    expect(screen.getByText("2 membres")).toBeTruthy();
    expect(screen.getByText("sam@example.test")).toBeTruthy();
  });

  // La ligne est éditable sur place : « Enregistrer » n'existe qu'une fois la
  // valeur changée, et l'aperçu dit le handle NORMALISÉ avant l'envoi.
  test("le nom d’utilisateur se change dans sa ligne", async () => {
    const calls = stubFetch();
    renderAccount();
    const field = await screen.findByRole<HTMLInputElement>("textbox", { name: "Nom d’utilisateur" });
    await waitFor(() => expect(field.value).toBe("elodie"));
    expect(screen.queryByRole("button", { name: "Enregistrer" })).toBeNull();

    fireEvent.change(field, { target: { value: "Élodie Dev" } });
    expect(await screen.findByText("Vos bots vous appelleront @elodie-dev.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method !== "GET" && call.url.includes("/api/operator"))).toBe(true);
    });
    expect(calls.find((call) => call.method !== "GET" && call.url.includes("/api/operator"))?.body)
      .toEqual({ username: "elodie-dev" });
  });

  test("le rôle d’un membre se change : l’owner reste hors d’atteinte", async () => {
    const calls = stubFetch();
    renderAccount();
    const trigger = await screen.findByRole("combobox", { name: "Rôle de sam@example.test" });
    expect(screen.queryByRole("combobox", { name: "Rôle de Élodie" })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("option", { name: "Administrateur" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "PATCH" && call.url.includes("/members/u-member"))).toBe(true);
    });
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ role: "admin" });
  });

  test("l’écran ne propose plus d’inviter un membre", async () => {
    stubFetch();
    renderAccount();
    expect(await screen.findByText("Membres")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Créer une invitation" })).toBeNull();
    expect(screen.queryByPlaceholderText("email@example.com")).toBeNull();
  });

  // Retirer quelqu'un d'un espace est irréversible depuis cet écran : la
  // confirmation nomme la personne avant que le DELETE ne parte.
  test("le retrait passe par une confirmation nommée", async () => {
    const calls = stubFetch();
    renderAccount();
    fireEvent.click(await screen.findByRole("button", { name: "Retirer" }));

    expect(await screen.findByText("Retirer ce membre ?")).toBeTruthy();
    expect(screen.getByText(/sam@example\.test perdra l’accès/)).toBeTruthy();
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Retirer le membre" }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/members/u-member"))).toBe(true);
    });
  });

  // Le lien Google et l'existence d'un mot de passe sont des FAITS servis par
  // `GET /api/account/security`, jamais déduits de l'adresse.
  test("dit par où le compte se connecte", async () => {
    stubFetch();
    renderAccount();
    expect(await screen.findByText("Google SSO")).toBeTruthy();
    expect(screen.getByText("Connecté")).toBeTruthy();
    expect(screen.getByText("Défini")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Changer le mot de passe" })).toBeTruthy();
  });

  test("un compte SSO seul n’a pas de mot de passe à changer", async () => {
    stubFetch({ method: { email: OWNER.email, password: false, google: true } });
    renderAccount();
    expect(await screen.findByText("Aucun")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Changer le mot de passe" })).toBeNull();
    expect(screen.getByText("Ce compte se connecte uniquement avec Google : il n’a pas de mot de passe à changer.")).toBeTruthy();
  });

  // Délier Google sans mot de passe laisserait le compte sans entrée : le
  // bouton reste visible, grisé, et la ligne dit pourquoi.
  test("Google ne se délie pas d’un compte sans mot de passe", async () => {
    stubFetch({ method: { email: OWNER.email, password: false, google: true } });
    renderAccount();
    const disconnect = await screen.findByRole("button", { name: "Déconnecter Google SSO" });
    expect((disconnect as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Définissez un mot de passe avant de délier Google : ce serait la seule entrée du compte."),
    ).toBeTruthy();
  });

  test("Google se délie avec le mot de passe actuel", async () => {
    let security = { email: OWNER.email, password: true, google: true };
    const calls = stubFetch({
      onRequest: (method, url) => {
        if (url.includes("/security/google/unlink") && method === "POST") {
          security = { ...security, google: false };
          return Response.json({ revokedOtherSessions: 1 });
        }
        if (url.includes("/api/account/security") && method === "GET") {
          return Response.json({ method: security, sessions: [] });
        }
        return null;
      },
    });
    renderAccount();
    fireEvent.click(await screen.findByRole("button", { name: "Déconnecter Google SSO" }));
    const field = await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>("#account-google-unlink-password");
      expect(input).toBeTruthy();
      return input!;
    });
    fireEvent.change(field, { target: { value: "Correct-Horse-Battery" } });
    fireEvent.click(document.querySelector<HTMLButtonElement>('button[form="account-google-unlink-form"]')!);

    await waitFor(() => {
      const unlink = calls.find((call) => call.url.includes("/security/google/unlink"));
      expect(unlink?.body).toEqual({ currentPassword: "Correct-Horse-Battery" });
    });
    expect(await screen.findByText("Google est délié de votre compte.")).toBeTruthy();
    expect(await screen.findByText("Non connecté")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connecter Google SSO" })).toBeTruthy();
  });

  // Google s'ouvre hors de la fenêtre ; la page sonde la tentative jusqu'à l'issue.
  test("Google se lie depuis la ligne, puis la page sonde l’issue", async () => {
    let security = { email: OWNER.email, password: true, google: false };
    const tab ={ opener: {}, location: { href: "" }, close: () => undefined };
    const realOpen = window.open;
    window.open = (() => tab) as unknown as typeof window.open;
    try {
      const calls = stubFetch({
        onRequest: (method, url) => {
          if (url.includes("/security/google/link/start")) {
            return Response.json({ attemptId: "attempt-1", authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
          }
          if (url.includes("/security/google/link/claim")) {
            security = { ...security, google: true };
            return Response.json({ status: "done" });
          }
          if (url.includes("/api/account/security") && method === "GET") {
            return Response.json({ method: security, sessions: [] });
          }
          return null;
        },
      });
      renderAccount();
      fireEvent.click(await screen.findByRole("button", { name: "Connecter Google SSO" }));
      await waitFor(() => expect(tab.location.href).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1"));
      expect(tab.opener).toBeNull();
      expect(
        await screen.findByText("Terminez dans la page Google ouverte dans votre navigateur, puis revenez ici."),
      ).toBeTruthy();

      expect(await screen.findByText("Google est lié à votre compte.", undefined, { timeout: 4_000 })).toBeTruthy();
      expect(calls.find((call) => call.url.includes("/link/claim"))?.body).toEqual({ attemptId: "attempt-1" });
      expect(await screen.findByText("Connecté")).toBeTruthy();
    } finally {
      window.open = realOpen;
    }
  });

  test("Connecter est grisé, avec la raison, quand Google est désactivé", async () => {
    stubFetch({
      method: { email: OWNER.email, password: true, google: false },
      googleProvider: { enabled: false, reason: "not_configured" },
    });
    renderAccount();
    await waitFor(() => {
      const connect = screen.getByRole("button", { name: "Connecter Google SSO" }) as HTMLButtonElement;
      expect(connect.disabled).toBe(true);
    });
    expect(screen.getByText(/Le SSO Google n’est pas configuré sur cet environnement/)).toBeTruthy();
  });

  // La règle est partagée avec l'API (`passwordProblem`) : le bouton reste
  // fermé tant que les trois exigences ne sont pas satisfaites.
  test("la modale de mot de passe tient les trois règles avant d’envoyer", async () => {
    const calls = stubFetch();
    renderAccount();
    fireEvent.click(await screen.findByRole("button", { name: "Changer le mot de passe" }));

    const fields = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'));
    await waitFor(() => expect(fields().length).toBe(3));
    const [currentField, nextField, confirmField] = fields();

    fireEvent.change(currentField!, { target: { value: "Old-Password-123" } });
    fireEvent.change(nextField!, { target: { value: "toutenminuscules1" } });
    fireEvent.change(confirmField!, { target: { value: "toutenminuscules1" } });
    const dialogSubmit = document.querySelector<HTMLButtonElement>('button[form="account-password-form"]')!;
    await waitFor(() => expect(dialogSubmit.disabled).toBe(true));
    expect(calls.some((call) => call.url.includes("/security/password"))).toBe(false);

    fireEvent.change(nextField!, { target: { value: "Brand-New-Password-1" } });
    fireEvent.change(confirmField!, { target: { value: "Brand-New-Password-1" } });
    await waitFor(() => expect(dialogSubmit.disabled).toBe(false));
    fireEvent.click(dialogSubmit);

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.includes("/security/password"))).toBe(true);
    });
  });

  // La liste des exigences est le retour EN DIRECT de la frappe : chaque
  // caractère la rejuge, et `data-ok` porte le verdict.
  test("les règles se cochent au fil de la frappe", async () => {
    stubFetch();
    renderAccount();
    fireEvent.click(await screen.findByRole("button", { name: "Changer le mot de passe" }));
    await waitFor(() => expect(document.querySelectorAll('input[type="password"]').length).toBe(3));
    const [, nextField, confirmField] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    );
    const rule = (label: string) => screen.getByText(label).hasAttribute("data-ok");

    expect(rule("12 caractères minimum")).toBe(false);
    expect(rule("Au moins une majuscule")).toBe(false);
    expect(rule("Au moins un caractère spécial")).toBe(false);
    expect(rule("Les deux saisies correspondent")).toBe(false);

    fireEvent.change(nextField!, { target: { value: "douzecaracter" } });
    await waitFor(() => expect(rule("12 caractères minimum")).toBe(true));
    expect(rule("Au moins une majuscule")).toBe(false);
    expect(rule("Au moins un caractère spécial")).toBe(false);

    fireEvent.change(nextField!, { target: { value: "DouzeCaracter" } });
    await waitFor(() => expect(rule("Au moins une majuscule")).toBe(true));
    expect(rule("Au moins un caractère spécial")).toBe(false);

    fireEvent.change(nextField!, { target: { value: "DouzeCaracter!" } });
    await waitFor(() => expect(rule("Au moins un caractère spécial")).toBe(true));

    // La confirmation est une règle comme les autres : elle se coche quand les
    // deux saisies se rejoignent, sans attendre l'envoi.
    fireEvent.change(confirmField!, { target: { value: "DouzeCaracter" } });
    await waitFor(() => expect(rule("Les deux saisies correspondent")).toBe(false));
    fireEvent.change(confirmField!, { target: { value: "DouzeCaracter!" } });
    await waitFor(() => expect(rule("Les deux saisies correspondent")).toBe(true));
  });

  // `requireRole` refuse déjà : un bouton qui part en 403 est un mensonge poli.
  test("un membre lit sans commande d’écriture", async () => {
    stubFetch({ role: "member" });
    renderAccount();
    expect(await screen.findByText("Membres")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retirer" })).toBeNull();
    expect(screen.getByText("Votre rôle ne permet pas de gérer les membres. Un owner ou un admin peut le faire.")).toBeTruthy();
  });
});

describe("Mon équipe", () => {
  const fleetOptions = (role: Exclude<WorkspaceRole, "agency">): Options => ({
    role,
    organizationId: FLEET_ID,
    agencyAvailable: true,
    workspaces: [
      { ...FLEET_WORKSPACE, role },
      CLIENT_WORKSPACE,
    ],
  });

  for (const role of ["owner", "admin"] as const) {
    test(`${role} gère les membres de son agence active`, async () => {
      const calls = stubFetch(fleetOptions(role));
      renderSettings(OrganizationTeamSettings, "/settings/team", FLEET_ID);

      expect(await screen.findByRole("heading", { name: "Agence" })).toBeTruthy();
      expect(await screen.findByText("sam@example.test")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Créer une invitation" })).toBeNull();
      expect(calls.filter((call) => call.url.includes("/api/organization/members") && call.method === "GET")
        .every((call) => call.organizationId === FLEET_ID)).toBe(true);
    });
  }

  test("un membre lit l’agence active sans commandes d’écriture", async () => {
    const calls = stubFetch(fleetOptions("member"));
    renderSettings(OrganizationTeamSettings, "/settings/team", FLEET_ID);

    expect(await screen.findByText("sam@example.test")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retirer" })).toBeNull();
    expect(calls.filter((call) => call.url.includes("/api/organization/members") && call.method === "GET")
      .some((call) => call.organizationId === FLEET_ID)).toBe(true);
    expect(calls.some((call) => call.method !== "GET" && call.url.includes("/api/organization/"))).toBe(false);
  });

  test("le cadre d’un client d’agence ne lit ni membres ni invitations", async () => {
    const calls = stubFetch({
      role: "agency",
      organizationId: CLIENT_ID,
      agencyAvailable: true,
      workspaces: [FLEET_WORKSPACE, CLIENT_WORKSPACE],
    });
    renderSettings(OrganizationTeamSettings, "/settings/team", CLIENT_ID);

    await waitFor(() => expect(calls.some((call) => call.url.includes("/api/account/workspaces"))).toBe(true));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Client : Client")).toBeTruthy();
    expect(screen.queryByText("sam@example.test")).toBeNull();
    expect(screen.queryByPlaceholderText("email@example.com")).toBeNull();
    expect(calls.some((call) => call.url.includes("/api/organization/members"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/api/organization/invitations"))).toBe(false);
  });

  test("le profil personnel ne monte aucune lecture de membres ou d’invitations", async () => {
    const calls = stubFetch();
    renderSettings(AccountProfileSettings, "/settings/profile");

    expect(await screen.findByRole("textbox", { name: "Nom d’utilisateur" })).toBeTruthy();
    expect(screen.queryByText("Membres")).toBeNull();
    expect(calls.some((call) => call.url.includes("/api/organization/members"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/api/organization/invitations"))).toBe(false);
  });
});
