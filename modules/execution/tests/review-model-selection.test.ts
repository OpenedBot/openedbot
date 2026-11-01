import { describe, expect, test } from "bun:test";
import { reviewModelSelection } from "../src/application/approval-review";

const base = {
  botReasoningEffort: null,
  assignmentMode: "per_bot",
  selectedProvider: "anthropic",
  selectedModel: "claude-sonnet-5-5",
  selectedReasoningEffort: null,
};

describe("the model a review runs on", () => {
  test("the gated run's model, with the runtime's provider when it is the same model", () => {
    // Measured on the lab host: without a provider the gateway guessed
    // xai-oauth for this model, and every review failed with a 404.
    expect(reviewModelSelection({ ...base, botModel: "claude-sonnet-5-5" })).toMatchObject({
      model: "claude-sonnet-5-5",
      provider: "anthropic",
    });
  });

  test("another bot model keeps no provider: the runtime's would be wrong for it", () => {
    expect(reviewModelSelection({ ...base, botModel: "grok-5" })).toMatchObject({ model: "grok-5", provider: null });
  });

  test("no bot model: the runtime's selection, provider included", () => {
    expect(reviewModelSelection({ ...base, botModel: null })).toMatchObject({ model: "claude-sonnet-5-5", provider: "anthropic" });
  });

  test("global assignment keeps the runtime's pair", () => {
    expect(reviewModelSelection({ ...base, assignmentMode: "global", botModel: "grok-5" })).toMatchObject({
      model: "claude-sonnet-5-5",
      provider: "anthropic",
    });
  });
});
