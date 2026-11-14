import { describe, expect, test } from "bun:test";
import {
  classifyProviderFailure,
  isModelUnavailableFailure,
  isVirtualAggregateProvider,
  providerIncidentTtlHours,
} from "../src/domain/provider-failure";

describe("classifyProviderFailure", () => {
  test("quota : 429, usage limit, rate limit, quota", () => {
    expect(classifyProviderFailure({ status: 429, message: "too many requests" })).toBe("quota");
    expect(classifyProviderFailure("HTTP 429: The usage limit has been reached")).toBe("quota");
    expect(classifyProviderFailure(new Error("Provider rate limit exceeded"))).toBe("quota");
    expect(classifyProviderFailure({ error: "quota exceeded for this key" })).toBe("quota");
  });

  test("a refusal by the gateway itself is not a provider failure", () => {
    expect(classifyProviderFailure({ status: 429, code: "HERMES_LIMIT_REACHED", message: "Hermes a atteint sa limite de runs simultanés." })).toBe("other");
    expect(classifyProviderFailure({ status: 401, code: "HERMES_TOKEN_REJECTED", message: "Le token Hermes a été refusé." })).toBe("other");
    expect(classifyProviderFailure({ status: 503, code: "HERMES_GATEWAY_DRAINING", message: "Le gateway Hermes redémarre." })).toBe("other");
  });

  test("auth : 401/403, authentication failed, not authenticated", () => {
    expect(classifyProviderFailure({ status: 401, message: "Missing Authentication header" })).toBe("auth");
    expect(classifyProviderFailure({ status: 403, message: "forbidden" })).toBe("auth");
    expect(classifyProviderFailure("Provider authentication failed: No inference provider configured.")).toBe("auth");
    expect(classifyProviderFailure({ message: "not authenticated" })).toBe("auth");
  });

  test("model_unsupported prime sur un 401 « not supported »", () => {
    expect(classifyProviderFailure({
      status: 401,
      message: "Model x-preview-f-free is not supported",
    })).toBe("model_unsupported");
    expect(classifyProviderFailure("HTTP 401: Model nemotron is not supported")).toBe("model_unsupported");
  });

  test("other : tout le reste", () => {
    expect(classifyProviderFailure({})).toBe("other");
    expect(classifyProviderFailure(null)).toBe("other");
    expect(classifyProviderFailure(new Error("connection reset"))).toBe("other");
    expect(classifyProviderFailure({ status: 500, message: "internal" })).toBe("other");
  });
});

describe("virtual aggregates", () => {
  test("moa n'est jamais un repli", () => {
    expect(isVirtualAggregateProvider("moa")).toBe(true);
    expect(isVirtualAggregateProvider("opencode-free")).toBe(false);
  });

  test("TTL : 6 h quota, 24 h auth", () => {
    expect(providerIncidentTtlHours("quota")).toBe(6);
    expect(providerIncidentTtlHours("auth")).toBe(24);
  });
});

describe("isModelUnavailableFailure", () => {
  test("reconnaît les messages réels de modèle refusé", () => {
    expect(isModelUnavailableFailure("HTTP 400: Upstream request failed: Model is unavailable.")).toBe(true);
    expect(isModelUnavailableFailure({ message: "Upstream request failed: Model is unavailable." })).toBe(true);
    expect(isModelUnavailableFailure(
      "HTTP 404: The model `gpt-9` does not exist or you do not have access to it.",
    )).toBe(true);
    expect(isModelUnavailableFailure({ status: 404, code: "model_not_found", message: "no such thing" })).toBe(true);
    expect(isModelUnavailableFailure("You do not have access to the model gpt-9")).toBe(true);
    expect(isModelUnavailableFailure(new Error("Model xyz is currently unavailable"))).toBe(true);
  });

  test("ne confond pas avec une autre panne", () => {
    expect(isModelUnavailableFailure("HTTP 429: The usage limit has been reached")).toBe(false);
    expect(isModelUnavailableFailure({ status: 429, message: "Model is unavailable, too many requests" })).toBe(false);
    expect(isModelUnavailableFailure("HTTP 503: Service unavailable")).toBe(false);
    expect(isModelUnavailableFailure("HTTP 400: Upstream request failed: connection reset")).toBe(false);
    expect(isModelUnavailableFailure(new Error("fetch failed: ECONNREFUSED"))).toBe(false);
    expect(isModelUnavailableFailure("Run Hermes annulé.")).toBe(false);
    expect(isModelUnavailableFailure("HTTP 401: Model nemotron is not supported")).toBe(false);
    expect(isModelUnavailableFailure("The model is overloaded. Try again.")).toBe(false);
    expect(isModelUnavailableFailure("Model answered. Upstream unavailable.")).toBe(false);
    expect(isModelUnavailableFailure({})).toBe(false);
    expect(isModelUnavailableFailure(null)).toBe(false);
  });
});
