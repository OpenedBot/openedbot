import { describe, expect, test } from "bun:test";
import { currentTurnMessages } from "../src/domain/agent-transcript";

describe("currentTurnMessages", () => {
  test("garde ce qui suit le dernier message user", () => {
    const messages = [
      { role: "user", content: "météo Lille" },
      { role: "assistant", tool_calls: [{ id: "a" }] },
      { role: "tool", tool_call_id: "a", content: "{}" },
      { role: "user", content: "horoscope Sagittaire" },
      { role: "assistant", tool_calls: [{ id: "b" }] },
      { role: "tool", tool_call_id: "b", content: "{}" },
    ];
    expect(currentTurnMessages(messages)).toEqual([
      { role: "assistant", tool_calls: [{ id: "b" }] },
      { role: "tool", tool_call_id: "b", content: "{}" },
    ]);
  });

  test("un tour encore vide ne rend rien du tour précédent", () => {
    const messages = [
      { role: "assistant", content: "réponse d'avant" },
      { role: "user", content: "nouvelle demande" },
    ];
    expect(currentTurnMessages(messages)).toEqual([]);
  });

  test("sans message user, le transcript est rendu entier", () => {
    // Le cas du transcript de tour livré par `run.completed` : déjà borné.
    const messages = [
      { role: "assistant", tool_calls: [{ id: "a" }] },
      { role: "tool", tool_call_id: "a", content: "{}" },
    ];
    expect(currentTurnMessages(messages)).toEqual(messages);
  });

  test("une entrée qui n'est pas une liste ne produit aucun message", () => {
    expect(currentTurnMessages(null)).toEqual([]);
    expect(currentTurnMessages({ data: [] })).toEqual([]);
    expect(currentTurnMessages("[]")).toEqual([]);
  });

  test("une entrée non-objet dans la liste ne casse pas la borne", () => {
    const messages = [null, "bruit", { role: "user", content: "x" }, { role: "assistant" }];
    expect(currentTurnMessages(messages)).toEqual([{ role: "assistant" }]);
  });
});
