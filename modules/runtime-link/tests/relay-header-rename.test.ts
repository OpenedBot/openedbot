import { describe, expect, test } from "bun:test";
import { relayStageOf } from "@openedbot/contracts-connector";
import { relayHopped } from "../src/application/instances";

// X-OHB-Relay-* -> X-OpenedBot-Relay-*: during a redeploy an instance still on
// the previous release sets the old name. One hop must stay one hop, and a
// link failure must stay a link failure, whichever name carries it.
describe("relay headers renamed, the former name read for one release", () => {
  test("a hop marked under either name is a hop", () => {
    const of = (headers: Record<string, string>) => relayHopped((name) => new Headers(headers).get(name) ?? undefined);
    expect(of({ "X-OpenedBot-Relay-Hop": "1" })).toBe(true);
    expect(of({ "x-ohb-relay-hop": "1" })).toBe(true);
    expect(of({})).toBe(false);
  });

  test("the relay stage reads the new name first, then the former one", () => {
    expect(relayStageOf(new Headers({ "X-OHB-Relay-Stage": "before_dispatch" }))).toBe("before_dispatch");
    expect(relayStageOf(new Headers({ "X-OHB-Relay-Stage": "before_dispatch", "X-OpenedBot-Relay-Stage": "after_dispatch" }))).toBe("after_dispatch");
    expect(relayStageOf(new Headers())).toBeNull();
  });
});
