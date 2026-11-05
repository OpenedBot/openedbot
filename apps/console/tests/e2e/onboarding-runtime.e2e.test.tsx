import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  RuntimeModelCatalogDto,
  RuntimeModelProviderDto,
  RuntimePublicDto,
} from "@openedbot/contracts-api";
import { ThemeProvider } from "@openedbot/browser-ui-kit/theme";
import { I18nProvider } from "../../src/lib/i18n";
import { StepRuntime } from "../../src/screens/onboarding/steps/step-runtime";

const runtime: RuntimePublicDto = {
  id: "runtime-onboarding",
  configured: true,
  baseUrl: "https://hermes.example.test",
  // Runtime joint par le LIEN : c'est la seule voie où l'accueil propose de
  // configurer un fournisseur depuis openedbot (`step-runtime.tsx` réserve le
  // sélecteur à `reachability === "connector"`). En accès direct, l'écran
  // renvoie au geste sur l'hôte, et il n'y a pas de sélecteur à ordonner.
  transport: "connector",
  reachability: "connector",
  link: {
    connected: true,
    lastSeenAt: "2026-09-02T08:00:00.000Z",
    lastReplacedAt: null,
    hijackSuspectedAt: null,
    rotatedAt: null,
    origin: null,
    originRetired: false,
    relinkCommand: null,
  },
  management: { kind: "host", credentialsWritable: true, oauthWritable: true },
  name: "Hermes onboarding",
  isDefault: true,
  isActive: true,
  tokenConfigured: true,
  botCount: 0,
  selectedProvider: "openai-api",
  selectedModel: "gpt-5.6-luna",
  reasoningEffort: "low",
  detectedVersion: "2026.8.19",
  capabilities: { toolsets: true },
  lastHealthStatus: "healthy",
  lastCheckedAt: null,
  updatedAt: null,
};

const unverifiedProvider: RuntimeModelProviderDto = {
  slug: "unverified-api",
  name: "API non vérifiée",
  isCurrent: false,
  authenticated: true,
  alwaysAuthenticated: false,
  provesInference: false,
  acceptsApiKey: true,
  acceptsOauth: false,
  sdkInstalled: null, sdkInstallable: null,
  warning: "Aucune inférence n’a encore été prouvée.",
  authCommand: null,
  models: [{
    id: "model-listed-only",
    fast: false,
    reasoning: false,
    isRuntimeDefault: false,
    freeTier: null,
  }],
};

const usableProvider: RuntimeModelProviderDto = {
  slug: "openai-api",
  name: "OpenAI API",
  isCurrent: true,
  authenticated: true,
  alwaysAuthenticated: false,
  provesInference: true,
  acceptsApiKey: true,
  acceptsOauth: false,
  sdkInstalled: null, sdkInstallable: null,
  warning: null,
  authCommand: "hermes auth add openai-api",
  models: [{
    id: "gpt-5.6-luna",
    fast: true,
    reasoning: true,
    isRuntimeDefault: true,
    freeTier: null,
  }],
};

const realFetch = globalThis.fetch;

function catalogWith(providers: RuntimeModelProviderDto[]): RuntimeModelCatalogDto {
  return {
    runtimeId: runtime.id!,
    runtimeName: runtime.name!,
    hermesProfile: null,
    currentProvider: runtime.selectedProvider,
    runtimeDefaultModel: runtime.selectedModel,
    hasUsableProvider: providers.some((provider) => provider.provesInference && provider.models.length > 0),
    runtimeConfigWritable: false,
    providers,
  };
}

function mockRuntime(catalog: RuntimeModelCatalogDto, served: RuntimePublicDto = runtime) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/runtime")) {
      return Response.json({
        runtime: served,
        runtimeMode: "external",
        adminMode: "disabled",
        devDefaults: null,
      });
    }
    if (url.endsWith("/api/runtime/test")) {
      return Response.json({ ok: true, status: "healthy", capabilities: { toolsets: true } });
    }
    // Un runtime joint en direct a sa PROPRE sonde, en trois preuves
    // (`directProbePassed`) : sans elle, l'accueil ne tient pas le runtime pour
    // vérifié et ne montre ni note d'hôte ni catalogue.
    if (url.endsWith(`/api/runtime/${served.id}/test`)) {
      return Response.json({
        ok: true,
        steps: [
          { step: "edge", ok: true },
          { step: "auth", ok: true },
          { step: "toolsets", ok: true },
        ],
        capabilities: { toolsets: true },
        hints: null,
      });
    }
    if (url.endsWith(`/api/runtimes/${runtime.id}/models`)) return Response.json(catalog);
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
}

function renderStep() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider>
          <StepRuntime onFinish={async () => {}} onSkip={async () => {}} />
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("openedbot:locale", "fr");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("onboarding du fournisseur et du modèle", () => {
  test("un seul sélecteur de fournisseur, puis le modèle : un fournisseur prêt est choisi d’office", async () => {
    mockRuntime(catalogWith([unverifiedProvider, usableProvider]));
    const { container } = renderStep();

    const providerSelect = await screen.findByLabelText("Fournisseur d’IA");
    const modelSelect = screen.getByLabelText("Modèle");
    const labels = Array.from(container.querySelectorAll("label"), (label) => label.textContent);

    expect(screen.queryByLabelText("Ajouter un fournisseur d’IA")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ouvrir la configuration" })).toBeNull();
    expect(labels.indexOf("Fournisseur d’IA")).toBeLessThan(labels.indexOf("Modèle"));
    expect(providerSelect.getAttribute("data-slot")).toBe("select-trigger");
    expect(modelSelect.getAttribute("data-slot")).toBe("select-trigger");
    expect(providerSelect.textContent).toContain("OpenAI API");
    expect(modelSelect.textContent).toContain("gpt-5.6-luna");

    // Sans nom de bot à saisir : un fournisseur prouvé et un modèle suffisent.
    const finish = screen.getByRole("button", { name: "Terminer" }) as HTMLButtonElement;
    expect(finish.getAttribute("data-slot")).toBe("button");
    expect(finish.getAttribute("data-variant")).toBe("default");
    expect(screen.queryByLabelText("Nom du premier bot")).toBeNull();
    await waitFor(() => expect(finish.disabled).toBe(false));
  });

  test("runtime direct sans opérateur hôte (manual) : la note renvoie au geste sur l’hôte, sans condition de lien", async () => {
    // Le cas est celui d'un runtime joint EN DIRECT : openedbot n'a pas de lien par
    // où porter une clé, l'accueil ne propose donc aucun sélecteur de
    // configuration et se contente de nommer le geste sur l'hôte.
    mockRuntime(catalogWith([usableProvider]), {
      ...runtime,
      transport: "direct",
      reachability: "direct",
      link: null,
      management: { kind: "manual", credentialsWritable: false, oauthWritable: false },
    });
    renderStep();
    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("edge-setup credentials add");
    expect(screen.queryByRole("button", { name: /^Connecter / })).toBeNull();
  });

  test("un fournisseur sans preuve d’inférence se propose à connecter, sans modèle, et bloque la fin", async () => {
    mockRuntime(catalogWith([unverifiedProvider]));
    renderStep();

    const connect = await screen.findByRole("button", { name: "Connecter API non vérifiée" });
    expect(connect.getAttribute("data-variant")).toBe("secondary");
    expect(screen.getByText("API non vérifiée n’est pas encore relié à votre machine", { exact: false })).toBeTruthy();
    expect(screen.queryByLabelText("Modèle")).toBeNull();
    const finish = screen.getByRole("button", { name: "Terminer" }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
  });
});
