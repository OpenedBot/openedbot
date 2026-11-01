import { describe, expect, test } from "bun:test";
import { RELAY_MAX_REQUEST_BODY } from "@openedbot/contracts-connector";
import { fitHermesRunImages, hermesRunRequestBody } from "../../src/client/run-body";

const base = { input: "describe it", instructions: "", sessionId: "session-1" };

describe("Hermes run images", () => {
  test("an image turns input into one multimodal user message", () => {
    const body = hermesRunRequestBody({
      ...base,
      images: [{ name: "a.png", dataUrl: "data:image/png;base64,AAAA" }],
    });
    expect(body.input).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "describe it" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    }]);
  });

  test("an image that would push the body over the relay bound is dropped, not sent", () => {
    const small = { name: "small.png", dataUrl: `data:image/png;base64,${"A".repeat(1000)}` };
    const huge = { name: "huge.png", dataUrl: `data:image/png;base64,${"A".repeat(RELAY_MAX_REQUEST_BODY)}` };
    const fitted = fitHermesRunImages({ ...base, images: [huge, small] });
    expect(fitted.images.map((image) => image.name)).toEqual(["small.png"]);
    expect(fitted.dropped.map((image) => image.name)).toEqual(["huge.png"]);
  });
});

describe("Hermes run model options", () => {
  test("the prompt-cache tier travels in model_options, beside the reasoning effort", () => {
    expect(hermesRunRequestBody({ ...base, reasoningEffort: "low", promptCacheTtl: "5m" }).model_options)
      .toEqual({ reasoning_effort: "low", prompt_cache_ttl: "5m" });
    expect(hermesRunRequestBody({ ...base, promptCacheTtl: "5m" }).model_options).toEqual({ prompt_cache_ttl: "5m" });
    expect(hermesRunRequestBody({ ...base, reasoningEffort: "high" }).model_options).toEqual({ reasoning_effort: "high" });
  });

  test("no option at all sends no model_options key", () => {
    expect("model_options" in hermesRunRequestBody({ ...base, promptCacheTtl: null, reasoningEffort: null })).toBe(false);
  });
});
