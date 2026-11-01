import { expect, test } from "bun:test";
import type { RuntimeModelDto, RuntimeModelProviderDto } from "@openedbot/contracts-api";
import { preferenceForProvider } from "../../../../src/screens/settings/installation/models-preference-panel";

const model = (id: string, isRuntimeDefault = false): RuntimeModelDto => ({
  id, fast: false, reasoning: true, isRuntimeDefault, freeTier: null,
});
const provider = (slug: string, models: RuntimeModelDto[]): RuntimeModelProviderDto => ({
  slug, name: slug, isCurrent: false, authenticated: true, alwaysAuthenticated: false, provesInference: true,
  acceptsApiKey: true, acceptsOauth: false, sdkInstalled: true, sdkInstallable: false, warning: null,
  authCommand: null, models,
});

test("switching provider drafts its default tier, even over the host's current model", () => {
  const anthropic = provider("anthropic", [model("claude-fable-5.1", true), model("claude-opus-5-5"), model("claude-sonnet-5-5")]);
  expect(preferenceForProvider(anthropic, "anthropic").model).toBe("claude-sonnet-5-5");
  const codex = provider("openai-codex", [model("gpt-6.1-sol"), model("gpt-6-luna-900k"), model("gpt-6-luna")]);
  expect(preferenceForProvider(codex, "openai-codex").model).toBe("gpt-6-luna");
});

test("a provider without a default tier keeps the host default, then the first model", () => {
  expect(preferenceForProvider(provider("xai-oauth", [model("grok-4.7"), model("grok-4.6", true)]), "xai-oauth").model).toBe("grok-4.6");
  expect(preferenceForProvider(provider("xai-oauth", [model("grok-4.7"), model("grok-4.6")]), "xai-oauth").model).toBe("grok-4.7");
  expect(preferenceForProvider(null, null).model).toBeNull();
});
