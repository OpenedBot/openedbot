import { describe, expect, test } from "bun:test";
import type { HermesModelOptions } from "@openedbot/hermes";
import {
  applyFallbackProfileModel,
  fallbackFailureMessage,
  fallbackIdempotencyKey,
  planProviderRetry,
  PROFILE_MANAGEMENT_FEATURE,
  providerAuthRequiredPayload,
  providerFallbackPayload,
  quotaEmailDedupeKey,
  reconciledFailureMessage,
  selectFallbackSelection,
  selectNextModelOnProvider,
  type ActiveProviderIncident,
  type ProviderRetryState,
} from "../src/application/provider-fallback";
import { resolveRunnableSelection } from "../src/application/runner";
import { chosenProviderAuthRequired, resolveSelectionForNewRun } from "../src/application/runner/provider-recovery";
import { NamedRunError } from "../src/application/runner/failure";
import type { RunContext } from "../src/application/runner/types";

const catalog: HermesModelOptions = {
  provider: "openai-codex",
  model: "gpt-5.4",
  providers: [
    {
      slug: "moa",
      name: "MOA",
      isCurrent: false,
      authenticated: true,
      authType: null,
      warning: null,
      models: [{ id: "ensemble", fast: false, reasoning: false }],
    },
    {
      slug: "openai-codex",
      name: "OpenAI Codex",
      isCurrent: true,
      authenticated: true,
      authType: "oauth",
      warning: null,
      models: [{ id: "gpt-5.4", fast: false, reasoning: true }],
    },
    {
      slug: "opencode-free",
      name: "OpenCode Free",
      isCurrent: false,
      authenticated: true,
      authType: null,
      warning: null,
      models: [
        { id: "x-preview-f-free", fast: true, reasoning: false },
        { id: "nemotron", fast: true, reasoning: false },
      ],
    },
  ],
};

const emptyState = (): ProviderRetryState => ({
  fallbackAttempted: false,
  extraModelTried: false,
  fromProvider: null,
  fallback: null,
});

describe("selectFallbackSelection", () => {
  // Mesuré le 10-09 : `opencode-free` est authentifié, annonce six modèles, et
  // chacun répond « Model … is not supported ». Le repli y brûlait ses deux
  // tentatives pendant que le xai-oauth choisi par l'opérateur répondait.
  test("prefers the provider the operator selected on the runtime over a *-free one", () => {
    const withSelected: HermesModelOptions = {
      ...catalog,
      providers: [
        ...catalog.providers,
        {
          slug: "xai-oauth",
          name: "xAI Grok OAuth",
          isCurrent: false,
          authenticated: true,
          authType: "oauth",
          warning: null,
          models: [{ id: "grok-4.6", fast: true, reasoning: true }],
        },
      ],
    };
    expect(selectFallbackSelection(withSelected, [], {
      excludedProvider: "openai-codex",
      runtimeSelectedProvider: "xai-oauth",
      runtimeSelectedModel: "grok-4.6",
    })).toEqual({ provider: "xai-oauth", model: "grok-4.6", reason: "quota", reasoning: true });
  });

  // La sélection de l'opérateur ne contourne pas un incident : un fournisseur
  // dont le quota est tombé reste écarté, et le gratuit reprend la main.
  test("skips the operator selection while it carries an active incident", () => {
    const withSelected: HermesModelOptions = {
      ...catalog,
      providers: [
        ...catalog.providers,
        {
          slug: "xai-oauth",
          name: "xAI Grok OAuth",
          isCurrent: false,
          authenticated: true,
          authType: "oauth",
          warning: null,
          models: [{ id: "grok-4.6", fast: true, reasoning: true }],
        },
      ],
    };
    const incidents: ActiveProviderIncident[] = [
      { provider: "xai-oauth", kind: "quota", until: new Date(Date.now() + 3_600_000) },
    ];
    expect(selectFallbackSelection(withSelected, incidents, {
      excludedProvider: "openai-codex",
      runtimeSelectedProvider: "xai-oauth",
      runtimeSelectedModel: "grok-4.6",
    })?.provider).toBe("opencode-free");
  });

  // Rien de choisi sur Anthropic : le repli prend la gamme courante (Sonnet),
  // pas le premier listé par Hermes (Fable, le plus cher).
  test("falls back to the default tier of a provider nobody picked a model on", () => {
    const withAnthropic: HermesModelOptions = {
      provider: "openai-codex",
      model: "gpt-5.4",
      providers: [
        catalog.providers[1]!,
        {
          slug: "anthropic",
          name: "Anthropic",
          isCurrent: false,
          authenticated: true,
          authType: "oauth",
          warning: null,
          models: [
            { id: "claude-fable-5.1", fast: false, reasoning: true },
            { id: "claude-opus-5-5", fast: false, reasoning: true },
            { id: "claude-sonnet-5-5", fast: false, reasoning: true },
          ],
        },
      ],
    };
    expect(selectFallbackSelection(withAnthropic, [], {
      excludedProvider: "openai-codex",
      runtimeSelectedProvider: "openai-codex",
      runtimeSelectedModel: "gpt-5.4",
    })?.model).toBe("claude-sonnet-5-5");
  });

  test("prefers a *-free provider and never moa", () => {
    const chosen = selectFallbackSelection(catalog, [], {
      excludedProvider: "openai-codex",
      runtimeSelectedProvider: "openai-codex",
      runtimeSelectedModel: "gpt-5.4",
    });
    expect(chosen).toEqual({
      provider: "opencode-free",
      model: "x-preview-f-free",
      reason: "quota",
      reasoning: false,
    });
  });

  test("skips a provider with an unexpired incident", () => {
    const incidents: ActiveProviderIncident[] = [{
      provider: "opencode-free",
      kind: "quota",
      until: new Date(Date.now() + 3_600_000),
    }];
    expect(selectFallbackSelection(catalog, incidents, {
      excludedProvider: "openai-codex",
      runtimeSelectedProvider: null,
      runtimeSelectedModel: null,
    })).toBeNull();
  });

  test("uses the OHB-selected model when it belongs to the fallback provider", () => {
    const chosen = selectFallbackSelection(catalog, [], {
      excludedProvider: "openai-codex",
      runtimeSelectedProvider: "opencode-free",
      runtimeSelectedModel: "nemotron",
    });
    expect(chosen?.model).toBe("nemotron");
  });
});

describe("selectNextModelOnProvider", () => {
  test("tries the next model of the same provider once", () => {
    expect(selectNextModelOnProvider(catalog, "opencode-free", "x-preview-f-free")).toEqual({
      provider: "opencode-free",
      model: "nemotron",
      reason: "model_unsupported",
      reasoning: false,
    });
    expect(selectNextModelOnProvider(catalog, "openai-codex", "gpt-5.4")).toBeNull();
  });
});

describe("planProviderRetry", () => {
  const selection = { provider: "openai-codex", model: "gpt-5.4", reasoningEffort: null };

  test("replays once on quota, then gives up", () => {
    const first = planProviderRetry(
      { status: 429, message: "HTTP 429: The usage limit has been reached" },
      selection,
      catalog,
      [],
      emptyState(),
      { runtimeSelectedProvider: null, runtimeSelectedModel: null },
    );
    expect(first.action).toBe("retry");
    if (first.action !== "retry") return;
    expect(first.selection.provider).toBe("opencode-free");
    expect(first.state.fallbackAttempted).toBe(true);

    const second = planProviderRetry(
      { status: 429, message: "still limited" },
      first.selection,
      catalog,
      [],
      first.state,
      { runtimeSelectedProvider: null, runtimeSelectedModel: null },
    );
    expect(second.action).toBe("give_up");
  });

  // `resolveRunnableSelection` et `catalogValidatedSelection` tiennent déjà cette
  // règle : `model_options.reasoning_effort` ne part que pour un modèle qui
  // raisonne. Le repli la contournait en recopiant l'effort du modèle de départ.
  test("drops the reasoning effort when the fallback model does not reason", () => {
    const plan = planProviderRetry(
      { status: 429, message: "HTTP 429: The usage limit has been reached" },
      { provider: "openai-codex", model: "gpt-5.4", reasoningEffort: "high" },
      catalog,
      [],
      emptyState(),
      { runtimeSelectedProvider: null, runtimeSelectedModel: null },
    );
    expect(plan.action).toBe("retry");
    if (plan.action !== "retry") return;
    expect(plan.selection.model).toBe("x-preview-f-free");
    expect(plan.selection.reasoningEffort).toBeNull();
  });

  test("keeps the reasoning effort when the fallback model reasons", () => {
    const withReasoningFallback: HermesModelOptions = {
      ...catalog,
      providers: catalog.providers.map((provider) => provider.slug === "opencode-free"
        ? { ...provider, models: [{ id: "hy3-free", fast: true, reasoning: true }] }
        : provider),
    };
    const plan = planProviderRetry(
      { status: 429, message: "HTTP 429: The usage limit has been reached" },
      { provider: "openai-codex", model: "gpt-5.4", reasoningEffort: "high" },
      withReasoningFallback,
      [],
      emptyState(),
      { runtimeSelectedProvider: null, runtimeSelectedModel: null },
    );
    expect(plan.action).toBe("retry");
    if (plan.action !== "retry") return;
    expect(plan.selection.reasoningEffort).toBe("high");
  });

  // Operator decision (2026-10-24): an expired xAI login was answered by
  // Anthropic, silently, run after run. An authentication failure of the
  // bot's provider is never re-routed, even with usable providers around.
  test("never re-routes an authentication failure", () => {
    for (const failure of [
      { status: 401, message: "not authenticated" },
      { message: "Provider authentication failed: xAI token refresh failed. Response: {\"error\":\"invalid_grant\"}" },
    ]) {
      const plan = planProviderRetry(failure, selection, catalog, [], emptyState(),
        { runtimeSelectedProvider: "opencode-free", runtimeSelectedModel: "nemotron" });
      expect(plan).toEqual({ action: "give_up", kind: "auth" });
    }
  });

  test("model_unsupported on the fallback tries the next model once", () => {
    const first = planProviderRetry(
      { status: 429, message: "HTTP 429: rate limit" },
      selection,
      catalog,
      [],
      emptyState(),
      { runtimeSelectedProvider: null, runtimeSelectedModel: null },
    );
    expect(first.action).toBe("retry");
    if (first.action !== "retry") return;
    const next = planProviderRetry(
      { status: 401, message: "Model x-preview-f-free is not supported" },
      first.selection,
      catalog,
      [],
      first.state,
      { runtimeSelectedProvider: null, runtimeSelectedModel: null },
    );
    expect(next.action).toBe("retry");
    if (next.action !== "retry") return;
    expect(next.selection.model).toBe("nemotron");
    expect(next.state.extraModelTried).toBe(true);
  });
});

describe("resolveRunnableSelection excludes incidents and virtual aggregates", () => {
  const ambiguous: HermesModelOptions = {
    ...catalog,
    provider: "openai-api",
    model: "gpt-5.4-mini",
    providers: [
      { ...catalog.providers[1]!, models: [{ id: "gpt-5.4-mini", fast: true, reasoning: true }] },
      { ...catalog.providers[1]!, slug: "openai-api", isCurrent: true,
        models: [{ id: "gpt-5.4-mini", fast: true, reasoning: true }] },
    ],
  };
  const implicit = { provider: null, model: "gpt-5.4-mini", reasoningEffort: "low" };

  test("keeps the profile provider when another provider lists the same model first", () => {
    expect(resolveRunnableSelection(ambiguous, implicit)).toEqual({ ...implicit, provider: "openai-api" });
  });

  test("uses the selected runtime provider when the profile has no current provider", () => {
    expect(resolveRunnableSelection({ ...ambiguous, provider: null, model: null }, implicit, [],
      { provider: "openai-api", model: "gpt-5.4-mini" }))
      .toEqual({ ...implicit, provider: "openai-api" });
  });

  test("an explicit provider still wins over the profile provider", () => {
    expect(resolveRunnableSelection(ambiguous, { ...implicit, provider: "openai-codex" })?.provider)
      .toBe("openai-codex");
  });

  test("the profile preference cannot bypass an incident or missing authentication", () => {
    expect(resolveRunnableSelection(ambiguous, implicit,
      [{ provider: "openai-api", until: new Date(Date.now() + 60_000) }])?.provider).toBe("openai-codex");
    expect(resolveRunnableSelection({ ...ambiguous, providers: ambiguous.providers.map((provider) =>
      provider.slug === "openai-api" ? { ...provider, authenticated: false } : provider) }, implicit)?.provider)
      .toBe("openai-codex");
  });

  test("an auth incident keeps the run on its own provider; a quota one routes around it", () => {
    const until = new Date(Date.now() + 60_000);
    const chosen = { provider: "openai-codex", model: "gpt-5.4", reasoningEffort: null };
    expect(resolveRunnableSelection(catalog, chosen, [{ provider: "openai-codex", until, kind: "auth" }])?.provider)
      .toBe("openai-codex");
    expect(resolveRunnableSelection(catalog, { ...chosen, provider: null }, [{ provider: "openai-codex", until, kind: "auth" }])?.provider)
      .toBe("openai-codex");
    expect(resolveRunnableSelection(catalog, chosen, [{ provider: "openai-codex", until, kind: "quota" }])?.provider)
      .toBe("opencode-free");
  });

  test("skips moa and a provider under incident", () => {
    const resolved = resolveRunnableSelection(
      catalog,
      { provider: "openai-codex", model: "gpt-5.4", reasoningEffort: null },
      [{ provider: "openai-codex", until: new Date(Date.now() + 60_000) }],
    );
    expect(resolved?.provider).toBe("opencode-free");
    expect(resolved?.provider).not.toBe("moa");
  });
});

describe("a chosen provider that lost its login is never served by another one", () => {
  const loggedOut: HermesModelOptions = {
    ...catalog,
    providers: catalog.providers.map((provider) =>
      provider.slug === "openai-codex" ? { ...provider, authenticated: false } : provider),
  };
  const chosen = { provider: "openai-codex", model: "gpt-5.4", reasoningEffort: null };
  const future = () => new Date(Date.now() + 60_000);

  test("names the chosen provider instead of falling back", () => {
    // Before: resolveRunnableSelection served this run on opencode-free, silently.
    expect(resolveRunnableSelection(loggedOut, chosen)?.provider).toBe("opencode-free");
    expect(chosenProviderAuthRequired(loggedOut, chosen)).toBe("openai-codex");
  });

  test("stays out of the way when the provider is logged in, implicit, or under quota", () => {
    expect(chosenProviderAuthRequired(catalog, chosen)).toBeNull();
    expect(chosenProviderAuthRequired(loggedOut, { ...chosen, provider: null })).toBeNull();
    expect(chosenProviderAuthRequired(loggedOut, { ...chosen, model: null })).toBeNull();
    expect(chosenProviderAuthRequired(catalog, { ...chosen, provider: "moa", model: "ensemble" })).toBeNull();
    expect(chosenProviderAuthRequired(loggedOut, chosen, [{ provider: "openai-codex", until: future(), kind: "quota" }])).toBeNull();
    expect(chosenProviderAuthRequired(loggedOut, chosen, [{ provider: "openai-codex", until: future(), kind: "auth" }]))
      .toBe("openai-codex");
  });

  test("a chosen provider gone from the catalogue is named, never silently replaced", () => {
    // Upstream lists authenticated providers only: a removed login vanishes.
    const vanished: HermesModelOptions = {
      ...catalog,
      providers: catalog.providers.filter((provider) => provider.slug !== "openai-codex"),
    };
    // Before: resolution served this run on opencode-free, with no fallback event.
    expect(resolveRunnableSelection(vanished, chosen)?.provider).toBe("opencode-free");
    expect(chosenProviderAuthRequired(vanished, chosen)).toBe("openai-codex");
    expect(chosenProviderAuthRequired(catalog, { ...chosen, provider: "gone" })).toBe("gone");
    // A quota incident on it still routes around it, like a listed provider.
    expect(chosenProviderAuthRequired(vanished, chosen, [{ provider: "openai-codex", until: future(), kind: "quota" }]))
      .toBeNull();
  });

  test("a new run fails with PROVIDER_AUTH_REQUIRED naming the provider", async () => {
    const tx = async () => [];
    const db = { begin: async (callback: (sql: typeof tx) => Promise<unknown>) => callback(tx) };
    const context = {
      id: "run-1",
      organizationId: "org-1",
      runtimeId: "runtime-1",
      provider: "openai-codex",
      model: "gpt-5.4",
      reasoningEffort: null,
      hermesProfile: null,
      runtimeSelectedProvider: null,
      runtimeSelectedModel: null,
      linkFeatures: [],
    } as unknown as RunContext;
    const failure = await resolveSelectionForNewRun(db as never, {} as never, context, Promise.resolve(loggedOut))
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(NamedRunError);
    expect((failure as NamedRunError).code).toBe("PROVIDER_AUTH_REQUIRED");
    expect((failure as NamedRunError).details).toEqual({ provider: "openai-codex" });
  });
});

describe("applyFallbackProfileModel", () => {
  const selection = { provider: "opencode-free", model: "nemotron" };
  const able = { linkFeatures: [PROFILE_MANAGEMENT_FEATURE] };

  function recordingClient(): {
    client: { hostSetProfileModel: (profile: string, input: { provider: string; model: string }) => Promise<{ profile: string; provider: string; model: string; applied: boolean }> };
    calls: Array<{ profile: string; provider: string; model: string }>;
  } {
    const calls: Array<{ profile: string; provider: string; model: string }> = [];
    return {
      calls,
      client: {
        hostSetProfileModel: async (profile, input) => {
          calls.push({ profile, ...input });
          return { profile, provider: input.provider, model: input.model, applied: true };
        },
      },
    };
  }

  test("writes the profile model when the host announces profile_management", async () => {
    const { client, calls } = recordingClient();
    expect(await applyFallbackProfileModel(client, "atlas", able, selection)).toBe(true);
    expect(calls).toEqual([{ profile: "atlas", ...selection }]);
  });

  // Un profil explicite ou importé n'est pas « possédé » par openedbot, mais le
  // gateway route quand même ses runs sur son bloc `model` : le droit d'écrire
  // vient de la capacité hôte, jamais de `hermes_profile_managed`.
  test("does not depend on OHB owning the profile", async () => {
    const { client, calls } = recordingClient();
    expect(await applyFallbackProfileModel(client, "imported-bot", able, selection)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("writes nothing without the announced capability, and nothing without a profile", async () => {
    const { client, calls } = recordingClient();
    expect(await applyFallbackProfileModel(client, "atlas", { linkFeatures: [] }, selection)).toBe(false);
    expect(await applyFallbackProfileModel(client, "atlas", { linkFeatures: ["mcp_management"] }, selection)).toBe(false);
    expect(await applyFallbackProfileModel(client, null, able, selection)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("an unproven write is reported as unproven", async () => {
    const refusing = {
      hostSetProfileModel: async () => { throw new Error("host refused"); },
    };
    expect(await applyFallbackProfileModel(refusing, "atlas", able, selection)).toBe(false);
  });
});

describe("fallback helpers", () => {
  test("mentions the attempted fallback on the original error", () => {
    expect(fallbackFailureMessage("quota", { provider: "opencode-free", model: "nemotron", reason: "quota", reasoning: false }))
      .toContain("opencode-free / nemotron");
  });

  test("idempotency keys differ between fallback and extra model", () => {
    expect(fallbackIdempotencyKey("run-1", false)).toBe("run-1:fallback");
    expect(fallbackIdempotencyKey("run-1", true)).toBe("run-1:fallback2");
  });

  test("payload is the run.provider_fallback notice", () => {
    expect(providerFallbackPayload("openai-codex", {
      provider: "opencode-free",
      model: "nemotron",
      reason: "quota",
      reasoning: false,
    })).toMatchObject({
      from: "openai-codex",
      to: "opencode-free",
      model: "nemotron",
      reason: "quota",
    });
  });

  test("an auth failure names the provider to reconnect", () => {
    expect(providerAuthRequiredPayload("xai-oauth")).toEqual({
      errorCode: "PROVIDER_AUTH_REQUIRED",
      provider: "xai-oauth",
      message: "xai-oauth a refusé l’authentification de ce bot. Reconnectez xai-oauth dans Réglages → Modèles.",
    });
  });

  test("email dedupe key is per runtime, provider and day", () => {
    expect(quotaEmailDedupeKey("rt-1", "openai-codex", new Date("2026-09-04T20:03:00.000Z")))
      .toBe("provider-quota:rt-1:openai-codex:2026-09-04");
  });
});

describe("reconciledFailureMessage", () => {
  test("says why the first provider was left when the fallback also failed", () => {
    const payload = { from: "openai-codex", to: "opencode-free", model: "x-preview-f-free", reason: "auth" };
    expect(reconciledFailureMessage(payload)).toBe(
      "Le run Hermes a échoué : openai-codex a refusé l’authentification de ce bot, puis le repli sur opencode-free / x-preview-f-free n’a pas abouti.",
    );
    expect(reconciledFailureMessage({ ...payload, reason: "quota" })).toContain("a atteint sa limite d’usage");
    expect(reconciledFailureMessage({ ...payload, reason: "model_unsupported" })).toContain("ne sert pas ce modèle");
    expect(reconciledFailureMessage({ to: "opencode-free", reason: "other" })).toBe("Le run Hermes a échoué après un repli sur opencode-free.");
  });

  test("keeps the generic message without a fallback", () => {
    expect(reconciledFailureMessage(null)).toBe("Le run Hermes a échoué.");
    expect(reconciledFailureMessage(undefined)).toBe("Le run Hermes a échoué.");
    expect(reconciledFailureMessage({ reason: "auth" })).toBe("Le run Hermes a échoué : le fournisseur du bot a refusé l’authentification de ce bot.");
  });
});
