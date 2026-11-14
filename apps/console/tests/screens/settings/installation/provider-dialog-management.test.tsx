import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { RuntimeModelProviderDto, RuntimeProviderOauthDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { t } from "@openedbot/browser-i18n";
import { I18nProvider } from "../../../../src/lib/i18n";
import { api } from "../../../../src/lib/api";
import { ProviderConfigDialog } from "../../../../src/screens/settings/installation/models";

/**
 * The provider dialog facing the `connector` channel: when the host announces
 * `provider_management` and the link is open, the write happens HERE, through
 * the link: the key field is offered and no « ce runtime vous
 * appartient » notice appears. Link closed, the notice comes back with the
 * edge-setup command to run on the host.
 */

/**
 * The key field's placeholder, READ from the dictionary rather than copied.
 *
 * It had been copied, and the copy changed (an em dash became a colon,
 * a repository rule): the positive assertion started failing, and the three
 * negative assertions started passing for the wrong reason, looking for a text
 * that no longer existed anywhere. What these tests mean is « the field
 * is offered », not « the sentence is this one ».
 */
const API_KEY_PLACEHOLDER = t("fr", "modelsSettings.apiKeyPlaceholder");

const connectorRuntime: RuntimePublicDto = {
  id: "runtime-1",
  configured: true,
  baseUrl: null,
  transport: "connector",
  reachability: "connector",
  link: { connected: true, lastReplacedAt: null, hijackSuspectedAt: null, rotatedAt: null, lastSeenAt: "2026-09-02T08:00:00.000Z", origin: null, originRetired: false, relinkCommand: null },
  management: { kind: "host", credentialsWritable: true, oauthWritable: true },
  name: "Hermes du VPS",
  isDefault: true,
  isActive: true,
  tokenConfigured: true,
  botCount: 0,
  selectedProvider: null,
  selectedModel: null,
  reasoningEffort: null,
  detectedVersion: null,
  capabilities: null,
  capacity: 4,
  lastHealthStatus: "healthy",
  lastHealthError: null,
  lastCheckedAt: null,
  createdAt: null,
  updatedAt: null,
};

const apiKeyProvider: RuntimeModelProviderDto = {
  slug: "openai-api",
  name: "OpenAI API",
  isCurrent: false,
  authenticated: false,
  alwaysAuthenticated: false,
  provesInference: false,
  acceptsApiKey: true,
  acceptsOauth: false,
  sdkInstalled: null, sdkInstallable: null,
  warning: null,
  authCommand: "hermes auth add openai-api",
  models: [],
};

const oauthProvider: RuntimeModelProviderDto = {
  ...apiKeyProvider,
  slug: "openai-codex",
  name: "OpenAI Codex",
  acceptsApiKey: false,
  acceptsOauth: true,
  authCommand: "hermes auth add openai-codex",
};

// What the API returns for an anonymous tier: Hermes calls it « détecté », openedbot
// removes the key field (`acceptsApiKey: false`, runtime-model-routes.ts).
const keylessProvider: RuntimeModelProviderDto = {
  ...apiKeyProvider,
  slug: "opencode-free",
  name: "OpenCode Free",
  authenticated: true,
  provesInference: true,
  acceptsApiKey: false,
  authCommand: null,
};

function renderDialog(runtime: RuntimePublicDto, provider: RuntimeModelProviderDto) {
  const rootRoute = createRootRoute({ component: Outlet });
  const dialogRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/models",
    component: () => (
      <ProviderConfigDialog
        runtime={runtime}
        provider={provider}
        hermesProfile={null}
        onClose={() => {}}
        onConnected={() => {}}
      />
    ),
  });
  const runtimeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/runtime",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([dialogRoute, runtimeRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/models"] }),
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

const oauthSession: RuntimeProviderOauthDto = {
  sessionId: "s-1",
  provider: "openai-codex",
  status: "pending",
  verificationUri: "https://example.test/device",
  userCode: "ABCD-EFGH",
  error: null,
  expiresAt: "2026-09-14T12:00:00.000Z",
};

const spies: { mockRestore: () => void }[] = [];

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  for (const spy of spies) spy.mockRestore();
  spies.length = 0;
});

describe("dialogue fournisseur sur un tier anonyme", () => {
  test("OpenCode Free : aucun champ de clé, la raison exacte", async () => {
    renderDialog(connectorRuntime, keylessProvider);
    expect(await screen.findByText(/OpenCode Free est servi anonymement : il n’y a ni clé ni compte à saisir/)).toBeTruthy();
    // The directory already carries « Accès anonyme »: the dialog does not repeat it.
    expect(screen.queryByText("Accès anonyme")).toBeNull();
    expect(screen.queryByText("Accès détecté")).toBeNull();
    expect(screen.queryByPlaceholderText(API_KEY_PLACEHOLDER)).toBeNull();
    // With neither a key nor OAuth, the « CLI uniquement » fallback would be a contradiction.
    expect(screen.queryByText(/Configurez-le directement avec la CLI Hermes/)).toBeNull();
  });
});

describe("dialogue fournisseur sur un runtime connecteur", () => {
  test("lien capable et ouvert : le champ de clé API est proposé, sans notice de runtime possédé", async () => {
    renderDialog(connectorRuntime, apiKeyProvider);
    expect(await screen.findByPlaceholderText(API_KEY_PLACEHOLDER)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enregistrer la clé" })).toBeTruthy();
    expect(screen.queryByText(/Ce runtime vous appartient/)).toBeNull();
    expect(screen.queryByText(/edge-setup credentials add/)).toBeNull();
    expect(screen.getByText(/par le lien connecteur/)).toBeTruthy();
  });

  test("lien capable mais fermé : reconnexion attendue, aucune commande manuelle", async () => {
    renderDialog(
      {
        ...connectorRuntime,
        link: { connected: false, lastSeenAt: null, lastReplacedAt: null, hijackSuspectedAt: null, rotatedAt: null, origin: null, originRetired: false, relinkCommand: null },
        management: { kind: "host", credentialsWritable: false, oauthWritable: false },
      },
      apiKeyProvider,
    );
    expect(await screen.findByText(/Le lien avec votre runtime est temporairement déconnecté/)).toBeTruthy();
    expect(screen.queryByText(/edge-setup credentials/)).toBeNull();
    expect(screen.queryByPlaceholderText(API_KEY_PLACEHOLDER)).toBeNull();
  });

  test("sans administration hôte : la commande clé API reste disponible", async () => {
    renderDialog(
      { ...connectorRuntime, management: { kind: "manual", credentialsWritable: false, oauthWritable: false } },
      apiKeyProvider,
    );
    expect(await screen.findByText("sudo edge-setup credentials add openai-api --yes")).toBeTruthy();
    expect(screen.queryByPlaceholderText(API_KEY_PLACEHOLDER)).toBeNull();
  });

  test("OAuth avec lien interrompu : reconnexion attendue, aucune commande manuelle", async () => {
    renderDialog(
      { ...connectorRuntime, management: { kind: "host", credentialsWritable: false, oauthWritable: false } },
      oauthProvider,
    );
    expect(await screen.findByText(/Le lien avec votre runtime est temporairement déconnecté/)).toBeTruthy();
    expect(screen.queryByText(/edge-setup credentials/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Connecter avec OAuth" })).toBeNull();
  });

  test("OAuth par le lien : la demande part dès l'ouverture, pas de notice", async () => {
    spies.push(spyOn(api, "startProviderOauth").mockResolvedValue(oauthSession));
    spies.push(spyOn(api, "providerOauth").mockResolvedValue(oauthSession));
    renderDialog(connectorRuntime, oauthProvider);
    expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Ouvrir la page/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connecter avec OAuth" })).toBeNull();
    expect(screen.queryByText(/Ce runtime vous appartient/)).toBeNull();
  });

  test("OAuth sans canal : la commande de repli est `credentials login`", async () => {
    renderDialog(
      { ...connectorRuntime, management: { kind: "manual", credentialsWritable: false, oauthWritable: false } },
      oauthProvider,
    );
    expect(await screen.findByText(/Ce runtime vous appartient/)).toBeTruthy();
    expect(screen.getByText("sudo edge-setup credentials login openai-codex --yes")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connecter avec OAuth" })).toBeNull();
  });
});

test("accès direct : aucun contrôle fournisseur même si l’ancien serveur annonce une écriture", async () => {
  renderDialog({ ...connectorRuntime, reachability: "direct", transport: "direct" }, apiKeyProvider);
  expect(await screen.findByText(/Capacités gérées sur l’hôte/)).toBeTruthy();
  expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  expect(document.querySelector('input[type="password"]')).toBeNull();
});
