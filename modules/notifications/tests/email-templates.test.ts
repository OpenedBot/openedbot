import { describe, expect, test } from "bun:test";
import { TRANSACTIONAL_EMAIL_KINDS, TRANSACTIONAL_EMAIL_LOCALES } from "@openedbot/contracts-api";
import { TRANSACTIONAL_EMAIL_SAMPLE_DATA } from "../src/domain/email/samples";
import { renderTransactionalEmail } from "../src/domain/email/templates";

/**
 * Un genre déclaré sans gabarit ne part pas en message vide : il part en échec
 * de rendu chez le worker, pour chaque destinataire, jusqu'à épuisement des
 * reprises. Cette boucle est donc le garde-fou de la liste elle-même.
 */
describe("gabarits transactionnels", () => {
  test("chaque genre rend un sujet, un texte et un HTML dans les deux langues", () => {
    for (const kind of TRANSACTIONAL_EMAIL_KINDS) {
      for (const locale of TRANSACTIONAL_EMAIL_LOCALES) {
        const rendered = renderTransactionalEmail({
          kind,
          locale,
          data: TRANSACTIONAL_EMAIL_SAMPLE_DATA[kind],
        });
        expect(rendered.subject.length).toBeGreaterThan(0);
        expect(rendered.text.length).toBeGreaterThan(0);
        expect(rendered.html).toStartWith("<!DOCTYPE html>");
      }
    }
  });

  test("un genre que le cœur ne rend plus (resté en file après un plug-in) échoue avec sa raison", () => {
    expect(() => renderTransactionalEmail({ kind: "staff_login_code" as never, locale: "fr", data: {} }))
      .toThrow('No email template for the kind "staff_login_code".');
  });
});

describe("connector à mettre à jour", () => {
  const data = {
    runtimeName: "VPS production",
    installedVersion: "v0.5.3",
    targetVersion: "v0.5.7",
    upgradeCommand: "sudo edge-setup upgrade --yes",
    settingsUrl: "https://openedbot.app/o/atelier/settings/runtime",
  };

  test("porte le runtime, les deux versions, la commande, l’impossibilité d’agir et le lien", () => {
    for (const locale of TRANSACTIONAL_EMAIL_LOCALES) {
      const rendered = renderTransactionalEmail({ kind: "runtime_connector_outdated", locale, data });
      expect(rendered.subject).toContain(data.runtimeName);
      for (const value of [data.installedVersion, data.targetVersion, data.upgradeCommand]) {
        expect(rendered.text).toContain(value);
      }
      expect(rendered.text).toContain(locale === "fr" ? "openedbot ne peut pas mettre à jour" : "openedbot cannot update");
      expect(rendered.html).toContain(`href="${data.settingsUrl}"`);
    }
  });
});
