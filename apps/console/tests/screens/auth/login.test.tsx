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
import { readCloudSession } from "../../../src/lib/session/cloud-session";
import { LoginScreen } from "../../../src/screens/auth/login";
import type { NativeAuthBridge, NativeSigninState } from "../../../src/lib/platform/native-bridge";
import { asDesktopBuild } from "../../support/desktop-build";

// These tests drive the desktop app's bridge, which only the desktop build reads.
asDesktopBuild();

const realFetch = globalThis.fetch;
let reply: Response;
let legalReply: Response;
let codeReply: Response;
let verifyReply: Response;
let calls: string[];

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
  window.localStorage.setItem("openedbot:locale", "fr");
  window.localStorage.removeItem("openedbot:cloud-session");
  reply = Response.json({ error: { code: "ALPHA_CLOSED", message: "Cette route n’est pas ouverte pendant l’alpha privée." } }, { status: 403 });
  legalReply = Response.json({ documents: [] });
  codeReply = Response.json({ sent: true });
  verifyReply = Response.json({ error: { code: "EMAIL_LOGIN_CODE_INVALID" } }, { status: 401 });
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = href(input);
    calls.push(new URL(url, "http://localhost").pathname);
    if (url.endsWith("/api/legal")) return legalReply;
    if (url.endsWith("/api/auth/providers")) return reply;
    if (url.endsWith("/api/auth/login/code")) return codeReply;
    if (url.endsWith("/api/auth/login/code/verify")) return verifyReply;
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  delete window.__OPENEDBOT_NATIVE__;
});

const CODE_PROVIDERS = { google: { enabled: false, reason: "not_configured" }, password: { enabled: false }, emailCode: { enabled: true } };

/** Une coque desktop simulée : chaque action pousse ses états, comme la coque Rust. */
function fakeShell(verifyOutcome: NativeSigninState) {
  const listeners = new Set<(state: NativeSigninState) => void>();
  let last: NativeSigninState = { status: "idle" };
  const push = (state: NativeSigninState) => {
    last = state;
    for (const listener of listeners) listener(state);
  };
  const actions: string[] = [];
  const auth: NativeAuthBridge = {
    requestEmailCode: async (email) => {
      actions.push(`code:${email}`);
      queueMicrotask(() => {
        push({ status: "sending" });
        push({ status: "code_sent", email });
      });
    },
    verifyEmailCode: async (email, code) => {
      actions.push(`verify:${email}:${code}`);
      queueMicrotask(() => {
        push({ status: "verifying" });
        push(verifyOutcome);
      });
    },
    startGoogle: async () => {},
    cancel: async () => {},
    onState: (listener) => {
      listeners.add(listener);
      listener(last);
      return () => listeners.delete(listener);
    },
  };
  window.__OPENEDBOT_NATIVE__ = {
    readAccessToken: async () => null,
    refresh: async () => null,
    openExternal: async () => {},
    signOut: async () => {},
    shell: { platform: "windows", version: "test" },
    auth,
  };
  return { actions, push };
}

async function typeCode(digits: string) {
  for (const [index, digit] of [...digits].entries()) {
    fireEvent.change(await screen.findByRole("textbox", { name: `${index + 1} / 6` }), { target: { value: digit } });
  }
}

describe("LoginScreen", () => {
  test("affiche la fermeture de l’alpha et masque la connexion", async () => {
    renderLogin();
    expect(await screen.findByRole("heading", { level: 2, name: "Connexion" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Retour à l’accueil" }).getAttribute("href")).toBe("/");
    expect(screen.queryByLabelText("Mot de passe")).toBeNull();
  });

  test("affiche le formulaire quand les fournisseurs répondent normalement", async () => {
    reply = Response.json({ ...CODE_PROVIDERS, password: { enabled: true } });
    renderLogin();
    // Un seul champ, l'adresse : plus de mot de passe à l'écran, même ouvert côté API.
    await waitFor(() => expect(screen.getByLabelText("Adresse e-mail")).toBeTruthy());
    expect(screen.getByRole("heading", { level: 1, name: "Se connecter à openedbot" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Envoyer le code" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Mot de passe")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Connexion" })).toBeNull();
  });

  // Les comptes semés s'affichent dans le terminal de `make dev`, plus à l'écran.
  test("ne pré-remplit ni ne propose les comptes de développement", async () => {
    reply = Response.json({
      ...CODE_PROVIDERS,
      devSignIn: { email: "dev@openedbot.local", password: "owner-secret" },
      devSignIns: [
        { email: "dev@openedbot.local", password: "owner-secret", role: "owner" },
        { email: "agency@openedbot.local", password: "agency-secret", role: "agency" },
      ],
    });
    renderLogin();
    const email = await screen.findByLabelText("Adresse e-mail") as HTMLInputElement;
    expect(email.value).toBe("");
    expect(screen.queryByText("agency@openedbot.local")).toBeNull();
  });

  // Les pages légales n'ont de lien que si le déploiement en sert vraiment.
  // En production aucune n'a de contenu, et la porte du produit ne doit pas
  // renvoyer vers une page vide.
  test("ne lie aucune page légale quand le catalogue n’en publie aucune", async () => {
    reply = Response.json(CODE_PROVIDERS);
    renderLogin();
    await screen.findByLabelText("Adresse e-mail");
    expect(screen.queryByRole("link", { name: "Mentions légales" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Confidentialité" })).toBeNull();
  });

  test("lie les seules pages légales que le catalogue publie", async () => {
    reply = Response.json(CODE_PROVIDERS);
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

  test("l’adresse envoie un code, et le sixième chiffre le vérifie sans clic", async () => {
    reply = Response.json(CODE_PROVIDERS);
    renderLogin();

    fireEvent.change(await screen.findByLabelText("Adresse e-mail"), { target: { value: " Member@Example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer le code" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Consultez votre boîte de réception" })).toBeTruthy();
    const codeNotice = screen.getByRole("status");
    expect(codeNotice.textContent).toContain("Un code a été envoyé à member@example.com.");
    expect(codeNotice.querySelector("br")?.nextSibling?.textContent).toBe("Il expire dans 10 minutes.");
    await typeCode("123456");

    expect(await screen.findByText("Code invalide ou expiré. Demandez un nouveau code.")).toBeTruthy();
    expect(calls).toContain("/api/auth/login/code/verify");
    expect(readCloudSession()).toBeNull();
    // « Changer d’e-mail » ramène au formulaire, l’adresse conservée.
    fireEvent.click(screen.getByRole("button", { name: "Changer d’e-mail" }));
    expect(((await screen.findByLabelText("Adresse e-mail")) as HTMLInputElement).value).toBe("member@example.com");
  });

  test("dans la coque desktop, le code passe par le pont et jamais par l’API web", async () => {
    reply = Response.json(CODE_PROVIDERS);
    const shell = fakeShell({ status: "error", code: "EMAIL_LOGIN_CODE_INVALID", message: "Code invalide." });
    renderLogin();

    fireEvent.change(await screen.findByLabelText("Adresse e-mail"), { target: { value: "member@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer le code" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Consultez votre boîte de réception" })).toBeTruthy();
    await typeCode("654321");

    expect(await screen.findByText("Code invalide ou expiré. Demandez un nouveau code.")).toBeTruthy();
    expect(shell.actions).toEqual(["code:member@example.com", "verify:member@example.com:654321"]);
    expect(calls.filter((path) => path.startsWith("/api/auth/login"))).toEqual([]);
    // Dans la coque, la marque ne mène nulle part.
    expect(screen.queryByRole("link", { name: "openedbot" })).toBeNull();
  });

  test("un état d’erreur rejoué d’avant ne fait pas échouer la nouvelle demande", async () => {
    reply = Response.json(CODE_PROVIDERS);
    const shell = fakeShell({ status: "idle" });
    shell.push({ status: "error", code: "RATE_LIMITED", message: "Trop de tentatives." });
    renderLogin();

    fireEvent.change(await screen.findByLabelText("Adresse e-mail"), { target: { value: "member@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer le code" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Consultez votre boîte de réception" })).toBeTruthy();
    expect(screen.queryByText("Trop de tentatives : patientez une minute.")).toBeNull();
  });

  test("un compte natif sans organisation indique de terminer la création de l’espace sur le web", async () => {
    reply = Response.json(CODE_PROVIDERS);
    fakeShell({ status: "error", code: "AUTH_NOT_A_MEMBER", message: "Définissez d’abord votre organisation depuis l’application web." });
    renderLogin();
    fireEvent.change(await screen.findByLabelText("Adresse e-mail"), { target: { value: "member@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer le code" }));
    await screen.findByRole("heading", { name: "Consultez votre boîte de réception" });
    await typeCode("123456");

    expect(await screen.findByText("Ce compte n’a pas encore d’organisation active : terminez la création de votre espace depuis l’application web, puis reconnectez-vous ici.")).toBeTruthy();
    expect(readCloudSession()).toBeNull();
  });
});
