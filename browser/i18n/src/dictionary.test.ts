import { describe, expect, test } from "bun:test";
import { loadLocale, t } from "./dictionary";

describe("t", () => {
  test("insère un paramètre tel quel, motifs de remplacement `$` compris", async () => {
    await loadLocale("fr");
    expect(t("fr", "newBotDialog.creatingTitle", { name: "Budget $&" })).toBe("Budget $& arrive…");
    expect(t("fr", "newBotDialog.creatingTitle", { name: "Budget $$" })).toBe("Budget $$ arrive…");
    expect(t("fr", "newBotDialog.creatingTitle", { name: "Budget $'" })).toBe("Budget $' arrive…");
  });
});
