import { expect, test } from "bun:test";
import {
  DEFAULT_CONTEXT_WINDOW,
  fallbackContextWindow,
  isDefaultContextWindow,
} from "../src/domain/runtime/model-context-window";

// La table est celle de `agent/model_metadata.py`. Ces tests tiennent sa
// sémantique, qui n'est pas celle qu'on attend d'une table de correspondance :
// sous-chaîne, clé la plus longue d'abord, et un défaut dur plutôt qu'un vide.

test("un modèle de la table rend sa fenêtre amont", () => {
  expect(fallbackContextWindow("gpt-5.6-luna")).toBe(1_050_000);
  expect(fallbackContextWindow("claude-sonnet-5")).toBe(1_000_000);
  expect(fallbackContextWindow("grok-4-fast")).toBe(2_000_000);
});

// C'est la règle qui surprend le plus : `gpt-5.4-mini` ne doit pas hériter des
// 1 050 000 de `gpt-5.4`, ni des 400 000 de `gpt-5` par accident.
test("la clé la plus longue gagne sur son fourre-tout", () => {
  expect(fallbackContextWindow("gpt-5.4-mini")).toBe(400_000);
  expect(fallbackContextWindow("gpt-5.4")).toBe(1_050_000);
  expect(fallbackContextWindow("gpt-5.3-codex-spark")).toBe(128_000);
  expect(fallbackContextWindow("claude-3-opus")).toBe(200_000);
});

// La recherche est une sous-chaîne : un identifiant préfixé ou suffixé par son
// fournisseur, ou une variante datée, retombe sur la même famille.
test("la recherche porte sur une sous-chaîne, pas sur l’égalité", () => {
  expect(fallbackContextWindow("openai/gpt-5.6-luna-preview")).toBe(1_050_000);
  expect(fallbackContextWindow("anthropic/claude-fable-5-20260401")).toBe(1_000_000);
});

test("la casse et les espaces ne changent rien", () => {
  expect(fallbackContextWindow("  GPT-5.6-Luna  ")).toBe(1_050_000);
});

// Un modèle hors table ne rend pas « inconnu » : il rend le plafond dur de
// l'amont, celui que l'agent applique lui-même faute de mieux.
test("un modèle hors table retombe sur le défaut de l’amont", () => {
  expect(fallbackContextWindow("un-modele-maison")).toBe(DEFAULT_CONTEXT_WINDOW);
  expect(isDefaultContextWindow("un-modele-maison")).toBe(true);
  expect(isDefaultContextWindow("gpt-5.6-luna")).toBe(false);
});

// Sans nom de modèle il n'y a rien à chercher : le défaut ne s'applique pas,
// parce qu'il vaut pour UN modèle inconnu, pas pour l'absence de modèle.
test("un nom vide ne rend aucune fenêtre", () => {
  expect(fallbackContextWindow("")).toBeNull();
  expect(fallbackContextWindow(null)).toBeNull();
  expect(fallbackContextWindow(undefined)).toBeNull();
  expect(isDefaultContextWindow(null)).toBe(false);
});
