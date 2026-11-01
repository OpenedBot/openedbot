import { describe, expect, test } from "bun:test";
import { buildRuntimeMemoryBlock } from "../src/domain/bot-memory";

describe("buildRuntimeMemoryBlock", () => {
  test("nomme l'outil quand il existe, dit que la mémoire est coupée sinon, et interdit remember: dans les deux cas", () => {
    const on = buildRuntimeMemoryBlock({ toolEnabled: true });
    expect(on).toContain("## Memory");
    expect(on).toContain("call `memory` (`action: add`) BEFORE replying");
    expect(on).toContain("`target: user`");
    expect(on).toContain("Never write `remember:` or `forget:` lines");
    expect(on).not.toContain("Facts you previously recorded");
    const off = buildRuntimeMemoryBlock({ toolEnabled: false });
    expect(off).toContain("Memory is switched off on this profile");
    expect(off).toContain("Never write `remember:` or `forget:` lines");
    expect(off).not.toContain("action: add");
  });
});
