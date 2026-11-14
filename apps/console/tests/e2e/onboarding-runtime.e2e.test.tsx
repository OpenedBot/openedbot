import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  // Runtime joined by the LINK: it is the only path where onboarding offers to
  // configure a provider from openedbot (`step-runtime.tsx` reserves the
  // picker for `reachability === "connector"`). On direct access, the screen
  // points back to the gesture on the host, and there is no picker to order.
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

function mockRuntime(catalog: RuntimeModelCatalogDto, served: RuntimePublicDto = runtime, failures: { configuration?: boolean; catalog?: boolean } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/runtime")) {
      if (failures.configuration) return Response.json({ error: { code: "CONFIG_UNAVAILABLE", message: "Configuration indisponible" } }, { status: 503 });
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
    // A runtime joined directly has its OWN probe, in three proofs
    // (`directProbePassed`): without it, onboarding does not treat the runtime as
    // verified and shows neither a host note nor the catalog.
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
    if (url.endsWith(`/api/runtimes/${runtime.id}/models`)) {
      if (failures.catalog) return Response.json({ error: { code: "CATALOG_UNAVAILABLE", message: "Catalogue indisponible" } }, { status: 503 });
      return Response.json(catalog);
    }
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
  test("une erreur de configuration propose de réessayer sans ouvrir l’ajout ou le remplacement du runtime", async () => {
    const failures = { configuration: true };
    mockRuntime(catalogWith([usableProvider]), runtime, failures);
    renderStep();
    expect((await screen.findByRole("alert")).textContent).toContain("Configuration indisponible");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Aucun runtime déclaré")).toBeNull();
    expect((screen.getByRole("button", { name: "Terminer" }) as HTMLButtonElement).disabled).toBe(true);
    failures.configuration = false;
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Terminer" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("un catalogue indisponible se recharge sans perdre la machine ni quitter l’étape", async () => {
    const failures = { catalog: true };
    mockRuntime(catalogWith([usableProvider]), runtime, failures);
    renderStep();
    expect((await screen.findByRole("alert")).textContent).toContain("Catalogue indisponible");
    expect(screen.getByText("Hermes onboarding")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Terminer" }) as HTMLButtonElement).disabled).toBe(true);
    failures.catalog = false;
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Terminer" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByLabelText("Modèle").textContent).toContain("gpt-5.6-luna");
  });

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

    // No bot name to enter: a proven provider and a model are enough.
    const finish = screen.getByRole("button", { name: "Terminer" }) as HTMLButtonElement;
    expect(finish.getAttribute("data-slot")).toBe("button");
    expect(finish.getAttribute("data-variant")).toBe("default");
    expect(screen.queryByLabelText("Nom du premier bot")).toBeNull();
    await waitFor(() => expect(finish.disabled).toBe(false));
  });

  test("runtime direct sans opérateur hôte (manual) : la note renvoie au geste sur l’hôte, sans condition de lien", async () => {
    // The case is a runtime joined DIRECTLY: openedbot has no link through
    // which to carry a key, so onboarding offers no configuration
    // picker and only names the gesture on the host.
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
