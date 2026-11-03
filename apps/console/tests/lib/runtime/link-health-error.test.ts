import { describe, expect, test } from "bun:test";
import { linkHealthErrorText } from "../../../src/lib/runtime/link-health-error";

const dated = (seen: string) => `restarted ${seen}`;

describe("linkHealthErrorText", () => {
  test("a restart stored without a clock gains the last sign of life", () => {
    expect(linkHealthErrorText(
      "L’instance openedbot qui tenait le lien s’est arrêtée.",
      "2026-10-12T12:22:00.000Z",
      dated,
    )).toBe("restarted 2026-10-12T12:22:00.000Z");
    expect(linkHealthErrorText(
      "openedbot a redémarré ; l’hôte ne s’est pas reconnecté depuis.",
      "2026-10-12T12:22:00.000Z",
      dated,
    )).toBe("restarted 2026-10-12T12:22:00.000Z");
  });

  test("any other sentence, and a restart with no last sign of life, stay as written", () => {
    expect(linkHealthErrorText("Le jeton du lien a été tourné ; l’hôte doit se reconnecter.", "2026-10-12T12:22:00.000Z", dated))
      .toBe("Le jeton du lien a été tourné ; l’hôte doit se reconnecter.");
    expect(linkHealthErrorText("L’instance openedbot qui tenait le lien s’est arrêtée.", null, dated))
      .toBe("L’instance openedbot qui tenait le lien s’est arrêtée.");
    expect(linkHealthErrorText(null, "2026-10-12T12:22:00.000Z", dated)).toBeNull();
  });
});
