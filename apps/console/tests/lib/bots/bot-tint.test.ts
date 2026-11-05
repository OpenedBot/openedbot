import { describe, expect, test } from "bun:test";
import { COLORS } from "@openedbot/browser-face/presets";
import { DARK_TINT_TEXT, botAccentColor, botBubbleColor, botTintStyle, botUserBubbleFill, tintTextColor } from "../../../src/lib/bots/bot-tint";

const vector = (palette: string) => ({ palette, shape: "cercle", eyes: "neutre" });

describe("couleur de la bulle de l'utilisateur", () => {
  test("un visage coloré donne sa couleur en aplat", () => {
    expect(botBubbleColor("bot-1", vector("violet"))).toBe("#8b5cf6");
    expect(botBubbleColor("bot-1", vector("rouge"))).toBe("#e8483f");
  });

  test("toutes les couleurs de la palette ont une bulle", () => {
    for (const color of COLORS) expect(botBubbleColor("bot-1", vector(color.id))).toBe(color.hex);
  });

  test("un avatar robot garde la bulle blanche : catalogue, défaut, téléversé", () => {
    expect(botBubbleColor("bot-1", { ...vector("rouge"), artwork: "solar" })).toBeNull();
    expect(botBubbleColor("bot-1", null)).toBeNull();
    expect(botBubbleColor("bot-1", undefined)).toBeNull();
    expect(botBubbleColor("bot-1", { ...vector("rouge"), artwork: "/api/bots/bot-1/avatar" })).toBeNull();
  });

  test("pas de bot : la bulle reste blanche", () => {
    expect(botBubbleColor(undefined, vector("rouge"))).toBeNull();
  });
});

describe("texte posé sur la couleur du bot", () => {
  test("blanc sur les couleurs soutenues, comme grokbot", () => {
    for (const id of ["rouge", "bleu", "violet", "rose", "brun", "encre"]) {
      const color = COLORS.find((candidate) => candidate.id === id);
      expect(color && tintTextColor(color.hex)).toBe("#ffffff");
    }
  });

  test("encre sur les couleurs claires, où le blanc tombe sous 3:1", () => {
    for (const id of ["orange", "ambre", "vert", "turquoise", "gris", "creme"]) {
      const color = COLORS.find((candidate) => candidate.id === id);
      expect(color && tintTextColor(color.hex)).toBe(DARK_TINT_TEXT);
    }
  });

  test("une couleur illisible garde le blanc d'avant", () => {
    expect(tintTextColor("rouge")).toBe("#ffffff");
  });
});

describe("accent de la conversation", () => {
  test("une couleur franche devient l'accent", () => {
    expect(botAccentColor("#e8483f")).toBe("#e8483f");
    expect(botAccentColor("#f0b429")).toBe("#f0b429");
  });

  test("un gris garde l'accent de l'app : encre, crème, gris", () => {
    expect(botAccentColor("#0a0a0c")).toBeNull();
    expect(botAccentColor("#f1efe9")).toBeNull();
    expect(botAccentColor("#a3a3a3")).toBeNull();
  });

  test("pas de couleur, ou une valeur illisible : pas d'accent", () => {
    expect(botAccentColor(null)).toBeNull();
    expect(botAccentColor("red")).toBeNull();
  });
});

describe("aplat Grok Bot de la bulle de l'utilisateur", () => {
  test("une teinte de Grok Bot : FillHover en clair, Fill en sombre", () => {
    expect(botUserBubbleFill("bot-1", vector("bleu"))).toEqual({ light: "#126fd4", dark: "#116dd2" });
    expect(botUserBubbleFill("bot-1", vector("ambre"))).toEqual({ light: "#c2730b", dark: "#c8770c" });
    expect(botUserBubbleFill("bot-1", vector("rose"))).toEqual({ light: "#c82779", dark: "#cf297e" });
  });

  test("l'encre, le gris et la crème ne teintent pas, comme black et gray chez Grok Bot", () => {
    for (const id of ["encre", "gris", "creme"]) expect(botUserBubbleFill("bot-1", vector(id))).toBeNull();
  });

  test("chaque autre couleur de la palette a son aplat", () => {
    const tinted = COLORS.filter((color) => !["encre", "gris", "creme"].includes(color.id));
    for (const color of tinted) expect(botUserBubbleFill("bot-1", vector(color.id))).not.toBeNull();
  });

  test("un avatar robot ou téléversé garde la bulle neutre", () => {
    expect(botUserBubbleFill("bot-1", { ...vector("bleu"), artwork: "solar" })).toBeNull();
    expect(botUserBubbleFill("bot-1", { ...vector("bleu"), artwork: "/api/bots/bot-1/avatar" })).toBeNull();
    expect(botUserBubbleFill(undefined, vector("bleu"))).toBeNull();
  });

  test("le style de la colonne porte l'aplat seulement quand il existe", () => {
    const fill = botUserBubbleFill("bot-1", vector("bleu"));
    expect(botTintStyle("#3b93f0", fill)).toMatchObject({ "--openedbot-user-fill-light": "#126fd4", "--openedbot-user-fill-dark": "#116dd2" });
    expect(botTintStyle("#a3a3a3", null)).not.toHaveProperty("--openedbot-user-fill-light");
    expect(botTintStyle(null, fill)).toBeUndefined();
  });
});
