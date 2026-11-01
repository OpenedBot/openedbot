import { describe, expect, test } from "bun:test";
import {
  CHARS_PER_TOKEN,
  contextUsageBreakdown,
  contextUsageTools,
  isContextUsageReading,
  readContextUsage,
} from "../src/domain/runtime/context-usage";

describe("readContextUsage", () => {
  test("compte ce qui a été envoyé : instructions, historique, entrée", () => {
    const reading = readContextUsage({
      instructions: "i".repeat(40),
      history: [{ role: "user", content: "h".repeat(40) }],
      input: "e".repeat(40),
    });
    expect(reading?.sentTokens).toBe(120 / CHARS_PER_TOKEN);
    expect(reading?.tokens).toBe(30);
    expect(reading?.toolTokens).toBe(0);
    expect(reading?.source).toBe("estimated");
  });

  test("ajoute ce que le TOUR a fait pousser, outils compris", () => {
    const reading = readContextUsage({
      input: "e".repeat(40),
      turnMessages: [
        { role: "assistant", tool_calls: [{ id: "c1", function: { name: "web_search", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "r".repeat(400) },
      ],
    });
    expect(reading!.tokens).toBeGreaterThan(reading!.sentTokens);
    expect(reading!.toolTokens).toBeGreaterThanOrEqual(100);
  });

  test("un tour sans outil n'attribue rien aux outils", () => {
    const reading = readContextUsage({
      input: "e".repeat(40),
      turnMessages: [{ role: "assistant", content: "OK" }],
    });
    expect(reading?.toolTokens).toBe(0);
  });

  // Mesuré le 2026-09-11 : neuf tours, session de 22 000 à 198 000 jetons,
  // entrée facturée plate à 29 300. Le contexte suit l'envoi, pas la session.
  test("le contexte suit ce qui est envoyé, pas la longueur de la conversation", () => {
    const bloc = { role: "user", content: "x".repeat(88_000) };
    const court = readContextUsage({ history: [bloc], input: "" });
    const longFil = readContextUsage({ history: [bloc], input: "" });
    expect(court?.tokens).toBe(longFil?.tokens);
    expect(court?.tokens).toBe(22_000);
  });

  test("ventile chaque poste sur sa propre source", () => {
    const reading = readContextUsage({
      instructions: "i".repeat(40),
      history: [{ role: "user", content: "h".repeat(80) }],
      input: "e".repeat(40),
      turnMessages: [
        {
          role: "assistant",
          content: "a".repeat(40),
          reasoning: "r".repeat(40),
          tool_calls: [{ id: "c1", function: { name: "web_search", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "x".repeat(400) },
      ],
    });
    const breakdown = contextUsageBreakdown(reading!);
    expect(breakdown).not.toBeNull();
    expect(breakdown!.instructions).toBe(10);
    expect(breakdown!.history).toBe(20);
    expect(breakdown!.input).toBe(10);
    expect(breakdown!.reply).toBe(10);
    expect(breakdown!.reasoning).toBe(10);
    expect(breakdown!.toolResults).toBe(100);
    expect(breakdown!.toolCalls).toBeGreaterThan(0);
  });

  test("réunit appels et résultats sous le nom de l'outil, résultat rattaché par tool_call_id", () => {
    const reading = readContextUsage({
      input: "e",
      turnMessages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "c1", function: { name: "web_search", arguments: "{}" } },
            { id: "c2", function: { name: "web_search", arguments: "{}" } },
            { id: "c3", function: { name: "terminal", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "x".repeat(400) },
        { role: "tool", tool_call_id: "c2", content: "x".repeat(400) },
        { role: "tool", tool_call_id: "c3", content: "x".repeat(40) },
        { role: "tool", name: "read_file", content: "y".repeat(8) },
        { role: "tool", tool_call_id: "inconnu", content: "z".repeat(8) },
      ],
    });
    const tools = contextUsageTools(reading!);
    expect(tools.map((tool) => tool.name)).toEqual(["web_search", "terminal", "read_file"]);
    expect(tools[0]!.calls).toBe(2);
    expect(tools[0]!.tokens).toBeGreaterThanOrEqual(200);
    // Un résultat sans appel connu ni nom compte dans les résultats, sans outil.
    expect(contextUsageBreakdown(reading!)!.toolResults).toBe(Math.ceil(856 / CHARS_PER_TOKEN));
  });

  test("relue depuis le journal, une lecture ancienne ou abîmée n'a pas de détail", () => {
    const ancienne = { tokens: 10, toolTokens: 0, sentTokens: 10, source: "estimated" as const };
    expect(contextUsageBreakdown(ancienne)).toBeNull();
    expect(contextUsageTools(ancienne)).toEqual([]);
    const abimee = { ...ancienne, breakdown: { instructions: "1" }, tools: [{ name: "", tokens: 1, calls: 1 }, 4] };
    expect(contextUsageBreakdown(abimee as never)).toBeNull();
    expect(contextUsageTools(abimee as never)).toEqual([]);
  });

  test("rien d'envoyé ne se lit pas « contexte à zéro »", () => {
    expect(readContextUsage({})).toBeNull();
    expect(readContextUsage({ instructions: "", input: "", history: [] })).toBeNull();
    expect(readContextUsage({ turnMessages: "pas une liste" })).toBeNull();
  });
});

describe("isContextUsageReading", () => {
  test("reconnaît une lecture projetée et rejette une forme approchante", () => {
    expect(isContextUsageReading(readContextUsage({ input: "abcd" }))).toBe(true);
    expect(isContextUsageReading({ tokens: 1, toolTokens: 0 })).toBe(false);
    expect(isContextUsageReading({ tokens: 1, toolTokens: 0, sentTokens: 1, source: "reported" })).toBe(false);
  });
});
