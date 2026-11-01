import { describe, expect, test } from "bun:test";
import { nextThreadPin, threadContainsOutgoingUserInput, withOutgoingUserInput } from "../../src/lib/thread-anchor";

const bottom = { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 };
const grown = { scrollTop: 800, scrollHeight: 1256, clientHeight: 200 };
const userUp = { scrollTop: 400, scrollHeight: 1000, clientHeight: 200 };
const keyboard = { scrollTop: 800, scrollHeight: 1000, clientHeight: 120 };

describe("nextThreadPin", () => {
  test("image decode : scrollHeight grandit, le pin tient", () => {
    expect(nextThreadPin(bottom, grown, true)).toBe(true);
  });

  test("image decode hors pin : on ne recolle pas", () => {
    expect(nextThreadPin(userUp, { ...userUp, scrollHeight: 1256 }, false)).toBe(false);
  });

  test("geste molette / doigt vers le haut : on lâche", () => {
    expect(nextThreadPin(bottom, userUp, true)).toBe(false);
  });

  test("retour dans les 40 px du fond : on re-pin", () => {
    expect(nextThreadPin(userUp, { scrollTop: 970, scrollHeight: 1000, clientHeight: 200 }, false)).toBe(true);
  });

  test("clavier / composer : clientHeight rétrécit, le pin tient", () => {
    expect(nextThreadPin(bottom, keyboard, true)).toBe(true);
  });

  test("contenu qui rétrécit en baissant scrollTop : pas un geste", () => {
    expect(
      nextThreadPin(bottom, { scrollTop: 700, scrollHeight: 900, clientHeight: 200 }, true),
    ).toBe(true);
  });
});

describe("withOutgoingUserInput", () => {
  test("sans envoi en vol : le snapshot inchangé", () => {
    const inputs = [{ id: "m1", text: "hello" }];
    expect(withOutgoingUserInput(inputs, null)).toEqual(inputs);
  });

  test("envoi en vol : la bulle s'ajoute en bas", () => {
    expect(
      withOutgoingUserInput(
        [{ id: "m1", text: "hello" }],
        { id: "pending:k", text: "Ping" },
      ),
    ).toEqual([
      { id: "m1", text: "hello" },
      { id: "pending:k", text: "Ping" },
    ]);
  });

  test("repeated text remains a distinct optimistic send", () => {
    const inputs = [{ id: "m2", text: "Ping" }];
    expect(withOutgoingUserInput(inputs, { id: "pending:k", text: "Ping" })).toHaveLength(2);
  });

  test("a snapshot arriving before the POST acknowledges the submission identity", () => {
    expect(threadContainsOutgoingUserInput(
      [{ id: "persisted", text: "Ping", clientSubmissionId: "key" }],
      { id: "pending:key", text: "Ping", clientSubmissionId: "key" },
    )).toBe(true);
    expect(threadContainsOutgoingUserInput(
      [{ id: "someone-else", text: "Ping", clientSubmissionId: "other-key" }],
      { id: "pending:key", text: "Ping", clientSubmissionId: "key" },
    )).toBe(false);
  });

  test("POST message identity acknowledges a legacy snapshot without a key", () => {
    expect(threadContainsOutgoingUserInput([{ id: "persisted", text: "Ping" }],
      { id: "pending:key", messageId: "persisted", text: "Ping" })).toBe(true);
  });

  test("même id : pas de double", () => {
    const inputs = [{ id: "pending:k", text: "Ping" }];
    expect(withOutgoingUserInput(inputs, { id: "pending:k", text: "Ping" })).toEqual(inputs);
  });
});
