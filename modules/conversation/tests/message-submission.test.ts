import { describe, expect, test } from "bun:test";
import { prepareMessageSubmission } from "../src/domain/message-submission";

let next = 0;
const key = () => `key-${(next += 1)}`;

describe("prepareMessageSubmission", () => {
  test("le même envoi rejoué garde sa clé", () => {
    const first = prepareMessageSubmission(null, { input: "bonjour", attachments: [], planOnly: true }, key);
    expect(first).toMatchObject({ input: "bonjour", planOnly: true });
    expect(prepareMessageSubmission(first, { input: "bonjour", attachments: [], planOnly: true }, key)).toBe(first);
  });

  test("« Planifier d'abord » posé ou retiré fait une autre opération", () => {
    const plain = prepareMessageSubmission(null, { input: "bonjour", attachments: [] }, key);
    expect("planOnly" in plain).toBe(false);
    const planned = prepareMessageSubmission(plain, { input: "bonjour", attachments: [], planOnly: true }, key);
    expect(planned.idempotencyKey).not.toBe(plain.idempotencyKey);
    expect(prepareMessageSubmission(plain, { input: "bonjour", attachments: [], planOnly: false }, key)).toBe(plain);
  });
});
