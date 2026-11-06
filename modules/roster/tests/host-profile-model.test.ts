import { expect, test } from "bun:test";
import { resolveImportedModel } from "../src/application/host-profile-model";
import type { HermesModelOptions } from "@openedbot/hermes";
const load = async () => ({ providers: [{ slug: "provider", authenticated: true, models: [{ id: "available" }, { id: "fallback" }] }] }) as Pick<HermesModelOptions, "providers">;
test("available explicit models survive; unavailable models fall back without a stale bot override", async () => {
  const profile = { name: "scout", model: { default: "available", provider: "provider" } };
  expect(await resolveImportedModel(profile, {}, load)).toMatchObject({ model: "available", selection: { model: "available", provider: "provider" }, limitations: [] });
  profile.model.default = "missing";
  expect(await resolveImportedModel(profile, { selectedModel: "fallback", selectedProvider: "provider" }, load)).toMatchObject({ model: null, selection: { model: "fallback", provider: "provider" } });
  expect(await resolveImportedModel(profile, {}, load)).toMatchObject({ model: null, selection: null, limitations: ["model-not-available:scout:provider/missing", "profile-model-unset:scout"] });
});
