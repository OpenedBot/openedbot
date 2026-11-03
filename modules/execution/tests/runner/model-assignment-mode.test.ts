import { describe, expect, test } from "bun:test";
import { applyRuntimeModelSelection } from "../../src/application/runner/provider-recovery";

const bot = { model: "gpt-5.6-luna", reasoningEffort: "high" };
const runtime = { provider: "xai-oauth", model: "grok-4.6", reasoningEffort: "minimal" };

describe("applyRuntimeModelSelection en mode per_bot", () => {
  test("le modèle du bot prime, son fournisseur reste à résoudre", () => {
    expect(applyRuntimeModelSelection(bot, runtime, "per_bot")).toEqual({
      model: "gpt-5.6-luna",
      // Volontairement nul : un même id est listé par plusieurs fournisseurs, et
      // c'est `resolveRunnableSelection` qui désigne celui qui l'authentifie.
      provider: null,
      reasoningEffort: "high",
    });
  });

  test("un bot sans modèle suit le choix global, fournisseur compris", () => {
    expect(applyRuntimeModelSelection({ model: null, reasoningEffort: null }, runtime, "per_bot")).toEqual({
      model: "grok-4.6",
      provider: "xai-oauth",
      reasoningEffort: "minimal",
    });
  });

  test("le mode par défaut est per_bot, donc le comportement d'avant la 0072", () => {
    expect(applyRuntimeModelSelection(bot, runtime)).toEqual(
      applyRuntimeModelSelection(bot, runtime, "per_bot"),
    );
  });
});

describe("applyRuntimeModelSelection en mode global", () => {
  test("le choix global l'emporte sur le modèle propre du bot", () => {
    expect(applyRuntimeModelSelection(bot, runtime, "global")).toEqual({
      model: "grok-4.6",
      provider: "xai-oauth",
      reasoningEffort: "minimal",
    });
  });

  test("l'effort du bot ne survit pas non plus : le global est un couple entier", () => {
    expect(applyRuntimeModelSelection(bot, { ...runtime, reasoningEffort: null }, "global").reasoningEffort)
      .toBeNull();
  });

  // Le mode dit « suivez le global » ; sans global posé il n'y a rien à suivre.
  // Ignorer quand même le modèle du bot laisserait le run sans modèle du tout,
  // et Hermes retomberait sur son défaut, qui peut viser un fournisseur mort.
  test("sans choix global posé, le modèle du bot reprend la main", () => {
    expect(applyRuntimeModelSelection(bot, { provider: null, model: null, reasoningEffort: null }, "global"))
      .toEqual({ model: "gpt-5.6-luna", provider: null, reasoningEffort: "high" });
    expect(applyRuntimeModelSelection(bot, { provider: "xai-oauth", model: "   ", reasoningEffort: null }, "global").model)
      .toBe("gpt-5.6-luna");
  });

  test("sans choix global ni modèle de bot, il n'y a rien à envoyer", () => {
    expect(applyRuntimeModelSelection(
      { model: null, reasoningEffort: null },
      { provider: null, model: null, reasoningEffort: null },
      "global",
    )).toEqual({ model: null, provider: null, reasoningEffort: null });
  });
});
