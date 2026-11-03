import { describe, expect, test } from "bun:test";
import {
  PERSONA_MAX_CHARS,
  composePersona,
  displayedCreatePersona,
  personaMetrics,
  resolveCreateInstructions,
} from "../src/domain/persona";

describe("composePersona", () => {
  test("compose un titre, un rôle, une mission et le paragraphe de cadrage", () => {
    expect(composePersona({
      name: "Hermes Local Test",
      role: "Research",
      mission: "Cite sources and refuse unsourced claims.",
    })).toBe(
      [
        "# Hermes Local Test",
        "",
        "**Role:** Research",
        "**Mission:** Cite sources and refuse unsourced claims.",
        "",
        "You are a persistent named agent (Hermes Local Test). You keep your own memory, skills, and conversation history. Speak as this identity on every turn.",
      ].join("\n"),
    );
  });

  test("un nom suffit : le rôle reprend le nom, la mission a un défaut", () => {
    const text = composePersona({ name: "Neo" });
    expect(text.startsWith("# Neo\n\n**Role:** Neo\n**Mission:** Act as Neo")).toBe(true);
    expect(text.includes("persistent named agent (Neo)")).toBe(true);
  });

  test("un nom vide tombe sur Bot, jamais une persona vide", () => {
    const text = composePersona({ name: "   " });
    expect(text).toContain("# Bot");
    expect(text).toContain("**Role:** Bot");
    expect(text.trim().length).toBeGreaterThan(0);
  });

  test("trim les champs et ignore un rôle / mission blanc", () => {
    const text = composePersona({ name: "  Ada  ", role: "  ", mission: "\n" });
    expect(text.startsWith("# Ada\n\n**Role:** Ada\n")).toBe(true);
  });
});

describe("resolveCreateInstructions", () => {
  test("conserve une persona explicite", () => {
    expect(resolveCreateInstructions({
      name: "Neo",
      instructions: "  You cite sources.  ",
    })).toBe("You cite sources.");
  });

  test("compose quand le champ est absent ou vide", () => {
    expect(resolveCreateInstructions({ name: "Neo" })).toBe(composePersona({ name: "Neo" }));
    expect(resolveCreateInstructions({ name: "Neo", instructions: "   " }))
      .toBe(composePersona({ name: "Neo" }));
    expect(resolveCreateInstructions({
      name: "Neo",
      role: "Research",
      mission: "Cite sources.",
    })).toBe(composePersona({ name: "Neo", role: "Research", mission: "Cite sources." }));
  });
});

describe("displayedCreatePersona", () => {
  test("sans édition, identique à l'octet près à resolveCreateInstructions côté serveur", () => {
    const input = { name: "Ada", role: "Research", mission: "Cite sources." };
    expect(displayedCreatePersona({ ...input, edited: false }))
      .toBe(resolveCreateInstructions(input));
    expect(displayedCreatePersona({ ...input, edited: false, editedText: "custom" }))
      .toBe(resolveCreateInstructions(input));
  });

  test("une saisie humaine n'est plus recomposée", () => {
    expect(displayedCreatePersona({
      name: "Ada",
      role: "Research",
      mission: "Cite sources.",
      edited: true,
      editedText: "You cite sources.\n",
    })).toBe("You cite sources.\n");
    expect(displayedCreatePersona({
      name: "Ada",
      edited: true,
      editedText: "",
    })).toBe("");
  });
});

describe("personaMetrics", () => {
  test("mesure le texte trimé contre le plafond", () => {
    const metrics = personaMetrics("  hello  ");
    expect(metrics.chars).toBe(5);
    expect(metrics.remaining).toBe(PERSONA_MAX_CHARS - 5);
    expect(metrics.overLimit).toBe(false);
    expect(metrics.estimatedTokens).toBe(Math.ceil(5 / 3.5));
  });
});
