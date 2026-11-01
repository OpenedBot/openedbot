import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import type { BotDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { toast } from "@openedbot/browser-ui-kit";
import { I18nProvider } from "../../src/lib/i18n";
import { ComposerModelPicker, ThreadModelPicker } from "../../src/components/composer-model-picker";
import { settledBotModelSaves } from "../../src/lib/bot-model-saves";

const realFetch = globalThis.fetch;

beforeEach(() => window.localStorage.setItem("ohb:locale", "fr"));
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.localStorage.clear();
});

const providers: RuntimeModelProviderDto[] = [{
  slug: "openai",
  name: "OpenAI",
  isCurrent: true,
  authenticated: true,
  alwaysAuthenticated: false,
  provesInference: true,
  acceptsApiKey: true,
  acceptsOauth: false,
  sdkInstalled: null, sdkInstallable: null,
  warning: null,
  authCommand: null,
  models: [
    { id: "gpt-5.6", fast: false, reasoning: true, isRuntimeDefault: true, freeTier: null },
    { id: "gpt-4.1-mini", fast: true, reasoning: false, isRuntimeDefault: false, freeTier: null },
  ],
}];

const bot: BotDto = {
  id: "bot-1",
  threadId: "thread-1",
  name: "Hermes",
  slug: "hermes",
  description: null,
  instructions: "",
  model: "gpt-5.6",
  reasoningEffort: "minimal",
  sectionId: "section-1",
  position: 0,
  pinned: false,
  face: null,
  voiceId: null,
  hermesProfile: null,
  isolation: "profile",
  hasOwnRuntime: false,
  runtimeName: "Local",
  awaitingApproval: false,
  preview: null,
  lastActivityAt: new Date().toISOString(),
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastRunAt: null,
};

function renderPicker(overrides: Partial<ComponentProps<typeof ComposerModelPicker>> = {}) {
  const models: Array<string | null> = [];
  const effortPreviews: string[] = [];
  const effortCommits: string[] = [];
  render(
    <I18nProvider>
      <ComposerModelPicker
        providers={providers}
        selectedModel={null}
        effectiveModel="gpt-5.6"
        effectiveEffort="medium"
        globalModel="gpt-5.6"
        supportsEffort
        disabled={false}
        loading={false}
        saving={false}
        error={false}
        onModelChange={(model) => models.push(model)}
        onEffortChange={(effort) => effortPreviews.push(effort)}
        onEffortCommit={(effort) => effortCommits.push(effort)}
        {...overrides}
      />
    </I18nProvider>,
  );
  fireEvent.click(document.querySelector("[data-composer-model-picker]")!);
  return { models, effortPreviews, effortCommits };
}

test("le picker choisit un modèle propre au bot ou le modèle global", () => {
  const { models } = renderPicker();

  fireEvent.click(screen.getByRole("radio", { name: "gpt-4.1-mini" }));
  fireEvent.click(screen.getByRole("radio", { name: /Modèle global/ }));

  expect(models).toEqual(["gpt-4.1-mini", null]);
});

test("loaded without any model, the chip asks for one instead of showing loading", () => {
  const { models } = renderPicker({ effectiveModel: null, effectiveEffort: null, globalModel: null });
  const trigger = document.querySelector("[data-composer-model-picker]")!;
  expect(trigger.textContent).toContain("Choisir un modèle");
  expect(trigger.textContent).not.toContain("Chargement");
  fireEvent.click(screen.getByRole("radio", { name: "gpt-4.1-mini" }));
  expect(models).toEqual(["gpt-4.1-mini"]);
  cleanup();

  renderPicker({ effectiveModel: null, effectiveEffort: null, globalModel: null, loading: true });
  expect(document.querySelector("[data-composer-model-picker]")!.textContent).toContain("Chargement");
});

test("la slidebar prévisualise librement puis commit une seule valeur au relâchement", () => {
  const { effortPreviews, effortCommits } = renderPicker();
  fireEvent.click(screen.getByRole("button", { name: /^Effort/ }));
  const slider = document.querySelector("[data-composer-effort-slider]") as HTMLInputElement;

  expect(slider.getAttribute("max")).toBe("5");
  fireEvent.change(slider, { target: { value: "4" } });
  expect(effortPreviews).toEqual(["high"]);
  expect(effortCommits).toEqual([]);

  fireEvent.pointerUp(slider, { target: { value: "4" } });

  expect(effortCommits).toEqual(["high"]);
});

test("un modèle sans raisonnement garde la slidebar visible mais inactive", () => {
  renderPicker({
    selectedModel: "gpt-4.1-mini",
    effectiveModel: "gpt-4.1-mini",
    effectiveEffort: null,
    supportsEffort: false,
  });

  fireEvent.click(screen.getByRole("button", { name: /^Effort/ }));
  const slider = document.querySelector("[data-composer-effort-slider]") as HTMLInputElement;
  expect(slider.disabled).toBe(true);
  expect(screen.getByText("Ce modèle n’accepte pas d’effort de raisonnement.")).toBeTruthy();
});

test("le picker connecté ne PATCH qu'au relâchement, avec la dernière prévisualisation", async () => {
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/runtime")) {
      return Response.json({
        runtime: {
          id: "runtime-1",
          configured: true,
          baseUrl: null,
          reachability: "connector",
          transport: "connector",
          link: null,
          management: { kind: "manual", credentialsWritable: false, oauthWritable: false },
          name: "Local",
          isDefault: true,
          isActive: true,
          tokenConfigured: true,
          botCount: 1,
          selectedProvider: "openai",
          selectedModel: "gpt-5.6",
          reasoningEffort: "minimal",
          detectedVersion: "test",
          capabilities: null,
          lastHealthStatus: "healthy",
          lastCheckedAt: null,
          updatedAt: null,
        },
        runtimeMode: "external",
        adminMode: "disabled",
        devDefaults: null,
      });
    }
    if (url.endsWith("/api/runtimes/runtime-1/models")) {
      return Response.json({
        runtimeId: "runtime-1",
        runtimeName: "Local",
        hermesProfile: null,
        currentProvider: "openai",
        runtimeDefaultModel: "gpt-5.6",
        hasUsableProvider: true,
        providers,
        runtimeConfigWritable: false,
      });
    }
    if (url.endsWith("/api/bots/bot-1") && init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push(patch);
      return Response.json({ ...bot, ...patch, updatedAt: new Date().toISOString() });
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <ThreadModelPicker bot={bot} />
      </I18nProvider>
    </QueryClientProvider>,
  );

  const trigger = await screen.findByRole("button", { name: /gpt-5.6/ });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("button", { name: /^Effort/ }));
  const slider = document.querySelector("[data-composer-effort-slider]") as HTMLInputElement;
  fireEvent.change(slider, { target: { value: "2" } });
  fireEvent.change(slider, { target: { value: "3" } });
  fireEvent.change(slider, { target: { value: "4" } });
  expect(patches).toHaveLength(0);

  fireEvent.pointerUp(slider);
  await waitFor(() => expect(patches).toHaveLength(1));
  // Effort seul : le modèle ne part pas, l'API n'a pas à interroger l'hôte.
  expect(patches[0]).toEqual({ reasoningEffort: "high" });
});

test("deux choix rapides : un seul aller à la fois, le dernier gagne, rien ne se fige", async () => {
  const patches: Array<Record<string, unknown>> = [];
  let releaseFirst: () => void = () => {};
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/runtime")) {
      return Response.json({ runtime: { id: "runtime-1", configured: true, selectedProvider: "openai", selectedModel: "gpt-5.6", reasoningEffort: "minimal" }, runtimeMode: "external", adminMode: "disabled" });
    }
    if (url.endsWith("/models")) return Response.json({ providers });
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push(patch);
      if (patches.length === 1) await firstHeld;
      return Response.json({ ...bot, ...patch });
    }
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><I18nProvider><ThreadModelPicker bot={bot} /></I18nProvider></QueryClientProvider>);

  fireEvent.click(await screen.findByRole("button", { name: /gpt-5.6/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Effort/ }));
  const slider = document.querySelector("[data-composer-effort-slider]") as HTMLInputElement;
  fireEvent.change(slider, { target: { value: "2" } });
  fireEvent.pointerUp(slider);
  await waitFor(() => expect(patches).toHaveLength(1));

  // Pendant l'aller, le réglage reste utilisable et deux autres choix s'enchaînent.
  expect(slider.disabled).toBe(false);
  fireEvent.change(slider, { target: { value: "3" } });
  fireEvent.pointerUp(slider);
  fireEvent.change(slider, { target: { value: "4" } });
  fireEvent.pointerUp(slider);
  expect(patches).toHaveLength(1);

  releaseFirst();
  // Seul le dernier choix part ensuite ; l'intermédiaire est abandonné.
  await waitFor(() => expect(patches).toHaveLength(2));
  expect(patches[1]).toEqual({ reasoningEffort: "high" });
  await waitFor(() => expect(slider.getAttribute("aria-valuetext")).toBe("High"));
});

test.each([200, 409])("cross-provider PATCH includes the catalog provider and reports status %i", async (status) => {
  const errorToast = spyOn(toast, "error").mockImplementation(() => "test-toast");
  try {
    const patches: Record<string, unknown>[] = [];
    const catalogProviders = [...providers, {
      ...providers[0]!, slug: "opencode-free", name: "OpenCode Free", isCurrent: false,
      models: [{ id: "nemotron-3.5-lightning-free", fast: true, reasoning: false, isRuntimeDefault: false, freeTier: null }],
    }];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // Le composer ne liste que le fournisseur émis : ici le global, OpenCode Free.
      // Mode global : seul le fournisseur du modèle global est proposé.
      if (url.endsWith("/api/runtime")) return Response.json({ runtime: { id: "runtime-1", configured: true, selectedProvider: "opencode-free", selectedModel: "nemotron-3.5-lightning-free" }, runtimeMode: "external", adminMode: "disabled", modelAssignmentMode: "global" });
      if (url.endsWith("/api/runtimes/assignment-mode") && init?.method === "PUT") return Response.json({ modelAssignmentMode: "per_bot" });
      if (url.endsWith("/models")) return Response.json({ providers: catalogProviders });
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body));
        patches.push(patch);
        return status === 409
          ? Response.json({ error: { code: "BOT_MODEL_UNAVAILABLE", message: "Modèle indisponible dans Hermes." } }, { status })
          : Response.json({ ...bot, ...patch });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><I18nProvider><ThreadModelPicker bot={{ ...bot, model: null }} /></I18nProvider></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /nemotron-3.5-lightning-free/ }));
    const emitted = await screen.findByRole("radio", { name: "nemotron-3.5-lightning-free" });
    expect(screen.queryByRole("radio", { name: "gpt-5.6" })).toBeNull();
    fireEvent.click(emitted);
    await waitFor(() => expect(patches).toEqual([{
      model: "nemotron-3.5-lightning-free", provider: "opencode-free", reasoningEffort: null,
    }]));
    if (status === 409) await waitFor(() => expect(errorToast).toHaveBeenCalledWith("Modèle indisponible dans Hermes.", { id: "composer-model-bot-1" }));
  } finally {
    errorToast.mockRestore();
  }

});

// Bug 2 (2026-10-24): the header said "grok-4.6 Medium" over an answer that
// Anthropic served after a fallback. The trigger names who served the last
// turn, marks the fallback, and leaves the setting alone.
test("the header names the model that served a re-routed last turn, marked as a fallback", () => {
  const servedBy = { runId: "run-9", from: "xai-oauth", provider: "anthropic", model: "claude-fable-5.1" };
  const { models } = renderPicker({ variant: "header", servedBy });
  const trigger = document.querySelector<HTMLElement>("[data-composer-model-picker]")!;
  expect(trigger.textContent).toContain("claude-fable-5.1");
  expect(trigger.textContent).toContain("repli");
  // The effort is the configured model's, not the fallback's.
  expect(trigger.textContent).not.toContain("Medium");
  expect(trigger.querySelector("[data-model-fallback]")).not.toBeNull();
  expect(trigger.getAttribute("title")).toBe("Dernière réponse servie par Anthropic / claude-fable-5.1 (repli). Le modèle réglé reste gpt-5.6.");
  expect(trigger.getAttribute("aria-label")).toContain("claude-fable-5.1");
  // The list still checks the configured model: nothing was rewritten.
  expect(screen.getByRole("radio", { name: /Modèle global/ }).getAttribute("aria-checked")).toBe("true");
  expect(models).toEqual([]);
  cleanup();

  renderPicker({ variant: "header" });
  const plain = document.querySelector<HTMLElement>("[data-composer-model-picker]")!;
  expect(plain.textContent).toContain("gpt-5.6");
  expect(plain.querySelector("[data-model-fallback]")).toBeNull();
  expect(plain.getAttribute("title")).toBeNull();
});

test("a save started on a picker that is gone since (the bot page) still holds the next send", async () => {
  let releasePatch: () => void = () => {};
  const patchHeld = new Promise<void>((resolve) => { releasePatch = resolve; });
  let patched = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/runtime")) {
      return Response.json({ runtime: { id: "runtime-1", configured: true, selectedProvider: "openai", selectedModel: "gpt-5.6", reasoningEffort: "minimal" }, runtimeMode: "external", adminMode: "disabled" });
    }
    if (url.endsWith("/models")) return Response.json({ providers });
    if (init?.method === "PATCH") {
      await patchHeld;
      patched = true;
      return Response.json({ ...bot, ...(JSON.parse(String(init.body)) as Record<string, unknown>) });
    }
    if (url.includes("/api/bots")) return Response.json({ bots: [bot], groups: [], sections: [] });
    throw new Error(`Route inattendue : ${url}`);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><I18nProvider><ThreadModelPicker bot={bot} variant="header" /></I18nProvider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: /gpt-5.6/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Effort/ }));
  const slider = document.querySelector("[data-composer-effort-slider]") as HTMLInputElement;
  fireEvent.change(slider, { target: { value: "3" } });
  fireEvent.pointerUp(slider);
  // The operator closes the bot page right away: the picker unmounts mid-save.
  view.unmount();
  let sendMayLeave = false;
  const wait = settledBotModelSaves(bot.id).then(() => { sendMayLeave = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sendMayLeave).toBe(false);
  releasePatch();
  await wait;
  expect(patched).toBe(true);
});

// Codex review (2026-10-24): a model picked on the bot page (another picker)
// must also clear the header's fallback mark, not only a pick in the header.
test("the header drops the fallback mark when the bot's model changes from another picker", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/runtime")) {
      return Response.json({ runtime: { id: "runtime-1", configured: true, selectedProvider: "openai", selectedModel: "gpt-5.6", reasoningEffort: "minimal" }, runtimeMode: "external", adminMode: "disabled" });
    }
    if (url.endsWith("/models")) return Response.json({ providers });
    if (url.includes("/api/bots")) return Response.json({ bots: [bot], groups: [], sections: [] });
    return Response.json({});
  }) as typeof fetch;
  const servedBy = { runId: "run-9", from: "xai-oauth", provider: "anthropic", model: "claude-fable-5.1" };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tree = (subject: BotDto, served: typeof servedBy = servedBy) => (
    <QueryClientProvider client={client}><I18nProvider><ThreadModelPicker bot={subject} variant="header" servedBy={served} /></I18nProvider></QueryClientProvider>
  );
  const view = render(tree(bot));
  await waitFor(() => expect(document.querySelector("[data-model-fallback]")).not.toBeNull());
  // The same bot, refetched after the bot page wrote another model.
  view.rerender(tree({ ...bot, model: "gpt-4.1-mini" }));
  await waitFor(() => expect(document.querySelector("[data-model-fallback]")).toBeNull());
  // A different bot is not a model change: its own fallback stays marked.
  view.rerender(tree({ ...bot, id: "bot-2", model: "gpt-5.6" }, { ...servedBy, runId: "run-10" }));
  await waitFor(() => expect(document.querySelector("[data-model-fallback]")).not.toBeNull());
});

// Codex review (2026-10-24): a pick dismisses the fallback mark at once, but
// a save that fails leaves the bot where it was. The mark comes back with the
// selection, since the next turn still runs where the last one did.
test("a failed save restores the fallback mark along with the selection", async () => {
  const errorToast = spyOn(toast, "error").mockImplementation(() => "test-toast");
  let releasePatch: () => void = () => {};
  const patchHeld = new Promise<void>((resolve) => { releasePatch = resolve; });
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/runtime")) {
        return Response.json({ runtime: { id: "runtime-1", configured: true, selectedProvider: "openai", selectedModel: "gpt-5.6", reasoningEffort: "minimal" }, runtimeMode: "external", adminMode: "disabled" });
      }
      if (url.endsWith("/models")) return Response.json({ providers });
      if (init?.method === "PATCH") {
        await patchHeld;
        return Response.json({ error: { code: "BOT_MODEL_UNAVAILABLE", message: "Modèle indisponible dans Hermes." } }, { status: 409 });
      }
      throw new Error(`Route inattendue : ${url}`);
    }) as typeof fetch;
    const servedBy = { runId: "run-9", from: "xai-oauth", provider: "anthropic", model: "claude-fable-5.1" };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><I18nProvider><ThreadModelPicker bot={bot} variant="header" servedBy={servedBy} /></I18nProvider></QueryClientProvider>);
    await waitFor(() => expect(document.querySelector("[data-model-fallback]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-composer-model-picker]")!);
    fireEvent.click(await screen.findByRole("radio", { name: "gpt-4.1-mini" }));
    // The pick wins at once, the mark goes with it.
    await waitFor(() => expect(document.querySelector("[data-model-fallback]")).toBeNull());
    releasePatch();
    await waitFor(() => expect(errorToast).toHaveBeenCalledWith("Modèle indisponible dans Hermes.", { id: "composer-model-bot-1" }));
    await waitFor(() => expect(document.querySelector("[data-model-fallback]")).not.toBeNull());
    expect(document.querySelector("[data-composer-model-picker]")!.textContent).toContain("claude-fable-5.1");
  } finally {
    errorToast.mockRestore();
  }
});
