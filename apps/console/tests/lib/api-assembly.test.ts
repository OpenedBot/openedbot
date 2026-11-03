import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { RuntimeConfigurationDto, RuntimePublicDto } from "@openedbot/contracts-api";
import { api } from "../../src/lib/api";
import { mergeApiParts } from "../../src/lib/api/merge";

/**
 * `lib/api.ts` assembles `api` from its domain parts (`lib/api/<domain>.ts`).
 * What a plain `{ ...a, ...b }` would have broken stays covered here: a getter
 * reads the assembled object, and a call between parts goes through the
 * assembled object, so a test spy intercepts it.
 */
afterEach(() => mock.restore());

test("the roster alias follows the assembled roster", () => {
  const roster = spyOn(api, "roster").mockResolvedValue({ bots: [], sections: [], groups: [], operator: null } as never);
  expect(api.rosterIncludingHidden).toBe(api.roster);
  expect(roster).not.toHaveBeenCalled();
});

test("a call between domain parts goes through the assembled object", async () => {
  const runtime = { id: "runtime-1" } as RuntimePublicDto;
  const configuration = spyOn(api, "runtimeConfiguration").mockResolvedValue({ runtime } as RuntimeConfigurationDto);
  expect(await api.runtime()).toBe(runtime);
  expect(configuration).toHaveBeenCalledTimes(1);
});

test("a key defined in two parts is refused at load", () => {
  expect(() => mergeApiParts({ health: () => 1 }, { health: () => 2 })).toThrow("lib/api: health is defined twice.");
  const getter = mergeApiParts({ value: 1, get double() { return (this as { value: number }).value * 2; } });
  expect(getter.double).toBe(2);
});
