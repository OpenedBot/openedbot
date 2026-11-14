import { describe, expect, test } from "bun:test";
import { resolveRunnableSelection, type RunSelectionCatalog } from "../src/domain/run-selection";

// The fast mode is billed at a higher rate: it reaches Hermes only for the
// model the bot chose, and only when the catalogue says that model offers it.
const catalog: RunSelectionCatalog = {
  provider: "openai-codex",
  model: "gpt-6-sol",
  providers: [
    {
      slug: "openai-codex",
      authenticated: true,
      models: [
        { id: "gpt-6-sol", reasoning: true, fast: true },
        { id: "gpt-6-luna", reasoning: true, fast: false },
      ],
    },
    { slug: "anthropic", authenticated: true, models: [{ id: "claude-opus-5", reasoning: true, fast: true }] },
  ],
};
const wish = { provider: null, reasoningEffort: "low", fastMode: true };

describe("resolveRunnableSelection and the fast mode", () => {
  test("kept for the chosen model when the catalogue marks it fast", () => {
    expect(resolveRunnableSelection(catalog, { ...wish, model: "gpt-6-sol" }))
      .toEqual({ provider: "openai-codex", model: "gpt-6-sol", reasoningEffort: "low", fastMode: true });
  });

  test("dropped on a model without fast mode", () => {
    const resolved = resolveRunnableSelection(catalog, { ...wish, model: "gpt-6-luna" });
    expect(resolved?.model).toBe("gpt-6-luna");
    expect(resolved && "fastMode" in resolved).toBe(false);
  });

  test("dropped when the run falls back to another model, even a fast one", () => {
    // The chosen model is gone from the catalogue: the runtime's default runs.
    const resolved = resolveRunnableSelection(catalog, { ...wish, model: "gpt-retired" });
    expect(resolved?.model).toBe("gpt-6-sol");
    expect(resolved && "fastMode" in resolved).toBe(false);
  });

  test("dropped when the chosen provider is under a quota incident and another serves", () => {
    const resolved = resolveRunnableSelection(
      catalog,
      { ...wish, provider: "anthropic", model: "claude-opus-5" },
      [{ provider: "anthropic", until: new Date(Date.now() + 60_000) }],
    );
    expect(resolved?.provider).toBe("openai-codex");
    expect(resolved && "fastMode" in resolved).toBe(false);
  });

  test("never added without the wish", () => {
    const resolved = resolveRunnableSelection(catalog, { provider: null, model: "gpt-6-sol", reasoningEffort: null });
    expect(resolved && "fastMode" in resolved).toBe(false);
  });
});
