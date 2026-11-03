import { expect, test } from "bun:test";
import { parseHermesBundleInput } from "../src/domain/validation";
import { profileCreationFailureState } from "../src/application/provision";
import { HermesClientError } from "@openedbot/hermes";
import { parseHermesProfileFiles } from "../src/domain/hermes-profile-bundle";
import { importDigest } from "../src/sql/jobs";

function bundle() {
  const parsed = parseHermesProfileFiles("scout", { "config.yaml": new TextEncoder().encode("name: Scout\nplatform_toolsets:\n  api_server:\n    memory: false\n") });
  if (!("entry" in parsed)) throw new Error("fixture");
  return { profiles: [parsed.entry], idempotencyKey: crypto.randomUUID() };
}
test("strict nested fields, booleans, duplicates, UTF-8 host name and bounded selection", () => {
  const input = bundle();
  expect(parseHermesBundleInput(input).input.profiles[0]?.toolsets).toEqual([{ name: "memory", enabled: false }]);
  for (const mutate of [
    (value: any) => value.profiles[0].model.api_key = "secret",
    (value: any) => value.profiles[0].toolsets[0].enabled = "false",
    (value: any) => value.profiles.push(value.profiles[0]),
    (value: any) => value.profiles[0].displayName = "é".repeat(61),
    (value: any) => value.profiles[0].name = "default",
    (value: any) => value.profiles[0].avatar = { contentType: "image/png", base64: "????" },
    (value: any) => value.profiles[0].uiMeta = { secret: true },
  ]) { const value = structuredClone(input); mutate(value); expect(() => parseHermesBundleInput(value)).toThrow(); }
});
test("normalization makes digest independent of object field order, but sensitive to selected projection", () => {
  const raw = bundle();
  const reordered = { idempotencyKey: raw.idempotencyKey, profiles: [{ ...raw.profiles[0], model: { provider: null, default: null } }] };
  expect(importDigest(parseHermesBundleInput(raw).input)).toBe(importDigest(parseHermesBundleInput(reordered).input));
  reordered.profiles[0]!.displayName = "Changed";
  expect(importDigest(parseHermesBundleInput(raw).input)).not.toBe(importDigest(parseHermesBundleInput(reordered).input));
});
test("only confirmed create outcomes establish ownership", () => {
  expect(profileCreationFailureState(new HermesClientError("exists", 409, "PROFILE_EXISTS"))).toBe("not_created");
  expect(profileCreationFailureState(new HermesClientError("created but verification failed", 502, "PROFILE_UNVERIFIED"))).toBe("created");
  expect(profileCreationFailureState(new Error("lost response"))).toBe("unknown");
});
