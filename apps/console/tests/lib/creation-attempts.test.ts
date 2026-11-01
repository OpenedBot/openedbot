import { describe, expect, test } from "bun:test";
import { creationAttempts } from "../../src/lib/creation-attempts";

function counter() {
  let next = 0;
  return () => `id-${++next}`;
}

describe("creationAttempts: one request id per creation content", () => {
  test("the same content keeps its id, whatever the key order", () => {
    const attempts = creationAttempts(counter());
    const first = attempts.idFor({ name: "Atlas", face: { palette: "bleu", eyes: "curieux" } });
    expect(attempts.idFor({ face: { eyes: "curieux", palette: "bleu" }, name: "Atlas" })).toBe(first);
  });

  test("an edit mints a new id, and going back to the old content does not revive the old id", () => {
    const attempts = creationAttempts(counter());
    const first = attempts.idFor({ name: "Atlas" });
    const renamed = attempts.idFor({ name: "Atlas bis" });
    expect(renamed).not.toBe(first);
    expect(attempts.idFor({ name: "Atlas bis" })).toBe(renamed);
    expect(attempts.idFor({ name: "Atlas" })).not.toBe(first);
  });

  test("a nested change (persona, copied settings) is an edit too", () => {
    const attempts = creationAttempts(counter());
    const first = attempts.idFor({ copied: { model: "a" }, instructions: "x" });
    expect(attempts.idFor({ copied: { model: "b" }, instructions: "x" })).not.toBe(first);
  });

  test("reset starts a new creation even with the same content", () => {
    const attempts = creationAttempts(counter());
    const first = attempts.idFor({ name: "Atlas" });
    attempts.reset();
    expect(attempts.idFor({ name: "Atlas" })).not.toBe(first);
  });
});
