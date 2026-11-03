import { expect, test } from "bun:test";
import { defaultTierModel } from "../src/domain/runtime/default-model";

const ids = (...list: string[]) => list.map((id) => ({ id }));
const pick = (...list: string[]) => defaultTierModel(ids(...list))?.id ?? null;

// The catalogues Hermes listed on lab VM 240 (2026-10-30), in Hermes order.
const ANTHROPIC = [
  "claude-fable-5.1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5",
  "claude-opus-4-8", "claude-sonnet-4-6", "claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514",
  "claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1",
];
const CODEX = [
  "gpt-6.1-sol", "gpt-6.1-sol-900k", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna",
  "gpt-6-luna-900k", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-luna-900k",
];

test("Claude defaults to the newest Sonnet, never Fable, Opus or Haiku", () => {
  expect(pick(...ANTHROPIC)).toBe("claude-sonnet-5-5");
});

test("GPT defaults to the newest Luna, never Sol, Astra, Terra or a long-context variant", () => {
  expect(pick(...CODEX)).toBe("gpt-6-luna");
  expect(pick("gpt-6-luna-900k", "gpt-5.6-luna")).toBe("gpt-5.6-luna");
});

test("Gemini defaults to Flash, not Pro nor Flash-Lite", () => {
  expect(pick("gemini-3-pro", "gemini-3-flash-lite", "gemini-2.5-flash", "gemini-3-flash")).toBe("gemini-3-flash");
});

test("an aggregator's prefixed ids are recognised", () => {
  expect(pick("anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "openai/gpt-6-luna")).toBe("anthropic/claude-sonnet-5");
});

test("no default tier: null, so the caller keeps its previous fallback", () => {
  expect(pick("grok-4.7", "grok-4.6", "grok-composer-2.5-fast")).toBeNull();
  expect(pick("claude-opus-5", "gpt-6-sol-900k", "gpt-6-luna-900k")).toBeNull();
  expect(pick()).toBeNull();
});
