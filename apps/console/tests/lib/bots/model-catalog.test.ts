import { describe, expect, test } from "bun:test";
import { modelsByRelease, runtimeGlobalModel } from "../../../src/lib/bots/model-catalog";

describe("runtimeGlobalModel : le même « modèle global » que Réglages → Modèles", () => {
  const host = { runtimeDefaultModel: "nemotron-3.5-lightning-free" };

  test("la préférence openedbot prime sur le modèle courant de l'hôte", () => {
    expect(runtimeGlobalModel({ selectedProvider: "openai-codex", selectedModel: "gpt-5.6-luna" }, host)).toBe("gpt-5.6-luna");
  });

  test("sans préférence, Hermes décide : c'est le modèle de l'hôte", () => {
    expect(runtimeGlobalModel({ selectedProvider: null, selectedModel: null }, host)).toBe("nemotron-3.5-lightning-free");
    expect(runtimeGlobalModel(null, host)).toBe("nemotron-3.5-lightning-free");
    expect(runtimeGlobalModel(null, null)).toBeNull();
  });

  test("un fournisseur épinglé sans modèle ne retombe pas sur le repli écrit par le worker", () => {
    expect(runtimeGlobalModel({ selectedProvider: "openai-codex", selectedModel: null }, host)).toBeNull();
  });
});

describe("modelsByRelease : les modèles d'un fournisseur, du plus récent au plus ancien", () => {
  const ids = (list: string[]) => modelsByRelease(list.map((id) => ({ id }))).map((model) => model.id);

  test("la version prime sur l'ordre de Hermes, la date départage", () => {
    expect(ids([
      "claude-opus-4-5-20251101",
      "claude-opus-5",
      "claude-haiku-4-5-20251001",
      "claude-fable-5.1",
      "claude-opus-5-5",
      "claude-opus-4-20250514",
    ])).toEqual([
      "claude-opus-5-5",
      "claude-fable-5.1",
      "claude-opus-5",
      "claude-opus-4-5-20251101",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-20250514",
    ]);
  });

  test("une mineure à points se lit en décimale et une variante garde l'ordre de Hermes", () => {
    expect(ids(["grok-4.20-0309-reasoning", "gpt-x", "grok-4.3", "grok-4.7"])).toEqual([
      "grok-4.7",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "gpt-x",
    ]);
    expect(ids(["gpt-6-sol", "gpt-6-sol-900k", "gpt-6.1-sol"])).toEqual(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-sol-900k"]);
  });

  test("deux alias d'un même modèle n'en font qu'un, le choix enregistré reste visible", () => {
    const models = ["claude-fable-5.1", "claude-opus-5-5", "claude-fable-5-1"].map((id) => ({ id }));
    expect(modelsByRelease(models).map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-fable-5.1"]);
    expect(modelsByRelease(models, ["claude-fable-5-1"]).map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-fable-5-1"]);
  });
});
