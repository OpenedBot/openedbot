import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { ThemeProvider } from "@openedbot/browser-ui-kit/theme";
import { I18nProvider } from "../../../src/lib/i18n";
import { readCloudSession } from "../../../src/lib/cloud-session";
import { LoginScreen } from "../../../src/screens/auth/login";

const realFetch = globalThis.fetch;
let reply: Response;
let legalReply: Response;
let passwordLoginReply: Response;

function href(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function renderLogin() {
  const rootRoute = createRootRoute({ component: Outlet });
  const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginScreen });
  const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  const legalRoute = createRoute({ getParentRoute: () => rootRoute, path: "/legal/$slug", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([loginRoute, homeRoute, legalRoute]),
    history: createMemoryHistory({ initialEntries: ["/login"] }),
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <I18nProvider>
          <RouterProvider router={router as never} />
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("ohb:locale", "fr");
  window.localStorage.removeItem("ohb:cloud-session");
  reply = Response.json({ error: { code: "ALPHA_CLOSED", message: "Cette route n’est pas ouverte pendant l’alpha privée." } }, { status: 403 });
  legalReply = Response.json({ documents: [] });
  passwordLoginReply = Response.json({ error: { code: "UNEXPECTED" } }, { status: 500 });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = href(input);
    if (url.endsWith("/api/legal")) return legalReply;
    if (url.endsWith("/api/auth/providers")) return reply;
    if (url.endsWith("/api/auth/login")) return passwordLoginReply;
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("LoginScreen", () => {
  test("affiche la fermeture de l’alpha et masque la connexion", async () => {
    renderLogin();
    expect(await screen.findByRole("heading", { level: 2, name: "Connexion" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Retour à l’accueil" }).getAttribute("href")).toBe("/");
    expect(screen.queryByLabelText("Mot de passe")).toBeNull();
  });

  test("affiche le formulaire quand les fournisseurs répondent normalement", async () => {
    reply = Response.json({ google: { enabled: false, reason: "not_configured" }, password: { enabled: true } });
    renderLogin();
    // L'adresse d'abord : le mot de passe n'apparaît qu'à l'étape suivante.
    await waitFor(() => expect(screen.getByLabelText("Adresse e-mail")).toBeTruthy());
    expect(screen.queryByLabelText("Mot de passe")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Connexion" })).toBeNull();
  });

  // Les comptes semés s'affichent dans le terminal de `make dev`, plus à l'écran.
  test("ne pré-remplit ni ne propose les comptes de développement", async () => {
    reply = Response.json({
      google: { enabled: false, reason: "not_configured" },
      password: { enabled: true },
      devSignIn: { email: "dev@ohb.local", password: "owner-secret" },
      devSignIns: [
        { email: "dev@ohb.local", password: "owner-secret", role: "owner" },
        { email: "agency@ohb.local", password: "agency-secret", role: "agency" },
      ],
    });
    renderLogin();
    const email = await screen.findByLabelText("Adresse e-mail") as HTMLInputElement;
    expect(email.value).toBe("");
    expect(screen.queryByText("agency@ohb.local")).toBeNull();
  });

  // Les pages légales n'ont de lien que si le déploiement en sert vraiment.
  // En production aucune n'a de contenu, et la porte du produit ne doit pas
  // renvoyer vers une page vide.
  test("ne lie aucune page légale quand le catalogue n’en publie aucune", async () => {
    reply = Response.json({ google: { enabled: false, reason: "not_configured" }, password: { enabled: true } });
    renderLogin();
    await screen.findByLabelText("Adresse e-mail");
    expect(screen.queryByRole("link", { name: "Mentions légales" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Confidentialité" })).toBeNull();
  });

  test("lie les seules pages légales que le catalogue publie", async () => {
    reply = Response.json({ google: { enabled: false, reason: "not_configured" }, password: { enabled: true } });
    legalReply = Response.json({
      documents: [
        { slug: "mentions", available: true },
        { slug: "privacy", available: false },
        { slug: "terms", available: true },
      ],
    });
    renderLogin();
    expect(await screen.findByRole("link", { name: "Mentions légales" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Confidentialité" })).toBeNull();
    expect(screen.getByRole("link", { name: "Conditions d’utilisation" })).toBeTruthy();
  });

  test("le mot de passe ouvre l’étape du code sans enregistrer de session", async () => {
    reply = Response.json({ google: { enabled: false, reason: "not_configured" }, password: { enabled: true }, emailCode: { enabled: true } });
    passwordLoginReply = Response.json({ status: "code_required" }, { status: 202 });
    renderLogin();

    const email = await screen.findByLabelText("Adresse e-mail");
    fireEvent.change(email, { target: { value: "member@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));

    const password = await screen.findByLabelText("Mot de passe");
    fireEvent.change(password, { target: { value: "correct-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Se connecter" }));

    expect(await screen.findByRole("textbox", { name: "1 / 6" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Vérifier et continuer" })).toBeTruthy();
    expect(readCloudSession()).toBeNull();
  });
});
