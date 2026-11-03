import { describe, expect, test } from "bun:test";
import { hasMessage, loadLocale, registerMessages, t, type MessageKey } from "@openedbot/browser-i18n";

/**
 * Open-core step 10: a console module (agency, billing, permission rules)
 * brings its own strings and registers them; the core dictionaries no longer
 * carry them, so a solo console bundles none.
 */
describe("registerMessages", () => {
  test("a registered string is translated; a core key keeps its core text", async () => {
    await loadLocale("fr");
    const before = t("fr", "common.cancel" as MessageKey);
    registerMessages("fr", { zzModuleTest: { hello: "Bonjour {name}" }, common: { cancel: "REMPLACÉ" } });
    expect(hasMessage("zzModuleTest.hello")).toBe(true);
    expect(t("fr", "zzModuleTest.hello" as MessageKey, { name: "Ada" })).toBe("Bonjour Ada");
    expect(t("fr", "common.cancel" as MessageKey)).toBe(before);
  });

  test("the pro screens' strings come from their module, not the core dictionary", async () => {
    // Their modules live in the external plugin repo since step 11, with
    // their strings (`packages/<plug-in>/console/messages.*.ts`).
    const { fr } = await import("@openedbot/browser-i18n/messages.fr");
    expect("agencyJournal" in fr).toBe(false);
    expect("settingsBilling" in fr).toBe(false);
    expect("permissionRules" in fr).toBe(false);
  });
});
