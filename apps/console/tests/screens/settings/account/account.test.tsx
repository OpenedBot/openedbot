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
import type { OrganizationMemberDto, WorkspaceRole } from "@openedbot/contracts-api";
import { I18nProvider } from "../../../../src/lib/i18n";
import { AccountSettings } from "../../../../src/screens/settings/account/account";

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
type Options = {
  role?: WorkspaceRole;
  organizationId?: string;
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
        workspaces: [{
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
      if (method === "GET") return Response.json({ invitations: [], truncated: false });
      if (method === "POST") {
        return Response.json(
          { id: "inv-1", email: body?.email, role: body?.role, status: "pending", expiresAt: "2026-09-12T09:00:00.000Z" },
          { status: 201 },
        );
      }
    }
    if (url.includes("/api/operator")) return Response.json({ operator: { username: "elodie", updatedAt: "2026-03-01T09:00:00.000Z" } });
    throw new Error(`Route inattendue : ${method} ${url}`);
  }) as unknown as typeof fetch;
  return calls;
}

function renderSettings(component: FunctionComponent, path: string, organizationId = "org-1") {
  window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId, csrfToken: "csrf", userId: `account-test-${++sessionSequence}` }));
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
  window.localStorage.setItem("openedbot:locale", "fr");
  window.localStorage.setItem("openedbot:cloud-session", JSON.stringify({ organizationId: "org-1", csrfToken: "csrf" }));
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("Mon compte", () => {
  // `GET /api/auth/me` has served the workspace and the role from the start; the client
  // discarded them, and no screen said which organization one writes in.
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

  // The row is editable in place: « Enregistrer » exists only once the
  // value has changed, and the preview states the NORMALIZED handle before sending.
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

  test("le propriétaire invite un membre dans son espace", async () => {
    const calls = stubFetch();
    renderAccount();
    expect(await screen.findByText("Aucune invitation en attente.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Inviter un membre" }));
    fireEvent.change(await screen.findByLabelText("Adresse invitée"), { target: { value: " Camille@Example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer l’invitation" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.includes("/api/organization/invitations"))).toBe(true);
    });
    const sent = calls.find((call) => call.method === "POST" && call.url.includes("/api/organization/invitations"));
    expect(sent?.body).toEqual({ email: "camille@example.com", role: "member", locale: "fr" });
    expect(sent?.organizationId).toBe("org-1");
  });

  test("une liste d’invitations tronquée le dit", async () => {
    stubFetch({
      onRequest: (method, url) => method === "GET" && url.includes("/api/organization/invitations")
        ? Response.json({
          invitations: [{ id: "inv-1", email: "old@example.test", role: "member", status: "pending", expiresAt: "2026-09-12T09:00:00.000Z" }],
          truncated: true,
        })
        : null,
    });
    renderAccount();
    expect(await screen.findByText("old@example.test")).toBeTruthy();
    expect(screen.getByText(/Seules les 1 invitations les plus récentes/)).toBeTruthy();
  });

  test("renvoyer une invitation garde la langue de la console", async () => {
    const pending = { id: "inv-1", email: "old@example.test", role: "member", status: "pending", expiresAt: "2026-09-12T09:00:00.000Z" };
    const calls = stubFetch({
      onRequest: (method, url) => {
        if (!url.includes("/api/organization/invitations")) return null;
        if (method === "GET") return Response.json({ invitations: [pending], truncated: false });
        if (method === "POST" && url.includes("/resend")) return Response.json(pending);
        return null;
      },
    });
    renderAccount();
    fireEvent.click(await screen.findByRole("button", { name: "Renvoyer" }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.includes("/invitations/inv-1/resend"))).toBe(true);
    });
    expect(calls.find((call) => call.url.includes("/resend"))?.body).toEqual({ locale: "fr" });
  });

  test("une adresse mal formée est signalée sans requête", async () => {
    const calls = stubFetch();
    renderAccount();
    fireEvent.click(await screen.findByRole("button", { name: "Inviter un membre" }));
    fireEvent.change(await screen.findByLabelText("Adresse invitée"), { target: { value: "camille@" } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer l’invitation" }));
    expect(await screen.findByText(/Saisissez une adresse e-mail valide/)).toBeTruthy();
    expect(calls.some((call) => call.method === "POST" && call.url.includes("/api/organization/invitations"))).toBe(false);
  });

  test("un membre n’invite pas et ne lit pas les invitations", async () => {
    const calls = stubFetch({ role: "member" });
    renderAccount();
    expect(await screen.findByText("sam@example.test")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Inviter un membre" })).toBeNull();
    expect(calls.some((call) => call.url.includes("/api/organization/invitations"))).toBe(false);
  });

  // Removing someone from a workspace is irreversible from this screen: the
  // confirmation names the person before the DELETE goes out.
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

  // The Google link and whether a password exists are FACTS served by
  // `GET /api/account/security`, never inferred from the address.
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

  // Unlinking Google without a password would leave the account with no way in: the
  // button stays visible, disabled, and the row says why.
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

  // Google opens outside the window; the page polls the attempt until the outcome.
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

  // The rule is shared with the API (`passwordProblem`): the button stays
  // closed until the three requirements are satisfied.
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

  // The requirements list is the LIVE feedback of typing: each
  // character rejudges it, and `data-ok` carries the verdict.
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

    // Confirmation is a rule like the others: it checks when the
    // two entries meet, without waiting for the submit.
    fireEvent.change(confirmField!, { target: { value: "DouzeCaracter" } });
    await waitFor(() => expect(rule("Les deux saisies correspondent")).toBe(false));
    fireEvent.change(confirmField!, { target: { value: "DouzeCaracter!" } });
    await waitFor(() => expect(rule("Les deux saisies correspondent")).toBe(true));
  });

  // `requireRole` already refuses: a button that goes out as a 403 is a polite lie.
  test("un membre lit sans commande d’écriture", async () => {
    stubFetch({ role: "member" });
    renderAccount();
    expect(await screen.findByText("Membres")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retirer" })).toBeNull();
    expect(screen.getByText("Votre rôle ne permet pas de gérer les membres. Un owner ou un admin peut le faire.")).toBeTruthy();
  });
});
